import os
import json
import base64
import logging
import uuid
import tempfile
import hashlib
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Dict, Tuple, Any
import xml.etree.ElementTree as ET
from google.cloud import storage

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import mimetypes

import sys

# Add current directory and backend directory to path
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.insert(0, current_dir)
sys.path.insert(0, parent_dir)

try:
    from .transcriber import (
        process_transcription,
        TranscriptTurn,
        generate_oncue_xml,
        compute_transcript_line_entries,
        seconds_to_timestamp,
        WordTimestamp,
        create_docx,
    )
except ImportError:
    try:
        from transcriber import (
            process_transcription,
            TranscriptTurn,
            generate_oncue_xml,
            compute_transcript_line_entries,
            seconds_to_timestamp,
            WordTimestamp,
            create_docx,
        )
    except ImportError:
        import transcriber
        process_transcription = transcriber.process_transcription
        TranscriptTurn = transcriber.TranscriptTurn
        generate_oncue_xml = transcriber.generate_oncue_xml
        compute_transcript_line_entries = transcriber.compute_transcript_line_entries
        seconds_to_timestamp = transcriber.seconds_to_timestamp
        WordTimestamp = transcriber.WordTimestamp
        create_docx = transcriber.create_docx

# Environment-based CORS configuration
ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
ALLOWED_ORIGINS = ["*"] if ENVIRONMENT == "development" else [
    "https://transcribealpha-*.cloudfunctions.net",
    "https://transcribealpha-*.appspot.com",
    "https://transcribealpha-*.run.app",
    # Add your production domains here
]

# Cloud Storage configuration
BUCKET_NAME = "transcribealpha-uploads-1750110926"
storage_client = storage.Client()

# Cache for transcription results
temp_transcript_cache: Dict[str, dict] = {}

# Default transcript layout configuration
DEFAULT_LINES_PER_PAGE = 25

# Track last cleanup time for periodic cleanup
last_cleanup_time = datetime.now()

EDITOR_SESSION_PREFIX = "editor_sessions/"
EDITOR_SESSION_TTL_DAYS = int(os.getenv("EDITOR_SESSION_TTL_DAYS", "7"))


def _session_blob_name(session_id: str) -> str:
    return f"{EDITOR_SESSION_PREFIX}{session_id}.json"


def serialize_transcript_turns(turns: List[TranscriptTurn]) -> List[dict]:
    serialized: List[dict] = []
    for turn in turns:
        turn_dict = turn.dict()
        if turn_dict.get("words"):
            sanitized_words = []
            for word in turn_dict["words"]:
                sanitized_words.append(
                    {
                        "text": word.get("text"),
                        "start": float(word.get("start", 0.0)),
                        "end": float(word.get("end", 0.0)),
                        "confidence": word.get("confidence"),
                        "speaker": word.get("speaker"),
                    }
                )
            turn_dict["words"] = sanitized_words
        serialized.append(turn_dict)
    return serialized


def save_editor_session(session_id: str, session_data: dict) -> None:
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = _session_blob_name(session_id)
        blob = bucket.blob(blob_name)
        blob.metadata = {
            "session_id": session_id,
            "created_at": session_data["created_at"],
            "expires_at": session_data["expires_at"],
            "updated_at": session_data.get("updated_at", session_data["created_at"]),
        }
        blob.upload_from_string(json.dumps(session_data), content_type="application/json")
        logger.info("Saved editor session %s", session_id)
    except Exception as e:
        logger.error("Failed to save editor session %s: %s", session_id, e)
        raise


def load_editor_session(session_id: str) -> Optional[dict]:
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = _session_blob_name(session_id)
        blob = bucket.blob(blob_name)
        if not blob.exists():
            return None
        raw = blob.download_as_text()
        session_data = json.loads(raw)
        return session_data
    except Exception as e:
        logger.error("Failed to load editor session %s: %s", session_id, e)
        return None


def delete_editor_session(session_id: str) -> None:
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = _session_blob_name(session_id)
        blob = bucket.blob(blob_name)
        if blob.exists():
            blob.delete()
            logger.info("Deleted editor session %s", session_id)
    except Exception as e:
        logger.error("Failed to delete editor session %s: %s", session_id, e)


def session_is_expired(session_data: dict) -> bool:
    expires_at = session_data.get("expires_at")
    if not expires_at:
        return False
    try:
        expires_dt = datetime.fromisoformat(expires_at)
    except ValueError:
        try:
            expires_dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError:
            return False
    return expires_dt < datetime.now(timezone.utc)


def cleanup_expired_editor_sessions():
    """Delete editor sessions older than the configured TTL."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        now = datetime.now(timezone.utc)
        deleted = 0
        for blob in bucket.list_blobs(prefix=EDITOR_SESSION_PREFIX):
            try:
                raw = blob.download_as_text()
                session_data = json.loads(raw)
            except Exception:
                continue
            expires_at = session_data.get("expires_at")
            if not expires_at:
                continue
            try:
                expires_dt = datetime.fromisoformat(expires_at)
            except ValueError:
                try:
                    expires_dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                except ValueError:
                    continue
            if expires_dt < now:
                blob.delete()
                deleted += 1
        if deleted:
            logger.info("Cleanup removed %s expired editor sessions", deleted)
    except Exception as e:
        logger.error("Error during editor session cleanup: %s", e)

def parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None


def format_transcript_text(turns: List[TranscriptTurn], include_timestamps: bool) -> str:
    if include_timestamps:
        return "\n\n".join(
            [
                f"{turn.timestamp + ' ' if (turn.timestamp and include_timestamps) else ''}{turn.speaker.upper()}:\t\t{turn.text}"
                for turn in turns
            ]
        )
    return "\n\n".join([f"{turn.speaker.upper()}:\t\t{turn.text}" for turn in turns])


def serialize_line_entries(line_entries: List[dict]) -> List[dict]:
    serialized = []
    for entry in line_entries:
        serialized.append(
            {
                "id": entry["id"],
                "speaker": entry["speaker"],
                "text": entry["text"],
                "start": float(entry["start"]),
                "end": float(entry["end"]),
                "page": entry.get("page"),
                "line": entry.get("line"),
                "pgln": entry.get("pgln"),
                "is_continuation": entry.get("is_continuation", False),
            }
        )
    return serialized


def build_session_artifacts(
    turns: List[TranscriptTurn],
    title_data: dict,
    duration_seconds: float,
    include_timestamps: bool,
    lines_per_page: int,
):
    docx_bytes = create_docx(title_data, turns, include_timestamps)
    oncue_xml = generate_oncue_xml(turns, title_data, duration_seconds, lines_per_page)
    line_entries, _ = compute_transcript_line_entries(turns, duration_seconds, lines_per_page)
    transcript_text = format_transcript_text(turns, include_timestamps)
    return docx_bytes, oncue_xml, transcript_text, serialize_line_entries(line_entries)


def build_session_response(session_data: dict) -> dict:
    return {
        "session_id": session_data.get("session_id"),
        "title_data": session_data.get("title_data", {}),
        "audio_duration": session_data.get("audio_duration", 0.0),
        "lines_per_page": session_data.get("lines_per_page", DEFAULT_LINES_PER_PAGE),
        "include_timestamps": session_data.get("include_timestamps", False),
        "lines": session_data.get("lines", []),
        "created_at": session_data.get("created_at"),
        "updated_at": session_data.get("updated_at"),
        "expires_at": session_data.get("expires_at"),
        "docx_base64": session_data.get("docx_base64"),
        "oncue_xml_base64": session_data.get("oncue_xml_base64"),
        "transcript": session_data.get("transcript_text"),
        "media_blob_name": session_data.get("media_blob_name"),
        "media_content_type": session_data.get("media_content_type"),
    }


def normalize_line_payloads(
    lines_payload: List[dict],
    duration_seconds: float,
) -> Tuple[List[dict], float]:
    normalized_lines = []
    max_end = duration_seconds

    for idx, line in enumerate(lines_payload):
        try:
            start_val = float(line.get("start", 0.0))
            end_val = float(line.get("end", start_val))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"Invalid start/end for line index {idx}")

        if end_val < start_val:
            end_val = start_val

        if duration_seconds > 0:
            start_val = max(0.0, min(start_val, duration_seconds))
            end_val = max(0.0, min(end_val, duration_seconds))
        else:
            start_val = max(0.0, start_val)
            end_val = max(start_val, end_val)

        speaker_name = str(line.get("speaker", "")).strip() or "SPEAKER"
        text_value = str(line.get("text", "")).strip()

        normalized_lines.append(
            {
                "id": line.get("id") or f"{idx}",
                "speaker": speaker_name.upper(),
                "text": text_value,
                "start": start_val,
                "end": end_val,
                "is_continuation": bool(line.get("is_continuation", False)),
            }
        )

        max_end = max(max_end, end_val)

    if duration_seconds == 0 and max_end > 0:
        duration_seconds = max_end
    elif max_end > duration_seconds:
        duration_seconds = max_end

    normalized_lines = sorted(
        enumerate(normalized_lines),
        key=lambda item: (item[1]["start"], item[0]),
    )

    return [item[1] for item in normalized_lines], duration_seconds


def construct_turns_from_lines(
    normalized_lines: List[dict],
    include_timestamps: bool,
) -> List[TranscriptTurn]:
    turns: List[TranscriptTurn] = []
    current_speaker: Optional[str] = None
    current_text_parts: List[str] = []
    current_words: List[WordTimestamp] = []
    current_start: Optional[float] = None

    def flush_turn():
        nonlocal current_speaker, current_text_parts, current_words, current_start
        if current_speaker is None:
            return
        full_text = " ".join([part for part in current_text_parts if part]).strip()
        timestamp_str = seconds_to_timestamp(current_start) if (current_start is not None and include_timestamps) else None
        turns.append(
            TranscriptTurn(
                speaker=current_speaker,
                text=full_text,
                timestamp=timestamp_str,
                words=current_words if current_words else None,
            )
        )
        current_speaker = None
        current_text_parts = []
        current_words = []
        current_start = None

    for line in normalized_lines:
        speaker = line["speaker"]
        start_val = line["start"]
        end_val = line["end"]
        text_val = line["text"]

        should_start_new = False
        if current_speaker is None:
            should_start_new = True
        elif line.get("is_continuation", False) is False:
            should_start_new = True
        elif speaker != current_speaker:
            should_start_new = True

        if should_start_new:
            flush_turn()
            current_speaker = speaker
            current_start = start_val

        current_text_parts.append(text_val)

        tokens = [tok for tok in text_val.split() if tok]
        line_duration = max(end_val - start_val, 0.01)
        word_count = len(tokens) or 1
        for word_idx, token in enumerate(tokens or [""]):
            token_start = start_val + (line_duration * word_idx / word_count)
            if word_idx == word_count - 1:
                token_end = end_val
            else:
                token_end = start_val + (line_duration * (word_idx + 1) / word_count)
            current_words.append(
                WordTimestamp(
                    text=token or "",
                    start=token_start * 1000.0,
                    end=max(token_end * 1000.0, token_start * 1000.0),
                    confidence=None,
                    speaker=speaker,
                )
            )

    flush_turn()
    return turns


def load_latest_editor_session() -> Optional[dict]:
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        latest_session = None
        latest_ts = None
        for blob in bucket.list_blobs(prefix=EDITOR_SESSION_PREFIX):
            try:
                raw = blob.download_as_text()
                session_data = json.loads(raw)
            except Exception:
                continue

            if session_is_expired(session_data):
                try:
                    blob.delete()
                except Exception:
                    pass
                continue

            updated_at_str = session_data.get("updated_at") or session_data.get("created_at")
            updated_at = parse_iso_datetime(updated_at_str)
            if not updated_at:
                continue

            if latest_ts is None or updated_at > latest_ts:
                latest_ts = updated_at
                latest_session = session_data

        return latest_session
    except Exception as e:
        logger.error("Failed to load latest editor session: %s", e)
        return None


def parse_oncue_xml(xml_text: str) -> Dict[str, Any]:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid OnCue XML: {exc}")

    deposition = root.find(".//deposition")
    title_data = {
        "CASE_NAME": "",
        "CASE_NUMBER": "",
        "FIRM_OR_ORGANIZATION_NAME": "",
        "DATE": deposition.get("date") if deposition is not None else "",
        "TIME": "",
        "LOCATION": "",
        "FILE_NAME": deposition.get("filename") if deposition is not None else "imported.xml",
        "FILE_DURATION": "",
    }

    lines: List[dict] = []
    current_speaker: Optional[str] = None
    max_end = 0.0

    for line_idx, line_elem in enumerate(root.findall(".//depoLine")):
        raw_text = line_elem.attrib.get("text", "")
        video_start = float(line_elem.attrib.get("videoStart", "0") or 0)
        video_stop = float(line_elem.attrib.get("videoStop", "0") or video_start)
        page = line_elem.attrib.get("page")
        line_number = line_elem.attrib.get("line")
        pgln = line_elem.attrib.get("pgLN")

        trimmed = raw_text.lstrip()
        speaker = current_speaker
        text_content = trimmed
        is_continuation = True

        if trimmed:
            if ":   " in trimmed:
                potential_speaker, remainder = trimmed.split(":   ", 1)
                if potential_speaker.strip():
                    speaker = potential_speaker.strip().upper()
                    text_content = remainder.strip()
                    is_continuation = False
            elif current_speaker is None:
                speaker = "SPEAKER"
                text_content = trimmed.strip()
                is_continuation = False
        else:
            text_content = ""

        if speaker is None:
            speaker = "SPEAKER"

        current_speaker = speaker
        max_end = max(max_end, video_stop)

        lines.append(
            {
                "id": line_elem.attrib.get("pgLN", f"{line_idx}"),
                "speaker": speaker,
                "text": text_content,
                "start": video_start,
                "end": video_stop,
                "page": int(page) if page and page.isdigit() else None,
                "line": int(line_number) if line_number and line_number.isdigit() else None,
                "pgln": int(pgln) if pgln and pgln.isdigit() else None,
                "is_continuation": is_continuation,
            }
        )

    duration_seconds = max_end
    hours, rem = divmod(duration_seconds, 3600)
    minutes, seconds = divmod(rem, 60)
    title_data["FILE_DURATION"] = "{:0>2}:{:0>2}:{:0>2}".format(int(hours), int(minutes), int(round(seconds)))

    return {
        "lines": lines,
        "title_data": title_data,
        "audio_duration": duration_seconds,
    }

def create_cache_key(
    file_bytes: bytes,
    speaker_list: Optional[List[str]],
) -> str:
    """Create a cache key based on file content and transcription settings"""
    # Create hash of file content
    file_hash = hashlib.md5(file_bytes).hexdigest()
    
    # Create hash of settings
    settings_str = f"{speaker_list or []}"
    settings_hash = hashlib.md5(settings_str.encode()).hexdigest()
    
    return f"{file_hash}_{settings_hash}"

def cleanup_old_files():
    """Clean up files older than 1 day from Cloud Storage to prevent billing issues"""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        cutoff_date = datetime.now() - timedelta(days=1)
        
        blobs = bucket.list_blobs()
        deleted_count = 0
        
        for blob in blobs:
            # Check if blob is older than 1 day
            if blob.time_created and blob.time_created.replace(tzinfo=None) < cutoff_date:
                blob.delete()
                deleted_count += 1
                logger.info(f"Deleted old file: {blob.name}")
        
        logger.info(f"Cleanup completed. Deleted {deleted_count} old files.")
    except Exception as e:
        logger.error(f"Error during cleanup: {str(e)}")

def upload_to_cloud_storage(file_bytes: bytes, filename: str) -> str:
    """Upload file to Cloud Storage and return the blob name"""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}_{filename}"
        blob = bucket.blob(blob_name)
        blob.upload_from_string(file_bytes)
        logger.info(f"Uploaded {filename} to Cloud Storage as {blob_name}")
        return blob_name
    except Exception as e:
        logger.error(f"Error uploading to Cloud Storage: {str(e)}")
        raise

def download_from_cloud_storage(blob_name: str) -> bytes:
    """Download file from Cloud Storage"""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(blob_name)
        return blob.download_as_bytes()
    except Exception as e:
        logger.error(f"Error downloading from Cloud Storage: {str(e)}")
        raise

def get_blob_metadata(blob_name: str) -> dict:
    """Get metadata for a blob in Cloud Storage"""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(blob_name)
        if not blob.exists():
            return None
        
        # Parse metadata from blob name and custom metadata
        metadata = blob.metadata or {}
        return {
            'filename': metadata.get('original_filename', blob_name.split('_')[-1]),
            'content_type': blob.content_type or metadata.get('content_type', 'application/octet-stream'),
            'size': blob.size,
            'created': blob.time_created,
        }
    except Exception as e:
        logger.error(f"Error getting blob metadata: {str(e)}")
        return None

def upload_preview_file_to_cloud_storage(file_bytes: bytes, filename: str, content_type: str = None) -> str:
    """Upload preview file to Cloud Storage with metadata"""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = f"preview_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}_{filename}"
        blob = bucket.blob(blob_name)
        
        # Set metadata
        blob.metadata = {
            'original_filename': filename,
            'content_type': content_type or 'application/octet-stream',
            'file_type': 'preview'
        }
        
        if content_type:
            blob.content_type = content_type
            
        blob.upload_from_string(file_bytes)
        logger.info(f"Uploaded preview file {filename} to Cloud Storage as {blob_name}")
        return blob_name
    except Exception as e:
        logger.error(f"Error uploading preview file to Cloud Storage: {str(e)}")
        raise

app = FastAPI(
    title="TranscribeAlpha API",
    description="Professional Legal Transcript Generator using AssemblyAI",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def startup_event():
    """Run cleanup on startup and log Cloud Storage status"""
    logger.info("Starting TranscribeAlpha with Cloud Storage enabled")
    cleanup_old_files()
    cleanup_expired_editor_sessions()


@app.post("/api/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    case_name: str = Form("") ,
    case_number: str = Form(""),
    firm_name: str = Form(""),
    input_date: str = Form(""),
    input_time: str = Form(""),
    location: str = Form(""),
    speaker_names: Optional[str] = Form(None),
    include_timestamps: Optional[str] = Form(None),
):
    logger.info(f"Received transcription request for file: {file.filename}")
    
    if not os.getenv("ASSEMBLYAI_API_KEY"):
        logger.error("ASSEMBLYAI_API_KEY environment variable not set")
        raise HTTPException(
            status_code=500,
            detail="Server configuration error: AssemblyAI API key not configured"
        )
    
    # Check file size and handle large files with Cloud Storage
    file_size = len(await file.read())
    await file.seek(0)  # Reset file pointer
    logger.info(f"File size: {file_size / (1024*1024):.2f} MB")
    
    # Increase limit to 2GB for Cloud Storage handling
    if file_size > 2 * 1024 * 1024 * 1024:  # 2GB limit
        raise HTTPException(status_code=413, detail="File too large. Maximum size is 2GB.")
    
    file_bytes = await file.read()
    
    # For large files (>100MB), use Cloud Storage
    use_cloud_storage = file_size > 100 * 1024 * 1024
    blob_name = None
    
    if use_cloud_storage:
        logger.info(f"Large file detected ({file_size / (1024*1024):.2f} MB), uploading to Cloud Storage")
        blob_name = upload_to_cloud_storage(file_bytes, file.filename)
        # Run cleanup after upload to manage storage costs
        cleanup_old_files()
    speaker_list: Optional[List[str]] = None
    if speaker_names:
        # Handle both comma-separated and JSON formats for backward compatibility
        speaker_names = speaker_names.strip()
        if speaker_names.startswith('[') and speaker_names.endswith(']'):
            # JSON format
            try:
                speaker_list = json.loads(speaker_names)
            except json.JSONDecodeError:
                raise HTTPException(status_code=400, detail="Invalid JSON format for speaker names")
        else:
            # Comma-separated format
            speaker_list = [name.strip() for name in speaker_names.split(',') if name.strip()]

    title_data = {
        "CASE_NAME": case_name,
        "CASE_NUMBER": case_number,
        "FIRM_OR_ORGANIZATION_NAME": firm_name,
        "DATE": input_date,
        "TIME": input_time,
        "LOCATION": location,
        "FILE_NAME": file.filename,
        "FILE_DURATION": "Calculating...",
    }

    # Convert checkbox value to boolean
    timestamps_enabled = include_timestamps == "on"
    
    # Upload media for editor playback
    media_blob_name = None
    media_content_type = file.content_type or mimetypes.guess_type(file.filename)[0]
    try:
        media_blob_name = upload_preview_file_to_cloud_storage(
            file_bytes,
            file.filename,
            media_content_type,
        )
    except Exception as e:
        logger.warning("Failed to store media preview for editor session: %s", e)
        media_blob_name = None
        media_content_type = None

    # Check cache first
    cache_key = create_cache_key(file_bytes, speaker_list)

    if cache_key in temp_transcript_cache:
        logger.info("Using cached AssemblyAI transcription")
        cached_result = temp_transcript_cache[cache_key]
        turns = cached_result["turns"]
        duration_seconds = cached_result.get("duration")
        logger.info(f"Used cached transcription with {len(turns)} turns.")
    else:
        # Generate new transcription
        logger.info("Starting new AssemblyAI transcription process...")
        try:
            turns, docx_bytes, duration_seconds = process_transcription(
                file_bytes,
                file.filename,
                speaker_list,
                title_data,
                timestamps_enabled,
            )

            # Cache the transcript results (not the docx, as that depends on timestamp setting)
            temp_transcript_cache[cache_key] = {
                "turns": turns,
                "duration": duration_seconds,
            }
            logger.info(f"Transcription completed and cached. Generated {len(turns)} turns.")
        except Exception as e:
            import traceback
            error_detail = f"Error: {str(e)}\nTraceback: {traceback.format_exc()}"
            logger.error(f"Transcription error: {error_detail}")
            raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

    docx_bytes, oncue_xml, transcript_text, line_payloads = build_session_artifacts(
        turns,
        title_data,
        duration_seconds or 0,
        timestamps_enabled,
        DEFAULT_LINES_PER_PAGE,
    )
    docx_b64 = base64.b64encode(docx_bytes).decode()
    oncue_b64 = base64.b64encode(oncue_xml.encode("utf-8")).decode()

    session_id = uuid.uuid4().hex
    created_at = datetime.now(timezone.utc)
    expires_at = created_at + timedelta(days=EDITOR_SESSION_TTL_DAYS)

    session_payload = {
        "session_id": session_id,
        "created_at": created_at.isoformat(),
        "expires_at": expires_at.isoformat(),
        "title_data": title_data,
        "audio_duration": float(duration_seconds or 0),
        "lines_per_page": DEFAULT_LINES_PER_PAGE,
        "include_timestamps": timestamps_enabled,
        "turns": serialize_transcript_turns(turns),
        "lines": line_payloads,
        "docx_base64": docx_b64,
        "oncue_xml_base64": oncue_b64,
        "transcript_text": transcript_text,
        "media_blob_name": media_blob_name,
        "media_content_type": media_content_type,
        "updated_at": created_at.isoformat(),
    }

    try:
        save_editor_session(session_id, session_payload)
    except Exception as e:
        logger.error("Failed to store editor session: %s", e)
        delete_editor_session(session_id)
        raise HTTPException(status_code=500, detail="Unable to persist editor session")

    response_data = {
        "transcript": transcript_text,
        "docx_base64": docx_b64,
        "oncue_xml_base64": oncue_b64,
        "editor_session_id": session_id,
        "include_timestamps": timestamps_enabled,
        "media_blob_name": media_blob_name,
        "media_content_type": media_content_type,
    }

    return JSONResponse(response_data)


@app.get("/api/transcripts/{session_id}")
async def get_editor_session(session_id: str):
    session_data = load_editor_session(session_id)
    if not session_data:
        raise HTTPException(status_code=404, detail="Editor session not found")
    if session_is_expired(session_data):
        delete_editor_session(session_id)
        raise HTTPException(status_code=404, detail="Editor session expired")

    return JSONResponse(build_session_response(session_data))


@app.get("/api/transcripts/latest")
async def get_latest_editor_session():
    session_data = load_latest_editor_session()
    if not session_data:
        raise HTTPException(status_code=404, detail="No editor sessions available")
    return JSONResponse(build_session_response(session_data))


@app.put("/api/transcripts/{session_id}")
async def update_editor_session(session_id: str, payload: Dict = Body(...)):
    session_data = load_editor_session(session_id)
    if not session_data:
        raise HTTPException(status_code=404, detail="Editor session not found")
    if session_is_expired(session_data):
        delete_editor_session(session_id)
        raise HTTPException(status_code=404, detail="Editor session expired")

    lines_payload = payload.get("lines")
    if not isinstance(lines_payload, list) or not lines_payload:
        raise HTTPException(status_code=400, detail="Lines payload is required")

    include_timestamps = payload.get("include_timestamps", session_data.get("include_timestamps", False))

    title_updates = payload.get("title_data") or {}
    current_title = dict(session_data.get("title_data") or {})
    current_title.update(title_updates)

    duration_seconds = float(session_data.get("audio_duration") or 0)
    lines_per_page = session_data.get("lines_per_page", DEFAULT_LINES_PER_PAGE)

    normalized_lines, duration_seconds = normalize_line_payloads(lines_payload, duration_seconds)
    turns = construct_turns_from_lines(normalized_lines, include_timestamps)

    if not turns:
        raise HTTPException(status_code=400, detail="No valid turns could be constructed from lines")

    docx_bytes, oncue_xml, transcript_text, updated_lines_payload = build_session_artifacts(
        turns,
        current_title,
        duration_seconds,
        include_timestamps,
        lines_per_page,
    )

    docx_b64 = base64.b64encode(docx_bytes).decode()
    oncue_b64 = base64.b64encode(oncue_xml.encode("utf-8")).decode()

    hours, rem = divmod(duration_seconds, 3600)
    minutes, seconds = divmod(rem, 60)
    current_title["FILE_DURATION"] = "{:0>2}:{:0>2}:{:0>2}".format(int(hours), int(minutes), int(round(seconds)))

    media_blob_name = payload.get("media_blob_name", session_data.get("media_blob_name"))
    media_content_type = payload.get("media_content_type", session_data.get("media_content_type"))

    updated_at = datetime.now(timezone.utc)

    session_data["turns"] = serialize_transcript_turns(turns)
    session_data["lines"] = updated_lines_payload
    session_data["title_data"] = current_title
    session_data["audio_duration"] = duration_seconds
    session_data["include_timestamps"] = include_timestamps
    session_data["docx_base64"] = docx_b64
    session_data["oncue_xml_base64"] = oncue_b64
    session_data["transcript_text"] = transcript_text
    session_data["media_blob_name"] = media_blob_name
    session_data["media_content_type"] = media_content_type
    session_data["updated_at"] = updated_at.isoformat()
    session_data["expires_at"] = (updated_at + timedelta(days=EDITOR_SESSION_TTL_DAYS)).isoformat()

    save_editor_session(session_id, session_data)

    response_payload = {
        "session_id": session_id,
        "lines": updated_lines_payload,
        "docx_base64": docx_b64,
        "oncue_xml_base64": oncue_b64,
        "transcript": transcript_text,
        "title_data": current_title,
        "include_timestamps": include_timestamps,
        "audio_duration": duration_seconds,
        "updated_at": session_data["updated_at"],
        "expires_at": session_data["expires_at"],
        "media_blob_name": media_blob_name,
        "media_content_type": media_content_type,
    }

    return JSONResponse(response_payload)


@app.post("/api/transcripts/import")
async def import_oncue_transcript(
    xml_file: UploadFile = File(...),
    media_file: Optional[UploadFile] = File(None),
    case_name: str = Form(""),
    case_number: str = Form(""),
    firm_name: str = Form(""),
    input_date: str = Form(""),
    input_time: str = Form(""),
    location: str = Form(""),
    include_timestamps: Optional[str] = Form(None),
):
    xml_bytes = await xml_file.read()
    if not xml_bytes:
        raise HTTPException(status_code=400, detail="Uploaded XML file is empty")

    xml_text = xml_bytes.decode("utf-8", errors="replace")
    parsed = parse_oncue_xml(xml_text)

    title_data = parsed["title_data"]
    overrides = {
        "CASE_NAME": case_name or title_data.get("CASE_NAME", ""),
        "CASE_NUMBER": case_number or title_data.get("CASE_NUMBER", ""),
        "FIRM_OR_ORGANIZATION_NAME": firm_name or title_data.get("FIRM_OR_ORGANIZATION_NAME", ""),
        "DATE": input_date or title_data.get("DATE", ""),
        "TIME": input_time or title_data.get("TIME", ""),
        "LOCATION": location or title_data.get("LOCATION", ""),
        "FILE_NAME": title_data.get("FILE_NAME") or xml_file.filename or "imported.xml",
    }
    title_data.update(overrides)

    duration_seconds = float(parsed["audio_duration"] or 0)
    lines_payload = parsed["lines"]
    include_ts = include_timestamps == "on" if include_timestamps is not None else True

    normalized_lines, duration_seconds = normalize_line_payloads(lines_payload, duration_seconds)
    turns = construct_turns_from_lines(normalized_lines, include_ts)
    if not turns:
        raise HTTPException(status_code=400, detail="Unable to construct transcript turns from XML")

    docx_bytes, oncue_xml, transcript_text, line_payloads = build_session_artifacts(
        turns,
        title_data,
        duration_seconds,
        include_ts,
        DEFAULT_LINES_PER_PAGE,
    )

    docx_b64 = base64.b64encode(docx_bytes).decode()
    oncue_b64 = base64.b64encode(oncue_xml.encode("utf-8")).decode()

    media_blob_name = None
    media_content_type = None
    if media_file:
        media_bytes = await media_file.read()
        if media_bytes:
            media_content_type = media_file.content_type or mimetypes.guess_type(media_file.filename)[0]
            try:
                media_blob_name = upload_preview_file_to_cloud_storage(
                    media_bytes,
                    media_file.filename,
                    media_content_type,
                )
            except Exception as e:
                logger.error("Failed to store media during import: %s", e)
                media_blob_name = None
                media_content_type = None

    session_id = uuid.uuid4().hex
    created_at = datetime.now(timezone.utc)
    expires_at = created_at + timedelta(days=EDITOR_SESSION_TTL_DAYS)

    session_payload = {
        "session_id": session_id,
        "created_at": created_at.isoformat(),
        "updated_at": created_at.isoformat(),
        "expires_at": expires_at.isoformat(),
        "title_data": title_data,
        "audio_duration": duration_seconds,
        "lines_per_page": DEFAULT_LINES_PER_PAGE,
        "include_timestamps": include_ts,
        "turns": serialize_transcript_turns(turns),
        "lines": line_payloads,
        "docx_base64": docx_b64,
        "oncue_xml_base64": oncue_b64,
        "transcript_text": transcript_text,
        "media_blob_name": media_blob_name,
        "media_content_type": media_content_type,
        "source": "import",
    }

    save_editor_session(session_id, session_payload)

    response_payload = build_session_response(session_payload)
    return JSONResponse(response_payload)

@app.post("/api/upload-preview")
async def upload_media_preview(file: UploadFile = File(...)):
    """Upload media file for preview purposes"""
    try:
        file_bytes = await file.read()
        content_type = file.content_type or mimetypes.guess_type(file.filename)[0]
        
        # Upload to Cloud Storage
        blob_name = upload_preview_file_to_cloud_storage(
            file_bytes, 
            file.filename, 
            content_type
        )
        
        logger.info(f"Uploaded media file for preview: {file.filename} ({len(file_bytes)} bytes)")
        
        return JSONResponse({
            "file_id": blob_name,
            "filename": file.filename,
            "size": len(file_bytes),
            "content_type": content_type
        })
        
    except Exception as e:
        logger.error(f"Media preview upload failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

@app.get("/api/media/{file_id}")
async def serve_media_file(file_id: str):
    """Serve media file for preview"""
    try:
        # Get file metadata
        metadata = get_blob_metadata(file_id)
        if not metadata:
            raise HTTPException(status_code=404, detail="Media file not found")
        
        # Download file from Cloud Storage
        file_bytes = download_from_cloud_storage(file_id)
        
        # Create streaming response for large files
        def generate():
            yield file_bytes
        
        return StreamingResponse(
            generate(),
            media_type=metadata['content_type'],
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(len(file_bytes)),
                "Cache-Control": "public, max-age=3600"
            }
        )
    except Exception as e:
        logger.error(f"Error serving media file {file_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error serving media file")

@app.get("/health")
async def health_check():
    """Health check endpoint for deployment platforms"""
    global last_cleanup_time
    
    # Run cleanup every 12 hours
    current_time = datetime.now()
    if current_time - last_cleanup_time > timedelta(hours=12):
        try:
            cleanup_old_files()
            cleanup_expired_editor_sessions()
            last_cleanup_time = current_time
            logger.info("Periodic cleanup completed via health check")
        except Exception as e:
            logger.error(f"Periodic cleanup failed: {str(e)}")
    
    return {
        "status": "healthy",
        "service": "TranscribeAlpha",
        "assemblyai_api_key_configured": bool(os.getenv("ASSEMBLYAI_API_KEY")),
        "last_cleanup": last_cleanup_time.isoformat()
    }

# Mount static files LAST so API routes take precedence
frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")

if __name__ == "__main__":
    # Cloud Run uses PORT environment variable, defaults to 8080
    port = int(os.getenv("PORT", 8080))
    host = os.getenv("HOST", "0.0.0.0")
    
    # Use Hypercorn for HTTP/2 support on Cloud Run
    import hypercorn.asyncio
    import hypercorn.config
    import asyncio
    
    config = hypercorn.config.Config()
    config.bind = [f"{host}:{port}"]
    config.application_path = "backend.server:app"
    
    # Enable HTTP/2 support
    config.h2 = True
    
    # Run the server
    asyncio.run(hypercorn.asyncio.serve(app, config))

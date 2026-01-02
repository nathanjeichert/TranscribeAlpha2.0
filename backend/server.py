import os
import json
import base64
import logging
import uuid
import tempfile
import io
import hashlib
import subprocess
import time
import re
import shutil
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Dict, Tuple, Any
import xml.etree.ElementTree as ET
from pydantic import BaseModel


# Pydantic models for Gemini structured output
class GeminiWordTiming(BaseModel):
    """Word-level timing from Gemini transcription"""
    word: str
    start: float
    end: float


class GeminiUtterance(BaseModel):
    """A single speaker utterance from Gemini transcription"""
    speaker: str
    text: str
    start: float
    end: float
    words: List[GeminiWordTiming]
from google.cloud import storage
from google.api_core import exceptions as gcs_exceptions

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body, Request, Depends
import anyio
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
        parse_docx_to_turns,
        ffmpeg_executable_path,
        convert_video_to_audio,
        get_media_duration,
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
            parse_docx_to_turns,
            ffmpeg_executable_path,
            convert_video_to_audio,
            get_media_duration,
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
        parse_docx_to_turns = transcriber.parse_docx_to_turns
        ffmpeg_executable_path = transcriber.ffmpeg_executable_path

# Import authentication module
try:
    from .auth import (
        authenticate_user,
        create_access_token,
        create_refresh_token,
        get_current_user,
        decode_token,
    )
except ImportError:
    try:
        from auth import (
            authenticate_user,
            create_access_token,
            create_refresh_token,
            get_current_user,
            decode_token,
        )
    except ImportError:
        import auth as auth_module
        authenticate_user = auth_module.authenticate_user
        create_access_token = auth_module.create_access_token
        create_refresh_token = auth_module.create_refresh_token
        get_current_user = auth_module.get_current_user
        decode_token = auth_module.decode_token

# Import Rev AI alignment module
try:
    from .rev_ai_sync import RevAIAligner
except ImportError:
    try:
        from rev_ai_sync import RevAIAligner
    except ImportError:
        import rev_ai_sync
        RevAIAligner = rev_ai_sync.RevAIAligner

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

# Default transcript layout configuration
DEFAULT_LINES_PER_PAGE = 25

# Track last cleanup time for periodic cleanup
last_cleanup_time = datetime.now()

EDITOR_SESSION_TTL_DAYS = int(os.getenv("EDITOR_SESSION_TTL_DAYS", "7"))

CLIP_SESSION_PREFIX = "clip_sessions/"
CLIP_SESSION_TTL_DAYS = int(os.getenv("CLIP_SESSION_TTL_DAYS", str(EDITOR_SESSION_TTL_DAYS)))

SNAPSHOT_PREFIX = "editor_snapshots/"
SNAPSHOT_TTL_DAYS = int(os.getenv("SNAPSHOT_TTL_DAYS", "14"))
SNAPSHOT_PER_SESSION_LIMIT = int(os.getenv("SNAPSHOT_PER_SESSION_LIMIT", "40"))
SNAPSHOT_PER_MEDIA_LIMIT = int(os.getenv("SNAPSHOT_PER_MEDIA_LIMIT", "10"))


def _clip_blob_name(clip_id: str) -> str:
    return f"{CLIP_SESSION_PREFIX}{clip_id}.json"


def _snapshot_blob_name(media_key: str, snapshot_id: str) -> str:
    return f"{SNAPSHOT_PREFIX}{media_key}/{snapshot_id}.json"


def _extract_media_key(data: dict) -> str:
    """Extract media key from session/payload data using priority chain.

    Priority: media_key field > title_data.MEDIA_ID > XML mediaId > filename > blob name > "unknown"
    """
    title_data = data.get("title_data") or {}

    # Direct media_key field
    if data.get("media_key"):
        return str(data["media_key"])

    # MEDIA_ID from title data
    if title_data.get("MEDIA_ID"):
        return str(title_data["MEDIA_ID"])

    # Try to extract from OnCue XML
    xml_filename = title_data.get("FILE_NAME") or title_data.get("CASE_NAME")
    media_id_from_xml = None
    xml_b64 = data.get("oncue_xml_base64")
    if xml_b64:
        try:
            xml_text = base64.b64decode(xml_b64).decode("utf-8", errors="replace")
            root = ET.fromstring(xml_text)
            deposition = root.find(".//deposition")
            if deposition is not None:
                media_id_from_xml = deposition.get("mediaId") or deposition.get("mediaID")
        except Exception:
            media_id_from_xml = None

    # Fallback chain
    key = media_id_from_xml or xml_filename or data.get("media_blob_name") or "unknown"
    return str(key)


def snapshot_media_key(session_data: dict) -> str:
    """Extract media key from session data. Wrapper for backwards compatibility."""
    return _extract_media_key(session_data)


def derive_media_key_from_payload(payload: dict) -> str:
    """Extract media key from payload data. Wrapper for backwards compatibility."""
    return _extract_media_key(payload)


def serialize_transcript_turns(turns: List[TranscriptTurn]) -> List[dict]:
    serialized: List[dict] = []
    for turn in turns:
        turn_dict = turn.model_dump()
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


# New media-key-based storage functions
def save_current_transcript(media_key: str, transcript_data: dict) -> None:
    """Save current working state for a transcript using media_key as identifier."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = f"transcripts/{media_key}/current.json"
        blob = bucket.blob(blob_name)

        # Set TTL metadata
        created_at = transcript_data.get("created_at", datetime.now(timezone.utc).isoformat())
        expires_at = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()

        blob.metadata = {
            "media_key": media_key,
            "created_at": created_at,
            "expires_at": expires_at,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "user_id": transcript_data.get("user_id"),
        }
        blob.upload_from_string(json.dumps(transcript_data), content_type="application/json")
        logger.info("Saved current transcript for media_key %s", media_key)
    except Exception as e:
        logger.error("Failed to save current transcript for %s: %s", media_key, e)
        raise


def load_current_transcript(media_key: str) -> Optional[dict]:
    """Load current working state, with fallback to latest snapshot."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)

        # Try loading current.json
        blob = bucket.blob(f"transcripts/{media_key}/current.json")
        if blob.exists():
            data = json.loads(blob.download_as_string())
            if not data.get("media_key"):
                data["media_key"] = media_key

            # Check expiration
            expires_at_str = blob.metadata.get("expires_at") if blob.metadata else None
            if expires_at_str:
                try:
                    expires_at = datetime.fromisoformat(expires_at_str.replace("Z", "+00:00"))
                    if datetime.now(timezone.utc) > expires_at:
                        # Expired, delete and fall through to history
                        blob.delete()
                        logger.info("Deleted expired current transcript for %s", media_key)
                    else:
                        return data
                except ValueError:
                    # If we can't parse expiration, return the data anyway
                    return data

        # Fallback: Load latest snapshot from history
        return load_latest_snapshot_for_media(media_key)

    except Exception as e:
        logger.error("Failed to load transcript for %s: %s", media_key, e)
        return None


def load_latest_snapshot_for_media(media_key: str, prefer_manual_save: bool = True) -> Optional[dict]:
    """Load most recent snapshot, prioritizing manual saves."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        prefix = f"transcripts/{media_key}/history/"
        blobs = list(bucket.list_blobs(prefix=prefix))

        if not blobs:
            return None

        # Separate manual saves from auto-saves
        manual_saves = []
        auto_saves = []

        for blob in blobs:
            try:
                data = json.loads(blob.download_as_string())
                if data.get("is_manual_save"):
                    manual_saves.append((blob.time_created, data))
                else:
                    auto_saves.append((blob.time_created, data))
            except Exception:
                continue

        # Return newest manual save if exists and preferred
        if prefer_manual_save and manual_saves:
            manual_saves.sort(key=lambda x: x[0], reverse=True)
            snapshot = manual_saves[0][1]
            if not snapshot.get("media_key"):
                snapshot["media_key"] = media_key
            return snapshot

        # Otherwise return newest overall
        all_snapshots = manual_saves + auto_saves
        if all_snapshots:
            all_snapshots.sort(key=lambda x: x[0], reverse=True)
            snapshot = all_snapshots[0][1]
            if not snapshot.get("media_key"):
                snapshot["media_key"] = media_key
            return snapshot

        return None

    except Exception as e:
        logger.error("Failed to load snapshot for %s: %s", media_key, e)
        return None


def list_all_transcripts(user_id: str) -> List[dict]:
    """List all transcripts for a user, grouped by media_key."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        prefix = "transcripts/"

        # Find all current.json files
        transcripts = []
        for blob in bucket.list_blobs(prefix=prefix):
            if blob.name.endswith("/current.json"):
                try:
                    data = json.loads(blob.download_as_string())

                    # Check user_id from JSON content (blob.metadata isn't populated by list_blobs)
                    if data.get("user_id") != user_id:
                        continue

                    media_key = blob.name.split("/")[1]  # Extract from path

                    title_data = data.get("title_data", {})
                    transcripts.append({
                        "media_key": media_key,
                        "title_label": title_data.get("CASE_NAME") or title_data.get("FILE_NAME") or media_key,
                        "updated_at": blob.updated.isoformat() if blob.updated else None,
                        "line_count": len(data.get("lines", [])),
                    })
                except Exception:
                    continue

        return sorted(transcripts, key=lambda x: x["updated_at"] or "", reverse=True)

    except Exception as e:
        logger.error("Failed to list transcripts: %s", e)
        return []


def save_clip_session(clip_id: str, clip_data: dict) -> None:
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(_clip_blob_name(clip_id))
        blob.metadata = {
            "clip_id": clip_id,
            "parent_media_key": clip_data.get("parent_media_key"),
            "created_at": clip_data.get("created_at"),
            "expires_at": clip_data.get("expires_at"),
        }
        blob.upload_from_string(json.dumps(clip_data), content_type="application/json")
        logger.info("Saved clip session %s", clip_id)
    except Exception as exc:
        logger.error("Failed to save clip session %s: %s", clip_id, exc)
        raise


def load_clip_session(clip_id: str) -> Optional[dict]:
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(_clip_blob_name(clip_id))
        if not blob.exists():
            return None
        return json.loads(blob.download_as_text())
    except Exception as exc:
        logger.error("Failed to load clip session %s: %s", clip_id, exc)
        return None


def delete_clip_session(clip_id: str) -> None:
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(_clip_blob_name(clip_id))
        if blob.exists():
            blob.delete()
            logger.info("Deleted clip session %s", clip_id)
    except Exception as exc:
        logger.error("Failed to delete clip session %s: %s", clip_id, exc)


def save_snapshot(media_key: str, snapshot_id: str, snapshot_data: dict) -> None:
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = _snapshot_blob_name(media_key, snapshot_id)
        blob = bucket.blob(blob_name)
        blob.metadata = {
            "snapshot_id": snapshot_id,
            "media_key": media_key,
            "created_at": snapshot_data.get("created_at"),
            "saved": str(snapshot_data.get("saved", False)),
            "line_count": str(snapshot_data.get("line_count", "")),
            "title_label": snapshot_data.get("title_label", ""),
        }
        blob.upload_from_string(json.dumps(snapshot_data), content_type="application/json")
        logger.info("Saved snapshot %s for media key %s", snapshot_id, media_key)
    except Exception as exc:
        logger.error("Failed to save snapshot %s for media key %s: %s", snapshot_id, media_key, exc)
        raise


def load_snapshot(media_key: str, snapshot_id: str) -> Optional[dict]:
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(_snapshot_blob_name(media_key, snapshot_id))
        if not blob.exists():
            return None
        raw = blob.download_as_text()
        return json.loads(raw)
    except Exception as exc:
        logger.error("Failed to load snapshot %s for media key %s: %s", snapshot_id, media_key, exc)
        return None


def list_snapshots_for_media(media_key: str) -> List[dict]:
    bucket = storage_client.bucket(BUCKET_NAME)
    prefix = f"{SNAPSHOT_PREFIX}{media_key}/"
    items: List[dict] = []
    try:
        for blob in bucket.list_blobs(prefix=prefix):
            try:
                metadata = blob.metadata or {}
                created_at = metadata.get("created_at") or blob.time_created.isoformat()
                item = {
                    "snapshot_id": metadata.get("snapshot_id") or os.path.splitext(os.path.basename(blob.name))[0],
                    "session_id": metadata.get("session_id"),
                    "media_key": metadata.get("media_key") or media_key,
                    "created_at": created_at,
                    "size": blob.size,
                    "saved": metadata.get("saved") == "True" or metadata.get("saved") is True,
                    "line_count": int(metadata.get("line_count") or 0),
                    "title_label": metadata.get("title_label") or "",
                }
                if not item["media_key"] or item["media_key"] == "unknown" or not item["title_label"]:
                    try:
                        payload = json.loads(blob.download_as_text())
                        item["media_key"] = derive_media_key_from_payload(payload)
                        if not item["title_label"]:
                            t = payload.get("title_data") or {}
                            item["title_label"] = t.get("CASE_NAME") or t.get("FILE_NAME") or ""
                        if not item["line_count"]:
                            item["line_count"] = len(payload.get("lines") or [])
                    except Exception:
                        pass
                items.append(item)
            except Exception:
                continue
    except Exception as exc:
        logger.error("Failed to list snapshots for media key %s: %s", media_key, exc)
    # Sort newest first
    items.sort(key=lambda itm: itm.get("created_at") or "", reverse=True)
    return items


def prune_snapshots(media_key: str) -> None:
    """Prune snapshots to keep newest 10, preserving newest manual save."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        limit = 10

        # Support both old and new storage paths during migration
        old_prefix = f"{SNAPSHOT_PREFIX}{media_key}/"
        new_prefix = f"transcripts/{media_key}/history/"

        blobs = list(bucket.list_blobs(prefix=new_prefix))
        if not blobs:
            # Fallback to old path for backwards compatibility
            blobs = list(bucket.list_blobs(prefix=old_prefix))

        # Phase 1: Delete expired snapshots (14+ days old)
        cutoff = datetime.now(timezone.utc) - timedelta(days=SNAPSHOT_TTL_DAYS)
        for blob in blobs[:]:
            if blob.time_created and blob.time_created < cutoff:
                try:
                    blob.delete()
                    blobs.remove(blob)
                except Exception:
                    logger.warning("Failed to delete expired snapshot %s", blob.name)

        # Phase 2: Enforce per-media limit (10 snapshots)
        if len(blobs) <= limit:
            return

        # Load all snapshot data to check is_manual_save flag
        snapshot_info = []
        for blob in blobs:
            try:
                data = json.loads(blob.download_as_string())
                # Support both old 'saved' flag and new 'is_manual_save' flag
                is_manual = data.get("is_manual_save", data.get("saved", False))
                snapshot_info.append({
                    "blob": blob,
                    "created_at": blob.time_created,
                    "is_manual_save": is_manual,
                })
            except Exception:
                continue

        # Sort by creation time (newest first)
        snapshot_info.sort(key=lambda x: x["created_at"] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)

        # Find newest manual save
        newest_manual_save = next(
            (s for s in snapshot_info if s["is_manual_save"]),
            None
        )

        # Keep newest N snapshots
        to_keep = snapshot_info[:limit]

        # Ensure newest manual save is included
        if newest_manual_save and newest_manual_save not in to_keep:
            # Replace oldest kept snapshot with the manual save
            to_keep[-1] = newest_manual_save

        # Deduplicate and sort keep list again newest first
        keep_blob_names = []
        deduped_keep = []
        for item in to_keep:
            name = item["blob"].name
            if name in keep_blob_names:
                continue
            keep_blob_names.append(name)
            deduped_keep.append(item)
        deduped_keep.sort(key=lambda x: x["created_at"] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)

        # Delete everything not in to_keep
        keep_names_set = {s["blob"].name for s in deduped_keep}
        for s in snapshot_info:
            if s["blob"].name not in keep_names_set:
                try:
                    s["blob"].delete()
                except Exception:
                    logger.warning("Failed to delete excess snapshot %s", s["blob"].name)

    except Exception as exc:
        logger.error("Snapshot pruning failed for %s: %s", media_key, exc)


def cleanup_expired_clip_sessions():
    """Delete stored clip sessions whose TTL has expired."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        now = datetime.now(timezone.utc)
        for blob in bucket.list_blobs(prefix=CLIP_SESSION_PREFIX):
            try:
                raw = blob.download_as_text()
                clip_data = json.loads(raw)
            except Exception:
                continue

            expires_at = clip_data.get("expires_at")
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
                try:
                    blob.delete()
                except Exception:
                    logger.warning("Failed to delete expired clip session %s", blob.name)
    except Exception as exc:
        logger.error("Error during clip session cleanup: %s", exc)

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


def format_transcript_text(turns: List[TranscriptTurn]) -> str:
    return "\n\n".join(
        [
            f"{(turn.timestamp + ' ') if turn.timestamp else ''}{turn.speaker.upper()}:\t\t{turn.text}"
            for turn in turns
        ]
    )


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
    lines_per_page: int,
):
    docx_bytes = create_docx(title_data, turns)
    oncue_xml = generate_oncue_xml(turns, title_data, duration_seconds, lines_per_page)
    line_entries, _ = compute_transcript_line_entries(turns, duration_seconds, lines_per_page)
    transcript_text = format_transcript_text(turns)
    return docx_bytes, oncue_xml, transcript_text, serialize_line_entries(line_entries)


def ensure_session_clip_list(session_data: dict) -> List[dict]:
    clips = session_data.get("clips")
    if isinstance(clips, list):
        return clips
    session_data["clips"] = []
    return session_data["clips"]


def parse_timecode_to_seconds(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped:
        return None
    try:
        if ":" not in stripped:
            return float(stripped)
        parts = stripped.split(":")
        seconds = 0.0
        multiplier = 1.0
        for component in reversed(parts):
            component = component.strip()
            if not component:
                return None
            seconds += float(component) * multiplier
            multiplier *= 60.0
        return seconds
    except ValueError:
        return None


def parse_pgln(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def find_line_index_by_id(lines: List[dict], line_id: Any) -> Optional[int]:
    if line_id is None:
        return None
    target = str(line_id)
    for idx, line in enumerate(lines):
        if str(line.get("id")) == target:
            return idx
    return None


def find_line_index_by_pgln(lines: List[dict], pgln: Optional[int]) -> Optional[int]:
    if pgln is None:
        return None
    for idx, line in enumerate(lines):
        line_pgln = line.get("pgln")
        try:
            if line_pgln is not None and int(line_pgln) == int(pgln):
                return idx
        except (TypeError, ValueError):
            continue
    return None


def find_line_index_by_time(
    lines: List[dict],
    time_seconds: Optional[float],
    prefer_start: bool,
) -> Optional[int]:
    if time_seconds is None or not lines:
        return None

    if prefer_start:
        for idx, line in enumerate(lines):
            start = float(line.get("start", 0.0))
            end = float(line.get("end", start))
            if time_seconds <= start:
                return idx
            if start <= time_seconds <= max(end, start):
                return idx
        return len(lines) - 1

    for reverse_idx in range(len(lines) - 1, -1, -1):
        line = lines[reverse_idx]
        start = float(line.get("start", 0.0))
        end = float(line.get("end", start))
        if time_seconds >= end:
            return reverse_idx
        if start <= time_seconds <= max(end, start):
            return reverse_idx
    return 0


def resolve_line_index(
    lines: List[dict],
    *,
    line_id: Any = None,
    pgln: Any = None,
    time_seconds: Optional[float] = None,
    prefer_start: bool,
) -> Optional[int]:
    candidate = find_line_index_by_id(lines, line_id)
    if candidate is not None:
        return candidate

    candidate = find_line_index_by_pgln(lines, parse_pgln(pgln))
    if candidate is not None:
        return candidate

    candidate = find_line_index_by_time(lines, time_seconds, prefer_start)
    if candidate is not None:
        return candidate

    return None


def sanitize_clip_label(label: Optional[str], default_name: str) -> str:
    if not label:
        return default_name
    cleaned = str(label).strip()
    if not cleaned:
        return default_name
    # Collapse whitespace and limit length for storage
    cleaned = re.sub(r"\s+", " ", cleaned)
    if len(cleaned) > 120:
        cleaned = cleaned[:120].rstrip()
    return cleaned


def get_ffmpeg_binary() -> str:
    if ffmpeg_executable_path and shutil.which(ffmpeg_executable_path):
        return ffmpeg_executable_path
    fallback = shutil.which("ffmpeg")
    if fallback:
        return fallback
    raise HTTPException(status_code=500, detail="FFmpeg binary not available on server")


def slugify_filename(name: str, default: str = "clip") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", name.strip()) if name else ""
    cleaned = cleaned.strip("-._")
    return cleaned or default


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

        normalized_line = {
            "id": line.get("id") or f"{idx}",
            "speaker": speaker_name.upper(),
            "text": text_value,
            "start": start_val,
            "end": end_val,
            "is_continuation": bool(line.get("is_continuation", False)),
        }

        # Pass through word-level timestamps if present
        if "words" in line and isinstance(line["words"], list):
            normalized_line["words"] = line["words"]

        normalized_lines.append(normalized_line)

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


def construct_turns_from_lines(normalized_lines: List[dict]) -> List[TranscriptTurn]:
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
        timestamp_str = seconds_to_timestamp(current_start) if current_start is not None else None
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

        # Word-level timestamps: AssemblyAI and Gemini (with structured output) always provide these.
        # OnCue XML imports only have line-level timing, so we interpolate for compatibility.
        # The Re-sync feature can replace interpolated data with real aligned timestamps.
        line_words = line.get("words")
        if isinstance(line_words, list) and len(line_words) > 0:
            # Use real word-level timestamps from transcription engine
            for word_data in line_words:
                if not isinstance(word_data, dict):
                    continue
                word_text = str(word_data.get("text", "")).strip()
                if not word_text:
                    continue
                word_start = float(word_data.get("start", 0.0))
                word_end = float(word_data.get("end", word_start))
                current_words.append(
                    WordTimestamp(
                        text=word_text,
                        start=word_start * 1000.0,  # convert to milliseconds
                        end=max(word_end * 1000.0, word_start * 1000.0),
                        confidence=None,
                        speaker=speaker,
                    )
                )
        else:
            # Fallback for OnCue XML imports: interpolate word timestamps from line timing.
            # These are estimates only - use Re-sync to get accurate timestamps.
            tokens = [tok for tok in text_val.split() if tok]
            if not tokens:
                continue
            line_duration = max(end_val - start_val, 0.01)
            word_count = len(tokens)
            for word_idx, token in enumerate(tokens):
                token_start = start_val + (line_duration * word_idx / word_count)
                token_end = start_val + (line_duration * (word_idx + 1) / word_count) if word_idx < word_count - 1 else end_val
                current_words.append(
                    WordTimestamp(
                        text=token,
                        start=token_start * 1000.0,
                        end=token_end * 1000.0,
                        confidence=None,
                        speaker=speaker,
                    )
                )

    flush_turn()
    return turns


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


def build_snapshot_payload(session_data: dict, lines_override: Optional[List[dict]] = None, title_override: Optional[dict] = None, is_manual_save: bool = False) -> dict:
    """Create a snapshot payload with XML + lines + media references."""
    xml_b64 = session_data.get("oncue_xml_base64")
    title_data = title_override or session_data.get("title_data") or {}
    lines_per_page = session_data.get("lines_per_page", DEFAULT_LINES_PER_PAGE)
    audio_duration = float(session_data.get("audio_duration") or 0.0)
    source_lines = lines_override if lines_override is not None else session_data.get("lines") or []

    # CRITICAL FIX: Always include media references for playback recovery
    media_blob_name = session_data.get("media_blob_name")
    media_content_type = session_data.get("media_content_type")

    if not xml_b64:
        # Rebuild XML from lines as a fallback
        normalized_lines, audio_duration = normalize_line_payloads(source_lines, audio_duration)
        turns = construct_turns_from_lines(normalized_lines)
        if not turns:
            raise HTTPException(status_code=400, detail="Unable to build snapshot XML from transcript lines")
        _, oncue_xml, _, updated_lines = build_session_artifacts(
            turns,
            title_data,
            audio_duration,
            lines_per_page,
        )
        xml_b64 = base64.b64encode(oncue_xml.encode("utf-8")).decode()
        source_lines = updated_lines

    created_at = datetime.now(timezone.utc).isoformat()
    return {
        "media_key": snapshot_media_key(session_data),
        "created_at": created_at,
        "title_data": title_data,
        "title_label": title_data.get("CASE_NAME") or title_data.get("FILE_NAME") or "",
        "audio_duration": audio_duration,
        "lines_per_page": lines_per_page,
        "lines": source_lines,
        "oncue_xml_base64": xml_b64,
        "line_count": len(source_lines),
        "is_manual_save": is_manual_save,
        "user_id": session_data.get("user_id"),
        # CRITICAL: Include media references for playback recovery
        "media_blob_name": media_blob_name,
        "media_content_type": media_content_type,
    }


def prepare_audio_for_gemini(blob_name: str, content_type: Optional[str]) -> Tuple[str, str, float, str]:
    """Download media, convert to audio if needed, and return (audio_path, mime_type, duration, original_path)."""
    media_path, detected_type = download_blob_to_path(blob_name)
    try:
        if os.path.getsize(media_path) <= 0:
            raise HTTPException(status_code=400, detail="Downloaded media file is empty")
    except OSError:
        raise HTTPException(status_code=500, detail="Unable to access downloaded media file")
    audio_path = media_path
    source_mime = (detected_type or content_type or "").lower().strip()
    if not source_mime:
        source_mime = (mimetypes.guess_type(media_path)[0] or "").lower().strip()

    def canonicalize_audio_mime(mime_value: str, file_path: str) -> str:
        mime_value = (mime_value or "").lower().strip()
        if mime_value in {"audio/mp3", "audio/mpeg", "audio/x-mp3", "audio/mpeg3"}:
            return "audio/mpeg"
        if mime_value in {"audio/x-wav"}:
            return "audio/wav"
        guessed = (mimetypes.guess_type(file_path)[0] or "").lower().strip()
        if guessed in {"audio/mpeg", "audio/mp3", "audio/x-mp3", "audio/mpeg3"}:
            return "audio/mpeg"
        if guessed == "audio/x-wav":
            return "audio/wav"
        return mime_value or guessed or "application/octet-stream"

    supported_audio_mimes = {
        "audio/mpeg",
        "audio/wav",
        "audio/aac",
        "audio/ogg",
        "audio/flac",
        "audio/mp4",
        "audio/aiff",
    }

    audio_mime = canonicalize_audio_mime(source_mime, media_path)
    needs_conversion = (source_mime.startswith("video/") or audio_mime not in supported_audio_mimes)
    if needs_conversion:
        ffmpeg_bin = get_ffmpeg_binary()
        temp_audio = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3")
        temp_audio.close()
        command = [
            ffmpeg_bin,
            "-y",
            "-i",
            media_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "96k",
            temp_audio.name,
        ]
        process = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if process.returncode != 0 or not os.path.exists(temp_audio.name):
            stderr = process.stderr.decode("utf-8", errors="ignore")
            logger.error("FFmpeg audio conversion failed: %s", stderr)
            try:
                os.remove(temp_audio.name)
            except OSError:
                pass
            raise HTTPException(status_code=500, detail="Failed to prepare audio for Gemini")
        audio_path = temp_audio.name
        audio_mime = "audio/mpeg"
    else:
        audio_mime = canonicalize_audio_mime(audio_mime, media_path)

    max_upload_bytes = int(os.getenv("GEMINI_MAX_UPLOAD_BYTES", str(1024 * 1024 * 1024)))  # 1 GiB default
    try:
        audio_size = os.path.getsize(audio_path)
    except OSError:
        audio_size = None
    if audio_size is not None and max_upload_bytes > 0 and audio_size > max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Audio is too large for Gemini refinement ({audio_size} bytes > {max_upload_bytes} bytes)",
        )

    duration_seconds = get_media_duration(audio_path) or 0.0
    return audio_path, audio_mime, duration_seconds, media_path


def run_gemini_edit(xml_text: str, audio_path: str, audio_mime: str, duration_hint: float) -> List[dict]:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if api_key:
        api_key = api_key.strip()
        if (api_key.startswith('"') and api_key.endswith('"')) or (api_key.startswith("'") and api_key.endswith("'")):
            api_key = api_key[1:-1].strip()
        if api_key in {"your-gemini-key-here", "YOUR_GEMINI_KEY_HERE"}:
            raise HTTPException(
                status_code=500,
                detail="GEMINI_API_KEY is still set to the placeholder value; update your Cloud Run env var or Cloud Build trigger substitution _GEMINI_API_KEY.",
            )
    if not api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not configured")

    try:
        from google import genai
        from google.genai import types as genai_types
    except Exception as exc:
        logger.error("google-genai not available: %s", exc)
        raise HTTPException(status_code=500, detail="Gemini client library not installed") from exc

    model_name = os.getenv("GEMINI_MODEL_NAME", "gemini-3-pro-preview").strip()
    if not model_name:
        model_name = "gemini-3-pro-preview"

    instructions = (
        "You are improving an OnCue-style legal transcript. "
        "Use the provided XML transcript and the audio to correct ONLY: wording errors, punctuation, capitalization, and speaker labels. "
        "CRITICAL: You MUST preserve the EXACT start and end timestamps from the original - do NOT modify timing values. "
        "Keep the same number of lines and line order. Only fix text content and speaker names."
    )

    # Schema for polish output - enforces structure, timestamps come from original
    polish_schema = {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "speaker": {"type": "string"},
                "text": {"type": "string"},
                "start": {"type": "number"},
                "end": {"type": "number"},
            },
            "required": ["speaker", "text", "start", "end"],
        },
    }

    def wait_for_file_active(client: Any, file_name: str, *, timeout_seconds: int = 120) -> Any:
        deadline = time.time() + max(5, timeout_seconds)
        last_state = None
        while time.time() < deadline:
            fetched = client.files.get(name=file_name)
            state = getattr(fetched, "state", None)
            if state != last_state:
                logger.info("Gemini file %s state=%s", file_name, state)
                last_state = state
            if state == genai_types.FileState.ACTIVE:
                return fetched
            if state == genai_types.FileState.FAILED:
                err = getattr(fetched, "error", None)
                raise RuntimeError(f"Gemini file processing failed: {err}")
            time.sleep(2.0)
        raise TimeoutError("Timed out waiting for Gemini file to become ACTIVE")

    client = None
    uploaded = None
    try:
        client = genai.Client(
            api_key=api_key,
            http_options=genai_types.HttpOptions(timeout=600_000),
        )
        upload_config = genai_types.UploadFileConfig(
            mime_type=audio_mime,
            display_name=os.path.basename(audio_path),
        )
        try:
            uploaded = client.files.upload(file=audio_path, config=upload_config)
        except Exception as exc:
            logger.exception("Failed to upload media to Gemini")
            exc_text = str(exc)
            if "API_KEY_INVALID" in exc_text or "API key not valid" in exc_text:
                logger.error("Gemini rejected API key (len=%s). Check for quotes/whitespace and correct key source.", len(api_key or ""))
            raise HTTPException(
                status_code=502,
                detail=(
                    "Uploading media to Gemini failed. "
                    "If this is an API key error, ensure `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) is set without quotes/whitespace "
                    "and is a valid Gemini Developer API key. "
                    f"({type(exc).__name__}: {exc})"
                ),
            ) from exc
        wait_timeout = int(os.getenv("GEMINI_FILE_ACTIVE_TIMEOUT_SECONDS", "120"))
        try:
            uploaded = wait_for_file_active(client, uploaded.name, timeout_seconds=wait_timeout)
        except Exception as exc:
            logger.exception("Uploaded file did not become ACTIVE")
            raise HTTPException(
                status_code=502,
                detail=f"Gemini file processing failed ({type(exc).__name__}: {exc})",
            ) from exc

        try:
            response = client.models.generate_content(
                model=model_name,
                contents=[
                    genai_types.Part.from_text(text=instructions),
                    genai_types.Part.from_text(
                        text=f"Total duration (seconds): {duration_hint:.2f}. Existing XML transcript follows:\n{xml_text}"
                    ),
                    genai_types.Part.from_uri(
                        file_uri=uploaded.uri,
                        mime_type=uploaded.mime_type or audio_mime,
                    ),
                ],
                config=genai_types.GenerateContentConfig(
                    temperature=0.15,
                    response_mime_type="application/json",
                    response_json_schema=polish_schema,
                    thinking_config=genai_types.ThinkingConfig(thinking_level="low"),
                ),
            )
        except Exception as exc:
            logger.exception("Gemini generation failed")
            raise HTTPException(
                status_code=502,
                detail=f"Gemini transcript refinement failed ({type(exc).__name__}: {exc})",
            ) from exc
    finally:
        if client and uploaded:
            try:
                client.files.delete(name=uploaded.name)
            except Exception:
                pass
        if client:
            try:
                client.close()
            except Exception:
                pass

    raw_text = getattr(response, "text", None) or getattr(response, "output_text", None)
    if not raw_text and getattr(response, "candidates", None):
        try:
            raw_text = response.candidates[0].content.parts[0].text
        except Exception:
            raw_text = None

    if not raw_text:
        logger.error("Gemini response missing text payload")
        raise HTTPException(status_code=502, detail="Gemini returned an empty response")

    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        logger.error("Failed to parse Gemini JSON: %s", exc)
        raise HTTPException(status_code=502, detail="Gemini returned invalid JSON") from exc

    if not isinstance(parsed, list):
        raise HTTPException(status_code=502, detail="Gemini response must be a list of line objects")

    normalized = []
    for idx, item in enumerate(parsed):
        if not isinstance(item, dict):
            continue
        speaker = str(item.get("speaker", "")).strip() or f"SPEAKER {idx + 1}"
        text = str(item.get("text", "")).strip()
        start_val = float(item.get("start", 0.0))
        end_val = float(item.get("end", start_val))
        normalized.append(
            {
                "id": item.get("id") or f"gem-{idx}",
                "speaker": speaker.upper(),
                "text": text,
                "start": max(start_val, 0.0),
                "end": max(end_val, start_val),
                "is_continuation": False,
            }
        )

    if not normalized:
        raise HTTPException(status_code=502, detail="Gemini did not return any transcript lines")

    logger.info("Gemini polish completed with %d lines", len(normalized))
    return normalized


def transcribe_with_gemini(
    audio_path: str,
    audio_mime: str,
    duration_hint: float,
    speaker_name_list: Optional[List[str]] = None,
) -> List[dict]:
    """
    Transcribe audio using Gemini 3.0 Pro with thinking_level="low".

    Args:
        audio_path: Path to the audio file
        audio_mime: MIME type of the audio
        duration_hint: Approximate duration in seconds
        speaker_name_list: Optional list of speaker names to use

    Returns:
        List of transcript line objects with speaker, text, start, end fields
    """
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if api_key:
        api_key = api_key.strip()
        if (api_key.startswith('"') and api_key.endswith('"')) or (api_key.startswith("'") and api_key.endswith("'")):
            api_key = api_key[1:-1].strip()
        if api_key in {"your-gemini-key-here", "YOUR_GEMINI_KEY_HERE"}:
            raise HTTPException(
                status_code=500,
                detail="GEMINI_API_KEY is still set to the placeholder value; update your Cloud Run env var.",
            )
    if not api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not configured")

    try:
        from google import genai
        from google.genai import types as genai_types
    except Exception as exc:
        logger.error("google-genai not available: %s", exc)
        raise HTTPException(status_code=500, detail="Gemini client library not installed") from exc

    model_name = os.getenv("GEMINI_MODEL_NAME", "gemini-3-pro-preview").strip()
    if not model_name:
        model_name = "gemini-3-pro-preview"

    # Build speaker instructions
    speaker_instructions = ""
    if speaker_name_list and len(speaker_name_list) > 0:
        speaker_instructions = (
            f"Use these speaker names in order of appearance: {', '.join(speaker_name_list)}. "
            f"Expected number of speakers: {len(speaker_name_list)}. "
        )
    else:
        speaker_instructions = (
            "Identify and label distinct speakers as SPEAKER A, SPEAKER B, SPEAKER C, etc. "
        )

    instructions = (
        "You are a professional legal transcriptionist. "
        "Transcribe the provided audio file into a legal transcript format with precise WORD-LEVEL timestamps. "
        f"{speaker_instructions}"
        "Each utterance must include the 'words' array with timing for EVERY word in the text. "
        "Ensure proper punctuation and capitalization. "
        "All timestamps should be accurate in seconds, with start < end, entries non-overlapping and chronological."
    )

    def wait_for_file_active(client: Any, file_name: str, *, timeout_seconds: int = 120) -> Any:
        deadline = time.time() + max(5, timeout_seconds)
        last_state = None
        while time.time() < deadline:
            fetched = client.files.get(name=file_name)
            state = getattr(fetched, "state", None)
            if state != last_state:
                logger.info("Gemini file %s state=%s", file_name, state)
                last_state = state
            if state == genai_types.FileState.ACTIVE:
                return fetched
            if state == genai_types.FileState.FAILED:
                err = getattr(fetched, "error", None)
                raise RuntimeError(f"Gemini file processing failed: {err}")
            time.sleep(2.0)
        raise TimeoutError("Timed out waiting for Gemini file to become ACTIVE")

    client = None
    uploaded = None
    try:
        client = genai.Client(
            api_key=api_key,
            http_options=genai_types.HttpOptions(timeout=600_000),
        )
        upload_config = genai_types.UploadFileConfig(
            mime_type=audio_mime,
            display_name=os.path.basename(audio_path),
        )
        try:
            uploaded = client.files.upload(file=audio_path, config=upload_config)
        except Exception as exc:
            logger.exception("Failed to upload media to Gemini")
            exc_text = str(exc)
            if "API_KEY_INVALID" in exc_text or "API key not valid" in exc_text:
                logger.error("Gemini rejected API key (len=%s). Check for quotes/whitespace.", len(api_key or ""))
            raise HTTPException(
                status_code=502,
                detail=(
                    "Uploading media to Gemini failed. "
                    f"({type(exc).__name__}: {exc})"
                ),
            ) from exc

        wait_timeout = int(os.getenv("GEMINI_FILE_ACTIVE_TIMEOUT_SECONDS", "120"))
        try:
            uploaded = wait_for_file_active(client, uploaded.name, timeout_seconds=wait_timeout)
        except Exception as exc:
            logger.exception("Uploaded file did not become ACTIVE")
            raise HTTPException(
                status_code=502,
                detail=f"Gemini file processing failed ({type(exc).__name__}: {exc})",
            ) from exc

        # Build the JSON schema for structured output
        # Using the Pydantic model's schema to enforce word-level timestamps
        utterance_schema = {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "speaker": {"type": "string"},
                    "text": {"type": "string"},
                    "start": {"type": "number"},
                    "end": {"type": "number"},
                    "words": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "word": {"type": "string"},
                                "start": {"type": "number"},
                                "end": {"type": "number"},
                            },
                            "required": ["word", "start", "end"],
                        },
                    },
                },
                "required": ["speaker", "text", "start", "end", "words"],
            },
        }

        try:
            response = client.models.generate_content(
                model=model_name,
                contents=[
                    genai_types.Part.from_text(text=instructions),
                    genai_types.Part.from_text(
                        text=f"Total audio duration (seconds): {duration_hint:.2f}. Please transcribe the following audio:"
                    ),
                    genai_types.Part.from_uri(
                        file_uri=uploaded.uri,
                        mime_type=uploaded.mime_type or audio_mime,
                    ),
                ],
                config=genai_types.GenerateContentConfig(
                    temperature=0.15,
                    response_mime_type="application/json",
                    response_json_schema=utterance_schema,
                    thinking_config=genai_types.ThinkingConfig(thinking_level="low"),
                ),
            )
        except Exception as exc:
            logger.exception("Gemini transcription failed")
            raise HTTPException(
                status_code=502,
                detail=f"Gemini transcription failed ({type(exc).__name__}: {exc})",
            ) from exc
    finally:
        if client and uploaded:
            try:
                client.files.delete(name=uploaded.name)
            except Exception:
                pass
        if client:
            try:
                client.close()
            except Exception:
                pass

    raw_text = getattr(response, "text", None) or getattr(response, "output_text", None)
    if not raw_text and getattr(response, "candidates", None):
        try:
            raw_text = response.candidates[0].content.parts[0].text
        except Exception:
            raw_text = None

    if not raw_text:
        logger.error("Gemini response missing text payload")
        raise HTTPException(status_code=502, detail="Gemini returned an empty response")

    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        logger.error("Failed to parse Gemini JSON: %s", exc)
        raise HTTPException(status_code=502, detail="Gemini returned invalid JSON") from exc

    if not isinstance(parsed, list):
        raise HTTPException(status_code=502, detail="Gemini response must be a list of utterance objects")

    # Map speaker names if provided
    speaker_mapping = {}
    if speaker_name_list:
        for i, name in enumerate(speaker_name_list):
            speaker_mapping[f"SPEAKER {chr(ord('A') + i)}"] = name.upper()
            speaker_mapping[chr(ord('A') + i)] = name.upper()

    normalized = []
    for idx, item in enumerate(parsed):
        if not isinstance(item, dict):
            logger.warning("Skipping non-dict item at index %d", idx)
            continue

        speaker = str(item.get("speaker", "")).strip().upper() or f"SPEAKER {chr(ord('A') + idx)}"

        # Apply speaker mapping if available
        if speaker in speaker_mapping:
            speaker = speaker_mapping[speaker]

        text = str(item.get("text", "")).strip()
        start_val = float(item.get("start", 0.0))
        end_val = float(item.get("end", start_val))

        # Extract word-level timestamps (guaranteed by schema)
        raw_words = item.get("words", [])
        if not raw_words:
            logger.warning("Utterance at index %d missing words array", idx)

        words_data = []
        for word_item in raw_words:
            word_text = str(word_item.get("word", "")).strip()
            if not word_text:
                continue
            word_start = float(word_item.get("start", 0.0))
            word_end = float(word_item.get("end", word_start))
            words_data.append({
                "text": word_text,
                "start": max(word_start, 0.0),
                "end": max(word_end, word_start),
                "speaker": speaker,
            })

        line_data = {
            "id": item.get("id") or f"gem-{idx}",
            "speaker": speaker,
            "text": text,
            "start": max(start_val, 0.0),
            "end": max(end_val, start_val),
            "is_continuation": False,
            "words": words_data,
        }

        normalized.append(line_data)

    if not normalized:
        raise HTTPException(status_code=502, detail="Gemini did not return any transcript lines")

    # Mark continuation turns (same speaker as previous)
    prev_speaker = None
    for item in normalized:
        current_speaker = item.get("speaker", "").strip().upper()
        if prev_speaker is not None and current_speaker == prev_speaker:
            item["is_continuation"] = True
        else:
            item["is_continuation"] = False
        prev_speaker = current_speaker

    logger.info("Gemini transcription completed with %d utterances", len(normalized))
    return normalized


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

def _format_gcs_error(error: Exception) -> str:
    if isinstance(error, gcs_exceptions.GoogleAPIError):
        message = error.message or str(error)
        if getattr(error, "errors", None):
            message = f"{message} | details={error.errors}"
        return message
    return str(error)


def _upload_bytes_to_blob(blob: storage.Blob, file_bytes: bytes, content_type: Optional[str] = None) -> None:
    blob.chunk_size = 5 * 1024 * 1024  # 5MB chunking to support larger files consistently
    buffer = io.BytesIO(file_bytes)
    buffer.seek(0)
    blob.upload_from_file(buffer, size=len(file_bytes), content_type=content_type or "application/octet-stream")


def upload_to_cloud_storage(file_bytes: bytes, filename: str) -> str:
    """Upload file to Cloud Storage and return the blob name"""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}_{filename}"
        blob = bucket.blob(blob_name)
        _upload_bytes_to_blob(blob, file_bytes)
        logger.info(f"Uploaded {filename} to Cloud Storage as {blob_name}")
        return blob_name
    except Exception as e:
        logger.error(f"Error uploading to Cloud Storage: {_format_gcs_error(e)}")
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
            
        _upload_bytes_to_blob(blob, file_bytes, content_type)
        logger.info(f"Uploaded preview file {filename} to Cloud Storage as {blob_name}")
        return blob_name
    except Exception as e:
        logger.error(f"Error uploading preview file to Cloud Storage: {_format_gcs_error(e)}")
        raise


def download_blob_to_path(blob_name: str) -> Tuple[str, Optional[str]]:
    """Download a blob to a temporary file and return the path and content type."""
    bucket = storage_client.bucket(BUCKET_NAME)
    blob = bucket.blob(blob_name)
    if not blob.exists():
        raise HTTPException(status_code=404, detail="Media blob not found")

    extension = os.path.splitext(blob.name)[1]
    suffix = extension or mimetypes.guess_extension(blob.content_type or "") or ".bin"
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    temp_file.close()
    blob.download_to_filename(temp_file.name)
    return temp_file.name, blob.content_type


def upload_clip_file_to_cloud_storage(file_bytes: bytes, filename: str, content_type: Optional[str]) -> str:
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        safe_name = filename or "clip-output"
        blob_name = f"clip_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}_{safe_name}"
        blob = bucket.blob(blob_name)
        metadata = {
            "original_filename": safe_name,
            "content_type": content_type or "application/octet-stream",
            "file_type": "clip",
        }
        blob.metadata = metadata
        if content_type:
            blob.content_type = content_type
        _upload_bytes_to_blob(blob, file_bytes, content_type)
        logger.info("Uploaded clip media %s to Cloud Storage", blob_name)
        return blob_name
    except Exception as exc:
        logger.error("Error uploading clip media to Cloud Storage: %s", _format_gcs_error(exc))
        raise


def clip_media_segment(
    source_blob_name: Optional[str],
    clip_start: float,
    clip_end: float,
    content_type: Optional[str],
    clip_label: str,
) -> Tuple[Optional[str], Optional[str]]:
    if not source_blob_name:
        return None, None

    if clip_end <= clip_start:
        raise HTTPException(status_code=400, detail="Clip duration must be greater than zero")

    bucket = storage_client.bucket(BUCKET_NAME)
    source_blob = bucket.blob(source_blob_name)
    if not source_blob.exists():
        raise HTTPException(status_code=404, detail="Original media for session is unavailable")

    extension = os.path.splitext(source_blob_name)[1]
    if not extension and content_type:
        guessed = mimetypes.guess_extension(content_type)
        extension = guessed or extension
    extension = extension or ".mp4"

    ffmpeg_bin = get_ffmpeg_binary()
    start_time = max(clip_start, 0.0)
    duration = max(clip_end - clip_start, 0.01)

    source_temp = tempfile.NamedTemporaryFile(suffix=extension, delete=False)
    output_temp = tempfile.NamedTemporaryFile(suffix=extension, delete=False)
    try:
        source_temp.close()
        output_temp.close()
        source_blob.download_to_filename(source_temp.name)

        command = [
            ffmpeg_bin,
            "-y",
            "-ss",
            f"{start_time:.3f}",
            "-i",
            source_temp.name,
            "-t",
            f"{duration:.3f}",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            output_temp.name,
        ]

        process = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if process.returncode != 0:
            logger.error("FFmpeg clip command failed: %s", process.stderr.decode("utf-8", errors="ignore"))
            raise HTTPException(status_code=500, detail="FFmpeg failed to produce clip")

        with open(output_temp.name, "rb") as output_file:
            clip_bytes = output_file.read()

        filename_slug = slugify_filename(clip_label or "clip")
        clip_filename = f"{filename_slug}{extension}"
        clip_blob_name = upload_clip_file_to_cloud_storage(clip_bytes, clip_filename, content_type)
        return clip_blob_name, content_type
    finally:
        for temp_path in (source_temp.name, output_temp.name):
            try:
                os.remove(temp_path)
            except OSError:
                pass

app = FastAPI(
    title="TranscribeAlpha API",
    description="Professional Legal Transcript Generator using AssemblyAI",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def startup_event():
    """Run cleanup on startup and log Cloud Storage status"""
    logger.info("Starting TranscribeAlpha with Cloud Storage enabled")
    cleanup_old_files()
    cleanup_expired_clip_sessions()


# Authentication endpoints
@app.post("/api/auth/login")
async def login(credentials: dict = Body(...)):
    """
    Authenticate user and return access and refresh tokens.

    Request body:
    {
        "username": "string",
        "password": "string"
    }
    """
    username = credentials.get("username")
    password = credentials.get("password")

    if not username or not password:
        raise HTTPException(
            status_code=400,
            detail="Username and password are required"
        )

    user = authenticate_user(username, password)
    if not user:
        raise HTTPException(
            status_code=401,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Create tokens
    access_token = create_access_token(
        data={"sub": username, "role": user.get("role", "user")}
    )
    refresh_token = create_refresh_token(
        data={"sub": username, "role": user.get("role", "user")}
    )

    logger.info(f"User '{username}' logged in successfully")

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "user": {
            "username": username,
            "role": user.get("role", "user")
        }
    }


@app.post("/api/auth/refresh")
async def refresh_token(token_data: dict = Body(...)):
    """
    Refresh access token using refresh token.

    Request body:
    {
        "refresh_token": "string"
    }
    """
    refresh_token = token_data.get("refresh_token")

    if not refresh_token:
        raise HTTPException(
            status_code=400,
            detail="Refresh token is required"
        )

    # Decode and validate refresh token
    payload = decode_token(refresh_token)

    if not payload or payload.get("type") != "refresh":
        raise HTTPException(
            status_code=401,
            detail="Invalid refresh token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    username = payload.get("sub")
    if not username:
        raise HTTPException(
            status_code=401,
            detail="Invalid refresh token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Create new access token
    access_token = create_access_token(
        data={"sub": username, "role": payload.get("role", "user")}
    )

    return {
        "access_token": access_token,
        "token_type": "bearer"
    }


@app.post("/api/auth/logout")
async def logout(current_user: dict = Depends(get_current_user)):
    """
    Logout endpoint (client should delete tokens).
    """
    logger.info(f"User '{current_user['username']}' logged out")
    return {"message": "Successfully logged out"}


@app.get("/api/auth/me")
async def get_current_user_info(current_user: dict = Depends(get_current_user)):
    """Get current user information from token."""
    return {
        "username": current_user["username"],
        "role": current_user.get("role", "user"),
        "user_id": current_user["user_id"]
    }


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
    transcription_model: str = Form("assemblyai"),
    current_user: dict = Depends(get_current_user),
):
    logger.info(f"Received transcription request for file: {file.filename} using model: {transcription_model}")

    # Validate model selection
    valid_models = {"assemblyai", "gemini"}
    if transcription_model not in valid_models:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid transcription model. Must be one of: {', '.join(valid_models)}"
        )

    # Check for required API key based on model
    if transcription_model == "assemblyai":
        if not os.getenv("ASSEMBLYAI_API_KEY"):
            logger.error("ASSEMBLYAI_API_KEY environment variable not set")
            raise HTTPException(
                status_code=500,
                detail="Server configuration error: AssemblyAI API key not configured"
            )
    elif transcription_model == "gemini":
        if not (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")):
            logger.error("GEMINI_API_KEY/GOOGLE_API_KEY environment variable not set")
            raise HTTPException(
                status_code=500,
                detail="Server configuration error: Gemini API key not configured"
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

    # Generate stable MEDIA_ID for this transcript
    media_key = uuid.uuid4().hex
    title_data = {
        "CASE_NAME": case_name,
        "CASE_NUMBER": case_number,
        "FIRM_OR_ORGANIZATION_NAME": firm_name,
        "DATE": input_date,
        "TIME": input_time,
        "LOCATION": location,
        "FILE_NAME": file.filename,
        "FILE_DURATION": "Calculating...",
        "MEDIA_ID": media_key,  # Stable identifier for this transcript
    }

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

    # Generate transcription based on selected model
    asr_start_time = time.time()
    if transcription_model == "assemblyai":
        logger.info("Starting AssemblyAI transcription...")
        try:
            turns, docx_bytes, duration_seconds = process_transcription(
                file_bytes,
                file.filename,
                speaker_list,
                title_data,
            )
            asr_elapsed = time.time() - asr_start_time
            logger.info(f"AssemblyAI completed in {asr_elapsed:.1f}s. Generated {len(turns)} turns.")
        except Exception as e:
            import traceback
            error_detail = f"Error: {str(e)}\nTraceback: {traceback.format_exc()}"
            logger.error(f"AssemblyAI transcription error: {error_detail}")
            raise HTTPException(status_code=500, detail=f"AssemblyAI transcription failed: {str(e)}")

    elif transcription_model == "gemini":
        logger.info("Starting Gemini transcription...")
        try:
            # Process audio file for Gemini (need to extract audio and get duration)
            with tempfile.TemporaryDirectory() as temp_dir:
                input_path = os.path.join(temp_dir, file.filename)
                with open(input_path, "wb") as f:
                    f.write(file_bytes)

                ext = file.filename.split('.')[-1].lower()
                audio_path = input_path
                audio_mime = "audio/mpeg"

                # Convert video to audio if needed
                SUPPORTED_VIDEO_TYPES = ["mp4", "mov", "avi", "mkv"]
                if ext in SUPPORTED_VIDEO_TYPES:
                    output_audio = os.path.join(temp_dir, f"{os.path.splitext(file.filename)[0]}.mp3")
                    audio_path = convert_video_to_audio(input_path, output_audio) or input_path
                    audio_mime = "audio/mpeg"
                else:
                    # Get audio mime type
                    mime_map = {
                        "mp3": "audio/mpeg",
                        "wav": "audio/wav",
                        "m4a": "audio/mp4",
                        "flac": "audio/flac",
                        "ogg": "audio/ogg",
                        "aac": "audio/aac",
                        "aiff": "audio/aiff",
                    }
                    audio_mime = mime_map.get(ext, "audio/mpeg")

                # Get duration
                duration_seconds = get_media_duration(audio_path) or 0.0

                # Update title_data with duration
                hours, rem = divmod(duration_seconds, 3600)
                minutes, seconds = divmod(rem, 60)
                title_data["FILE_DURATION"] = "{:0>2}:{:0>2}:{:0>2}".format(int(hours), int(minutes), int(round(seconds)))

                # Run Gemini transcription (blocking call in thread)
                gemini_lines = await anyio.to_thread.run_sync(
                    transcribe_with_gemini,
                    audio_path,
                    audio_mime,
                    duration_seconds,
                    speaker_list,
                )

                # Normalize and convert to TranscriptTurn objects
                normalized_lines, normalized_duration = normalize_line_payloads(gemini_lines, duration_seconds)
                turns = construct_turns_from_lines(normalized_lines)

                if not turns:
                    raise HTTPException(status_code=400, detail="Gemini transcription returned no usable turns")

                asr_elapsed = time.time() - asr_start_time
                logger.info(f"Gemini completed in {asr_elapsed:.1f}s. Generated {len(turns)} turns.")

        except HTTPException:
            raise
        except Exception as e:
            import traceback
            error_detail = f"Error: {str(e)}\nTraceback: {traceback.format_exc()}"
            logger.error(f"Gemini transcription error: {error_detail}")
            raise HTTPException(status_code=500, detail=f"Gemini transcription failed: {str(e)}")

    # Apply Rev AI forced alignment for accurate word-level timestamps
    rev_api_key = os.getenv("REV_AI_API_KEY")
    if rev_api_key and media_blob_name:
        alignment_audio_path = None
        alignment_start_time = time.time()
        try:
            logger.info("Starting Rev AI forced alignment...")

            # Download media and convert to audio if needed (same as resync flow)
            alignment_audio_path, _, _, _ = await anyio.to_thread.run_sync(
                prepare_audio_for_gemini, media_blob_name, media_content_type
            )

            aligner = RevAIAligner(rev_api_key)

            # Convert turns to dicts for the aligner
            turns_payload = [t.model_dump() for t in turns]

            # Run alignment (preserves original text, only updates timestamps)
            aligned_turns_payload = await anyio.to_thread.run_sync(
                aligner.align_transcript, turns_payload, alignment_audio_path, None
            )

            # Convert back to TranscriptTurn objects
            turns = [TranscriptTurn(**t) for t in aligned_turns_payload]
            alignment_elapsed = time.time() - alignment_start_time
            logger.info(f"Rev AI alignment completed in {alignment_elapsed:.1f}s. Updated {len(turns)} turns.")

        except Exception as e:
            # Fallback: keep original timestamps from ASR
            logger.warning(f"Rev AI alignment failed, using native timestamps: {e}")
        finally:
            # Cleanup temporary audio file
            if alignment_audio_path and os.path.exists(alignment_audio_path):
                try:
                    os.remove(alignment_audio_path)
                except OSError:
                    pass
    elif not rev_api_key:
        logger.info("REV_AI_API_KEY not configured, using native ASR timestamps")
    elif not media_blob_name:
        logger.warning("Media blob not available for alignment, using native ASR timestamps")

    docx_bytes, oncue_xml, transcript_text, line_payloads = build_session_artifacts(
        turns,
        title_data,
        duration_seconds or 0,
        DEFAULT_LINES_PER_PAGE,
    )
    docx_b64 = base64.b64encode(docx_bytes).decode()
    oncue_b64 = base64.b64encode(oncue_xml.encode("utf-8")).decode()

    created_at = datetime.now(timezone.utc)

    transcript_data = {
        "media_key": media_key,
        "created_at": created_at.isoformat(),
        "title_data": title_data,
        "audio_duration": float(duration_seconds or 0),
        "lines_per_page": DEFAULT_LINES_PER_PAGE,
        "turns": serialize_transcript_turns(turns),
        "lines": line_payloads,
        "docx_base64": docx_b64,
        "oncue_xml_base64": oncue_b64,
        "transcript_text": transcript_text,
        "transcript": transcript_text,
        "media_blob_name": media_blob_name,
        "media_content_type": media_content_type,
        "updated_at": created_at.isoformat(),
        "user_id": current_user["user_id"],
        "clips": [],
    }

    try:
        # Save as current state
        save_current_transcript(media_key, transcript_data)

        # Also create initial snapshot (manual save)
        snapshot_id = uuid.uuid4().hex
        snapshot_payload = build_snapshot_payload(transcript_data, is_manual_save=True)
        bucket = storage_client.bucket(BUCKET_NAME)
        snapshot_blob = bucket.blob(f"transcripts/{media_key}/history/{snapshot_id}.json")
        snapshot_blob.upload_from_string(json.dumps(snapshot_payload), content_type="application/json")

    except Exception as e:
        logger.error("Failed to store transcript: %s", e)
        raise HTTPException(status_code=500, detail="Unable to persist transcript")

    response_data = {
        **transcript_data,
        "transcript": transcript_text,
    }

    return JSONResponse(response_data)


# New media-key-based API endpoints
@app.get("/api/transcripts")
async def list_transcripts_endpoint(current_user: dict = Depends(get_current_user)):
    """List all transcripts for authenticated user."""
    try:
        transcripts = list_all_transcripts(current_user["user_id"])
        return JSONResponse(content={"transcripts": transcripts})
    except Exception as e:
        logger.error(f"Failed to list transcripts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/transcripts/by-key/{media_key:path}")
async def get_transcript_by_media_key(media_key: str, current_user: dict = Depends(get_current_user)):
    """Get current transcript state or latest snapshot by media_key."""
    try:
        data = load_current_transcript(media_key)
        if not data:
            raise HTTPException(status_code=404, detail="Transcript not found")

        # Verify user owns this transcript
        if data.get("user_id") != current_user["user_id"]:
            raise HTTPException(status_code=403, detail="Access denied to this transcript")

        return JSONResponse(content=data)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to load transcript {media_key}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/transcripts/by-key/{media_key:path}")
async def save_transcript_by_media_key(media_key: str, request: Request, current_user: dict = Depends(get_current_user)):
    """Save transcript changes (auto-save or manual save)."""
    try:
        payload = await request.json()

        lines = payload.get("lines", [])
        title_data = payload.get("title_data", {})
        is_manual_save = payload.get("is_manual_save", False)
        user_id = current_user["user_id"]

        # Load existing or create new
        existing = load_current_transcript(media_key) or {}

        # Update with new data
        transcript_data = {
            **existing,
            "media_key": media_key,
            "lines": lines,
            "title_data": title_data,
            "user_id": user_id,
            "created_at": existing.get("created_at", datetime.now(timezone.utc).isoformat()),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "audio_duration": payload.get("audio_duration", existing.get("audio_duration", 0.0)),
            "lines_per_page": payload.get("lines_per_page", existing.get("lines_per_page", DEFAULT_LINES_PER_PAGE)),
            "media_blob_name": payload.get("media_blob_name", existing.get("media_blob_name")),
            "media_content_type": payload.get("media_content_type", existing.get("media_content_type")),
        }

        # Regenerate DOCX and XML
        try:
            normalized_lines, normalized_duration = normalize_line_payloads(lines, float(transcript_data.get("audio_duration") or 0.0))
            turns = construct_turns_from_lines(normalized_lines)
            docx_bytes, oncue_xml, transcript_text, updated_lines = build_session_artifacts(
                turns,
                title_data,
                normalized_duration,
                transcript_data.get("lines_per_page", DEFAULT_LINES_PER_PAGE),
            )
            transcript_data["lines"] = updated_lines
            transcript_data["audio_duration"] = normalized_duration
            transcript_data["docx_base64"] = base64.b64encode(docx_bytes).decode("ascii")
            transcript_data["oncue_xml_base64"] = base64.b64encode(oncue_xml.encode("utf-8")).decode("ascii")
            transcript_data["transcript_text"] = transcript_text
            transcript_data["transcript"] = transcript_text
        except Exception as e:
            logger.warning(f"Failed to regenerate documents: {e}")

        # Save current state
        save_current_transcript(media_key, transcript_data)

        # Also create snapshot in history
        snapshot_id = uuid.uuid4().hex
        snapshot_payload = build_snapshot_payload(transcript_data, is_manual_save=is_manual_save)
        bucket = storage_client.bucket(BUCKET_NAME)
        snapshot_blob = bucket.blob(f"transcripts/{media_key}/history/{snapshot_id}.json")
        snapshot_blob.upload_from_string(json.dumps(snapshot_payload), content_type="application/json")

        # Prune old snapshots
        prune_snapshots(media_key)

        return JSONResponse(content=transcript_data)

    except Exception as e:
        logger.error(f"Save failed for {media_key}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/transcripts/by-key/{media_key:path}/history")
async def list_transcript_history_by_media_key(media_key: str, current_user: dict = Depends(get_current_user)):
    """List all snapshots for a media_key."""
    try:
        logger.info(f"Fetching history for media_key: {media_key}")
        bucket = storage_client.bucket(BUCKET_NAME)
        prefix = f"transcripts/{media_key}/history/"
        logger.info(f"Looking for snapshots at prefix: {prefix}")

        snapshots = []
        blob_count = 0
        for blob in bucket.list_blobs(prefix=prefix):
            blob_count += 1
            try:
                data = json.loads(blob.download_as_string())
                # Support both old 'saved' and new 'is_manual_save' flags
                is_manual = data.get("is_manual_save", data.get("saved", False))
                snapshots.append({
                    "snapshot_id": blob.name.split("/")[-1].replace(".json", ""),
                    "created_at": data.get("created_at"),
                    "is_manual_save": is_manual,
                    "line_count": data.get("line_count", 0),
                    "title_label": data.get("title_label", "Transcript"),
                })
            except Exception as e:
                logger.warning(f"Failed to parse snapshot blob {blob.name}: {e}")
                continue

        logger.info(f"Found {blob_count} blobs, {len(snapshots)} valid snapshots")

        # Sort newest first
        snapshots.sort(key=lambda x: x["created_at"] or "", reverse=True)

        return JSONResponse(content={"snapshots": snapshots})

    except Exception as e:
        logger.error(f"Failed to list history for {media_key}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/transcripts/by-key/{media_key:path}/restore/{snapshot_id}")
async def restore_snapshot_by_media_key(media_key: str, snapshot_id: str, current_user: dict = Depends(get_current_user)):
    """Restore a specific snapshot as current state."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(f"transcripts/{media_key}/history/{snapshot_id}.json")

        if not blob.exists():
            raise HTTPException(status_code=404, detail="Snapshot not found")

        snapshot_data = json.loads(blob.download_as_string())

        if not snapshot_data.get("media_key"):
            snapshot_data["media_key"] = media_key

        # Save as current
        save_current_transcript(media_key, snapshot_data)

        return JSONResponse(content=snapshot_data)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to restore snapshot {snapshot_id} for {media_key}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/transcripts/snapshots")
async def list_all_snapshots(current_user: dict = Depends(get_current_user)):
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        items: List[dict] = []
        for blob in bucket.list_blobs(prefix=SNAPSHOT_PREFIX):
            try:
                metadata = blob.metadata or {}
                created_at = metadata.get("created_at") or blob.time_created.isoformat()
                actual_media_key = metadata.get("media_key") or os.path.basename(os.path.dirname(blob.name)).replace(SNAPSHOT_PREFIX.strip("/"), "") or "unknown"
                media_key_for_restore = actual_media_key

                title_label = metadata.get("title_label") or ""
                saved_flag = metadata.get("saved") == "True" or metadata.get("saved") is True
                line_count = int(metadata.get("line_count") or 0)

                display_media_key = actual_media_key
                # Derive display key from payload if metadata is missing or empty
                if not display_media_key or display_media_key == "unknown":
                    try:
                        payload = json.loads(blob.download_as_text())
                        display_media_key = derive_media_key_from_payload(payload)
                        title_label = title_label or (payload.get("title_data") or {}).get("CASE_NAME") or (payload.get("title_data") or {}).get("FILE_NAME") or ""
                        saved_flag = saved_flag or bool(payload.get("saved"))
                        line_count = line_count or len(payload.get("lines") or [])
                    except Exception:
                        display_media_key = actual_media_key or "unknown"

                items.append(
                    {
                        "snapshot_id": metadata.get("snapshot_id") or os.path.splitext(os.path.basename(blob.name))[0],
                        "session_id": metadata.get("session_id"),
                        "media_key": media_key_for_restore,
                        "display_media_key": display_media_key,
                        "created_at": created_at,
                        "size": blob.size,
                        "saved": saved_flag,
                        "line_count": line_count,
                        "title_label": title_label,
                    }
                )
            except Exception:
                continue
        # Sort by created desc and trim per media bucket to limit
        items.sort(key=lambda itm: itm.get("created_at") or "", reverse=True)
        grouped: dict = {}
        for snap in items:
            media_key = snap.get("display_media_key") or snap.get("media_key") or "unknown"
            grouped.setdefault(media_key, []).append(snap)
        trimmed: List[dict] = []
        for media_key, snaps in grouped.items():
            # prune per media to limit while keeping at least one saved
            saved = [s for s in snaps if s.get("saved")]
            newest_saved = saved[0] if saved else None
            keep = snaps[:SNAPSHOT_PER_MEDIA_LIMIT]
            if newest_saved and all(s["snapshot_id"] != newest_saved["snapshot_id"] for s in keep):
                if len(keep) >= SNAPSHOT_PER_MEDIA_LIMIT:
                    keep[-1] = newest_saved
                else:
                    keep.append(newest_saved)
            trimmed.extend(keep[:SNAPSHOT_PER_MEDIA_LIMIT])
        trimmed.sort(key=lambda itm: itm.get("created_at") or "", reverse=True)
        return JSONResponse({"snapshots": trimmed})
    except Exception as exc:
        logger.error("Failed to list all snapshots: %s", exc)
        raise HTTPException(status_code=500, detail="Unable to list snapshots")


@app.get("/api/snapshots/{media_key}")
async def list_snapshots_media_key(media_key: str, current_user: dict = Depends(get_current_user)):
    prune_snapshots(media_key)
    return JSONResponse({"snapshots": list_snapshots_for_media(media_key)})


@app.get("/api/snapshots/{media_key}/{snapshot_id}")
async def get_snapshot_by_media(media_key: str, snapshot_id: str, current_user: dict = Depends(get_current_user)):
    snapshot = load_snapshot(media_key, snapshot_id)
    if not snapshot:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    if not snapshot.get("media_key"):
        snapshot["media_key"] = derive_media_key_from_payload(snapshot)
    return JSONResponse(snapshot)


@app.post("/api/transcripts/by-key/{media_key:path}/gemini-refine")
async def gemini_refine_transcript(media_key: str, current_user: dict = Depends(get_current_user)):
    session_data = load_current_transcript(media_key)
    if not session_data:
        raise HTTPException(status_code=404, detail="Transcript not found")

    media_blob_name = session_data.get("media_blob_name")
    if not media_blob_name:
        raise HTTPException(status_code=400, detail="This session has no media attached for Gemini refinement")

    xml_b64 = session_data.get("oncue_xml_base64")
    if not xml_b64:
        raise HTTPException(status_code=400, detail="OnCue XML is missing for this session")

    try:
        xml_text = base64.b64decode(xml_b64).decode("utf-8", errors="replace")
    except Exception:
        raise HTTPException(status_code=400, detail="Unable to decode the session XML")

    audio_path = None
    media_path = None
    try:
        audio_path, audio_mime, duration_seconds, media_path = await anyio.to_thread.run_sync(
            prepare_audio_for_gemini,
            media_blob_name,
            session_data.get("media_content_type"),
        )
        duration_hint = duration_seconds or float(session_data.get("audio_duration") or 0)
        gemini_lines = await anyio.to_thread.run_sync(
            run_gemini_edit,
            xml_text,
            audio_path,
            audio_mime,
            duration_hint,
        )

        normalized_lines, normalized_duration = normalize_line_payloads(gemini_lines, duration_hint)
        turns = construct_turns_from_lines(normalized_lines)
        if not turns:
            raise HTTPException(status_code=400, detail="Gemini refinement returned no usable turns")

        lines_per_page = session_data.get("lines_per_page", DEFAULT_LINES_PER_PAGE)
        title_data = session_data.get("title_data") or {}

        docx_bytes, oncue_xml, transcript_text, updated_lines_payload = build_session_artifacts(
            turns,
            title_data,
            normalized_duration,
            lines_per_page,
        )

        docx_b64 = base64.b64encode(docx_bytes).decode()
        oncue_b64 = base64.b64encode(oncue_xml.encode("utf-8")).decode()

        hours, rem = divmod(normalized_duration, 3600)
        minutes, seconds = divmod(rem, 60)
        title_data["FILE_DURATION"] = "{:0>2}:{:0>2}:{:0>2}".format(int(hours), int(minutes), int(round(seconds)))

        updated_at = datetime.now(timezone.utc)
        session_data["turns"] = serialize_transcript_turns(turns)
        session_data["lines"] = updated_lines_payload
        session_data["title_data"] = title_data
        session_data["audio_duration"] = normalized_duration
        session_data["docx_base64"] = docx_b64
        session_data["oncue_xml_base64"] = oncue_b64
        session_data["transcript_text"] = transcript_text
        session_data["transcript"] = transcript_text
        session_data["updated_at"] = updated_at.isoformat()

        save_current_transcript(media_key, session_data)

        return JSONResponse(session_data)
    finally:
        for path in (audio_path, media_path):
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except Exception:
                    pass


@app.post("/api/clips")
async def create_clip(payload: Dict = Body(...), current_user: dict = Depends(get_current_user)):
    media_key = payload.get("media_key")
    if not media_key:
        raise HTTPException(status_code=400, detail="media_key is required")

    session_data = load_current_transcript(media_key)
    if not session_data:
        raise HTTPException(status_code=404, detail="Transcript not found")

    lines = session_data.get("lines") or []
    if not lines:
        raise HTTPException(status_code=400, detail="Session does not contain transcript lines")

    # Resolve lines-per-page for the clip
    try:
        lines_per_page = int(payload.get("lines_per_page") or session_data.get("lines_per_page") or DEFAULT_LINES_PER_PAGE)
    except (TypeError, ValueError):
        lines_per_page = DEFAULT_LINES_PER_PAGE
    if lines_per_page <= 0:
        lines_per_page = DEFAULT_LINES_PER_PAGE

    # Accept page/line pairs if provided and derive pgln value for lookup
    start_pgln = payload.get("start_pgln")
    if start_pgln is None and payload.get("start_page") is not None and payload.get("start_line") is not None:
        try:
            start_pgln = int(payload["start_page"]) * 100 + int(payload["start_line"])
        except (TypeError, ValueError):
            start_pgln = None

    end_pgln = payload.get("end_pgln")
    if end_pgln is None and payload.get("end_page") is not None and payload.get("end_line") is not None:
        try:
            end_pgln = int(payload["end_page"]) * 100 + int(payload["end_line"])
        except (TypeError, ValueError):
            end_pgln = None

    start_time = parse_timecode_to_seconds(payload.get("start_time"))
    end_time = parse_timecode_to_seconds(payload.get("end_time"))

    start_index = resolve_line_index(
        lines,
        line_id=payload.get("start_line_id"),
        pgln=start_pgln,
        time_seconds=start_time,
        prefer_start=True,
    )
    if start_index is None:
        raise HTTPException(status_code=400, detail="Unable to resolve clip start line")

    end_index = resolve_line_index(
        lines,
        line_id=payload.get("end_line_id"),
        pgln=end_pgln,
        time_seconds=end_time,
        prefer_start=False,
    )
    if end_index is None:
        raise HTTPException(status_code=400, detail="Unable to resolve clip end line")

    if start_index > end_index:
        start_index, end_index = end_index, start_index

    selected_slice = lines[start_index : end_index + 1]
    if not selected_slice:
        raise HTTPException(status_code=400, detail="Selected clip range is empty")

    start_line = selected_slice[0]
    end_line = selected_slice[-1]

    start_absolute = float(start_line.get("start", 0.0) or 0.0)
    end_absolute = float(end_line.get("end", start_absolute) or start_absolute)
    if end_absolute <= start_absolute:
        end_absolute = start_absolute + 0.01

    rebased_lines: List[dict] = []
    for local_idx, original_line in enumerate(selected_slice):
        original_start = float(original_line.get("start", 0.0) or 0.0)
        original_end = float(original_line.get("end", original_start) or original_start)
        if original_end <= original_start:
            original_end = original_start + 0.01

        rebased_lines.append(
            {
                "id": f"clip-{local_idx}",
                "speaker": (str(original_line.get("speaker", "SPEAKER"))).strip().upper() or "SPEAKER",
                "text": str(original_line.get("text", "")),
                "start": max(original_start - start_absolute, 0.0),
                "end": max(original_end - start_absolute, 0.0),
                "is_continuation": False if local_idx == 0 else bool(original_line.get("is_continuation", False)),
            }
        )

    clip_duration_hint = max(end_absolute - start_absolute, 0.01)
    normalized_lines, normalized_duration = normalize_line_payloads(rebased_lines, clip_duration_hint)
    turns = construct_turns_from_lines(normalized_lines)
    if not turns:
        raise HTTPException(status_code=400, detail="Unable to construct transcript turns for clip")

    title_overrides = payload.get("title_overrides") if isinstance(payload.get("title_overrides"), dict) else {}
    clip_title_data = dict(session_data.get("title_data") or {})
    for key, value in title_overrides.items():
        if value is None:
            continue
        clip_title_data[key] = str(value)

    clip_count = len(ensure_session_clip_list(session_data))
    default_name = f"Clip {clip_count + 1}"
    clip_name = sanitize_clip_label(payload.get("clip_label"), default_name)

    base_filename = clip_title_data.get("FILE_NAME") or "clip-output"
    filename_root, filename_ext = os.path.splitext(base_filename)
    if not filename_ext:
        guessed_ext = mimetypes.guess_extension(session_data.get("media_content_type") or "")
        filename_ext = guessed_ext or ""
    clip_filename = f"{filename_root}_{slugify_filename(clip_name)}{filename_ext}" if filename_root else f"{slugify_filename(clip_name)}{filename_ext}"
    clip_title_data["FILE_NAME"] = clip_filename

    hours, remainder = divmod(normalized_duration, 3600)
    minutes, seconds = divmod(remainder, 60)
    clip_title_data["FILE_DURATION"] = f"{int(hours):02d}:{int(minutes):02d}:{int(round(seconds)):02d}"

    docx_bytes, oncue_xml, transcript_text, clip_line_entries = build_session_artifacts(
        turns,
        clip_title_data,
        normalized_duration,
        lines_per_page,
    )

    docx_b64 = base64.b64encode(docx_bytes).decode()
    oncue_b64 = base64.b64encode(oncue_xml.encode("utf-8")).decode()

    clip_media_blob_name, clip_media_content_type = clip_media_segment(
        session_data.get("media_blob_name"),
        start_absolute,
        end_absolute,
        session_data.get("media_content_type"),
        clip_name,
    )

    clip_id = uuid.uuid4().hex
    created_at = datetime.now(timezone.utc)
    clip_expires_at = created_at + timedelta(days=CLIP_SESSION_TTL_DAYS)

    clip_data = {
        "clip_id": clip_id,
        "parent_media_key": media_key,
        "name": clip_name,
        "created_at": created_at.isoformat(),
        "expires_at": clip_expires_at.isoformat(),
        "duration": float(normalized_duration),
        "start_time": float(start_absolute),
        "end_time": float(end_absolute),
        "start_line_id": start_line.get("id"),
        "end_line_id": end_line.get("id"),
        "start_pgln": start_line.get("pgln"),
        "end_pgln": end_line.get("pgln"),
        "start_page": start_line.get("page"),
        "start_line_number": start_line.get("line"),
        "end_page": end_line.get("page"),
        "end_line_number": end_line.get("line"),
        "docx_base64": docx_b64,
        "oncue_xml_base64": oncue_b64,
        "transcript_text": transcript_text,
        "lines": clip_line_entries,
        "title_data": clip_title_data,
        "lines_per_page": lines_per_page,
        "media_blob_name": clip_media_blob_name,
        "media_content_type": clip_media_content_type,
    }

    clip_summary = {
        "clip_id": clip_id,
        "parent_media_key": media_key,
        "name": clip_name,
        "created_at": created_at.isoformat(),
        "duration": float(normalized_duration),
        "start_time": float(start_absolute),
        "end_time": float(end_absolute),
        "start_pgln": start_line.get("pgln"),
        "end_pgln": end_line.get("pgln"),
        "start_page": start_line.get("page"),
        "start_line": start_line.get("line"),
        "end_page": end_line.get("page"),
        "end_line": end_line.get("line"),
        "media_blob_name": clip_media_blob_name,
        "media_content_type": clip_media_content_type,
        "file_name": clip_title_data.get("FILE_NAME"),
    }

    try:
        save_clip_session(clip_id, clip_data)
    except Exception as exc:
        logger.error("Failed to store clip session %s: %s", clip_id, exc)
        raise HTTPException(status_code=500, detail="Unable to persist clip data")

    clips_list = ensure_session_clip_list(session_data)
    clips_list.append(clip_summary)

    session_data["updated_at"] = created_at.isoformat()
    session_data["media_key"] = media_key

    try:
        save_current_transcript(media_key, session_data)
    except Exception as exc:
        clips_list.pop()
        delete_clip_session(clip_id)
        logger.error("Failed to update session %s after clip creation: %s", media_key, exc)
        raise HTTPException(status_code=500, detail="Unable to update session with clip metadata")

    clip_response = dict(clip_data)
    clip_response.pop("parent_media_key", None)
    clip_response["transcript"] = clip_response.pop("transcript_text", "")
    clip_response["summary"] = clip_summary

    return JSONResponse({
        "clip": clip_response,
        "transcript": session_data,
    })


@app.get("/api/clips/{clip_id}")
async def get_clip_session(clip_id: str, current_user: dict = Depends(get_current_user)):
    clip_data = load_clip_session(clip_id)
    if not clip_data:
        raise HTTPException(status_code=404, detail="Clip session not found")

    expires_at = clip_data.get("expires_at")
    if expires_at:
        try:
            expires_dt = datetime.fromisoformat(expires_at)
        except ValueError:
            try:
                expires_dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            except ValueError:
                expires_dt = None
        if expires_dt and expires_dt < datetime.now(timezone.utc):
            delete_clip_session(clip_id)
            raise HTTPException(status_code=404, detail="Clip session expired")

    response_payload = dict(clip_data)
    response_payload["transcript"] = response_payload.pop("transcript_text", "")
    return JSONResponse(response_payload)


@app.post("/api/transcripts/import")
async def import_transcript(
    transcript_file: UploadFile = File(...),
    media_file: UploadFile = File(...),
    case_name: str = Form(""),
    case_number: str = Form(""),
    firm_name: str = Form(""),
    input_date: str = Form(""),
    input_time: str = Form(""),
    location: str = Form(""),
    current_user: dict = Depends(get_current_user),
):
    """
    Import a transcript from OnCue XML or DOCX file.

    - XML: Parses OnCue format, uses embedded timestamps
    - DOCX: Parses speaker/text, runs Rev AI alignment for timestamps

    Media file is required for both to enable playback and re-sync.
    """
    filename = transcript_file.filename or ""
    file_ext = filename.lower().split('.')[-1] if '.' in filename else ''

    logger.info(f"Import request: file={filename} (type={file_ext}), media={media_file.filename if media_file else 'None'}")

    file_bytes = await transcript_file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded transcript file is empty")

    # Upload media first (required for both formats)
    media_blob_name = None
    media_content_type = None
    duration_seconds = 0.0

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
                logger.info(f"Import: uploaded media to blob {media_blob_name}")

                # Get duration from media
                audio_path, _, dur, _ = await anyio.to_thread.run_sync(
                    prepare_audio_for_gemini, media_blob_name, media_content_type
                )
                duration_seconds = dur or 0.0
                # Cleanup temp file
                if audio_path and os.path.exists(audio_path):
                    try:
                        os.remove(audio_path)
                    except OSError:
                        pass
            except Exception as e:
                logger.error("Failed to process media during import: %s", e)
                raise HTTPException(status_code=500, detail=f"Failed to process media file: {e}")
    else:
        raise HTTPException(status_code=400, detail="Media file is required for import")

    # Parse transcript based on file type
    if file_ext == 'xml':
        # OnCue XML format
        xml_text = file_bytes.decode("utf-8", errors="replace")
        parsed = parse_oncue_xml(xml_text)
        title_data = parsed["title_data"]
        xml_duration = float(parsed["audio_duration"] or 0)
        if xml_duration > 0:
            duration_seconds = xml_duration

        lines_payload = parsed["lines"]
        normalized_lines, duration_seconds = normalize_line_payloads(lines_payload, duration_seconds)
        turns = construct_turns_from_lines(normalized_lines)

        if not turns:
            raise HTTPException(status_code=400, detail="Unable to construct transcript turns from XML")

    elif file_ext == 'docx':
        # DOCX format - parse and run Rev AI alignment
        docx_turns = parse_docx_to_turns(file_bytes)

        if not docx_turns:
            raise HTTPException(status_code=400, detail="Unable to parse transcript from DOCX")

        # Convert to TranscriptTurn objects (without timestamps initially)
        turns = []
        for t in docx_turns:
            turns.append(TranscriptTurn(
                speaker=t['speaker'],
                text=t['text'],
                timestamp=None,
                words=None,
            ))

        # Run Rev AI alignment to get timestamps
        rev_api_key = os.getenv("REV_AI_API_KEY")
        if rev_api_key and media_blob_name:
            alignment_audio_path = None
            alignment_start_time = time.time()
            try:
                logger.info("Running Rev AI alignment for DOCX import...")

                alignment_audio_path, _, _, _ = await anyio.to_thread.run_sync(
                    prepare_audio_for_gemini, media_blob_name, media_content_type
                )

                aligner = RevAIAligner(rev_api_key)
                turns_payload = [t.model_dump() for t in turns]

                aligned_turns_payload = await anyio.to_thread.run_sync(
                    aligner.align_transcript, turns_payload, alignment_audio_path, None
                )

                turns = [TranscriptTurn(**t) for t in aligned_turns_payload]
                alignment_elapsed = time.time() - alignment_start_time
                logger.info(f"Rev AI alignment completed in {alignment_elapsed:.1f}s for DOCX import")

            except Exception as e:
                logger.warning(f"Rev AI alignment failed for DOCX import: {e}")
                # Continue without timestamps - user can resync later
            finally:
                if alignment_audio_path and os.path.exists(alignment_audio_path):
                    try:
                        os.remove(alignment_audio_path)
                    except OSError:
                        pass
        else:
            logger.warning("REV_AI_API_KEY not configured, DOCX import will have no timestamps")

        title_data = {}
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {file_ext}. Use .xml (OnCue) or .docx"
        )

    # Apply form overrides to title_data
    overrides = {
        "CASE_NAME": case_name or title_data.get("CASE_NAME", ""),
        "CASE_NUMBER": case_number or title_data.get("CASE_NUMBER", ""),
        "FIRM_OR_ORGANIZATION_NAME": firm_name or title_data.get("FIRM_OR_ORGANIZATION_NAME", ""),
        "DATE": input_date or title_data.get("DATE", ""),
        "TIME": input_time or title_data.get("TIME", ""),
        "LOCATION": location or title_data.get("LOCATION", ""),
        "FILE_NAME": title_data.get("FILE_NAME") or filename or "imported",
    }
    title_data.update(overrides)

    # Always use a fresh media key
    media_key = uuid.uuid4().hex
    title_data["MEDIA_ID"] = media_key

    # Build artifacts
    docx_bytes_out, oncue_xml, transcript_text, line_payloads = build_session_artifacts(
        turns,
        title_data,
        duration_seconds,
        DEFAULT_LINES_PER_PAGE,
    )

    docx_b64 = base64.b64encode(docx_bytes_out).decode()
    oncue_b64 = base64.b64encode(oncue_xml.encode("utf-8")).decode()

    created_at = datetime.now(timezone.utc)

    try:
        transcript_data = {
            "media_key": media_key,
            "created_at": created_at.isoformat(),
            "updated_at": created_at.isoformat(),
            "title_data": title_data,
            "audio_duration": duration_seconds,
            "lines_per_page": DEFAULT_LINES_PER_PAGE,
            "turns": serialize_transcript_turns(turns),
            "lines": line_payloads,
            "docx_base64": docx_b64,
            "oncue_xml_base64": oncue_b64,
            "transcript_text": transcript_text,
            "transcript": transcript_text,
            "media_blob_name": media_blob_name,
            "media_content_type": media_content_type,
            "user_id": current_user["user_id"],
            "clips": [],
        }

        save_current_transcript(media_key, transcript_data)

        # Create initial snapshot
        snapshot_id = uuid.uuid4().hex
        snapshot_payload = build_snapshot_payload(transcript_data, is_manual_save=True)
        bucket = storage_client.bucket(BUCKET_NAME)
        snapshot_blob = bucket.blob(f"transcripts/{media_key}/history/{snapshot_id}.json")
        snapshot_blob.upload_from_string(json.dumps(snapshot_payload), content_type="application/json")
        logger.info(f"Created initial snapshot for imported transcript: {media_key}")

    except Exception as e:
        logger.error("Failed to save imported transcript: %s", e)
        raise HTTPException(status_code=500, detail="Unable to persist imported transcript")

    return JSONResponse(dict(transcript_data))

@app.post("/api/upload-preview")
async def upload_media_preview(file: UploadFile = File(...), current_user: dict = Depends(get_current_user)):
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
async def serve_media_file(file_id: str, request: Request):
    """Serve media file for preview"""
    try:
        metadata = get_blob_metadata(file_id)
        if not metadata:
            raise HTTPException(status_code=404, detail="Media file not found")

        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(file_id)
        if not blob.exists():
            raise HTTPException(status_code=404, detail="Media file not found")

        # Reload blob to get actual size from GCS (blob.size is None until reload)
        blob.reload()
        file_size = metadata.get("size") or blob.size or 0
        logger.info(f"Serving media {file_id}: size={file_size}, content_type={metadata.get('content_type')}")
        content_type = metadata.get("content_type", "application/octet-stream")

        range_header = request.headers.get("range")
        start = 0
        end = file_size - 1 if file_size else None
        status_code = 200
        headers = {
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
        }

        if range_header and file_size:
            range_match = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if range_match:
                if range_match.group(1):
                    start = int(range_match.group(1))
                if range_match.group(2):
                    end = int(range_match.group(2))
                if end is None or end >= file_size:
                    end = file_size - 1
                if start > end:
                    raise HTTPException(status_code=416, detail="Invalid range header")

                status_code = 206
                headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
                headers["Content-Length"] = str(end - start + 1)
            else:
                logger.warning("Invalid range header received: %s", range_header)

        elif file_size:
            headers["Content-Length"] = str(file_size)

        def iter_chunks(start_pos: int, end_pos: Optional[int]):
            chunk_size = 1024 * 1024  # 1MB chunks
            bytes_remaining = (end_pos - start_pos + 1) if end_pos is not None else None
            with blob.open("rb") as stream:
                if start_pos:
                    stream.seek(start_pos)
                while True:
                    read_size = chunk_size if bytes_remaining is None else min(chunk_size, bytes_remaining)
                    if read_size <= 0:
                        break
                    data = stream.read(read_size)
                    if not data:
                        break
                    yield data
                    if bytes_remaining is not None:
                        bytes_remaining -= len(data)
                        if bytes_remaining <= 0:
                            break

        return StreamingResponse(
            iter_chunks(start, end),
            media_type=content_type,
            status_code=status_code,
            headers=headers,
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
            cleanup_expired_clip_sessions()
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

@app.post("/api/resync")
async def resync_transcript(
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    """
    Re-sync the transcript using Rev AI Forced Alignment.

    Payload:
      - media_key: string
      - api_key: string (optional, checks env if missing)
    """
    media_key = payload.get("media_key")
    if not media_key:
        raise HTTPException(status_code=400, detail="Missing media_key")

    # 1. Load Session
    session_data = load_current_transcript(media_key)
    if not session_data:
        raise HTTPException(status_code=404, detail="Transcript not found")

    # 2. Get Audio Access (Consistent with Gemini flow)
    media_blob_name = session_data.get("media_blob_name")
    media_content_type = session_data.get("media_content_type")

    logger.info(f"Resync: media_key={media_key}, media_blob_name={media_blob_name}, media_content_type={media_content_type}")
    logger.info(f"Resync: session_data keys={list(session_data.keys())}")

    if not media_blob_name:
        raise HTTPException(status_code=400, detail="Audio file reference not found in session")

    # Use existing helper to download and convert (if needed)
    # This ensures we handle video->audio conversion and mime types consistently
    audio_path = None
    try:
        # Run in thread pool to avoid blocking async event loop
        audio_path, _, _, _ = await anyio.to_thread.run_sync(
            prepare_audio_for_gemini, media_blob_name, media_content_type
        )
    except Exception as e:
        logger.error(f"Failed to prepare audio for re-sync: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to prepare audio: {e}")

    try:
        # 3. Get API Key
        rev_api_key = payload.get("api_key") or os.getenv("REV_AI_API_KEY")
        if not rev_api_key:
            raise HTTPException(status_code=500, detail="Rev AI API Key not configured")

        aligner = RevAIAligner(rev_api_key)

        # 4. Prepare Turns
        lines = session_data.get("lines", [])
        if not lines:
            raise HTTPException(status_code=400, detail="No transcript lines to align")

        # Normalize lines before constructing turns (consistent with other endpoints)
        audio_duration = session_data.get("audio_duration", 0.0)
        normalized_lines, _ = normalize_line_payloads(lines, audio_duration)
        turns = construct_turns_from_lines(normalized_lines)

        # 5. Call Rev AI
        # Convert turns to dicts for the aligner
        turns_payload = [t.model_dump() for t in turns]

        # We pass the local audio_path. The aligner prefers file upload.
        updated_turns_payload = await anyio.to_thread.run_sync(
            aligner.align_transcript, turns_payload, audio_path, None
        )

        updated_turns = [TranscriptTurn(**t) for t in updated_turns_payload]

        # 6. Rebuild Artifacts
        title_data = session_data.get("title_data", {})
        audio_duration = session_data.get("audio_duration", 0.0)
        lines_per_page = session_data.get("lines_per_page", DEFAULT_LINES_PER_PAGE)

        docx_bytes, oncue_xml, transcript_text, new_line_entries = build_session_artifacts(
            updated_turns,
            title_data,
            audio_duration,
            lines_per_page
        )

        # 7. Update Session
        session_data["lines"] = new_line_entries
        session_data["docx_base64"] = base64.b64encode(docx_bytes).decode()
        session_data["oncue_xml_base64"] = base64.b64encode(oncue_xml.encode("utf-8")).decode()
        session_data["transcript_text"] = transcript_text
        session_data["updated_at"] = datetime.now(timezone.utc).isoformat()

        save_current_transcript(media_key, session_data)

        return {
            "status": "success",
            "lines": new_line_entries,
            "docx_base64": session_data["docx_base64"],
            "oncue_xml_base64": session_data["oncue_xml_base64"]
        }

    except Exception as e:
        logger.error(f"Re-sync failed: {e}")
        raise HTTPException(status_code=502, detail=f"Re-sync process failed: {e}")

    finally:
        # Cleanup temporary audio file
        if audio_path and os.path.exists(audio_path):
            try:
                os.remove(audio_path)
            except OSError:
                pass


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

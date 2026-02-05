import base64
import json
import logging
import mimetypes
import os
import tempfile
import time
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

import anyio
from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

try:
    from ..access_control import _user_owns_media_key
except ImportError:
    try:
        from access_control import _user_owns_media_key
    except ImportError:
        import access_control as access_control_module
        _user_owns_media_key = access_control_module._user_owns_media_key

try:
    from ..auth import get_current_user
except ImportError:
    try:
        from auth import get_current_user
    except ImportError:
        import auth as auth_module
        get_current_user = auth_module.get_current_user

try:
    from ..config import DEFAULT_LINES_PER_PAGE, APP_VARIANT
except ImportError:
    try:
        from config import DEFAULT_LINES_PER_PAGE, APP_VARIANT
    except ImportError:
        import config as config_module
        DEFAULT_LINES_PER_PAGE = config_module.DEFAULT_LINES_PER_PAGE
        APP_VARIANT = config_module.APP_VARIANT

try:
    from ..gemini import run_gemini_edit, transcribe_with_gemini
except ImportError:
    try:
        from gemini import run_gemini_edit, transcribe_with_gemini
    except ImportError:
        import gemini as gemini_module
        run_gemini_edit = gemini_module.run_gemini_edit
        transcribe_with_gemini = gemini_module.transcribe_with_gemini

try:
    from ..media_processing import prepare_audio_for_gemini
except ImportError:
    try:
        from media_processing import prepare_audio_for_gemini
    except ImportError:
        import media_processing as media_processing_module
        prepare_audio_for_gemini = media_processing_module.prepare_audio_for_gemini

try:
    from ..models import TranscriptTurn
except ImportError:
    try:
        from models import TranscriptTurn
    except ImportError:
        import models as models_module
        TranscriptTurn = models_module.TranscriptTurn

try:
    from ..rev_ai_sync import RevAIAligner
except ImportError:
    try:
        from rev_ai_sync import RevAIAligner
    except ImportError:
        import rev_ai_sync as rev_ai_sync_module
        RevAIAligner = rev_ai_sync_module.RevAIAligner

try:
    from ..storage import (
        BUCKET_NAME,
        add_transcript_to_case,
        check_media_exists,
        list_all_transcripts,
        load_current_transcript,
        prune_snapshots,
        save_current_transcript,
        save_upload_to_tempfile,
        storage_client,
        upload_preview_file_to_cloud_storage_from_path,
    )
except ImportError:
    try:
        from storage import (
            BUCKET_NAME,
            add_transcript_to_case,
            check_media_exists,
            list_all_transcripts,
            load_current_transcript,
            prune_snapshots,
            save_current_transcript,
            save_upload_to_tempfile,
            storage_client,
            upload_preview_file_to_cloud_storage_from_path,
        )
    except ImportError:
        import storage as storage_module
        BUCKET_NAME = storage_module.BUCKET_NAME
        add_transcript_to_case = storage_module.add_transcript_to_case
        check_media_exists = storage_module.check_media_exists
        list_all_transcripts = storage_module.list_all_transcripts
        load_current_transcript = storage_module.load_current_transcript
        prune_snapshots = storage_module.prune_snapshots
        save_current_transcript = storage_module.save_current_transcript
        save_upload_to_tempfile = storage_module.save_upload_to_tempfile
        storage_client = storage_module.storage_client
        upload_preview_file_to_cloud_storage_from_path = storage_module.upload_preview_file_to_cloud_storage_from_path

try:
    from ..transcriber import (
        convert_video_to_audio,
        get_media_duration,
        process_transcription,
    )
except ImportError:
    try:
        from transcriber import (
            convert_video_to_audio,
            get_media_duration,
            process_transcription,
        )
    except ImportError:
        import transcriber as transcriber_module
        convert_video_to_audio = transcriber_module.convert_video_to_audio
        get_media_duration = transcriber_module.get_media_duration
        process_transcription = transcriber_module.process_transcription

try:
    from ..word_legacy import parse_docx_to_turns
except ImportError:
    try:
        from word_legacy import parse_docx_to_turns
    except ImportError:
        import word_legacy as word_legacy_module
        parse_docx_to_turns = word_legacy_module.parse_docx_to_turns

try:
    from ..transcript_utils import (
        build_session_artifacts,
        build_snapshot_payload,
        build_variant_exports,
        construct_turns_from_lines,
        normalize_line_payloads,
        parse_oncue_xml,
        parse_viewer_html,
        resolve_media_filename,
        serialize_transcript_turns,
    )
except ImportError:
    try:
        from transcript_utils import (
            build_session_artifacts,
            build_snapshot_payload,
            build_variant_exports,
            construct_turns_from_lines,
            normalize_line_payloads,
            parse_oncue_xml,
            parse_viewer_html,
            resolve_media_filename,
            serialize_transcript_turns,
        )
    except ImportError:
        import transcript_utils as transcript_utils_module
        build_session_artifacts = transcript_utils_module.build_session_artifacts
        build_snapshot_payload = transcript_utils_module.build_snapshot_payload
        build_variant_exports = transcript_utils_module.build_variant_exports
        construct_turns_from_lines = transcript_utils_module.construct_turns_from_lines
        normalize_line_payloads = transcript_utils_module.normalize_line_payloads
        parse_oncue_xml = transcript_utils_module.parse_oncue_xml
        parse_viewer_html = transcript_utils_module.parse_viewer_html
        resolve_media_filename = transcript_utils_module.resolve_media_filename
        serialize_transcript_turns = transcript_utils_module.serialize_transcript_turns

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/api/config")
async def get_app_config():
    """Return app configuration including variant type."""
    return JSONResponse({
        "variant": APP_VARIANT,
        "features": {
            "oncue_xml": APP_VARIANT == "oncue",
            "viewer_html": APP_VARIANT == "criminal",
            "import_oncue": APP_VARIANT == "oncue",
            "import_viewer_html": APP_VARIANT == "criminal",
        }
    })


@router.post("/api/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    case_name: str = Form(""),
    case_number: str = Form(""),
    firm_name: str = Form(""),
    input_date: str = Form(""),
    input_time: str = Form(""),
    location: str = Form(""),
    speaker_names: Optional[str] = Form(None),
    transcription_model: str = Form("assemblyai"),
    case_id: Optional[str] = Form(None),
    current_user: dict = Depends(get_current_user),
):
    logger.info("Received transcription request for file: %s using model: %s", file.filename, transcription_model)

    # Validate model selection
    valid_models = {"assemblyai", "gemini"}
    if transcription_model not in valid_models:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid transcription model. Must be one of: {', '.join(valid_models)}",
        )

    # Check for required API key based on model
    if transcription_model == "assemblyai":
        if not os.getenv("ASSEMBLYAI_API_KEY"):
            logger.error("ASSEMBLYAI_API_KEY environment variable not set")
            raise HTTPException(
                status_code=500,
                detail="Server configuration error: AssemblyAI API key not configured",
            )
    elif transcription_model == "gemini":
        if not (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")):
            logger.error("GEMINI_API_KEY/GOOGLE_API_KEY environment variable not set")
            raise HTTPException(
                status_code=500,
                detail="Server configuration error: Gemini API key not configured",
            )

    temp_upload_path = None
    try:
        temp_upload_path, file_size = await save_upload_to_tempfile(file)
        logger.info("File size: %.2f MB", file_size / (1024 * 1024))

        # Increase limit to 2GB
        if file_size > 2 * 1024 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="File too large. Maximum size is 2GB.")

        if not temp_upload_path:
            raise HTTPException(status_code=400, detail="Unable to read uploaded file")

        speaker_list: Optional[List[str]] = None
        if speaker_names:
            speaker_names = speaker_names.strip()
            if speaker_names.startswith('[') and speaker_names.endswith(']'):
                try:
                    speaker_list = json.loads(speaker_names)
                except json.JSONDecodeError:
                    raise HTTPException(status_code=400, detail="Invalid JSON format for speaker names")
            else:
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
            "MEDIA_ID": media_key,
        }

        # Upload media for editor playback
        media_blob_name = None
        media_content_type = file.content_type or mimetypes.guess_type(file.filename)[0]
        try:
            media_blob_name = upload_preview_file_to_cloud_storage_from_path(
                temp_upload_path,
                file.filename,
                media_content_type,
                user_id=current_user["user_id"],
                media_key=media_key,
            )
        except Exception as e:
            logger.warning("Failed to store media preview for editor session: %s", e)
            media_blob_name = None
            media_content_type = None

        duration_seconds = 0.0
        asr_start_time = time.time()

        if transcription_model == "assemblyai":
            logger.info("Starting AssemblyAI transcription...")
            try:
                turns, duration_seconds = process_transcription(
                    None,
                    file.filename,
                    speaker_list,
                    title_data,
                    input_path=temp_upload_path,
                )
                asr_elapsed = time.time() - asr_start_time
                logger.info("AssemblyAI completed in %.1fs. Generated %d turns.", asr_elapsed, len(turns))
            except Exception as e:
                logger.exception("AssemblyAI transcription error")
                raise HTTPException(status_code=500, detail=f"AssemblyAI transcription failed: {str(e)}") from e

        elif transcription_model == "gemini":
            logger.info("Starting Gemini transcription...")
            try:
                with tempfile.TemporaryDirectory() as temp_dir:
                    input_path = temp_upload_path

                    ext = file.filename.split('.')[-1].lower()
                    audio_path = input_path
                    audio_mime = "audio/mpeg"

                    SUPPORTED_VIDEO_TYPES = ["mp4", "mov", "avi", "mkv"]
                    if ext in SUPPORTED_VIDEO_TYPES:
                        output_audio = os.path.join(
                            temp_dir,
                            f"{os.path.splitext(os.path.basename(file.filename))[0]}.mp3",
                        )
                        converted_audio = convert_video_to_audio(input_path, output_audio)
                        if converted_audio:
                            audio_path = converted_audio
                            audio_mime = "audio/mpeg"
                        else:
                            # Keep MIME aligned with the actual fallback input path.
                            video_mime_map = {
                                "mp4": "video/mp4",
                                "mov": "video/quicktime",
                                "avi": "video/x-msvideo",
                                "mkv": "video/x-matroska",
                            }
                            guessed_video_mime = (
                                file.content_type
                                or video_mime_map.get(ext)
                                or mimetypes.guess_type(file.filename)[0]
                                or "video/mp4"
                            )
                            audio_path = input_path
                            audio_mime = guessed_video_mime
                            logger.warning(
                                "FFmpeg conversion failed for %s; falling back to source media with MIME %s",
                                file.filename,
                                audio_mime,
                            )
                    else:
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

                    duration_seconds = get_media_duration(audio_path) or 0.0

                    hours, rem = divmod(duration_seconds, 3600)
                    minutes, seconds = divmod(rem, 60)
                    title_data["FILE_DURATION"] = "{:0>2}:{:0>2}:{:0>2}".format(
                        int(hours),
                        int(minutes),
                        int(round(seconds)),
                    )

                    gemini_lines = await anyio.to_thread.run_sync(
                        transcribe_with_gemini,
                        audio_path,
                        audio_mime,
                        duration_seconds,
                        speaker_list,
                    )

                    normalized_lines, normalized_duration = normalize_line_payloads(
                        gemini_lines,
                        duration_seconds,
                    )
                    turns = construct_turns_from_lines(normalized_lines)

                    if not turns:
                        raise HTTPException(status_code=400, detail="Gemini transcription returned no usable turns")

                    duration_seconds = normalized_duration
                    asr_elapsed = time.time() - asr_start_time
                    logger.info("Gemini completed in %.1fs. Generated %d turns.", asr_elapsed, len(turns))

            except HTTPException:
                raise
            except Exception as e:
                logger.exception("Gemini transcription error")
                raise HTTPException(status_code=500, detail=f"Gemini transcription failed: {str(e)}") from e

        logger.info("Preserving native ASR/Gemini word timestamps for initial transcription")

        pdf_bytes, oncue_xml, transcript_text, line_payloads = build_session_artifacts(
            turns,
            title_data,
            duration_seconds or 0,
            DEFAULT_LINES_PER_PAGE,
        )
        pdf_b64 = base64.b64encode(pdf_bytes).decode()

        created_at = datetime.now(timezone.utc)

        transcript_data = {
            "media_key": media_key,
            "created_at": created_at.isoformat(),
            "title_data": title_data,
            "audio_duration": float(duration_seconds or 0),
            "lines_per_page": DEFAULT_LINES_PER_PAGE,
            "turns": serialize_transcript_turns(turns),
            "source_turns": serialize_transcript_turns(turns),
            "lines": line_payloads,
            "pdf_base64": pdf_b64,
            "transcript_text": transcript_text,
            "transcript": transcript_text,
            "media_blob_name": media_blob_name,
            "media_content_type": media_content_type,
            "updated_at": created_at.isoformat(),
            "user_id": current_user["user_id"],
            "clips": [],
            "case_id": case_id if case_id else None,
            "is_persistent": bool(case_id),
        }

        media_filename = resolve_media_filename(title_data, media_blob_name, fallback=file.filename or "media.mp4")
        transcript_data.update(
            build_variant_exports(
                APP_VARIANT,
                line_payloads,
                title_data,
                duration_seconds or 0,
                DEFAULT_LINES_PER_PAGE,
                media_filename,
                media_content_type,
                oncue_xml=oncue_xml,
            )
        )

        try:
            save_current_transcript(media_key, transcript_data)

            snapshot_id = uuid.uuid4().hex
            snapshot_payload = build_snapshot_payload(transcript_data, is_manual_save=True)
            bucket = storage_client.bucket(BUCKET_NAME)
            snapshot_blob = bucket.blob(f"transcripts/{media_key}/history/{snapshot_id}.json")
            snapshot_blob.upload_from_string(json.dumps(snapshot_payload), content_type="application/json")

            # If case_id provided, add transcript to case (makes it persistent)
            if case_id:
                try:
                    title_label = title_data.get("CASE_NAME") or title_data.get("FILE_NAME") or media_key
                    add_transcript_to_case(current_user["user_id"], case_id, media_key, title_label)
                    logger.info("Added transcript %s to case %s", media_key, case_id)
                except Exception as case_err:
                    logger.warning("Failed to add transcript to case %s: %s", case_id, case_err)
                    # Don't fail the whole request - transcript was saved, case assignment can be retried

        except Exception as e:
            logger.error("Failed to store transcript: %s", e)
            raise HTTPException(status_code=500, detail="Unable to persist transcript") from e

        response_data = {
            **transcript_data,
            "transcript": transcript_text,
        }

        return JSONResponse(response_data)
    finally:
        if temp_upload_path and os.path.exists(temp_upload_path):
            try:
                os.remove(temp_upload_path)
            except OSError:
                pass


@router.get("/api/transcripts")
async def list_transcripts_endpoint(current_user: dict = Depends(get_current_user)):
    """List all transcripts for authenticated user."""
    try:
        transcripts = list_all_transcripts(current_user["user_id"])
        return JSONResponse(content={"transcripts": transcripts})
    except Exception as e:
        logger.error("Failed to list transcripts: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/transcripts/by-key/{media_key}/history")
async def list_transcript_history_by_media_key(media_key: str, current_user: dict = Depends(get_current_user)):
    """List all snapshots for a media_key."""
    try:
        if not _user_owns_media_key(media_key, current_user["user_id"]):
            raise HTTPException(status_code=403, detail="Access denied to this transcript")

        logger.info("Fetching history for media_key: %s", media_key)
        bucket = storage_client.bucket(BUCKET_NAME)
        prefix = f"transcripts/{media_key}/history/"
        logger.info("Looking for snapshots at prefix: %s", prefix)

        snapshots = []
        blob_count = 0
        for blob in bucket.list_blobs(prefix=prefix):
            blob_count += 1
            try:
                data = json.loads(blob.download_as_string())
                is_manual = data.get("is_manual_save", data.get("saved", False))
                snapshots.append(
                    {
                        "snapshot_id": blob.name.split("/")[-1].replace(".json", ""),
                        "created_at": data.get("created_at"),
                        "is_manual_save": is_manual,
                        "line_count": data.get("line_count", 0),
                        "title_label": data.get("title_label", "Transcript"),
                    }
                )
            except Exception as e:
                logger.warning("Failed to parse snapshot blob %s: %s", blob.name, e)
                continue

        logger.info("Found %d blobs, %d valid snapshots", blob_count, len(snapshots))

        snapshots.sort(key=lambda x: x["created_at"] or "", reverse=True)

        return JSONResponse(content={"snapshots": snapshots})

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to list history for %s: %s", media_key, e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/transcripts/by-key/{media_key}")
async def get_transcript_by_media_key(media_key: str, current_user: dict = Depends(get_current_user)):
    """Get current transcript state or latest snapshot by media_key."""
    try:
        data = load_current_transcript(media_key)
        if not data:
            raise HTTPException(status_code=404, detail="Transcript not found")

        if data.get("user_id") != current_user["user_id"]:
            raise HTTPException(status_code=403, detail="Access denied to this transcript")

        return JSONResponse(content=data)
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to load transcript %s: %s", media_key, e)
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/api/transcripts/by-key/{media_key}")
async def save_transcript_by_media_key(media_key: str, request: Request, current_user: dict = Depends(get_current_user)):
    """Save transcript changes (auto-save or manual save)."""
    try:
        payload = await request.json()

        lines = payload.get("lines", [])
        title_data = payload.get("title_data", {})
        is_manual_save = payload.get("is_manual_save", False)
        user_id = current_user["user_id"]

        existing = load_current_transcript(media_key) or {}
        if existing and existing.get("user_id") and existing.get("user_id") != user_id:
            raise HTTPException(status_code=403, detail="Access denied to this transcript")

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

        try:
            normalized_lines, normalized_duration = normalize_line_payloads(
                lines,
                float(transcript_data.get("audio_duration") or 0.0),
            )
            turns = construct_turns_from_lines(normalized_lines)
            pdf_bytes, oncue_xml, transcript_text, updated_lines = build_session_artifacts(
                turns,
                title_data,
                normalized_duration,
                transcript_data.get("lines_per_page", DEFAULT_LINES_PER_PAGE),
                enforce_min_line_duration=False,
            )
            transcript_data["lines"] = updated_lines
            transcript_data["audio_duration"] = normalized_duration
            transcript_data["pdf_base64"] = base64.b64encode(pdf_bytes).decode("ascii")
            transcript_data["transcript_text"] = transcript_text
            transcript_data["transcript"] = transcript_text

            media_filename = resolve_media_filename(
                title_data,
                transcript_data.get("media_blob_name"),
                fallback="media.mp4",
            )
            transcript_data.update(
                build_variant_exports(
                    APP_VARIANT,
                    updated_lines,
                    title_data,
                    normalized_duration,
                    transcript_data.get("lines_per_page", DEFAULT_LINES_PER_PAGE),
                    media_filename,
                    transcript_data.get("media_content_type"),
                    oncue_xml=oncue_xml,
                )
            )
        except Exception as e:
            logger.warning("Failed to regenerate documents: %s", e)

        save_current_transcript(media_key, transcript_data)

        snapshot_id = uuid.uuid4().hex
        snapshot_payload = build_snapshot_payload(transcript_data, is_manual_save=is_manual_save)
        bucket = storage_client.bucket(BUCKET_NAME)
        snapshot_blob = bucket.blob(f"transcripts/{media_key}/history/{snapshot_id}.json")
        snapshot_blob.upload_from_string(json.dumps(snapshot_payload), content_type="application/json")

        prune_snapshots(media_key)

        return JSONResponse(content=transcript_data)

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Save failed for %s: %s", media_key, e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/transcripts/by-key/{media_key}/restore/{snapshot_id}")
async def restore_snapshot_by_media_key(media_key: str, snapshot_id: str, current_user: dict = Depends(get_current_user)):
    """Restore a specific snapshot as current state."""
    try:
        if not _user_owns_media_key(media_key, current_user["user_id"]):
            raise HTTPException(status_code=403, detail="Access denied to this transcript")

        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(f"transcripts/{media_key}/history/{snapshot_id}.json")

        if not blob.exists():
            raise HTTPException(status_code=404, detail="Snapshot not found")

        snapshot_data = json.loads(blob.download_as_string())

        if not snapshot_data.get("media_key"):
            snapshot_data["media_key"] = media_key

        lines = snapshot_data.get("lines") or []
        if lines:
            title_data = snapshot_data.get("title_data") or {}
            lines_per_page = snapshot_data.get("lines_per_page", DEFAULT_LINES_PER_PAGE)
            audio_duration = float(snapshot_data.get("audio_duration") or 0.0)
            try:
                normalized_lines, normalized_duration = normalize_line_payloads(lines, audio_duration)
                turns = construct_turns_from_lines(normalized_lines)
                if turns:
                    pdf_bytes, oncue_xml, transcript_text, updated_lines = build_session_artifacts(
                        turns,
                        title_data,
                        normalized_duration,
                        lines_per_page,
                        enforce_min_line_duration=False,
                    )
                    snapshot_data["lines"] = updated_lines
                    snapshot_data["audio_duration"] = normalized_duration
                    snapshot_data["pdf_base64"] = base64.b64encode(pdf_bytes).decode("ascii")
                    snapshot_data["transcript_text"] = transcript_text
                    snapshot_data["transcript"] = transcript_text

                    media_filename = resolve_media_filename(
                        title_data,
                        snapshot_data.get("media_blob_name"),
                        fallback="media.mp4",
                    )
                    snapshot_data.update(
                        build_variant_exports(
                            APP_VARIANT,
                            updated_lines,
                            title_data,
                            normalized_duration,
                            lines_per_page,
                            media_filename,
                            snapshot_data.get("media_content_type"),
                            oncue_xml=oncue_xml,
                        )
                    )
            except Exception as exc:
                logger.warning("Failed to rebuild snapshot artifacts for %s: %s", media_key, exc)

        snapshot_data["updated_at"] = datetime.now(timezone.utc).isoformat()

        save_current_transcript(media_key, snapshot_data)

        return JSONResponse(content=snapshot_data)

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to restore snapshot %s for %s: %s", snapshot_id, media_key, e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/transcripts/by-key/{media_key}/gemini-refine")
async def gemini_refine_transcript(media_key: str, current_user: dict = Depends(get_current_user)):
    session_data = load_current_transcript(media_key)
    if not session_data:
        raise HTTPException(status_code=404, detail="Transcript not found")
    if session_data.get("user_id") and session_data.get("user_id") != current_user["user_id"]:
        raise HTTPException(status_code=403, detail="Access denied to this transcript")

    media_blob_name = session_data.get("media_blob_name")
    if not media_blob_name:
        raise HTTPException(status_code=400, detail="This session has no media attached for Gemini refinement")

    xml_b64 = session_data.get("oncue_xml_base64")
    if not xml_b64:
        raise HTTPException(status_code=400, detail="OnCue XML is missing for this session")

    try:
        xml_text = base64.b64decode(xml_b64).decode("utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(status_code=400, detail="Unable to decode the session XML") from e

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

        pdf_bytes, oncue_xml, transcript_text, updated_lines_payload = build_session_artifacts(
            turns,
            title_data,
            normalized_duration,
            lines_per_page,
        )

        pdf_b64 = base64.b64encode(pdf_bytes).decode()

        hours, rem = divmod(normalized_duration, 3600)
        minutes, seconds = divmod(rem, 60)
        title_data["FILE_DURATION"] = "{:0>2}:{:0>2}:{:0>2}".format(
            int(hours),
            int(minutes),
            int(round(seconds)),
        )

        updated_at = datetime.now(timezone.utc)
        session_data["turns"] = serialize_transcript_turns(turns)
        session_data["lines"] = updated_lines_payload
        session_data["title_data"] = title_data
        session_data["audio_duration"] = normalized_duration
        session_data["pdf_base64"] = pdf_b64
        session_data["transcript_text"] = transcript_text
        session_data["transcript"] = transcript_text
        session_data["updated_at"] = updated_at.isoformat()

        media_filename = resolve_media_filename(
            title_data,
            session_data.get("media_blob_name"),
            fallback="media.mp4",
        )
        session_data.update(
            build_variant_exports(
                APP_VARIANT,
                updated_lines_payload,
                title_data,
                normalized_duration,
                lines_per_page,
                media_filename,
                session_data.get("media_content_type"),
                oncue_xml=oncue_xml,
            )
        )

        save_current_transcript(media_key, session_data)

        return JSONResponse(session_data)
    finally:
        for path in (audio_path, media_path):
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except Exception:
                    pass


@router.post("/api/transcripts/import")
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
    Import a transcript from OnCue XML, HTML viewer, or DOCX file (deprecated path).

    - XML: Parses OnCue format, uses embedded timestamps
    - HTML: Parses embedded viewer JSON payload for timestamps
    - DOCX (deprecated): Parses speaker/text, runs Rev AI alignment for timestamps

    Media file is required for both to enable playback and re-sync.
    """
    filename = transcript_file.filename or ""
    file_ext = filename.lower().split('.')[-1] if '.' in filename else ''

    logger.info(
        "Import request: file=%s (type=%s), media=%s",
        filename,
        file_ext,
        media_file.filename if media_file else "None",
    )

    media_key = uuid.uuid4().hex
    transcript_path = None
    media_path = None
    try:
        transcript_path, transcript_size = await save_upload_to_tempfile(transcript_file)
        if not transcript_path or transcript_size == 0:
            raise HTTPException(status_code=400, detail="Uploaded transcript file is empty")

        if not media_file:
            raise HTTPException(status_code=400, detail="Media file is required for import")

        media_path, media_size = await save_upload_to_tempfile(media_file)
        if not media_path or media_size == 0:
            raise HTTPException(status_code=400, detail="Uploaded media file is empty")

        media_blob_name = None
        media_content_type = media_file.content_type or mimetypes.guess_type(media_file.filename)[0]
        duration_seconds = 0.0

        try:
            media_blob_name = upload_preview_file_to_cloud_storage_from_path(
                media_path,
                media_file.filename,
                media_content_type,
                user_id=current_user["user_id"],
                media_key=media_key,
            )
            logger.info("Import: uploaded media to blob %s", media_blob_name)

            audio_path, _, dur, original_media_path = await anyio.to_thread.run_sync(
                prepare_audio_for_gemini,
                media_blob_name,
                media_content_type,
            )
            duration_seconds = dur or 0.0
            for temp_path in (audio_path, original_media_path):
                if temp_path and os.path.exists(temp_path):
                    try:
                        os.remove(temp_path)
                    except OSError:
                        pass
        except Exception as e:
            logger.error("Failed to process media during import: %s", e)
            raise HTTPException(status_code=500, detail=f"Failed to process media file: {e}") from e

        with open(transcript_path, "rb") as transcript_stream:
            file_bytes = transcript_stream.read()
        if not file_bytes:
            raise HTTPException(status_code=400, detail="Uploaded transcript file is empty")

        lines_per_page = DEFAULT_LINES_PER_PAGE
        title_data: dict = {}

        if file_ext == 'xml':
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

        elif file_ext in ('html', 'htm'):
            html_text = file_bytes.decode("utf-8", errors="replace")
            parsed = parse_viewer_html(html_text)
            title_data = parsed["title_data"]
            html_duration = float(parsed.get("audio_duration") or 0.0)
            if html_duration > 0:
                duration_seconds = html_duration
            lines_per_page = parsed.get("lines_per_page", DEFAULT_LINES_PER_PAGE)

            lines_payload = parsed["lines"]
            normalized_lines, duration_seconds = normalize_line_payloads(lines_payload, duration_seconds)
            turns = construct_turns_from_lines(normalized_lines)

            if not turns:
                raise HTTPException(status_code=400, detail="Unable to construct transcript turns from HTML viewer")

        elif file_ext == 'docx':
            docx_turns = parse_docx_to_turns(file_bytes)

            if not docx_turns:
                raise HTTPException(status_code=400, detail="Unable to parse transcript from DOCX")

            turns = [
                TranscriptTurn(
                    speaker=turn["speaker"],
                    text=turn["text"],
                    timestamp=None,
                    words=None,
                    is_continuation=bool(turn.get("is_continuation", False)),
                )
                for turn in docx_turns
            ]

            rev_api_key = os.getenv("REV_AI_API_KEY")
            if rev_api_key and media_blob_name:
                alignment_audio_path = None
                alignment_media_path = None
                alignment_start_time = time.time()
                try:
                    logger.info("Running Rev AI alignment for DOCX import...")

                    alignment_audio_path, _, _, alignment_media_path = await anyio.to_thread.run_sync(
                        prepare_audio_for_gemini,
                        media_blob_name,
                        media_content_type,
                    )

                    aligner = RevAIAligner(rev_api_key)
                    turns_payload = [turn.model_dump() for turn in turns]

                    aligned_turns_payload = await anyio.to_thread.run_sync(
                        aligner.align_transcript,
                        turns_payload,
                        alignment_audio_path,
                        None,
                    )

                    turns = [TranscriptTurn(**turn) for turn in aligned_turns_payload]
                    alignment_elapsed = time.time() - alignment_start_time
                    logger.info("Rev AI alignment completed in %.1fs for DOCX import", alignment_elapsed)

                except Exception as e:
                    logger.warning("Rev AI alignment failed for DOCX import: %s", e)
                finally:
                    for temp_path in (alignment_audio_path, alignment_media_path):
                        if temp_path and os.path.exists(temp_path):
                            try:
                                os.remove(temp_path)
                            except OSError:
                                pass
            else:
                logger.warning("REV_AI_API_KEY not configured, DOCX import will have no timestamps")

            title_data = {}
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type: {file_ext}. Use .xml (OnCue), .html (viewer), or .docx (deprecated)",
            )

        overrides = {
            "CASE_NAME": case_name or title_data.get("CASE_NAME", ""),
            "CASE_NUMBER": case_number or title_data.get("CASE_NUMBER", ""),
            "FIRM_OR_ORGANIZATION_NAME": firm_name or title_data.get("FIRM_OR_ORGANIZATION_NAME", ""),
            "DATE": input_date or title_data.get("DATE", ""),
            "TIME": input_time or title_data.get("TIME", ""),
            "LOCATION": location or title_data.get("LOCATION", ""),
            "FILE_NAME": title_data.get("FILE_NAME") or media_file.filename or filename or "imported",
        }
        title_data.update(overrides)

        title_data["MEDIA_ID"] = media_key

        pdf_bytes_out, oncue_xml, transcript_text, line_payloads = build_session_artifacts(
            turns,
            title_data,
            duration_seconds,
            lines_per_page,
        )

        pdf_b64 = base64.b64encode(pdf_bytes_out).decode()

        created_at = datetime.now(timezone.utc)

        try:
            transcript_data = {
                "media_key": media_key,
                "created_at": created_at.isoformat(),
                "updated_at": created_at.isoformat(),
                "title_data": title_data,
                "audio_duration": duration_seconds,
                "lines_per_page": lines_per_page,
                "turns": serialize_transcript_turns(turns),
                "source_turns": serialize_transcript_turns(turns),
                "lines": line_payloads,
                "pdf_base64": pdf_b64,
                "transcript_text": transcript_text,
                "transcript": transcript_text,
                "media_blob_name": media_blob_name,
                "media_content_type": media_content_type,
                "user_id": current_user["user_id"],
                "clips": [],
            }

            media_filename = resolve_media_filename(
                title_data,
                media_blob_name,
                fallback=media_file.filename or filename or "media.mp4",
            )
            transcript_data.update(
                build_variant_exports(
                    APP_VARIANT,
                    line_payloads,
                    title_data,
                    duration_seconds,
                    lines_per_page,
                    media_filename,
                    media_content_type,
                    oncue_xml=oncue_xml,
                )
            )

            save_current_transcript(media_key, transcript_data)

            snapshot_id = uuid.uuid4().hex
            snapshot_payload = build_snapshot_payload(transcript_data, is_manual_save=True)
            bucket = storage_client.bucket(BUCKET_NAME)
            snapshot_blob = bucket.blob(f"transcripts/{media_key}/history/{snapshot_id}.json")
            snapshot_blob.upload_from_string(json.dumps(snapshot_payload), content_type="application/json")
            logger.info("Created initial snapshot for imported transcript: %s", media_key)

        except Exception as e:
            logger.error("Failed to save imported transcript: %s", e)
            raise HTTPException(status_code=500, detail="Unable to persist imported transcript") from e

        return JSONResponse(dict(transcript_data))
    finally:
        for temp_path in (transcript_path, media_path):
            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass


@router.post("/api/resync")
async def resync_transcript(
    payload: dict = Body(...),
    current_user: dict = Depends(get_current_user),
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

    session_data = load_current_transcript(media_key)
    if not session_data:
        raise HTTPException(status_code=404, detail="Transcript not found")
    if session_data.get("user_id") and session_data.get("user_id") != current_user["user_id"]:
        raise HTTPException(status_code=403, detail="Access denied to this transcript")

    media_blob_name = session_data.get("media_blob_name")
    media_content_type = session_data.get("media_content_type")

    logger.info(
        "Resync: media_key=%s, media_blob_name=%s, media_content_type=%s",
        media_key,
        media_blob_name,
        media_content_type,
    )

    if not media_blob_name:
        raise HTTPException(status_code=400, detail="Audio file reference not found in session")

    audio_path = None
    try:
        audio_path, _, _, _ = await anyio.to_thread.run_sync(
            prepare_audio_for_gemini,
            media_blob_name,
            media_content_type,
        )
    except Exception as e:
        logger.error("Failed to prepare audio for re-sync: %s", e)
        raise HTTPException(status_code=500, detail=f"Failed to prepare audio: {e}") from e

    try:
        rev_api_key = payload.get("api_key") or os.getenv("REV_AI_API_KEY")
        if not rev_api_key:
            raise HTTPException(status_code=500, detail="Rev AI API Key not configured")

        aligner = RevAIAligner(rev_api_key)

        lines = session_data.get("lines", [])
        if not lines:
            raise HTTPException(status_code=400, detail="No transcript lines to align")

        audio_duration = session_data.get("audio_duration", 0.0)
        normalized_lines, _ = normalize_line_payloads(lines, audio_duration)
        turns = construct_turns_from_lines(normalized_lines)

        turns_payload = [turn.model_dump() for turn in turns]
        source_turns_payload = session_data.get("source_turns")

        updated_turns_payload = await anyio.to_thread.run_sync(
            aligner.align_transcript,
            turns_payload,
            audio_path,
            None,
            source_turns_payload,
        )

        updated_turns = [TranscriptTurn(**turn) for turn in updated_turns_payload]

        title_data = session_data.get("title_data", {})
        lines_per_page = session_data.get("lines_per_page", DEFAULT_LINES_PER_PAGE)

        pdf_bytes, oncue_xml, transcript_text, new_line_entries = build_session_artifacts(
            updated_turns,
            title_data,
            audio_duration,
            lines_per_page,
        )

        session_data["lines"] = new_line_entries
        session_data["turns"] = serialize_transcript_turns(updated_turns)
        session_data["pdf_base64"] = base64.b64encode(pdf_bytes).decode()
        session_data["transcript_text"] = transcript_text
        session_data["updated_at"] = datetime.now(timezone.utc).isoformat()

        # Conditionally generate OnCue XML or HTML viewer based on app variant
        response_data = {
            "status": "success",
            "lines": new_line_entries,
            "pdf_base64": session_data["pdf_base64"],
        }

        media_filename = resolve_media_filename(
            title_data,
            session_data.get("media_blob_name"),
            fallback="media.mp4",
        )
        exports = build_variant_exports(
            APP_VARIANT,
            new_line_entries,
            title_data,
            audio_duration,
            lines_per_page,
            media_filename,
            session_data.get("media_content_type"),
            oncue_xml=oncue_xml,
        )
        session_data.update(exports)
        response_data.update(exports)

        save_current_transcript(media_key, session_data)

        return response_data

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Re-sync failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Re-sync process failed: {e}") from e

    finally:
        if audio_path and os.path.exists(audio_path):
            try:
                os.remove(audio_path)
            except OSError:
                pass


@router.post("/api/transcripts/by-key/{media_key}/regenerate-viewer")
async def regenerate_viewer_html(media_key: str, current_user: dict = Depends(get_current_user)):
    """Rebuild HTML viewer export from current session state without creating a snapshot."""
    if APP_VARIANT != "criminal":
        raise HTTPException(status_code=400, detail="HTML viewer exports are not enabled for this variant")
    try:
        transcript = load_current_transcript(media_key)
        if not transcript:
            raise HTTPException(status_code=404, detail="Transcript not found")
        if transcript.get("user_id") != current_user["user_id"]:
            raise HTTPException(status_code=403, detail="Access denied to this transcript")

        lines = transcript.get("lines") or []
        title_data = transcript.get("title_data") or {}
        audio_duration = float(transcript.get("audio_duration") or 0.0)
        lines_per_page = transcript.get("lines_per_page", DEFAULT_LINES_PER_PAGE)

        media_filename = resolve_media_filename(
            title_data,
            transcript.get("media_blob_name"),
            fallback=title_data.get("FILE_NAME") or "media.mp4",
        )

        oncue_xml = None
        oncue_b64 = transcript.get("oncue_xml_base64")
        if oncue_b64:
            try:
                oncue_xml = base64.b64decode(oncue_b64).decode("utf-8", errors="replace")
            except Exception:
                oncue_xml = None

        exports = build_variant_exports(
            APP_VARIANT,
            lines,
            title_data,
            audio_duration,
            lines_per_page,
            media_filename,
            transcript.get("media_content_type"),
            oncue_xml=oncue_xml,
        )
        transcript.update(exports)
        transcript["updated_at"] = datetime.now(timezone.utc).isoformat()
        save_current_transcript(media_key, transcript)

        return JSONResponse({
            "viewer_html_base64": transcript.get("viewer_html_base64"),
            "updated_at": transcript.get("updated_at"),
        })

    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Failed to regenerate viewer HTML for %s: %s", media_key, exc)
        raise HTTPException(status_code=500, detail="Failed to regenerate viewer HTML") from exc


@router.get("/api/transcripts/by-key/{media_key}/media-status")
async def get_media_status(media_key: str, current_user: dict = Depends(get_current_user)):
    """
    Check if the media file for a transcript still exists.
    Returns availability status and blob info.
    """
    try:
        # Load transcript and verify ownership
        transcript = load_current_transcript(media_key)
        if not transcript:
            raise HTTPException(status_code=404, detail="Transcript not found")
        if transcript.get("user_id") != current_user["user_id"]:
            raise HTTPException(status_code=403, detail="Access denied to this transcript")

        blob_name = transcript.get("media_blob_name")
        content_type = transcript.get("media_content_type")

        # Check if media exists
        available = check_media_exists(blob_name) if blob_name else False

        return JSONResponse({
            "media_available": available,
            "available": available,
            "blob_name": blob_name,
            "content_type": content_type,
            "media_key": media_key,
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to check media status for %s: %s", media_key, e)
        raise HTTPException(status_code=500, detail="Failed to check media status")


@router.post("/api/transcripts/by-key/{media_key}/reattach-media")
async def reattach_media(
    media_key: str,
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
):
    """
    Upload a new media file to attach to an existing transcript.
    Used when the original media has expired but the transcript is persistent.
    """
    try:
        # Load transcript and verify ownership
        transcript = load_current_transcript(media_key)
        if not transcript:
            raise HTTPException(status_code=404, detail="Transcript not found")
        if transcript.get("user_id") != current_user["user_id"]:
            raise HTTPException(status_code=403, detail="Access denied to this transcript")

        # Save uploaded file to temp
        temp_path, file_size = await save_upload_to_tempfile(file)

        try:
            # Upload to cloud storage
            content_type = file.content_type or mimetypes.guess_type(file.filename)[0]
            blob_name = upload_preview_file_to_cloud_storage_from_path(
                temp_path,
                file.filename,
                content_type,
                user_id=current_user["user_id"],
                media_key=media_key,
            )

            # Update transcript with new media reference
            title_data = transcript.get("title_data") or {}
            if file.filename:
                title_data["FILE_NAME"] = file.filename
            transcript["title_data"] = title_data
            transcript["media_blob_name"] = blob_name
            transcript["media_content_type"] = content_type
            transcript["updated_at"] = datetime.now(timezone.utc).isoformat()

            lines = transcript.get("lines") or []
            audio_duration = float(transcript.get("audio_duration") or 0.0)
            lines_per_page = transcript.get("lines_per_page", DEFAULT_LINES_PER_PAGE)
            oncue_xml = None
            oncue_b64 = transcript.get("oncue_xml_base64")
            if oncue_b64:
                try:
                    oncue_xml = base64.b64decode(oncue_b64).decode("utf-8", errors="replace")
                except Exception:
                    oncue_xml = None

            if APP_VARIANT == "oncue" and oncue_xml is None:
                normalized_lines, normalized_duration = normalize_line_payloads(lines, audio_duration)
                turns = construct_turns_from_lines(normalized_lines)
                if turns:
                    _pdf_bytes, oncue_xml, _transcript_text, updated_lines = build_session_artifacts(
                        turns,
                        title_data,
                        normalized_duration,
                        lines_per_page,
                        enforce_min_line_duration=False,
                    )
                    transcript["lines"] = updated_lines
                    transcript["audio_duration"] = normalized_duration

            media_filename = resolve_media_filename(
                title_data,
                blob_name,
                fallback=file.filename or "media.mp4",
            )
            transcript.update(
                build_variant_exports(
                    APP_VARIANT,
                    transcript.get("lines") or [],
                    title_data,
                    float(transcript.get("audio_duration") or 0.0),
                    lines_per_page,
                    media_filename,
                    content_type,
                    oncue_xml=oncue_xml,
                )
            )

            save_current_transcript(media_key, transcript)

            logger.info("Reattached media to transcript %s: %s", media_key, blob_name)

            return JSONResponse({
                "message": "Media file attached successfully",
                "media_key": media_key,
                "blob_name": blob_name,
                "content_type": content_type,
            })

        finally:
            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to reattach media for %s: %s", media_key, e)
        raise HTTPException(status_code=500, detail="Failed to attach media file")

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
from fastapi.responses import JSONResponse, Response

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
        delete_transcript_for_user,
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
            delete_transcript_for_user,
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
        delete_transcript_for_user = storage_module.delete_transcript_for_user
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
    from ..transcript_formatting import create_pdf
except ImportError:
    try:
        from transcript_formatting import create_pdf
    except ImportError:
        import transcript_formatting as transcript_formatting_module
        create_pdf = transcript_formatting_module.create_pdf

try:
    from ..viewer import get_viewer_template
except ImportError:
    try:
        from viewer import get_viewer_template
    except ImportError:
        import viewer as viewer_module
        get_viewer_template = viewer_module.get_viewer_template

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


@router.get("/api/viewer-template")
async def get_viewer_template_endpoint(current_user: dict = Depends(get_current_user)):
    if APP_VARIANT != "criminal":
        raise HTTPException(status_code=400, detail="Viewer template is only available for criminal variant")
    template_html = get_viewer_template()
    return Response(content=template_html, media_type="text/html")


@router.post("/api/format-pdf")
async def format_pdf_clip_excerpt(
    payload: dict = Body(...),
    current_user: dict = Depends(get_current_user),
):
    title_data = payload.get("title_data")
    line_entries = payload.get("line_entries")
    lines_per_page = payload.get("lines_per_page", DEFAULT_LINES_PER_PAGE)

    if not isinstance(title_data, dict):
        raise HTTPException(status_code=400, detail="title_data must be an object")
    if not isinstance(line_entries, list) or not line_entries:
        raise HTTPException(status_code=400, detail="line_entries must be a non-empty array")

    try:
        page_size = int(lines_per_page)
        if page_size <= 0:
            page_size = DEFAULT_LINES_PER_PAGE
    except (TypeError, ValueError):
        page_size = DEFAULT_LINES_PER_PAGE

    normalized_entries: List[dict] = []
    for idx, raw_entry in enumerate(line_entries):
        if not isinstance(raw_entry, dict):
            continue

        def _as_int(value, fallback):
            try:
                return int(value)
            except (TypeError, ValueError):
                return fallback

        def _as_float(value, fallback):
            try:
                return float(value)
            except (TypeError, ValueError):
                return fallback

        speaker = str(raw_entry.get("speaker") or "").strip()
        text = str(raw_entry.get("text") or "")
        rendered_text = str(raw_entry.get("rendered_text") or "")
        if not rendered_text:
            if speaker:
                rendered_text = f"          {speaker}:   {text}"
            else:
                rendered_text = text

        page = _as_int(raw_entry.get("page"), (idx // page_size) + 1)
        line = _as_int(raw_entry.get("line"), (idx % page_size) + 1)
        pgln = _as_int(raw_entry.get("pgln"), (page * 100) + line)
        start = _as_float(raw_entry.get("start"), 0.0)
        end = _as_float(raw_entry.get("end"), start)

        normalized_entries.append(
            {
                "id": str(raw_entry.get("id") or f"line-{idx}"),
                "speaker": speaker,
                "text": text,
                "rendered_text": rendered_text,
                "start": start,
                "end": end,
                "page": page,
                "line": line,
                "pgln": pgln,
                "is_continuation": bool(raw_entry.get("is_continuation", False)),
            }
        )

    if not normalized_entries:
        raise HTTPException(status_code=400, detail="No valid line_entries to format")

    try:
        pdf_bytes = create_pdf(title_data, normalized_entries, lines_per_page=page_size)
    except Exception as exc:
        logger.error("Failed to format PDF clip excerpt: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to generate PDF") from exc

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=clip-excerpt.pdf"},
    )


@router.post("/api/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    case_name: str = Form(""),
    case_number: str = Form(""),
    firm_name: str = Form(""),
    input_date: str = Form(""),
    input_time: str = Form(""),
    location: str = Form(""),
    speakers_expected: Optional[int] = Form(None),
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

    is_criminal = APP_VARIANT == "criminal"
    temp_upload_path = None
    try:
        temp_upload_path, file_size = await save_upload_to_tempfile(file)
        logger.info("File size: %.2f MB", file_size / (1024 * 1024))

        # Increase limit to 2GB
        if file_size > 2 * 1024 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="File too large. Maximum size is 2GB.")

        if not temp_upload_path:
            raise HTTPException(status_code=400, detail="Unable to read uploaded file")

        if speakers_expected is not None and speakers_expected <= 0:
            raise HTTPException(status_code=400, detail="speakers_expected must be a positive integer")

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

        # Upload media for editor playback (skip for criminal - media stays local)
        media_blob_name = None
        media_content_type = file.content_type or mimetypes.guess_type(file.filename)[0]
        if not is_criminal:
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
                    speakers_expected,
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
                        None,
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

        if is_criminal:
            # Criminal variant: return full transcript data without persisting to GCS
            # The client saves it to the local workspace folder
            response_data = {
                **transcript_data,
                "transcript": transcript_text,
            }
            return JSONResponse(response_data)

        # Oncue variant: persist to GCS as before
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
    if APP_VARIANT == "criminal":
        raise HTTPException(status_code=410, detail="Transcript listing is handled locally in this variant")
    try:
        transcripts = list_all_transcripts(current_user["user_id"])
        return JSONResponse(content={"transcripts": transcripts})
    except Exception as e:
        logger.error("Failed to list transcripts: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/transcripts/by-key/{media_key}/history")
async def list_transcript_history_by_media_key(media_key: str, current_user: dict = Depends(get_current_user)):
    """List all snapshots for a media_key."""
    if APP_VARIANT == "criminal":
        raise HTTPException(status_code=410, detail="Snapshot history is handled locally in this variant")
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
    if APP_VARIANT == "criminal":
        raise HTTPException(status_code=410, detail="Transcript retrieval is handled locally in this variant")
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


@router.delete("/api/transcripts/by-key/{media_key}")
async def delete_transcript_by_media_key(media_key: str, current_user: dict = Depends(get_current_user)):
    """Permanently delete a transcript, snapshots, and linked media artifacts."""
    if APP_VARIANT == "criminal":
        raise HTTPException(status_code=410, detail="Transcript deletion is handled locally in this variant")
    try:
        deleted = delete_transcript_for_user(current_user["user_id"], media_key)
        if not deleted:
            raise HTTPException(status_code=404, detail="Transcript not found")

        return JSONResponse(
            {
                "message": "Transcript deleted successfully",
                "media_key": media_key,
            }
        )

    except PermissionError:
        raise HTTPException(status_code=403, detail="Access denied to this transcript")
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to delete transcript %s: %s", media_key, e)
        raise HTTPException(status_code=500, detail="Failed to delete transcript")


@router.put("/api/transcripts/by-key/{media_key}")
async def save_transcript_by_media_key(media_key: str, request: Request, current_user: dict = Depends(get_current_user)):
    """Save transcript changes (auto-save or manual save)."""
    if APP_VARIANT == "criminal":
        raise HTTPException(status_code=410, detail="Transcript saving is handled locally in this variant")
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
    if APP_VARIANT == "criminal":
        raise HTTPException(status_code=410, detail="Snapshot restore is handled locally in this variant")
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
    if APP_VARIANT == "criminal":
        raise HTTPException(status_code=410, detail="Gemini refinement is handled via /api/gemini-refine in this variant")
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
    if APP_VARIANT == "criminal":
        raise HTTPException(status_code=410, detail="Transcript import is handled locally in this variant")

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
    Re-sync the transcript using Rev AI Forced Alignment (oncue variant).

    Payload:
      - media_key: string
      - api_key: string (optional, checks env if missing)
    """
    if APP_VARIANT == "criminal":
        raise HTTPException(status_code=410, detail="Use /api/resync-local for the criminal variant")

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


@router.post("/api/resync-local")
async def resync_transcript_local(
    media_file: UploadFile = File(...),
    transcript_data: str = Form(...),
    current_user: dict = Depends(get_current_user),
):
    """
    Re-sync transcript using Rev AI Forced Alignment (criminal variant).
    Accepts media file and transcript data as multipart form.
    Returns re-synced lines without persisting.
    """
    temp_media_path = None
    try:
        session_data = json.loads(transcript_data)
    except (json.JSONDecodeError, TypeError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid transcript_data JSON: {e}") from e

    try:
        temp_media_path, _ = await save_upload_to_tempfile(media_file)
        if not temp_media_path:
            raise HTTPException(status_code=400, detail="Unable to read uploaded media file")

        rev_api_key = os.getenv("REV_AI_API_KEY")
        if not rev_api_key:
            raise HTTPException(status_code=500, detail="Rev AI API Key not configured")

        aligner = RevAIAligner(rev_api_key)

        lines = session_data.get("lines", [])
        if not lines:
            raise HTTPException(status_code=400, detail="No transcript lines to align")

        audio_duration = float(session_data.get("audio_duration", 0.0))
        normalized_lines, _ = normalize_line_payloads(lines, audio_duration)
        turns = construct_turns_from_lines(normalized_lines)

        turns_payload = [turn.model_dump() for turn in turns]
        source_turns_payload = session_data.get("source_turns")

        updated_turns_payload = await anyio.to_thread.run_sync(
            aligner.align_transcript,
            turns_payload,
            temp_media_path,
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

        response_data = {
            "status": "success",
            "lines": new_line_entries,
            "turns": serialize_transcript_turns(updated_turns),
            "pdf_base64": base64.b64encode(pdf_bytes).decode(),
            "transcript_text": transcript_text,
        }

        media_filename = resolve_media_filename(
            title_data,
            None,
            fallback=media_file.filename or "media.mp4",
        )
        exports = build_variant_exports(
            APP_VARIANT,
            new_line_entries,
            title_data,
            audio_duration,
            lines_per_page,
            media_filename,
            media_file.content_type or mimetypes.guess_type(media_file.filename or "")[0],
            oncue_xml=oncue_xml,
        )
        response_data.update(exports)

        return response_data

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Local re-sync failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Re-sync process failed: {e}") from e
    finally:
        if temp_media_path and os.path.exists(temp_media_path):
            try:
                os.remove(temp_media_path)
            except OSError:
                pass


@router.post("/api/gemini-refine")
async def gemini_refine_local(
    media_file: UploadFile = File(...),
    transcript_data: str = Form(...),
    current_user: dict = Depends(get_current_user),
):
    """
    Gemini refinement for criminal variant.
    Accepts media file and transcript data as multipart form.
    Returns refined lines without persisting.
    """
    temp_media_path = None
    try:
        session_data = json.loads(transcript_data)
    except (json.JSONDecodeError, TypeError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid transcript_data JSON: {e}") from e

    try:
        temp_media_path, _ = await save_upload_to_tempfile(media_file)
        if not temp_media_path:
            raise HTTPException(status_code=400, detail="Unable to read uploaded media file")

        # Get or build the XML from transcript data
        xml_b64 = session_data.get("oncue_xml_base64")
        if xml_b64:
            xml_text = base64.b64decode(xml_b64).decode("utf-8", errors="replace")
        else:
            # Build XML from lines
            lines = session_data.get("lines", [])
            title_data = session_data.get("title_data", {})
            audio_duration = float(session_data.get("audio_duration", 0.0))
            lines_per_page = session_data.get("lines_per_page", DEFAULT_LINES_PER_PAGE)

            normalized_lines, normalized_duration = normalize_line_payloads(lines, audio_duration)
            turns = construct_turns_from_lines(normalized_lines)
            if not turns:
                raise HTTPException(status_code=400, detail="No usable transcript turns found")

            _, oncue_xml_str, _, _ = build_session_artifacts(
                turns, title_data, normalized_duration, lines_per_page,
            )
            if not oncue_xml_str:
                raise HTTPException(status_code=400, detail="Unable to generate XML for Gemini refinement")
            xml_text = oncue_xml_str

        # Prepare audio for Gemini
        media_content_type = media_file.content_type or mimetypes.guess_type(media_file.filename or "")[0]
        ext = (media_file.filename or "").split(".")[-1].lower() if media_file.filename and "." in media_file.filename else ""
        audio_path = temp_media_path
        audio_mime = media_content_type or "audio/mpeg"

        SUPPORTED_VIDEO_TYPES = ["mp4", "mov", "avi", "mkv"]
        temp_audio_dir = None
        if ext in SUPPORTED_VIDEO_TYPES:
            temp_audio_dir = tempfile.mkdtemp()
            output_audio = os.path.join(temp_audio_dir, "converted.mp3")
            converted = convert_video_to_audio(temp_media_path, output_audio)
            if converted:
                audio_path = converted
                audio_mime = "audio/mpeg"
        else:
            mime_map = {
                "mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4",
                "flac": "audio/flac", "ogg": "audio/ogg", "aac": "audio/aac",
            }
            audio_mime = mime_map.get(ext, audio_mime)

        duration_hint = float(session_data.get("audio_duration", 0.0))

        try:
            gemini_lines = await anyio.to_thread.run_sync(
                run_gemini_edit,
                xml_text,
                audio_path,
                audio_mime,
                duration_hint,
            )
        finally:
            if temp_audio_dir and os.path.exists(temp_audio_dir):
                import shutil
                shutil.rmtree(temp_audio_dir, ignore_errors=True)

        normalized_lines, normalized_duration = normalize_line_payloads(gemini_lines, duration_hint)
        turns = construct_turns_from_lines(normalized_lines)
        if not turns:
            raise HTTPException(status_code=400, detail="Gemini refinement returned no usable turns")

        title_data = session_data.get("title_data", {})
        lines_per_page = session_data.get("lines_per_page", DEFAULT_LINES_PER_PAGE)

        pdf_bytes, oncue_xml, transcript_text, updated_lines = build_session_artifacts(
            turns, title_data, normalized_duration, lines_per_page,
        )

        response_data = {
            "status": "success",
            "lines": updated_lines,
            "turns": serialize_transcript_turns(turns),
            "pdf_base64": base64.b64encode(pdf_bytes).decode(),
            "transcript_text": transcript_text,
            "audio_duration": normalized_duration,
        }

        media_filename = resolve_media_filename(
            title_data, None, fallback=media_file.filename or "media.mp4",
        )
        exports = build_variant_exports(
            APP_VARIANT,
            updated_lines,
            title_data,
            normalized_duration,
            lines_per_page,
            media_filename,
            media_content_type,
            oncue_xml=oncue_xml,
        )
        response_data.update(exports)

        return response_data

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Local Gemini refinement failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Gemini refinement failed: {e}") from e
    finally:
        if temp_media_path and os.path.exists(temp_media_path):
            try:
                os.remove(temp_media_path)
            except OSError:
                pass


@router.post("/api/transcripts/by-key/{media_key}/regenerate-viewer")
async def regenerate_viewer_html(media_key: str, current_user: dict = Depends(get_current_user)):
    """Rebuild HTML viewer export from current session state without creating a snapshot."""
    if APP_VARIANT == "criminal":
        raise HTTPException(status_code=410, detail="Viewer regeneration is handled locally in this variant")
    # Non-criminal variants don't support viewer HTML exports
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
    if APP_VARIANT == "criminal":
        raise HTTPException(status_code=410, detail="Media status is handled locally in this variant")
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
    if APP_VARIANT == "criminal":
        raise HTTPException(status_code=410, detail="Media reattachment is handled locally in this variant")
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

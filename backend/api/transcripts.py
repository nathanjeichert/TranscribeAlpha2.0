import base64
import json
import logging
import mimetypes
import os
import tempfile
import time
import uuid
from datetime import datetime, timezone
from typing import List, Optional

import anyio
from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

try:
    from ..auth import get_current_user
except ImportError:
    from auth import get_current_user

try:
    from ..config import DEFAULT_LINES_PER_PAGE, APP_VARIANT
except ImportError:
    from config import DEFAULT_LINES_PER_PAGE, APP_VARIANT

try:
    from ..gemini import run_gemini_edit, transcribe_with_gemini
except ImportError:
    from gemini import run_gemini_edit, transcribe_with_gemini

try:
    from ..models import TranscriptTurn
except ImportError:
    from models import TranscriptTurn

try:
    from ..rev_ai_sync import RevAIAligner
except ImportError:
    from rev_ai_sync import RevAIAligner

try:
    from ..storage import save_upload_to_tempfile
except ImportError:
    from storage import save_upload_to_tempfile

try:
    from ..transcriber import convert_video_to_audio, get_media_duration, process_transcription
except ImportError:
    from transcriber import convert_video_to_audio, get_media_duration, process_transcription

try:
    from ..transcript_formatting import create_pdf
except ImportError:
    from transcript_formatting import create_pdf

try:
    from ..transcript_utils import (
        build_session_artifacts,
        build_variant_exports,
        construct_turns_from_lines,
        normalize_line_payloads,
        normalize_speaker_label,
        resolve_media_filename,
        serialize_transcript_turns,
    )
except ImportError:
    from transcript_utils import (
        build_session_artifacts,
        build_variant_exports,
        construct_turns_from_lines,
        normalize_line_payloads,
        normalize_speaker_label,
        resolve_media_filename,
        serialize_transcript_turns,
    )

try:
    from ..viewer import get_viewer_template
except ImportError:
    from viewer import get_viewer_template


router = APIRouter()
logger = logging.getLogger(__name__)
_RESYNC_MEDIA_TTL_SECONDS = 15 * 60
_RESYNC_MEDIA_REGISTRY = {}


def _cleanup_resync_media_registry():
    now = time.time()
    expired_tokens = []
    for token, entry in list(_RESYNC_MEDIA_REGISTRY.items()):
        expires_at = float(entry.get("expires_at", 0))
        file_path = str(entry.get("path") or "")
        if expires_at <= now or not file_path or not os.path.exists(file_path):
            if file_path and os.path.exists(file_path):
                try:
                    os.remove(file_path)
                except OSError:
                    pass
            expired_tokens.append(token)
    for token in expired_tokens:
        _RESYNC_MEDIA_REGISTRY.pop(token, None)


def _register_resync_media(path: str, media_type: str, filename: str) -> str:
    token = uuid.uuid4().hex
    _RESYNC_MEDIA_REGISTRY[token] = {
        "path": path,
        "media_type": media_type or "application/octet-stream",
        "filename": filename or "media.bin",
        "expires_at": time.time() + _RESYNC_MEDIA_TTL_SECONDS,
    }
    return token


@router.get("/api/config")
async def get_app_config():
    """Return app configuration including variant and enabled export formats."""
    return JSONResponse(
        {
            "variant": APP_VARIANT,
            "features": {
                "oncue_xml": True,
                "viewer_html": True,
                "import_oncue": True,
                "import_viewer_html": True,
            },
        }
    )


@router.get("/api/viewer-template")
async def get_viewer_template_endpoint(current_user: dict = Depends(get_current_user)):
    _ = current_user
    template_html = get_viewer_template()
    return Response(content=template_html, media_type="text/html")


@router.post("/api/convert")
async def convert_media(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
):
    """Convert a proprietary audio/video file to a browser-playable format."""
    _ = current_user

    import shutil
    import subprocess

    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise HTTPException(status_code=500, detail="ffmpeg is not installed on the server")

    content_type = file.content_type or ""
    is_video = content_type.startswith("video/")
    out_ext = ".mp4" if is_video else ".wav"
    out_mime = "video/mp4" if is_video else "audio/wav"

    with tempfile.NamedTemporaryFile(
        suffix=os.path.splitext(file.filename or "input")[1] or ".wav",
        delete=False,
    ) as tmp_in:
        tmp_in_path = tmp_in.name
        chunk = await file.read(64 * 1024 * 1024)
        tmp_in.write(chunk)
        remainder = await file.read(1)
        if remainder:
            os.unlink(tmp_in_path)
            raise HTTPException(status_code=413, detail="File too large (max 64 MB)")

    tmp_out_path = tmp_in_path + out_ext
    try:
        if is_video:
            cmd = [
                ffmpeg_path,
                "-y",
                "-i",
                tmp_in_path,
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "18",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                tmp_out_path,
            ]
        else:
            cmd = [ffmpeg_path, "-y", "-i", tmp_in_path, "-acodec", "pcm_s16le", tmp_out_path]

        result = subprocess.run(cmd, capture_output=True, timeout=120)
        if result.returncode != 0:
            stderr_text = result.stderr.decode("utf-8", errors="replace")[-500:]
            raise HTTPException(status_code=422, detail=f"ffmpeg conversion failed: {stderr_text}")

        out_size = os.path.getsize(tmp_out_path)
        if out_size == 0:
            raise HTTPException(status_code=422, detail="ffmpeg produced an empty output file")

        orig_name = file.filename or "converted"
        dot = orig_name.rfind(".")
        base = orig_name[:dot] if dot != -1 else orig_name
        out_filename = f"{base}_converted{out_ext}"

        with open(tmp_out_path, "rb") as f:
            out_bytes = f.read()

        return Response(
            content=out_bytes,
            media_type=out_mime,
            headers={"Content-Disposition": f'attachment; filename="{out_filename}"'},
        )
    finally:
        for path in (tmp_in_path, tmp_out_path):
            try:
                os.unlink(path)
            except OSError:
                pass


@router.post("/api/format-pdf")
async def format_pdf_clip_excerpt(
    payload: dict = Body(...),
    current_user: dict = Depends(get_current_user),
):
    _ = current_user

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

        speaker = normalize_speaker_label(raw_entry.get("speaker") or "", fallback="SPEAKER")
        text = str(raw_entry.get("text") or "")
        rendered_text = str(raw_entry.get("rendered_text") or "")
        if not rendered_text:
            rendered_text = f"          {speaker}:   {text}" if speaker else text

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
    source_filename: Optional[str] = Form(None),
    current_user: dict = Depends(get_current_user),
):
    _ = current_user

    logger.info("Received transcription request for file=%s model=%s", file.filename, transcription_model)

    valid_models = {"assemblyai", "gemini"}
    if transcription_model not in valid_models:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid transcription model. Must be one of: {', '.join(valid_models)}",
        )

    if transcription_model == "assemblyai" and not os.getenv("ASSEMBLYAI_API_KEY"):
        raise HTTPException(status_code=500, detail="Server configuration error: AssemblyAI API key not configured")
    if transcription_model == "gemini" and not (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")):
        raise HTTPException(status_code=500, detail="Server configuration error: Gemini API key not configured")

    display_filename = (source_filename or "").strip() or file.filename or "media"
    media_content_type = file.content_type or mimetypes.guess_type(display_filename)[0] or "application/octet-stream"

    temp_upload_path = None
    try:
        temp_upload_path, file_size = await save_upload_to_tempfile(file)
        logger.info("Transcription upload size: %.2f MB", file_size / (1024 * 1024))

        if file_size > 2 * 1024 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="File too large. Maximum size is 2GB.")

        if not temp_upload_path:
            raise HTTPException(status_code=400, detail="Unable to read uploaded file")

        if speakers_expected is not None and speakers_expected <= 0:
            raise HTTPException(status_code=400, detail="speakers_expected must be a positive integer")

        media_key = uuid.uuid4().hex
        title_data = {
            "CASE_NAME": case_name,
            "CASE_NUMBER": case_number,
            "FIRM_OR_ORGANIZATION_NAME": firm_name,
            "DATE": input_date,
            "TIME": input_time,
            "LOCATION": location,
            "FILE_NAME": display_filename,
            "FILE_DURATION": "Calculating...",
            "MEDIA_ID": media_key,
        }

        duration_seconds = 0.0
        asr_start_time = time.time()

        if transcription_model == "assemblyai":
            turns, duration_seconds = process_transcription(
                None,
                file.filename or display_filename,
                speakers_expected,
                title_data,
                input_path=temp_upload_path,
            )
            logger.info("AssemblyAI completed in %.1fs (%d turns)", time.time() - asr_start_time, len(turns))
        else:
            with tempfile.TemporaryDirectory() as temp_dir:
                input_path = temp_upload_path
                ext = (file.filename or display_filename).split(".")[-1].lower()
                audio_path = input_path
                audio_mime = "audio/mpeg"

                supported_video_types = ["mp4", "mov", "avi", "mkv"]
                if ext in supported_video_types:
                    output_audio = os.path.join(
                        temp_dir,
                        f"{os.path.splitext(os.path.basename(file.filename or display_filename))[0]}.mp3",
                    )
                    converted_audio = convert_video_to_audio(input_path, output_audio)
                    if converted_audio:
                        audio_path = converted_audio
                        audio_mime = "audio/mpeg"
                    else:
                        video_mime_map = {
                            "mp4": "video/mp4",
                            "mov": "video/quicktime",
                            "avi": "video/x-msvideo",
                            "mkv": "video/x-matroska",
                        }
                        audio_path = input_path
                        audio_mime = file.content_type or video_mime_map.get(ext) or "video/mp4"
                        logger.warning("Video conversion failed for %s; falling back to source media", display_filename)
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

                normalized_lines, normalized_duration = normalize_line_payloads(gemini_lines, duration_seconds)
                turns = construct_turns_from_lines(normalized_lines)
                if not turns:
                    raise HTTPException(status_code=400, detail="Gemini transcription returned no usable turns")

                duration_seconds = normalized_duration
                logger.info("Gemini completed in %.1fs (%d turns)", time.time() - asr_start_time, len(turns))

        pdf_bytes, oncue_xml, transcript_text, line_payloads = build_session_artifacts(
            turns,
            title_data,
            duration_seconds or 0,
            DEFAULT_LINES_PER_PAGE,
        )

        transcript_data = {
            "media_key": media_key,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "title_data": title_data,
            "audio_duration": float(duration_seconds or 0),
            "lines_per_page": DEFAULT_LINES_PER_PAGE,
            "turns": serialize_transcript_turns(turns),
            "source_turns": serialize_transcript_turns(turns),
            "lines": line_payloads,
            "pdf_base64": base64.b64encode(pdf_bytes).decode("ascii"),
            "transcript_text": transcript_text,
            "transcript": transcript_text,
            "media_blob_name": None,
            "media_content_type": media_content_type,
            "media_filename": display_filename,
            "media_handle_id": media_key,
            "clips": [],
            "case_id": case_id or None,
        }

        media_filename = resolve_media_filename(title_data, None, fallback=display_filename or "media.mp4")
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

        return JSONResponse(transcript_data)
    finally:
        if temp_upload_path and os.path.exists(temp_upload_path):
            try:
                os.remove(temp_upload_path)
            except OSError:
                pass


@router.get("/api/resync-media/{token}", include_in_schema=False)
async def serve_resync_media(token: str):
    _cleanup_resync_media_registry()
    entry = _RESYNC_MEDIA_REGISTRY.get(token)
    if not entry:
        raise HTTPException(status_code=404, detail="Media token not found or expired")

    media_path = str(entry.get("path") or "")
    if not media_path or not os.path.exists(media_path):
        _RESYNC_MEDIA_REGISTRY.pop(token, None)
        raise HTTPException(status_code=404, detail="Media file not found")

    return FileResponse(
        media_path,
        media_type=str(entry.get("media_type") or "application/octet-stream"),
        filename=str(entry.get("filename") or os.path.basename(media_path)),
    )


@router.post("/api/resync")
async def resync_transcript(
    request: Request,
    media_file: UploadFile = File(...),
    transcript_data: str = Form(...),
    current_user: dict = Depends(get_current_user),
):
    """Re-sync transcript timestamps using Rev AI forced alignment (stateless)."""
    _ = current_user

    temp_media_path = None
    resync_media_token = None
    try:
        session_data = json.loads(transcript_data)
    except (json.JSONDecodeError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid transcript_data JSON: {exc}") from exc

    try:
        temp_media_path, _ = await save_upload_to_tempfile(media_file)
        if not temp_media_path:
            raise HTTPException(status_code=400, detail="Unable to read uploaded media file")

        _cleanup_resync_media_registry()
        media_content_type = media_file.content_type or mimetypes.guess_type(media_file.filename or "")[0] or "application/octet-stream"
        resync_media_token = _register_resync_media(
            temp_media_path,
            media_content_type,
            media_file.filename or "media.bin",
        )
        audio_url = str(request.url_for("serve_resync_media", token=resync_media_token))

        rev_api_key = os.getenv("REV_AI_API_KEY")
        if not rev_api_key:
            raise HTTPException(status_code=500, detail="Rev AI API Key not configured")

        aligner = RevAIAligner(rev_api_key)

        lines = session_data.get("lines", [])
        if not lines:
            raise HTTPException(status_code=400, detail="No transcript lines to align")

        audio_duration = float(session_data.get("audio_duration", 0.0))
        measured_duration = get_media_duration(temp_media_path)
        if measured_duration and measured_duration > 0:
            audio_duration = measured_duration

        normalized_lines, _ = normalize_line_payloads(lines, audio_duration)
        turns = construct_turns_from_lines(normalized_lines)

        turns_payload = [turn.model_dump() for turn in turns]
        source_turns_payload = session_data.get("source_turns")

        updated_turns_payload = await anyio.to_thread.run_sync(
            aligner.align_transcript,
            turns_payload,
            audio_url,
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
            media_content_type,
            oncue_xml=oncue_xml,
        )

        response_data = {
            "status": "success",
            "lines": new_line_entries,
            "turns": serialize_transcript_turns(updated_turns),
            "pdf_base64": base64.b64encode(pdf_bytes).decode("ascii"),
            "transcript_text": transcript_text,
            "audio_duration": audio_duration,
            **exports,
        }

        return JSONResponse(response_data)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Re-sync failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"Re-sync process failed: {exc}") from exc
    finally:
        if resync_media_token:
            _RESYNC_MEDIA_REGISTRY.pop(resync_media_token, None)
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
    """Gemini transcript refinement endpoint (stateless)."""
    _ = current_user

    temp_media_path = None
    try:
        session_data = json.loads(transcript_data)
    except (json.JSONDecodeError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid transcript_data JSON: {exc}") from exc

    try:
        temp_media_path, _ = await save_upload_to_tempfile(media_file)
        if not temp_media_path:
            raise HTTPException(status_code=400, detail="Unable to read uploaded media file")

        xml_b64 = session_data.get("oncue_xml_base64")
        if xml_b64:
            xml_text = base64.b64decode(xml_b64).decode("utf-8", errors="replace")
        else:
            lines = session_data.get("lines", [])
            title_data = session_data.get("title_data", {})
            audio_duration = float(session_data.get("audio_duration", 0.0))
            lines_per_page = session_data.get("lines_per_page", DEFAULT_LINES_PER_PAGE)

            normalized_lines, normalized_duration = normalize_line_payloads(lines, audio_duration)
            turns = construct_turns_from_lines(normalized_lines)
            if not turns:
                raise HTTPException(status_code=400, detail="No usable transcript turns found")

            _, oncue_xml_str, _, _ = build_session_artifacts(
                turns,
                title_data,
                normalized_duration,
                lines_per_page,
            )
            xml_text = oncue_xml_str

        media_content_type = media_file.content_type or mimetypes.guess_type(media_file.filename or "")[0]
        ext = (
            (media_file.filename or "").split(".")[-1].lower()
            if media_file.filename and "." in media_file.filename
            else ""
        )

        audio_path = temp_media_path
        audio_mime = media_content_type or "audio/mpeg"

        supported_video_types = ["mp4", "mov", "avi", "mkv"]
        temp_audio_dir = None
        if ext in supported_video_types:
            temp_audio_dir = tempfile.mkdtemp()
            output_audio = os.path.join(temp_audio_dir, "converted.mp3")
            converted = convert_video_to_audio(temp_media_path, output_audio)
            if converted:
                audio_path = converted
                audio_mime = "audio/mpeg"
        else:
            mime_map = {
                "mp3": "audio/mpeg",
                "wav": "audio/wav",
                "m4a": "audio/mp4",
                "flac": "audio/flac",
                "ogg": "audio/ogg",
                "aac": "audio/aac",
            }
            audio_mime = mime_map.get(ext, audio_mime)

        duration_hint = float(session_data.get("audio_duration", 0.0))
        if duration_hint <= 0:
            duration_hint = get_media_duration(audio_path) or 0.0

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
            turns,
            title_data,
            normalized_duration,
            lines_per_page,
        )

        media_filename = resolve_media_filename(
            title_data,
            None,
            fallback=media_file.filename or "media.mp4",
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

        response_data = {
            "status": "success",
            "lines": updated_lines,
            "turns": serialize_transcript_turns(turns),
            "pdf_base64": base64.b64encode(pdf_bytes).decode("ascii"),
            "transcript_text": transcript_text,
            "audio_duration": normalized_duration,
            **exports,
        }

        return JSONResponse(response_data)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Gemini refinement failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Gemini refinement failed: {exc}") from exc
    finally:
        if temp_media_path and os.path.exists(temp_media_path):
            try:
                os.remove(temp_media_path)
            except OSError:
                pass

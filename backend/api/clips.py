import base64
import uuid
from datetime import datetime, timedelta, timezone
from typing import Dict

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import JSONResponse

try:
    from ..auth import get_current_user
except ImportError:
    try:
        from auth import get_current_user
    except ImportError:
        import auth as auth_module
        get_current_user = auth_module.get_current_user

try:
    from ..config import CLIP_SESSION_TTL_DAYS, DEFAULT_LINES_PER_PAGE, APP_VARIANT
except ImportError:
    try:
        from config import CLIP_SESSION_TTL_DAYS, DEFAULT_LINES_PER_PAGE, APP_VARIANT
    except ImportError:
        import config as config_module
        CLIP_SESSION_TTL_DAYS = config_module.CLIP_SESSION_TTL_DAYS
        DEFAULT_LINES_PER_PAGE = config_module.DEFAULT_LINES_PER_PAGE
        APP_VARIANT = config_module.APP_VARIANT

try:
    from ..media_processing import clip_media_segment
except ImportError:
    try:
        from media_processing import clip_media_segment
    except ImportError:
        import media_processing as media_processing_module
        clip_media_segment = media_processing_module.clip_media_segment

try:
    from ..storage import (
        delete_clip_session,
        load_clip_session,
        load_current_transcript,
        save_clip_session,
        save_current_transcript,
    )
except ImportError:
    try:
        from storage import (
            delete_clip_session,
            load_clip_session,
            load_current_transcript,
            save_clip_session,
            save_current_transcript,
        )
    except ImportError:
        import storage as storage_module
        delete_clip_session = storage_module.delete_clip_session
        load_clip_session = storage_module.load_clip_session
        load_current_transcript = storage_module.load_current_transcript
        save_clip_session = storage_module.save_clip_session
        save_current_transcript = storage_module.save_current_transcript

try:
    from ..transcript_utils import (
        build_session_artifacts,
        build_variant_exports,
        construct_turns_from_lines,
        ensure_session_clip_list,
        normalize_line_payloads,
        parse_timecode_to_seconds,
        resolve_line_index,
        resolve_media_filename,
        sanitize_clip_label,
    )
except ImportError:
    try:
        from transcript_utils import (
            build_session_artifacts,
            build_variant_exports,
            construct_turns_from_lines,
            ensure_session_clip_list,
            normalize_line_payloads,
            parse_timecode_to_seconds,
            resolve_line_index,
            resolve_media_filename,
            sanitize_clip_label,
        )
    except ImportError:
        import transcript_utils as transcript_utils_module
        build_session_artifacts = transcript_utils_module.build_session_artifacts
        build_variant_exports = transcript_utils_module.build_variant_exports
        construct_turns_from_lines = transcript_utils_module.construct_turns_from_lines
        ensure_session_clip_list = transcript_utils_module.ensure_session_clip_list
        normalize_line_payloads = transcript_utils_module.normalize_line_payloads
        parse_timecode_to_seconds = transcript_utils_module.parse_timecode_to_seconds
        resolve_line_index = transcript_utils_module.resolve_line_index
        resolve_media_filename = transcript_utils_module.resolve_media_filename
        sanitize_clip_label = transcript_utils_module.sanitize_clip_label

try:
    from ..transcript_formatting import create_clip_docx
except ImportError:
    try:
        from transcript_formatting import create_clip_docx
    except ImportError:
        import transcript_formatting as transcript_formatting_module
        create_clip_docx = transcript_formatting_module.create_clip_docx

router = APIRouter()


@router.post("/api/clips")
async def create_clip(payload: Dict = Body(...), current_user: dict = Depends(get_current_user)):
    media_key = payload.get("media_key")
    if not media_key:
        raise HTTPException(status_code=400, detail="media_key is required")

    session_data = load_current_transcript(media_key)
    if not session_data:
        raise HTTPException(status_code=404, detail="Transcript not found")
    if session_data.get("user_id") and session_data.get("user_id") != current_user["user_id"]:
        raise HTTPException(status_code=403, detail="Access denied to this transcript")

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

    rebased_lines = []
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

    clip_count = len(ensure_session_clip_list(session_data))
    default_name = f"Clip {clip_count + 1}"
    clip_name = sanitize_clip_label(payload.get("clip_label"), default_name)

    clip_title_data = dict(session_data.get("title_data") or {})
    title_overrides = payload.get("title_overrides") if isinstance(payload.get("title_overrides"), dict) else {}
    for key, value in title_overrides.items():
        if value is not None:
            clip_title_data[key] = str(value)

    hours, remainder = divmod(normalized_duration, 3600)
    minutes, seconds = divmod(remainder, 60)
    clip_title_data["CLIP_DURATION"] = f"{int(hours):02d}:{int(minutes):02d}:{int(round(seconds)):02d}"
    clip_title_data["CLIP_TITLE"] = clip_name

    docx_bytes, oncue_xml, transcript_text, clip_line_entries = build_session_artifacts(
        turns,
        clip_title_data,
        normalized_duration,
        lines_per_page,
        enforce_min_line_duration=False,
    )
    docx_bytes = create_clip_docx(clip_title_data, turns, clip_name)

    docx_b64 = base64.b64encode(docx_bytes).decode()

    clip_media_blob_name, clip_media_content_type = clip_media_segment(
        session_data.get("media_blob_name"),
        start_absolute,
        end_absolute,
        session_data.get("media_content_type"),
        clip_name,
        user_id=session_data.get("user_id"),
        parent_media_key=media_key,
    )

    media_filename = resolve_media_filename(
        clip_title_data,
        clip_media_blob_name or session_data.get("media_blob_name"),
        fallback="media.mp4",
    )
    export_payload = build_variant_exports(
        APP_VARIANT,
        clip_line_entries,
        clip_title_data,
        normalized_duration,
        lines_per_page,
        media_filename,
        clip_media_content_type or session_data.get("media_content_type"),
        oncue_xml=oncue_xml,
    )

    clip_id = uuid.uuid4().hex
    created_at = datetime.now(timezone.utc)
    clip_expires_at = created_at + timedelta(days=CLIP_SESSION_TTL_DAYS)

    clip_data = {
        "clip_id": clip_id,
        "parent_media_key": media_key,
        "user_id": session_data.get("user_id"),
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
        "transcript_text": transcript_text,
        "lines": clip_line_entries,
        "title_data": clip_title_data,
        "lines_per_page": lines_per_page,
        "media_blob_name": clip_media_blob_name,
        "media_content_type": clip_media_content_type,
    }
    clip_data.update(export_payload)

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
        raise HTTPException(status_code=500, detail="Unable to persist clip data") from exc

    clips_list = ensure_session_clip_list(session_data)
    clips_list.append(clip_summary)

    session_data["updated_at"] = created_at.isoformat()
    session_data["media_key"] = media_key

    try:
        save_current_transcript(media_key, session_data)
    except Exception as exc:
        clips_list.pop()
        delete_clip_session(clip_id)
        raise HTTPException(status_code=500, detail="Unable to update session with clip metadata") from exc

    clip_response = dict(clip_data)
    clip_response.pop("parent_media_key", None)
    clip_response.pop("user_id", None)
    clip_response["transcript"] = clip_response.pop("transcript_text", "")
    clip_response["summary"] = clip_summary

    return JSONResponse({
        "clip": clip_response,
        "transcript": session_data,
    })


@router.get("/api/clips/{clip_id}")
async def get_clip_session(clip_id: str, current_user: dict = Depends(get_current_user)):
    clip_data = load_clip_session(clip_id)
    if not clip_data:
        raise HTTPException(status_code=404, detail="Clip session not found")

    if clip_data.get("user_id") and clip_data.get("user_id") != current_user["user_id"]:
        raise HTTPException(status_code=403, detail="Access denied to this clip")

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
    response_payload.pop("user_id", None)
    response_payload["transcript"] = response_payload.pop("transcript_text", "")
    return JSONResponse(response_payload)

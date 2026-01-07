import logging
import mimetypes
import os
import shutil
import subprocess
import tempfile
from typing import Optional, Tuple

from fastapi import HTTPException

try:
    from .storage import download_blob_to_path, upload_clip_file_to_cloud_storage, storage_client, BUCKET_NAME
except ImportError:
    try:
        from storage import download_blob_to_path, upload_clip_file_to_cloud_storage, storage_client, BUCKET_NAME
    except ImportError:
        import storage as storage_module
        download_blob_to_path = storage_module.download_blob_to_path
        upload_clip_file_to_cloud_storage = storage_module.upload_clip_file_to_cloud_storage
        storage_client = storage_module.storage_client
        BUCKET_NAME = storage_module.BUCKET_NAME

try:
    from .transcript_utils import slugify_filename
except ImportError:
    try:
        from transcript_utils import slugify_filename
    except ImportError:
        import transcript_utils as transcript_utils_module
        slugify_filename = transcript_utils_module.slugify_filename

try:
    from .transcriber import ffmpeg_executable_path, get_media_duration
except ImportError:
    try:
        from transcriber import ffmpeg_executable_path, get_media_duration
    except ImportError:
        import transcriber as transcriber_module
        ffmpeg_executable_path = transcriber_module.ffmpeg_executable_path
        get_media_duration = transcriber_module.get_media_duration


def get_ffmpeg_binary() -> str:
    if ffmpeg_executable_path and shutil.which(ffmpeg_executable_path):
        return ffmpeg_executable_path
    fallback = shutil.which("ffmpeg")
    if fallback:
        return fallback
    raise HTTPException(status_code=500, detail="FFmpeg binary not available on server")


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
            logger = logging.getLogger(__name__)
            logger.error("FFmpeg conversion failed: %s", stderr)
            raise HTTPException(status_code=500, detail="Failed to convert media to audio")
        audio_path = temp_audio.name
        audio_mime = "audio/mpeg"

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


def clip_media_segment(
    source_blob_name: Optional[str],
    clip_start: float,
    clip_end: float,
    content_type: Optional[str],
    clip_label: str,
    user_id: Optional[str] = None,
    parent_media_key: Optional[str] = None,
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
            stderr = process.stderr.decode("utf-8", errors="ignore")
            logger = logging.getLogger(__name__)
            logger.error("FFmpeg clip command failed: %s", stderr)
            raise HTTPException(status_code=500, detail="FFmpeg failed to produce clip")

        with open(output_temp.name, "rb") as output_file:
            clip_bytes = output_file.read()

        filename_slug = slugify_filename(clip_label or "clip")
        clip_filename = f"{filename_slug}{extension}"
        clip_blob_name = upload_clip_file_to_cloud_storage(
            clip_bytes,
            clip_filename,
            content_type,
            user_id=user_id,
            parent_media_key=parent_media_key,
        )
        return clip_blob_name, content_type
    finally:
        for temp_path in (source_temp.name, output_temp.name):
            try:
                os.remove(temp_path)
            except OSError:
                pass

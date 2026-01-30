import logging
import os
import mimetypes
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

try:
    from ..auth import get_current_user, create_media_token
except ImportError:
    try:
        from auth import get_current_user, create_media_token
    except ImportError:
        import auth as auth_module
        get_current_user = auth_module.get_current_user
        create_media_token = auth_module.create_media_token

try:
    from ..config import MEDIA_TOKEN_TTL_MINUTES
except ImportError:
    try:
        from config import MEDIA_TOKEN_TTL_MINUTES
    except ImportError:
        import config as config_module
        MEDIA_TOKEN_TTL_MINUTES = config_module.MEDIA_TOKEN_TTL_MINUTES

try:
    from ..access_control import _get_user_from_request, _user_can_access_media_blob
except ImportError:
    try:
        from access_control import _get_user_from_request, _user_can_access_media_blob
    except ImportError:
        import access_control as access_control_module
        _get_user_from_request = access_control_module._get_user_from_request
        _user_can_access_media_blob = access_control_module._user_can_access_media_blob

try:
    from ..storage import (
        get_blob_metadata,
        save_upload_to_tempfile,
        storage_client,
        BUCKET_NAME,
        upload_preview_file_to_cloud_storage_from_path,
    )
except ImportError:
    try:
        from storage import (
            get_blob_metadata,
            save_upload_to_tempfile,
            storage_client,
            BUCKET_NAME,
            upload_preview_file_to_cloud_storage_from_path,
        )
    except ImportError:
        import storage as storage_module
        get_blob_metadata = storage_module.get_blob_metadata
        save_upload_to_tempfile = storage_module.save_upload_to_tempfile
        storage_client = storage_module.storage_client
        BUCKET_NAME = storage_module.BUCKET_NAME
        upload_preview_file_to_cloud_storage_from_path = storage_module.upload_preview_file_to_cloud_storage_from_path

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/api/upload-preview")
async def upload_media_preview(file: UploadFile = File(...), current_user: dict = Depends(get_current_user)):
    """Upload media file for preview purposes"""
    temp_path = None
    try:
        temp_path, file_size = await save_upload_to_tempfile(file)
        if not temp_path or file_size == 0:
            raise HTTPException(status_code=400, detail="Uploaded media file is empty")

        content_type = file.content_type or mimetypes.guess_type(file.filename)[0]

        blob_name = upload_preview_file_to_cloud_storage_from_path(
            temp_path,
            file.filename,
            content_type,
            user_id=current_user["user_id"],
        )

        logger.info("Uploaded media file for preview: %s (%d bytes)", file.filename, file_size)

        return JSONResponse({
            "file_id": blob_name,
            "filename": file.filename,
            "size": file_size,
            "content_type": content_type,
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Media preview upload failed: %s", str(e))
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")
    finally:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass


@router.post("/api/media-token")
async def create_media_token_endpoint(current_user: dict = Depends(get_current_user)):
    """Issue a short-lived token scoped for media playback."""
    ttl_minutes = max(int(MEDIA_TOKEN_TTL_MINUTES or 0), 1)
    expires_delta = timedelta(minutes=ttl_minutes)
    expires_at = datetime.now(timezone.utc) + expires_delta
    token = create_media_token(
        data={"sub": current_user["username"], "role": current_user.get("role", "user")},
        expires_delta=expires_delta,
    )
    return JSONResponse({
        "token": token,
        "expires_at": expires_at.isoformat(),
        "expires_in": ttl_minutes * 60,
    })


@router.get("/api/media/{file_id}")
async def serve_media_file(file_id: str, request: Request):
    """Serve media file for preview"""
    try:
        request_user = _get_user_from_request(request)
        if not request_user:
            raise HTTPException(status_code=401, detail="Authentication required")

        metadata = get_blob_metadata(file_id)
        if not metadata:
            raise HTTPException(status_code=404, detail="Media file not found")

        if not _user_can_access_media_blob(request_user["user_id"], file_id, metadata):
            raise HTTPException(status_code=403, detail="Access denied to media file")

        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(file_id)
        if not blob.exists():
            raise HTTPException(status_code=404, detail="Media file not found")

        blob.reload()
        file_size = metadata.get("size") or blob.size or 0
        logger.info("Serving media %s: size=%s, content_type=%s", file_id, file_size, metadata.get("content_type"))
        content_type = metadata.get("content_type", "application/octet-stream")

        range_header = request.headers.get("range")
        start = 0
        end = file_size - 1 if file_size else None
        status_code = 200
        headers = {
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, no-store",
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
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error serving media file %s: %s", file_id, str(e))
        raise HTTPException(status_code=500, detail="Error serving media file")

import json
import logging
from typing import Optional

from fastapi import Request

try:
    from .auth import decode_token
except ImportError:
    try:
        from auth import decode_token
    except ImportError:
        import auth as auth_module
        decode_token = auth_module.decode_token

try:
    from .storage import load_current_transcript, storage_client, BUCKET_NAME
except ImportError:
    try:
        from storage import load_current_transcript, storage_client, BUCKET_NAME
    except ImportError:
        import storage as storage_module
        load_current_transcript = storage_module.load_current_transcript
        storage_client = storage_module.storage_client
        BUCKET_NAME = storage_module.BUCKET_NAME

logger = logging.getLogger(__name__)


def _extract_token_from_request(request: Request) -> Optional[str]:
    auth_header = request.headers.get("authorization") or request.headers.get("Authorization")
    if auth_header:
        parts = auth_header.split()
        if len(parts) == 2 and parts[0].lower() == "bearer":
            return parts[1]
    token_param = request.query_params.get("token")
    return token_param or None


def _get_user_from_request(request: Request) -> Optional[dict]:
    token = _extract_token_from_request(request)
    if not token:
        return None
    payload = decode_token(token)
    if not payload or payload.get("type") not in {"access", "media"}:
        return None
    username = payload.get("sub")
    if not username:
        return None
    return {
        "username": username,
        "role": payload.get("role", "user"),
        "user_id": username,
    }


def _user_can_access_media_blob(user_id: str, blob_name: str, metadata: Optional[dict]) -> bool:
    if metadata and metadata.get("user_id"):
        return metadata.get("user_id") == user_id

    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        for blob in bucket.list_blobs(prefix="transcripts/"):
            if not blob.name.endswith("/current.json"):
                continue
            try:
                data = json.loads(blob.download_as_string())
            except Exception:
                continue
            if data.get("user_id") != user_id:
                continue
            if data.get("media_blob_name") == blob_name:
                return True
            for clip in data.get("clips") or []:
                if clip.get("media_blob_name") == blob_name:
                    return True
        return False
    except Exception as exc:
        logger.warning("Failed to verify media ownership for %s: %s", blob_name, exc)
        return False


def _user_owns_media_key(media_key: str, user_id: str) -> bool:
    current = load_current_transcript(media_key)
    if current and current.get("user_id") == user_id:
        return True

    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        prefix = f"transcripts/{media_key}/history/"
        for blob in bucket.list_blobs(prefix=prefix):
            try:
                snapshot_data = json.loads(blob.download_as_string())
            except Exception:
                continue
            if snapshot_data.get("user_id") == user_id:
                return True
        return False
    except Exception as exc:
        logger.warning("Failed to verify transcript ownership for %s: %s", media_key, exc)
        return False

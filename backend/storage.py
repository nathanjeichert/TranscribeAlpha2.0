import io
import json
import logging
import os
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple

from google.cloud import storage
from google.api_core import exceptions as gcs_exceptions
from fastapi import HTTPException

try:
    from .config import (
        BUCKET_NAME,
        CLIP_SESSION_PREFIX,
        CLIP_SESSION_TTL_DAYS,
        MEDIA_CLEANUP_PREFIXES,
        MEDIA_TTL_DAYS,
        SNAPSHOT_TTL_DAYS,
    )
except ImportError:
    try:
        from config import (
            BUCKET_NAME,
            CLIP_SESSION_PREFIX,
            CLIP_SESSION_TTL_DAYS,
            MEDIA_CLEANUP_PREFIXES,
            MEDIA_TTL_DAYS,
            SNAPSHOT_TTL_DAYS,
        )
    except ImportError:
        import config as config_module
        BUCKET_NAME = config_module.BUCKET_NAME
        CLIP_SESSION_PREFIX = config_module.CLIP_SESSION_PREFIX
        CLIP_SESSION_TTL_DAYS = config_module.CLIP_SESSION_TTL_DAYS
        MEDIA_CLEANUP_PREFIXES = config_module.MEDIA_CLEANUP_PREFIXES
        MEDIA_TTL_DAYS = config_module.MEDIA_TTL_DAYS
        SNAPSHOT_TTL_DAYS = config_module.SNAPSHOT_TTL_DAYS

logger = logging.getLogger(__name__)

storage_client = storage.Client()


def _clip_blob_name(clip_id: str) -> str:
    return f"{CLIP_SESSION_PREFIX}{clip_id}.json"


def save_current_transcript(media_key: str, transcript_data: dict) -> None:
    """Save current working state for a transcript using media_key as identifier."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = f"transcripts/{media_key}/current.json"
        blob = bucket.blob(blob_name)

        # Set TTL metadata
        created_at = transcript_data.get("created_at", datetime.now(timezone.utc).isoformat())
        now = datetime.now(timezone.utc).isoformat()

        # Check if transcript is persistent (in a case) - don't set TTL
        is_persistent = transcript_data.get("is_persistent", False) or transcript_data.get("case_id")

        metadata = {
            "media_key": media_key,
            "created_at": created_at,
            "updated_at": now,
            "user_id": transcript_data.get("user_id"),
        }

        if is_persistent:
            metadata["is_persistent"] = "true"
            # No expires_at for persistent transcripts
        else:
            metadata["is_persistent"] = "false"
            metadata["expires_at"] = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()

        blob.metadata = metadata
        blob.upload_from_string(json.dumps(transcript_data), content_type="application/json")
        logger.info("Saved current transcript for media_key %s (persistent: %s)", media_key, is_persistent)
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
            try:
                blob.reload()
            except Exception:
                pass
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

        transcripts = []
        for blob in bucket.list_blobs(prefix=prefix):
            if blob.name.endswith("/current.json"):
                try:
                    data = json.loads(blob.download_as_string())

                    # Check user_id from JSON content (blob.metadata isn't populated by list_blobs)
                    if data.get("user_id") != user_id:
                        continue

                    media_key = blob.name.split("/")[1]

                    title_data = data.get("title_data", {})
                    transcripts.append({
                        "media_key": media_key,
                        "title_label": title_data.get("FILE_NAME") or title_data.get("CASE_NAME") or media_key,
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
            "user_id": clip_data.get("user_id"),
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


def prune_snapshots(media_key: str) -> None:
    """Prune snapshots to keep newest 10, preserving newest manual save."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        limit = 10

        prefix = f"transcripts/{media_key}/history/"
        blobs = list(bucket.list_blobs(prefix=prefix))

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


def cleanup_old_files():
    """Clean up media files older than MEDIA_TTL_DAYS from Cloud Storage to prevent billing issues."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        cutoff_date = datetime.now(timezone.utc) - timedelta(days=MEDIA_TTL_DAYS)

        deleted_count = 0
        for prefix in MEDIA_CLEANUP_PREFIXES:
            for blob in bucket.list_blobs(prefix=prefix):
                if blob.time_created and blob.time_created < cutoff_date:
                    blob.delete()
                    deleted_count += 1
                    logger.info("Deleted old media file: %s", blob.name)

        logger.info("Media cleanup completed. Deleted %d files.", deleted_count)
    except Exception as e:
        logger.error("Error during cleanup: %s", str(e))


def _format_gcs_error(error: Exception) -> str:
    if isinstance(error, gcs_exceptions.GoogleAPIError):
        return f"{error.__class__.__name__}: {error.message}"
    return str(error)


def _upload_bytes_to_blob(blob: storage.Blob, file_bytes: bytes, content_type: Optional[str] = None) -> None:
    blob.chunk_size = 5 * 1024 * 1024  # 5MB chunking to support larger files consistently
    buffer = io.BytesIO(file_bytes)
    buffer.seek(0)
    blob.upload_from_file(buffer, size=len(file_bytes), content_type=content_type or "application/octet-stream")


def _upload_file_to_blob(blob: storage.Blob, file_path: str, content_type: Optional[str] = None) -> None:
    blob.chunk_size = 5 * 1024 * 1024  # 5MB chunking to support larger files consistently
    with open(file_path, "rb") as stream:
        blob.upload_from_file(stream, content_type=content_type or "application/octet-stream")


def get_blob_metadata(blob_name: str) -> dict:
    """Get metadata for a blob in Cloud Storage"""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(blob_name)
        if not blob.exists():
            return None

        blob.reload()
        metadata = blob.metadata or {}
        return {
            "filename": metadata.get("original_filename", blob_name.split("_")[-1]),
            "content_type": blob.content_type or metadata.get("content_type", "application/octet-stream"),
            "size": blob.size,
            "created": blob.time_created,
            "user_id": metadata.get("user_id"),
            "media_key": metadata.get("media_key"),
            "parent_media_key": metadata.get("parent_media_key"),
            "file_type": metadata.get("file_type"),
        }
    except Exception as e:
        logger.error("Error getting blob metadata: %s", str(e))
        return None


def upload_preview_file_to_cloud_storage(
    file_bytes: bytes,
    filename: str,
    content_type: Optional[str] = None,
    user_id: Optional[str] = None,
    media_key: Optional[str] = None,
) -> str:
    """Upload preview file to Cloud Storage with metadata."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = f"preview_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}_{filename}"
        blob = bucket.blob(blob_name)

        metadata = {
            "original_filename": filename,
            "content_type": content_type or "application/octet-stream",
            "file_type": "preview",
        }
        if user_id:
            metadata["user_id"] = user_id
        if media_key:
            metadata["media_key"] = media_key

        blob.metadata = metadata
        if content_type:
            blob.content_type = content_type

        _upload_bytes_to_blob(blob, file_bytes, content_type)
        logger.info("Uploaded preview file %s to Cloud Storage as %s", filename, blob_name)
        return blob_name
    except Exception as e:
        logger.error("Error uploading preview file to Cloud Storage: %s", _format_gcs_error(e))
        raise


def upload_preview_file_to_cloud_storage_from_path(
    file_path: str,
    filename: str,
    content_type: Optional[str] = None,
    user_id: Optional[str] = None,
    media_key: Optional[str] = None,
) -> str:
    """Upload preview file to Cloud Storage from disk with metadata."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = f"preview_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}_{filename}"
        blob = bucket.blob(blob_name)

        metadata = {
            "original_filename": filename,
            "content_type": content_type or "application/octet-stream",
            "file_type": "preview",
        }
        if user_id:
            metadata["user_id"] = user_id
        if media_key:
            metadata["media_key"] = media_key

        blob.metadata = metadata
        if content_type:
            blob.content_type = content_type

        _upload_file_to_blob(blob, file_path, content_type)
        logger.info("Uploaded preview file %s to Cloud Storage as %s", filename, blob_name)
        return blob_name
    except Exception as e:
        logger.error("Error uploading preview file to Cloud Storage: %s", _format_gcs_error(e))
        raise


def download_blob_to_path(blob_name: str) -> Tuple[str, Optional[str]]:
    """Download a blob to a temporary file and return the path and content type."""
    bucket = storage_client.bucket(BUCKET_NAME)
    blob = bucket.blob(blob_name)
    if not blob.exists():
        raise HTTPException(status_code=404, detail="Media blob not found")

    extension = os.path.splitext(blob.name)[1]
    suffix = extension or ".bin"
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    temp_file.close()
    blob.download_to_filename(temp_file.name)
    return temp_file.name, blob.content_type


def upload_clip_file_to_cloud_storage(
    file_bytes: bytes,
    filename: str,
    content_type: Optional[str],
    user_id: Optional[str] = None,
    parent_media_key: Optional[str] = None,
) -> str:
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
        if user_id:
            metadata["user_id"] = user_id
        if parent_media_key:
            metadata["parent_media_key"] = parent_media_key
        blob.metadata = metadata
        if content_type:
            blob.content_type = content_type
        _upload_bytes_to_blob(blob, file_bytes, content_type)
        logger.info("Uploaded clip media %s to Cloud Storage", blob_name)
        return blob_name
    except Exception as exc:
        logger.error("Error uploading clip media to Cloud Storage: %s", _format_gcs_error(exc))
        raise


async def save_upload_to_tempfile(upload) -> Tuple[str, int]:
    """Stream an UploadFile to disk and return (path, size)."""
    suffix = os.path.splitext(upload.filename or "")[1]
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    size = 0
    try:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            temp_file.write(chunk)
    finally:
        temp_file.close()
    try:
        await upload.seek(0)
    except Exception:
        pass
    return temp_file.name, size


# ============================================================================
# Cases Storage Functions
# ============================================================================


def _case_meta_path(user_id: str, case_id: str) -> str:
    """Return GCS path for case metadata."""
    return f"cases/{user_id}/{case_id}/meta.json"


def _case_transcripts_path(user_id: str, case_id: str) -> str:
    """Return GCS path for case transcript list."""
    return f"cases/{user_id}/{case_id}/transcripts.json"


def _case_index_path(user_id: str) -> str:
    """Return GCS path for user's case index."""
    return f"cases/{user_id}/index.json"


def create_case(user_id: str, case_id: str, name: str, description: Optional[str] = None) -> dict:
    """Create a new case and return its metadata."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        now = datetime.now(timezone.utc).isoformat()

        case_meta = {
            "case_id": case_id,
            "user_id": user_id,
            "name": name,
            "description": description or "",
            "created_at": now,
            "updated_at": now,
            "transcript_count": 0,
        }

        # Save case metadata
        meta_blob = bucket.blob(_case_meta_path(user_id, case_id))
        meta_blob.upload_from_string(json.dumps(case_meta), content_type="application/json")

        # Initialize empty transcripts list
        transcripts_blob = bucket.blob(_case_transcripts_path(user_id, case_id))
        transcripts_blob.upload_from_string(json.dumps([]), content_type="application/json")

        # Update user's case index
        _update_case_index(user_id)

        logger.info("Created case %s for user %s", case_id, user_id)
        return case_meta

    except Exception as e:
        logger.error("Failed to create case %s: %s", case_id, e)
        raise


def load_case_meta(user_id: str, case_id: str) -> Optional[dict]:
    """Load case metadata."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(_case_meta_path(user_id, case_id))

        if not blob.exists():
            return None

        return json.loads(blob.download_as_string())

    except Exception as e:
        logger.error("Failed to load case meta %s: %s", case_id, e)
        return None


def update_case_meta(user_id: str, case_id: str, updates: dict) -> Optional[dict]:
    """Update case metadata fields (name, description)."""
    try:
        case_meta = load_case_meta(user_id, case_id)
        if not case_meta:
            return None

        # Only allow updating specific fields
        allowed_fields = {"name", "description"}
        for field in allowed_fields:
            if field in updates:
                case_meta[field] = updates[field]

        case_meta["updated_at"] = datetime.now(timezone.utc).isoformat()

        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(_case_meta_path(user_id, case_id))
        blob.upload_from_string(json.dumps(case_meta), content_type="application/json")

        # Update index
        _update_case_index(user_id)

        logger.info("Updated case %s", case_id)
        return case_meta

    except Exception as e:
        logger.error("Failed to update case %s: %s", case_id, e)
        raise


def delete_case(user_id: str, case_id: str, delete_transcripts: bool = False) -> List[str]:
    """
    Delete a case. Returns list of media_keys that were affected.
    If delete_transcripts=True, also deletes the transcripts.
    If delete_transcripts=False, moves transcripts to uncategorized (restores TTL).
    """
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        affected_keys = []

        # Get transcript list
        transcripts = get_case_transcripts(user_id, case_id)

        for entry in transcripts:
            media_key = entry.get("media_key")
            if not media_key:
                continue

            affected_keys.append(media_key)

            if delete_transcripts:
                # Delete the transcript entirely
                _delete_transcript(media_key)
            else:
                # Remove case association and restore TTL
                _remove_case_from_transcript(media_key)
                restore_transcript_ttl(media_key)

        # Delete case files
        meta_blob = bucket.blob(_case_meta_path(user_id, case_id))
        if meta_blob.exists():
            meta_blob.delete()

        transcripts_blob = bucket.blob(_case_transcripts_path(user_id, case_id))
        if transcripts_blob.exists():
            transcripts_blob.delete()

        # Update index
        _update_case_index(user_id)

        logger.info("Deleted case %s (transcripts deleted: %s)", case_id, delete_transcripts)
        return affected_keys

    except Exception as e:
        logger.error("Failed to delete case %s: %s", case_id, e)
        raise


def list_user_cases(user_id: str) -> List[dict]:
    """List all cases for a user."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(_case_index_path(user_id))

        if blob.exists():
            index_data = json.loads(blob.download_as_string())
            return index_data.get("cases", [])

        # Fallback: scan for cases if index doesn't exist
        return _rebuild_case_index(user_id)

    except Exception as e:
        logger.error("Failed to list cases for user %s: %s", user_id, e)
        return []


def _update_case_index(user_id: str) -> None:
    """Rebuild and save the user's case index."""
    try:
        cases = _rebuild_case_index(user_id)
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(_case_index_path(user_id))

        index_data = {
            "user_id": user_id,
            "cases": cases,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        blob.upload_from_string(json.dumps(index_data), content_type="application/json")

    except Exception as e:
        logger.error("Failed to update case index for user %s: %s", user_id, e)


def _rebuild_case_index(user_id: str) -> List[dict]:
    """Scan GCS and rebuild case list for user."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        prefix = f"cases/{user_id}/"
        cases = []

        # Find all case directories by looking for meta.json files
        for blob in bucket.list_blobs(prefix=prefix):
            if blob.name.endswith("/meta.json"):
                try:
                    case_meta = json.loads(blob.download_as_string())
                    cases.append(case_meta)
                except Exception:
                    continue

        # Sort by updated_at descending
        cases.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
        return cases

    except Exception as e:
        logger.error("Failed to rebuild case index for user %s: %s", user_id, e)
        return []


def get_case_transcripts(user_id: str, case_id: str) -> List[dict]:
    """Get list of transcripts in a case."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(_case_transcripts_path(user_id, case_id))

        if not blob.exists():
            return []

        return json.loads(blob.download_as_string())

    except Exception as e:
        logger.error("Failed to get case transcripts for %s: %s", case_id, e)
        return []


def add_transcript_to_case(user_id: str, case_id: str, media_key: str, title_label: Optional[str] = None) -> bool:
    """
    Add a transcript to a case.
    Also sets the transcript as persistent (removes TTL) and adds case_id to transcript.
    """
    try:
        # Verify case exists and belongs to user
        case_meta = load_case_meta(user_id, case_id)
        if not case_meta:
            logger.warning("Case %s not found for user %s", case_id, user_id)
            return False

        # Verify transcript exists and belongs to user
        transcript = load_current_transcript(media_key)
        if not transcript:
            logger.warning("Transcript %s not found", media_key)
            return False
        if transcript.get("user_id") != user_id:
            logger.warning("Transcript %s does not belong to user %s", media_key, user_id)
            return False

        # Check if transcript is already in another case
        existing_case_id = transcript.get("case_id")
        if existing_case_id and existing_case_id != case_id:
            # Remove from old case first
            remove_transcript_from_case(user_id, existing_case_id, media_key)

        bucket = storage_client.bucket(BUCKET_NAME)
        now = datetime.now(timezone.utc).isoformat()

        # Get current transcripts list
        transcripts = get_case_transcripts(user_id, case_id)

        # Check if already in this case
        if any(t.get("media_key") == media_key for t in transcripts):
            return True  # Already added

        # Add to case
        transcripts.append({
            "media_key": media_key,
            "added_at": now,
            "title_label": title_label or transcript.get("title_data", {}).get("FILE_NAME") or transcript.get("title_data", {}).get("CASE_NAME") or media_key,
        })

        # Save updated transcripts list
        transcripts_blob = bucket.blob(_case_transcripts_path(user_id, case_id))
        transcripts_blob.upload_from_string(json.dumps(transcripts), content_type="application/json")

        # Update case metadata
        case_meta["transcript_count"] = len(transcripts)
        case_meta["updated_at"] = now
        meta_blob = bucket.blob(_case_meta_path(user_id, case_id))
        meta_blob.upload_from_string(json.dumps(case_meta), content_type="application/json")

        # Update transcript with case_id and make persistent
        _set_case_on_transcript(media_key, case_id)
        set_transcript_persistent(media_key)

        # Update index
        _update_case_index(user_id)

        logger.info("Added transcript %s to case %s", media_key, case_id)
        return True

    except Exception as e:
        logger.error("Failed to add transcript %s to case %s: %s", media_key, case_id, e)
        raise


def remove_transcript_from_case(user_id: str, case_id: str, media_key: str) -> bool:
    """
    Remove a transcript from a case.
    Restores TTL on the transcript.
    """
    try:
        bucket = storage_client.bucket(BUCKET_NAME)

        # Get current transcripts list
        transcripts = get_case_transcripts(user_id, case_id)
        original_count = len(transcripts)

        # Remove the transcript
        transcripts = [t for t in transcripts if t.get("media_key") != media_key]

        if len(transcripts) == original_count:
            return False  # Wasn't in the case

        # Save updated list
        transcripts_blob = bucket.blob(_case_transcripts_path(user_id, case_id))
        transcripts_blob.upload_from_string(json.dumps(transcripts), content_type="application/json")

        # Update case metadata
        case_meta = load_case_meta(user_id, case_id)
        if case_meta:
            case_meta["transcript_count"] = len(transcripts)
            case_meta["updated_at"] = datetime.now(timezone.utc).isoformat()
            meta_blob = bucket.blob(_case_meta_path(user_id, case_id))
            meta_blob.upload_from_string(json.dumps(case_meta), content_type="application/json")

        # Remove case_id from transcript and restore TTL
        _remove_case_from_transcript(media_key)
        restore_transcript_ttl(media_key)

        # Update index
        _update_case_index(user_id)

        logger.info("Removed transcript %s from case %s", media_key, case_id)
        return True

    except Exception as e:
        logger.error("Failed to remove transcript %s from case %s: %s", media_key, case_id, e)
        raise


def _set_case_on_transcript(media_key: str, case_id: str) -> None:
    """Set case_id on a transcript's current.json."""
    try:
        transcript = load_current_transcript(media_key)
        if not transcript:
            return

        transcript["case_id"] = case_id
        transcript["is_persistent"] = True
        save_current_transcript(media_key, transcript)

    except Exception as e:
        logger.error("Failed to set case on transcript %s: %s", media_key, e)


def _remove_case_from_transcript(media_key: str) -> None:
    """Remove case_id from a transcript's current.json."""
    try:
        transcript = load_current_transcript(media_key)
        if not transcript:
            return

        transcript["case_id"] = None
        transcript["is_persistent"] = False
        save_current_transcript(media_key, transcript)

    except Exception as e:
        logger.error("Failed to remove case from transcript %s: %s", media_key, e)


def set_transcript_persistent(media_key: str) -> None:
    """Remove TTL from a transcript (make it persistent)."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(f"transcripts/{media_key}/current.json")

        if not blob.exists():
            return

        blob.reload()
        metadata = blob.metadata or {}

        # Remove expires_at to make persistent
        if "expires_at" in metadata:
            del metadata["expires_at"]
        metadata["is_persistent"] = "true"
        metadata["updated_at"] = datetime.now(timezone.utc).isoformat()

        blob.metadata = metadata
        blob.patch()

        logger.info("Set transcript %s as persistent", media_key)

    except Exception as e:
        logger.error("Failed to set transcript %s as persistent: %s", media_key, e)


def restore_transcript_ttl(media_key: str) -> None:
    """Restore 30-day TTL to a transcript."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(f"transcripts/{media_key}/current.json")

        if not blob.exists():
            return

        blob.reload()
        metadata = blob.metadata or {}

        # Set new expiration 30 days from now
        metadata["expires_at"] = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
        metadata["is_persistent"] = "false"
        metadata["updated_at"] = datetime.now(timezone.utc).isoformat()

        blob.metadata = metadata
        blob.patch()

        logger.info("Restored TTL on transcript %s", media_key)

    except Exception as e:
        logger.error("Failed to restore TTL on transcript %s: %s", media_key, e)


def _delete_transcript(media_key: str) -> None:
    """Delete a transcript and all its history."""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        prefix = f"transcripts/{media_key}/"

        for blob in bucket.list_blobs(prefix=prefix):
            try:
                blob.delete()
            except Exception:
                continue

        logger.info("Deleted transcript %s", media_key)

    except Exception as e:
        logger.error("Failed to delete transcript %s: %s", media_key, e)


def _delete_blob_if_exists(blob_name: Optional[str]) -> None:
    if not blob_name:
        return
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(str(blob_name))
        if blob.exists():
            blob.delete()
            logger.info("Deleted blob %s", blob_name)
    except Exception as e:
        logger.warning("Failed to delete blob %s: %s", blob_name, e)


def delete_transcript_for_user(user_id: str, media_key: str) -> bool:
    """
    Permanently delete a transcript owned by user_id.
    Also removes case references and linked media/clip blobs when available.
    """
    transcript = load_current_transcript(media_key)
    if not transcript:
        return False

    transcript_user_id = transcript.get("user_id")
    if transcript_user_id and transcript_user_id != user_id:
        raise PermissionError(f"Transcript {media_key} does not belong to user {user_id}")

    case_id = transcript.get("case_id")
    if case_id:
        try:
            remove_transcript_from_case(user_id, case_id, media_key)
        except Exception as e:
            logger.warning("Failed to detach transcript %s from case %s: %s", media_key, case_id, e)

    # Defensive cleanup in case a transcript reference exists in multiple cases.
    try:
        for case_meta in list_user_cases(user_id):
            candidate_case_id = case_meta.get("case_id")
            if not candidate_case_id or candidate_case_id == case_id:
                continue
            entries = get_case_transcripts(user_id, candidate_case_id)
            if any(entry.get("media_key") == media_key for entry in entries):
                try:
                    remove_transcript_from_case(user_id, candidate_case_id, media_key)
                except Exception as e:
                    logger.warning(
                        "Failed to remove transcript %s from case %s during delete: %s",
                        media_key,
                        candidate_case_id,
                        e,
                    )
    except Exception as e:
        logger.warning("Failed scanning cases for transcript %s references: %s", media_key, e)

    media_blob_name = transcript.get("media_blob_name")
    clip_blob_names = set()
    for clip_entry in transcript.get("clips") or []:
        if isinstance(clip_entry, dict):
            clip_blob_name = clip_entry.get("media_blob_name")
            if isinstance(clip_blob_name, str) and clip_blob_name.strip():
                clip_blob_names.add(clip_blob_name.strip())

    _delete_transcript(media_key)
    _delete_blob_if_exists(media_blob_name)
    for clip_blob_name in clip_blob_names:
        _delete_blob_if_exists(clip_blob_name)

    return True


def list_uncategorized_transcripts(user_id: str) -> List[dict]:
    """List transcripts not in any case (with TTL info)."""
    try:
        # Get all user's transcripts
        all_transcripts = list_all_transcripts(user_id)

        # Filter to only those without case_id
        uncategorized = []
        for t in all_transcripts:
            transcript = load_current_transcript(t["media_key"])
            if transcript and not transcript.get("case_id"):
                # Get expiration info from blob metadata
                bucket = storage_client.bucket(BUCKET_NAME)
                blob = bucket.blob(f"transcripts/{t['media_key']}/current.json")
                expires_at = None
                if blob.exists():
                    blob.reload()
                    if blob.metadata:
                        expires_at = blob.metadata.get("expires_at")

                uncategorized.append({
                    **t,
                    "expires_at": expires_at,
                })

        return uncategorized

    except Exception as e:
        logger.error("Failed to list uncategorized transcripts: %s", e)
        return []


def search_case_transcripts(user_id: str, case_id: str, query: str) -> List[dict]:
    """
    Search text and speaker names across all transcripts in a case.
    Returns list of CaseSearchResult-like dicts.
    """
    try:
        if not query or len(query.strip()) < 2:
            return []

        query_lower = query.lower().strip()
        results = []

        # Get all transcripts in case
        transcripts = get_case_transcripts(user_id, case_id)

        for entry in transcripts:
            media_key = entry.get("media_key")
            if not media_key:
                continue

            transcript = load_current_transcript(media_key)
            if not transcript:
                continue

            matches = []
            lines = transcript.get("lines", [])

            for line in lines:
                line_text = line.get("text", "")
                speaker = line.get("speaker", "")
                match_type = None

                # Search in text
                if query_lower in line_text.lower():
                    match_type = "text"
                # Search in speaker name
                elif query_lower in speaker.lower():
                    match_type = "speaker"

                if match_type:
                    matches.append({
                        "line_id": line.get("id", ""),
                        "page": line.get("page", 0),
                        "line": line.get("line", 0),
                        "text": line_text,
                        "speaker": speaker,
                        "match_type": match_type,
                    })

            if matches:
                results.append({
                    "media_key": media_key,
                    "title_label": entry.get("title_label", media_key),
                    "matches": matches,
                })

        return results

    except Exception as e:
        logger.error("Failed to search case %s: %s", case_id, e)
        return []


def check_media_exists(blob_name: str) -> bool:
    """Check if a media blob exists in GCS."""
    try:
        if not blob_name:
            return False

        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(blob_name)
        return blob.exists()

    except Exception as e:
        logger.error("Failed to check media existence for %s: %s", blob_name, e)
        return False


def get_transcript_case_id(media_key: str) -> Optional[str]:
    """Get the case_id for a transcript, if any."""
    try:
        transcript = load_current_transcript(media_key)
        if transcript:
            return transcript.get("case_id")
        return None
    except Exception:
        return None

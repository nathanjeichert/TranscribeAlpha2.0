#!/usr/bin/env python3
import argparse
import json
import logging
from typing import Optional

try:
    from backend.storage import storage_client, BUCKET_NAME
except ImportError:
    try:
        from storage import storage_client, BUCKET_NAME
    except ImportError:
        import storage as storage_module
        storage_client = storage_module.storage_client
        BUCKET_NAME = storage_module.BUCKET_NAME


logger = logging.getLogger(__name__)


def _derive_media_key_from_path(blob_name: str) -> Optional[str]:
    parts = blob_name.split("/")
    if len(parts) >= 3 and parts[0] == "transcripts" and parts[2] == "current.json":
        return parts[1]
    return None


def _update_blob_metadata(blob_name: str, user_id: str, media_key: Optional[str] = None,
                          parent_media_key: Optional[str] = None, dry_run: bool = True) -> bool:
    bucket = storage_client.bucket(BUCKET_NAME)
    blob = bucket.blob(blob_name)
    if not blob.exists():
        logger.warning("Blob not found: %s", blob_name)
        return False

    blob.reload()
    metadata = blob.metadata or {}
    updates = {}

    if user_id and metadata.get("user_id") != user_id:
        updates["user_id"] = user_id
    if media_key and metadata.get("media_key") != media_key:
        updates["media_key"] = media_key
    if parent_media_key and metadata.get("parent_media_key") != parent_media_key:
        updates["parent_media_key"] = parent_media_key

    if not updates:
        return False

    logger.info("Updating %s metadata: %s", blob_name, updates)
    if not dry_run:
        metadata.update(updates)
        blob.metadata = metadata
        blob.patch()
    return True


def backfill_media_metadata(dry_run: bool = True, limit: Optional[int] = None) -> int:
    bucket = storage_client.bucket(BUCKET_NAME)
    updated = 0
    processed = 0

    for blob in bucket.list_blobs(prefix="transcripts/"):
        if not blob.name.endswith("/current.json"):
            continue
        processed += 1
        if limit and processed > limit:
            break

        try:
            data = json.loads(blob.download_as_string())
        except Exception:
            logger.warning("Failed to parse transcript payload: %s", blob.name)
            continue

        user_id = data.get("user_id")
        if not user_id:
            logger.warning("Skipping transcript without user_id: %s", blob.name)
            continue

        media_key = data.get("media_key") or _derive_media_key_from_path(blob.name)

        media_blob_name = data.get("media_blob_name")
        if media_blob_name:
            if _update_blob_metadata(media_blob_name, user_id, media_key=media_key, dry_run=dry_run):
                updated += 1

        for clip in data.get("clips") or []:
            clip_blob = clip.get("media_blob_name")
            if clip_blob:
                if _update_blob_metadata(
                    clip_blob,
                    user_id,
                    parent_media_key=media_key,
                    dry_run=dry_run,
                ):
                    updated += 1

    logger.info("Processed %d transcripts; updated %d media blobs.", processed, updated)
    return updated


def main():
    parser = argparse.ArgumentParser(description="Backfill user_id metadata for media blobs.")
    parser.add_argument("--apply", action="store_true", help="Apply changes (default is dry run).")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of transcripts to scan.")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    dry_run = not args.apply
    if dry_run:
        logger.info("Dry run mode. Use --apply to persist changes.")
    backfill_media_metadata(dry_run=dry_run, limit=args.limit)


if __name__ == "__main__":
    main()

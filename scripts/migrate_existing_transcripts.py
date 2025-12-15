#!/usr/bin/env python3
"""
Migration script to assign existing transcripts to a specific user.

This script updates all existing transcripts in Cloud Storage to set the user_id
field to a specified username (default: "VerdictGroup").

Usage:
    python scripts/migrate_existing_transcripts.py [--user-id USERNAME] [--dry-run]

Arguments:
    --user-id: The username to assign to all existing transcripts (default: VerdictGroup)
    --dry-run: Show what would be changed without making actual changes
"""

import argparse
import json
import sys
from google.cloud import storage

# Cloud Storage configuration
BUCKET_NAME = "transcribealpha-uploads-1750110926"
TRANSCRIPT_PREFIX = "transcripts/"


def migrate_transcripts(user_id: str = "VerdictGroup", dry_run: bool = False):
    """
    Migrate all existing transcripts to a specific user_id.

    Args:
        user_id: The username to assign to existing transcripts
        dry_run: If True, only show what would be changed
    """
    print(f"{'DRY RUN: ' if dry_run else ''}Migrating transcripts to user: {user_id}")
    print(f"Bucket: {BUCKET_NAME}")
    print("-" * 80)

    try:
        storage_client = storage.Client()
        bucket = storage_client.bucket(BUCKET_NAME)

        # Find all current.json files (these are the main transcript files)
        blobs = bucket.list_blobs(prefix=TRANSCRIPT_PREFIX)

        updated_count = 0
        skipped_count = 0
        error_count = 0

        for blob in blobs:
            # Only process current.json files (main transcript state)
            if not blob.name.endswith("/current.json"):
                continue

            try:
                # Download and parse the JSON
                content = blob.download_as_string()
                data = json.loads(content)

                current_user_id = data.get("user_id")

                # Check if already has a user_id other than "anonymous"
                if current_user_id and current_user_id != "anonymous":
                    print(f"SKIP: {blob.name} (already has user_id: {current_user_id})")
                    skipped_count += 1
                    continue

                # Update user_id
                old_user_id = current_user_id or "None"
                data["user_id"] = user_id

                if dry_run:
                    print(f"WOULD UPDATE: {blob.name} ({old_user_id} → {user_id})")
                else:
                    # Upload updated JSON
                    blob.upload_from_string(
                        json.dumps(data),
                        content_type="application/json"
                    )
                    print(f"UPDATED: {blob.name} ({old_user_id} → {user_id})")

                updated_count += 1

            except json.JSONDecodeError as e:
                print(f"ERROR: Failed to parse JSON for {blob.name}: {e}")
                error_count += 1
            except Exception as e:
                print(f"ERROR: Failed to process {blob.name}: {e}")
                error_count += 1

        # Also update snapshot files
        print("\n" + "=" * 80)
        print("Updating snapshot files...")
        print("=" * 80)

        snapshot_blobs = bucket.list_blobs(prefix="transcripts/")
        snapshot_updated = 0

        for blob in snapshot_blobs:
            # Process history snapshots
            if "/history/" not in blob.name or not blob.name.endswith(".json"):
                continue

            try:
                content = blob.download_as_string()
                data = json.loads(content)

                current_user_id = data.get("user_id")

                if current_user_id and current_user_id != "anonymous":
                    skipped_count += 1
                    continue

                old_user_id = current_user_id or "None"
                data["user_id"] = user_id

                if dry_run:
                    print(f"WOULD UPDATE SNAPSHOT: {blob.name} ({old_user_id} → {user_id})")
                else:
                    blob.upload_from_string(
                        json.dumps(data),
                        content_type="application/json"
                    )
                    print(f"UPDATED SNAPSHOT: {blob.name} ({old_user_id} → {user_id})")

                snapshot_updated += 1

            except Exception as e:
                print(f"ERROR: Failed to process snapshot {blob.name}: {e}")
                error_count += 1

        print("\n" + "=" * 80)
        print("Migration Summary:")
        print("=" * 80)
        print(f"Transcripts updated: {updated_count}")
        print(f"Snapshots updated: {snapshot_updated}")
        print(f"Skipped (already assigned): {skipped_count}")
        print(f"Errors: {error_count}")

        if dry_run:
            print("\nThis was a DRY RUN. No changes were made.")
            print("Run without --dry-run to apply changes.")

        return updated_count + snapshot_updated, error_count

    except Exception as e:
        print(f"FATAL ERROR: {e}")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Migrate existing transcripts to a specific user"
    )
    parser.add_argument(
        "--user-id",
        default="VerdictGroup",
        help="Username to assign to existing transcripts (default: VerdictGroup)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be changed without making actual changes"
    )

    args = parser.parse_args()

    updated, errors = migrate_transcripts(args.user_id, args.dry_run)

    if errors > 0:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()

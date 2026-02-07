"""
Cases API Router

Provides endpoints for managing case folders that organize transcripts.
"""

import logging
import uuid
from typing import Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

# Multi-context imports for auth
try:
    from ..auth import get_current_user
except ImportError:
    try:
        from auth import get_current_user
    except ImportError:
        import auth as auth_module
        get_current_user = auth_module.get_current_user

# Multi-context imports for storage
try:
    from ..storage import (
        create_case,
        load_case_meta,
        update_case_meta,
        delete_case,
        list_user_cases,
        get_case_transcripts,
        add_transcript_to_case,
        remove_transcript_from_case,
        search_case_transcripts,
        list_uncategorized_transcripts,
        load_current_transcript,
    )
except ImportError:
    try:
        from storage import (
            create_case,
            load_case_meta,
            update_case_meta,
            delete_case,
            list_user_cases,
            get_case_transcripts,
            add_transcript_to_case,
            remove_transcript_from_case,
            search_case_transcripts,
            list_uncategorized_transcripts,
            load_current_transcript,
        )
    except ImportError:
        import storage as storage_module
        create_case = storage_module.create_case
        load_case_meta = storage_module.load_case_meta
        update_case_meta = storage_module.update_case_meta
        delete_case = storage_module.delete_case
        list_user_cases = storage_module.list_user_cases
        get_case_transcripts = storage_module.get_case_transcripts
        add_transcript_to_case = storage_module.add_transcript_to_case
        remove_transcript_from_case = storage_module.remove_transcript_from_case
        search_case_transcripts = storage_module.search_case_transcripts
        list_uncategorized_transcripts = storage_module.list_uncategorized_transcripts
        load_current_transcript = storage_module.load_current_transcript


router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/api/cases")
async def list_cases(current_user: dict = Depends(get_current_user)):
    """
    List all cases for the authenticated user.
    Also returns count of uncategorized transcripts.
    """
    try:
        user_id = current_user["user_id"]
        cases = list_user_cases(user_id)
        uncategorized = list_uncategorized_transcripts(user_id)

        return JSONResponse({
            "cases": cases,
            "uncategorized_count": len(uncategorized),
        })

    except Exception as e:
        logger.error("Failed to list cases: %s", e)
        raise HTTPException(status_code=500, detail="Failed to list cases")


@router.post("/api/cases")
async def create_new_case(
    payload: Dict = Body(...),
    current_user: dict = Depends(get_current_user),
):
    """
    Create a new case.

    Body:
        name: str (required) - Name of the case
        description: str (optional) - Description of the case
    """
    name = payload.get("name")
    if not name or not name.strip():
        raise HTTPException(status_code=400, detail="Case name is required")

    try:
        user_id = current_user["user_id"]
        case_id = uuid.uuid4().hex
        description = payload.get("description", "")

        case_meta = create_case(user_id, case_id, name.strip(), description)

        return JSONResponse({
            "case": case_meta,
            "message": "Case created successfully",
        })

    except Exception as e:
        logger.error("Failed to create case: %s", e)
        raise HTTPException(status_code=500, detail="Failed to create case")


@router.get("/api/cases/{case_id}")
async def get_case(
    case_id: str,
    current_user: dict = Depends(get_current_user),
):
    """
    Get case details with list of transcripts.
    """
    try:
        user_id = current_user["user_id"]
        case_meta = load_case_meta(user_id, case_id)

        if not case_meta:
            raise HTTPException(status_code=404, detail="Case not found")

        # Get transcript list with additional details
        transcripts = get_case_transcripts(user_id, case_id)
        enriched_transcripts = []

        for entry in transcripts:
            media_key = entry.get("media_key")
            transcript = load_current_transcript(media_key) if media_key else None

            enriched_transcripts.append({
                "media_key": media_key,
                "title_label": entry.get("title_label", media_key),
                "added_at": entry.get("added_at"),
                "updated_at": transcript.get("updated_at") if transcript else None,
                "line_count": len(transcript.get("lines", [])) if transcript else 0,
                "audio_duration": transcript.get("audio_duration", 0) if transcript else 0,
            })

        return JSONResponse({
            "case": case_meta,
            "transcripts": enriched_transcripts,
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to get case %s: %s", case_id, e)
        raise HTTPException(status_code=500, detail="Failed to get case")


@router.put("/api/cases/{case_id}")
async def update_case(
    case_id: str,
    payload: Dict = Body(...),
    current_user: dict = Depends(get_current_user),
):
    """
    Update case metadata (name, description).

    Body:
        name: str (optional)
        description: str (optional)
    """
    try:
        user_id = current_user["user_id"]

        # Verify case exists
        case_meta = load_case_meta(user_id, case_id)
        if not case_meta:
            raise HTTPException(status_code=404, detail="Case not found")

        # Build updates
        updates = {}
        if "name" in payload:
            name = payload["name"]
            if not name or not name.strip():
                raise HTTPException(status_code=400, detail="Case name cannot be empty")
            updates["name"] = name.strip()
        if "description" in payload:
            updates["description"] = payload["description"] or ""

        if not updates:
            return JSONResponse({"case": case_meta, "message": "No changes made"})

        updated_meta = update_case_meta(user_id, case_id, updates)

        return JSONResponse({
            "case": updated_meta,
            "message": "Case updated successfully",
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to update case %s: %s", case_id, e)
        raise HTTPException(status_code=500, detail="Failed to update case")


@router.delete("/api/cases/{case_id}")
async def delete_case_endpoint(
    case_id: str,
    delete_transcripts: bool = Query(default=False),
    current_user: dict = Depends(get_current_user),
):
    """
    Delete a case.

    Query params:
        delete_transcripts: bool (default False)
            - If True, permanently deletes all transcripts in the case
            - If False, moves transcripts to uncategorized (restores 30-day TTL)
    """
    try:
        user_id = current_user["user_id"]

        # Verify case exists
        case_meta = load_case_meta(user_id, case_id)
        if not case_meta:
            raise HTTPException(status_code=404, detail="Case not found")

        # Get transcript count for response
        transcripts = get_case_transcripts(user_id, case_id)
        transcript_count = len(transcripts)

        # Delete the case
        affected_keys = delete_case(user_id, case_id, delete_transcripts=delete_transcripts)

        action = "deleted" if delete_transcripts else "moved to uncategorized"
        return JSONResponse({
            "message": f"Case deleted successfully. {transcript_count} transcript(s) {action}.",
            "affected_transcript_count": transcript_count,
            "transcripts_deleted": delete_transcripts,
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to delete case %s: %s", case_id, e)
        raise HTTPException(status_code=500, detail="Failed to delete case")


@router.post("/api/cases/{case_id}/transcripts")
async def add_transcript_to_case_endpoint(
    case_id: str,
    payload: Dict = Body(...),
    current_user: dict = Depends(get_current_user),
):
    """
    Add a transcript to a case.
    The transcript becomes persistent (no TTL expiration).

    Body:
        media_key: str (required) - The transcript's media_key
    """
    media_key = payload.get("media_key")
    if not media_key:
        raise HTTPException(status_code=400, detail="media_key is required")

    try:
        user_id = current_user["user_id"]

        # Verify case exists
        case_meta = load_case_meta(user_id, case_id)
        if not case_meta:
            raise HTTPException(status_code=404, detail="Case not found")

        # Verify transcript exists and belongs to user
        transcript = load_current_transcript(media_key)
        if not transcript:
            raise HTTPException(status_code=404, detail="Transcript not found")
        if transcript.get("user_id") != user_id:
            raise HTTPException(status_code=403, detail="Access denied to this transcript")

        # Get title label
        title_data = transcript.get("title_data", {})
        title_label = title_data.get("FILE_NAME") or title_data.get("CASE_NAME") or media_key

        # Add to case
        success = add_transcript_to_case(user_id, case_id, media_key, title_label)

        if not success:
            raise HTTPException(status_code=500, detail="Failed to add transcript to case")

        return JSONResponse({
            "message": "Transcript added to case successfully",
            "media_key": media_key,
            "case_id": case_id,
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to add transcript %s to case %s: %s", media_key, case_id, e)
        raise HTTPException(status_code=500, detail="Failed to add transcript to case")


@router.delete("/api/cases/{case_id}/transcripts/{media_key}")
async def remove_transcript_from_case_endpoint(
    case_id: str,
    media_key: str,
    current_user: dict = Depends(get_current_user),
):
    """
    Remove a transcript from a case.
    The transcript moves to uncategorized and 30-day TTL is restored.
    """
    try:
        user_id = current_user["user_id"]

        # Verify case exists
        case_meta = load_case_meta(user_id, case_id)
        if not case_meta:
            raise HTTPException(status_code=404, detail="Case not found")

        # Remove from case
        success = remove_transcript_from_case(user_id, case_id, media_key)

        if not success:
            raise HTTPException(status_code=404, detail="Transcript not found in this case")

        return JSONResponse({
            "message": "Transcript removed from case. It will expire in 30 days if not added to another case.",
            "media_key": media_key,
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to remove transcript %s from case %s: %s", media_key, case_id, e)
        raise HTTPException(status_code=500, detail="Failed to remove transcript from case")


@router.get("/api/cases/{case_id}/search")
async def search_case(
    case_id: str,
    q: str = Query(..., min_length=2),
    current_user: dict = Depends(get_current_user),
):
    """
    Search text and speaker names across all transcripts in a case.

    Query params:
        q: str (required, min 2 chars) - Search query
    """
    try:
        user_id = current_user["user_id"]

        # Verify case exists
        case_meta = load_case_meta(user_id, case_id)
        if not case_meta:
            raise HTTPException(status_code=404, detail="Case not found")

        results = search_case_transcripts(user_id, case_id, q)

        # Calculate totals
        total_matches = sum(len(r.get("matches", [])) for r in results)
        transcripts_with_matches = len(results)

        return JSONResponse({
            "query": q,
            "case_id": case_id,
            "results": results,
            "total_matches": total_matches,
            "transcripts_with_matches": transcripts_with_matches,
        })

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to search case %s: %s", case_id, e)
        raise HTTPException(status_code=500, detail="Failed to search case")


@router.get("/api/transcripts/uncategorized")
async def list_uncategorized(current_user: dict = Depends(get_current_user)):
    """
    List all transcripts not assigned to any case.
    These have 30-day TTL and will expire.
    """
    try:
        user_id = current_user["user_id"]
        transcripts = list_uncategorized_transcripts(user_id)

        return JSONResponse({
            "transcripts": transcripts,
            "count": len(transcripts),
        })

    except Exception as e:
        logger.error("Failed to list uncategorized transcripts: %s", e)
        raise HTTPException(status_code=500, detail="Failed to list transcripts")

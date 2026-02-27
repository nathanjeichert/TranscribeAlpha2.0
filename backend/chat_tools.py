"""
Chat tool definitions and execution for the investigation agent.
Three tools: list_transcripts, search_text, read_transcript.
"""

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ─── Tool Definitions (Anthropic API format) ─────────────────────────

TOOL_DEFINITIONS = [
    {
        "name": "list_transcripts",
        "description": (
            "List all transcripts available in this case with their metadata. "
            "Returns title, date, evidence type, speakers, summary, duration, and media_key. "
            "Call this first to understand what evidence is available before searching."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "evidence_type": {
                    "type": "string",
                    "description": "Optional filter by evidence type (jail_call, 911_call, body_worn_camera, interrogation, deposition, other).",
                },
            },
            "required": [],
        },
    },
    {
        "name": "search_text",
        "description": (
            "Search for keywords or phrases across all transcript lines in this case. "
            "Returns matching lines with surrounding context, speaker, page/line numbers, "
            "and media_key for citations. Case-insensitive."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search term or phrase to find in transcript text.",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default 20, max 50).",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "read_transcript",
        "description": (
            "Read the full content of a specific transcript. Supports page range or time range filtering. "
            "If no range is specified, returns the first 5 pages plus total page count. "
            "Use this to read detailed context around search results or to review a full transcript."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "media_key": {
                    "type": "string",
                    "description": "The media_key of the transcript to read.",
                },
                "page_start": {
                    "type": "integer",
                    "description": "Start page number (1-indexed). Used with page_end.",
                },
                "page_end": {
                    "type": "integer",
                    "description": "End page number (inclusive). Max 20 pages per call.",
                },
                "time_start": {
                    "type": "number",
                    "description": "Start time in seconds. Used with time_end.",
                },
                "time_end": {
                    "type": "number",
                    "description": "End time in seconds.",
                },
            },
            "required": ["media_key"],
        },
    },
]


# ─── Tool Execution ──────────────────────────────────────────────────


def execute_tool(
    tool_name: str,
    tool_input: dict[str, Any],
    workspace_path: str,
    case_id: str,
    filters: Optional[dict] = None,
) -> str:
    """Execute a tool and return the result as a JSON string."""
    import json

    try:
        from workspace_reader import (
            list_case_transcript_metadata,
            read_transcript_pages,
            search_transcript_lines,
        )
    except ImportError:
        from .workspace_reader import (
            list_case_transcript_metadata,
            read_transcript_pages,
            search_transcript_lines,
        )

    try:
        if tool_name == "list_transcripts":
            return _execute_list_transcripts(
                tool_input, workspace_path, case_id, filters,
                list_case_transcript_metadata,
            )
        elif tool_name == "search_text":
            return _execute_search_text(
                tool_input, workspace_path, case_id, filters,
                search_transcript_lines,
                list_case_transcript_metadata,
            )
        elif tool_name == "read_transcript":
            return _execute_read_transcript(
                tool_input, workspace_path, case_id, filters,
                read_transcript_pages,
                list_case_transcript_metadata,
            )
        else:
            return json.dumps({"error": f"Unknown tool: {tool_name}"})
    except Exception as e:
        logger.warning("Tool execution error (%s): %s", tool_name, e)
        return json.dumps({"error": str(e)})


def _normalize_date(date_str: str) -> str:
    """Normalize a date string to YYYY-MM-DD for reliable comparison.
    Handles MM/DD/YYYY, M/D/YYYY, YYYY-MM-DD, and similar formats."""
    if not date_str:
        return ""
    # Already ISO format
    if len(date_str) >= 10 and date_str[4] == '-':
        return date_str[:10]
    # Try common US formats (MM/DD/YYYY, M/D/YYYY)
    for fmt in ("%m/%d/%Y", "%m-%d-%Y", "%m/%d/%y", "%m-%d-%y"):
        try:
            from datetime import datetime
            dt = datetime.strptime(date_str.strip(), fmt)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return date_str


def _date_in_range(
    date_str: str, date_from: Optional[str] = None, date_to: Optional[str] = None
) -> bool:
    """Check if a date string falls within the given range after normalization."""
    normalized = _normalize_date(date_str)
    if not normalized:
        return False
    if date_from and normalized < _normalize_date(date_from):
        return False
    if date_to and normalized > _normalize_date(date_to):
        return False
    return True


def _apply_filters(
    metadata: list[dict], filters: Optional[dict], extra_type: Optional[str] = None
) -> list[dict]:
    """Apply user-level filters to transcript metadata."""
    if not filters and not extra_type:
        return metadata

    result = metadata
    f = filters or {}

    # Evidence type filter (combine user filter + agent filter)
    type_filter = set()
    if f.get("evidence_types"):
        type_filter.update(f["evidence_types"])
    if extra_type:
        type_filter.add(extra_type)
    if type_filter:
        result = [m for m in result if m.get("evidence_type") in type_filter]

    # Date filters (normalize to ISO for reliable comparison)
    if f.get("date_from") or f.get("date_to"):
        result = [m for m in result if _date_in_range(
            m.get("date", ""), f.get("date_from"), f.get("date_to")
        )]

    # Speaker filter
    if f.get("speakers"):
        speaker_set = set(s.lower() for s in f["speakers"])
        result = [
            m for m in result
            if any(s.lower() in speaker_set for s in m.get("speakers", []))
        ]

    # Location filter
    if f.get("location"):
        loc_lower = f["location"].lower()
        result = [m for m in result if loc_lower in (m.get("location") or "").lower()]

    # Transcript key filter
    if f.get("transcript_keys"):
        key_set = set(f["transcript_keys"])
        result = [m for m in result if m.get("media_key") in key_set]

    return result


def _execute_list_transcripts(
    tool_input, workspace_path, case_id, filters, list_fn
) -> str:
    import json

    metadata = list_fn(workspace_path, case_id)
    extra_type = tool_input.get("evidence_type")
    filtered = _apply_filters(metadata, filters, extra_type)

    # Return concise metadata
    results = []
    for m in filtered:
        results.append({
            "media_key": m["media_key"],
            "title": m["title"],
            "date": m.get("date", ""),
            "evidence_type": m.get("evidence_type", ""),
            "speakers": m.get("speakers", []),
            "ai_summary": m.get("ai_summary", ""),
            "duration_seconds": m.get("audio_duration", 0),
            "line_count": m.get("line_count", 0),
        })

    return json.dumps({"count": len(results), "transcripts": results})


def _execute_search_text(
    tool_input, workspace_path, case_id, filters, search_fn, list_fn
) -> str:
    import json

    query = tool_input.get("query", "")
    if not query:
        return json.dumps({"error": "Missing 'query' parameter"})

    max_results = min(tool_input.get("max_results", 20), 50)

    # Apply all user filters (evidence type, speakers, location, date) to restrict search scope
    transcript_keys = None
    if filters:
        meta = list_fn(workspace_path, case_id)
        filtered_meta = _apply_filters(meta, filters)
        allowed_keys = [m["media_key"] for m in filtered_meta]
        transcript_keys = allowed_keys

    matches = search_fn(
        workspace_path, case_id, query,
        max_results=max_results,
        transcript_keys=transcript_keys,
    )

    return json.dumps({
        "query": query,
        "match_count": len(matches),
        "matches": matches,
    })


def _execute_read_transcript(
    tool_input, workspace_path, case_id, filters, read_fn, list_fn
) -> str:
    import json

    media_key = tool_input.get("media_key", "")
    if not media_key:
        return json.dumps({"error": "Missing 'media_key' parameter"})

    # Enforce user filters — block reads of filtered-out transcripts
    if filters:
        meta = list_fn(workspace_path, case_id)
        filtered = _apply_filters(meta, filters)
        allowed = {m["media_key"] for m in filtered}
        if media_key not in allowed:
            return json.dumps({"error": f"Transcript '{media_key}' is excluded by active filters"})

    result = read_fn(
        workspace_path,
        case_id,
        media_key,
        page_start=tool_input.get("page_start"),
        page_end=tool_input.get("page_end"),
        time_start=tool_input.get("time_start"),
        time_end=tool_input.get("time_end"),
    )

    if result is None:
        return json.dumps({"error": f"Transcript not found: {media_key}"})

    return json.dumps(result)

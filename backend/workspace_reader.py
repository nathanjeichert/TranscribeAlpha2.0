"""
Workspace Reader — reads transcript files from the user's workspace folder.
Used by the chat agent to access case transcript data.
"""

import json
import logging
import os
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


def validate_workspace_path(workspace: str) -> Path:
    """Validate and return the workspace path, preventing directory traversal."""
    wp = Path(workspace).resolve()
    if not wp.is_dir():
        raise ValueError(f"Workspace path is not a directory: {workspace}")
    return wp


def get_workspace_path_from_request(request) -> str:
    """Extract and validate X-Workspace-Path header from a FastAPI request."""
    workspace = request.headers.get("x-workspace-path", "").strip()
    if not workspace:
        raise ValueError("Missing X-Workspace-Path header")
    validate_workspace_path(workspace)
    return workspace


def _safe_subpath(workspace: Path, *parts: str) -> Path:
    """Build a path under workspace, preventing traversal attacks."""
    target = workspace.joinpath(*parts).resolve()
    if not str(target).startswith(str(workspace)):
        raise ValueError("Path traversal detected")
    return target


def _read_json(path: Path) -> Optional[dict]:
    """Read and parse a JSON file, returning None on failure."""
    try:
        if path.is_file():
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        logger.debug("Failed to read %s: %s", path, e)
    return None


def list_case_transcript_metadata(
    workspace: str, case_id: str
) -> list[dict[str, Any]]:
    """
    Read all transcript JSONs in a case, returning lightweight metadata
    (no full line arrays) for the system prompt and tool results.
    """
    wp = validate_workspace_path(workspace)
    transcripts_dir = _safe_subpath(wp, "cases", case_id, "transcripts")

    results = []
    if not transcripts_dir.is_dir():
        return results

    for filename in os.listdir(transcripts_dir):
        if not filename.endswith(".json"):
            continue
        data = _read_json(transcripts_dir / filename)
        if not data:
            continue

        title_data = data.get("title_data", {})
        lines = data.get("lines", [])

        # Extract unique speakers
        speakers = set()
        for line in lines:
            speaker = str(line.get("speaker", "")).strip()
            if speaker:
                speakers.add(speaker)

        meta = {
            "media_key": data.get("media_key", filename.replace(".json", "")),
            "title": title_data.get("FILE_NAME") or title_data.get("CASE_NAME") or filename,
            "date": title_data.get("DATE", ""),
            "location": title_data.get("LOCATION", ""),
            "ai_summary": data.get("ai_summary", ""),
            "evidence_type": data.get("evidence_type", ""),
            "speakers": sorted(speakers),
            "audio_duration": data.get("audio_duration", 0),
            "line_count": len(lines),
            "lines_per_page": data.get("lines_per_page", 25),
            "created_at": data.get("created_at", ""),
        }
        results.append(meta)

    results.sort(key=lambda m: m.get("created_at", ""), reverse=True)
    return results


def read_transcript_file(
    workspace: str, case_id: str, media_key: str
) -> Optional[dict]:
    """Read a single full transcript JSON."""
    wp = validate_workspace_path(workspace)
    path = _safe_subpath(wp, "cases", case_id, "transcripts", f"{media_key}.json")
    return _read_json(path)


def search_transcript_lines(
    workspace: str,
    case_id: str,
    query: str,
    max_results: int = 20,
    transcript_keys: Optional[list[str]] = None,
) -> list[dict[str, Any]]:
    """
    Case-insensitive keyword search across transcript lines.
    Returns matching lines with 1 line of context before/after.
    """
    wp = validate_workspace_path(workspace)
    transcripts_dir = _safe_subpath(wp, "cases", case_id, "transcripts")

    if not transcripts_dir.is_dir():
        return []

    lower_query = query.lower()
    results = []

    for filename in os.listdir(transcripts_dir):
        if not filename.endswith(".json"):
            continue

        media_key_from_file = filename.replace(".json", "")
        if transcript_keys and media_key_from_file not in transcript_keys:
            continue

        data = _read_json(transcripts_dir / filename)
        if not data or not isinstance(data.get("lines"), list):
            continue

        title_data = data.get("title_data", {})
        title = title_data.get("FILE_NAME") or title_data.get("CASE_NAME") or media_key_from_file
        lines = data["lines"]

        for i, line in enumerate(lines):
            text = str(line.get("text", ""))
            speaker = str(line.get("speaker", ""))
            if lower_query not in text.lower() and lower_query not in speaker.lower():
                continue

            context_before = lines[i - 1] if i > 0 else None
            context_after = lines[i + 1] if i < len(lines) - 1 else None

            match = {
                "media_key": data.get("media_key", media_key_from_file),
                "transcript_title": title,
                "line_id": str(line.get("id", "")),
                "page": line.get("page", 0),
                "line": line.get("line", 0),
                "timestamp": line.get("timestamp", ""),
                "speaker": speaker,
                "text": text,
                "context_before": {
                    "speaker": str(context_before.get("speaker", "")) if context_before else "",
                    "text": str(context_before.get("text", "")) if context_before else "",
                } if context_before else None,
                "context_after": {
                    "speaker": str(context_after.get("speaker", "")) if context_after else "",
                    "text": str(context_after.get("text", "")) if context_after else "",
                } if context_after else None,
            }
            results.append(match)

            if len(results) >= max_results:
                return results

    return results


def read_transcript_pages(
    workspace: str,
    case_id: str,
    media_key: str,
    page_start: Optional[int] = None,
    page_end: Optional[int] = None,
    time_start: Optional[float] = None,
    time_end: Optional[float] = None,
) -> Optional[dict[str, Any]]:
    """
    Read a transcript with optional page or time range filtering.
    Caps at 20 pages per call to prevent context blowout.
    """
    data = read_transcript_file(workspace, case_id, media_key)
    if not data or not isinstance(data.get("lines"), list):
        return None

    lines = data["lines"]
    lines_per_page = data.get("lines_per_page", 25)
    total_pages = max(1, (len(lines) + lines_per_page - 1) // lines_per_page) if lines else 0
    title_data = data.get("title_data", {})

    # Filter by time range
    if time_start is not None or time_end is not None:
        filtered = []
        for line in lines:
            ts = line.get("start_time") or line.get("timestamp_seconds") or 0
            if isinstance(ts, str):
                try:
                    ts = float(ts)
                except ValueError:
                    ts = 0
            if time_start is not None and ts < time_start:
                continue
            if time_end is not None and ts > time_end:
                continue
            filtered.append(line)
        lines = filtered[:500]  # hard cap
    elif page_start is not None or page_end is not None:
        # Filter by page range
        ps = max(1, page_start or 1)
        pe = min(total_pages, page_end or (ps + 19))
        pe = min(pe, ps + 19)  # cap at 20 pages
        filtered = [l for l in lines if ps <= (l.get("page", 0)) <= pe]
        lines = filtered
    else:
        # Default: first 5 pages
        max_page = min(5, total_pages)
        lines = [l for l in lines if (l.get("page", 0)) <= max_page]

    return {
        "media_key": data.get("media_key", media_key),
        "title": title_data.get("FILE_NAME") or title_data.get("CASE_NAME") or media_key,
        "total_pages": total_pages,
        "total_lines": len(data["lines"]),
        "returned_lines": len(lines),
        "lines": [
            {
                "id": l.get("id", ""),
                "page": l.get("page", 0),
                "line": l.get("line", 0),
                "speaker": l.get("speaker", ""),
                "text": l.get("text", ""),
                "timestamp": l.get("timestamp", ""),
            }
            for l in lines
        ],
    }

"""
Chat SSE endpoint — POST /api/chat
Streams agent responses as Server-Sent Events.
"""

import json
import logging

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/api/chat")
async def chat(request: Request):
    try:
        from standalone_config import get_api_key
    except ImportError:
        from ..standalone_config import get_api_key

    try:
        from chat_models import ChatRequest
    except ImportError:
        from ..chat_models import ChatRequest

    try:
        from chat_agent import run_agent
    except ImportError:
        from ..chat_agent import run_agent

    try:
        from workspace_reader import (
            get_workspace_path_from_request,
            list_case_transcript_metadata,
        )
    except ImportError:
        from ..workspace_reader import (
            get_workspace_path_from_request,
            list_case_transcript_metadata,
        )

    # Validate API key
    api_key = get_api_key("anthropic_api_key")
    if not api_key:
        return _sse_error(
            "Anthropic API key not configured. Add it in Settings.", status=400
        )

    # Validate workspace path
    try:
        workspace_path = get_workspace_path_from_request(request)
    except ValueError as e:
        return _sse_error(str(e), status=400)

    # Parse request body
    try:
        body = await request.json()
        chat_req = ChatRequest(**body)
    except Exception as e:
        return _sse_error(f"Invalid request: {e}", status=400)

    if not chat_req.case_id:
        return _sse_error("Missing case_id", status=400)

    # Load transcript metadata
    try:
        metadata = list_case_transcript_metadata(workspace_path, chat_req.case_id)
    except Exception as e:
        logger.warning("Failed to load transcript metadata: %s", e)
        metadata = []

    # Get case name from meta.json
    case_name = chat_req.case_id
    try:
        import json as _json
        from pathlib import Path
        meta_path = Path(workspace_path) / "cases" / chat_req.case_id / "meta.json"
        if meta_path.is_file():
            with open(meta_path, "r", encoding="utf-8") as f:
                case_meta = _json.load(f)
            case_name = case_meta.get("name", case_name)
    except Exception:
        pass  # Fall back to case_id

    # Build filters dict
    filters = None
    if chat_req.filters:
        filters = chat_req.filters.model_dump(exclude_none=True)

    # Prepare messages
    messages = [
        {"role": m.role, "content": m.content} for m in chat_req.messages
    ]

    def event_generator():
        for event in run_agent(
            api_key=api_key,
            messages=messages,
            case_name=case_name,
            transcript_metadata=metadata,
            workspace_path=workspace_path,
            case_id=chat_req.case_id,
            filters=filters,
        ):
            event_type = event.get("event", "error")
            data = json.dumps(event.get("data", {}))
            yield f"event: {event_type}\ndata: {data}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _sse_error(message: str, status: int = 500):
    """Return a single SSE error event as a streaming response."""

    def gen():
        data = json.dumps({"message": message})
        yield f"event: error\ndata: {data}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        status_code=status,
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )

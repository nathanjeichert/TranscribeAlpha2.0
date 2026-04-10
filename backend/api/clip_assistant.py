"""
Clip Assistant API — drafts a single clip range for the current Viewer transcript.
"""

import json
import logging
from typing import Literal, Optional, Union

from fastapi import APIRouter, Body, HTTPException, Request
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter()

CONFIDENCE_VALUES = {"low", "medium", "high"}

SYSTEM_PROMPT = """
You are a legal trial presentation clip assistant. Your job is to draft exactly one
continuous video clip range from the transcript lines provided by the application.

Rules:
- Return ONLY valid JSON matching the schema.
- Use the current transcript only.
- Never invent line ids. start_line_id and end_line_id must be ids from the supplied lines.
- The clip must be one continuous range, with start_line_id at or before end_line_id.
- If the user asks for exact pages, page/line numbers, or timestamps, follow those boundaries exactly using the supplied metadata.
- If the user asks for a topic or event, choose the shortest useful range that captures the relevant testimony and enough surrounding Q/A context to make it understandable.
- Prefer under-including over over-including unless the user's request clearly asks for a broad range.
- If the request is ambiguous, impossible from the provided transcript, or would require multiple separate clips, return needs_clarification with a short plain-language message.
- Do not save clips, export files, or claim that a clip has been created. You only draft an editable range.
""".strip()


class ClipAssistantLine(BaseModel):
    id: str
    page: Optional[int] = None
    line: Optional[int] = None
    pgln: Optional[int] = None
    start: float
    end: float
    speaker: str = ""
    text: str = ""


class ClipAssistantRequest(BaseModel):
    media_key: str
    case_id: Optional[str] = None
    transcript_title: Optional[str] = None
    media_duration: float = 0
    selected_line_id: Optional[str] = None
    user_request: str
    lines: list[ClipAssistantLine] = Field(default_factory=list)


class ClipAssistantDraft(BaseModel):
    name: str
    start_line_id: str
    end_line_id: str
    rationale: str
    confidence: Literal["low", "medium", "high"] = "medium"
    warnings: list[str] = Field(default_factory=list)


class ClipAssistantDraftResponse(BaseModel):
    status: Literal["draft"]
    draft: ClipAssistantDraft


class ClipAssistantClarificationResponse(BaseModel):
    status: Literal["needs_clarification"]
    message: str


ClipAssistantResponse = Union[
    ClipAssistantDraftResponse,
    ClipAssistantClarificationResponse,
]


@router.post("/api/clip-assistant", response_model=ClipAssistantResponse)
async def clip_assistant(
    request: Request,
    req: ClipAssistantRequest = Body(...),
):
    try:
        from auth import require_standalone_session
    except ImportError:
        from ..auth import require_standalone_session

    require_standalone_session(request)

    try:
        from standalone_config import get_api_key
    except ImportError:
        from ..standalone_config import get_api_key

    api_key = get_api_key("anthropic_api_key")
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="Anthropic API key not configured. Add it in Settings.",
        )

    prompt = req.user_request.strip()
    if not prompt:
        return ClipAssistantClarificationResponse(
            status="needs_clarification",
            message="Tell me what part of the transcript to clip.",
        )

    if not req.lines:
        return ClipAssistantClarificationResponse(
            status="needs_clarification",
            message="This transcript does not have line timing available for clip drafting.",
        )

    line_by_id: dict[str, ClipAssistantLine] = {}
    ordered_ids: list[str] = []
    for line in req.lines:
        if line.id and line.id not in line_by_id:
            line_by_id[line.id] = line
            ordered_ids.append(line.id)

    if not ordered_ids:
        return ClipAssistantClarificationResponse(
            status="needs_clarification",
            message="This transcript does not have usable line ids for clip drafting.",
        )

    user_content = _build_user_content(req)

    try:
        import anthropic
    except Exception:
        logger.exception("Anthropic SDK unavailable for clip assistant")
        raise HTTPException(
            status_code=500,
            detail="Clip Assistant is temporarily unavailable.",
        )

    try:
        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=900,
            temperature=0.2,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_content}],
            output_config={
                "format": {
                    "type": "json_schema",
                    "schema": {
                        "type": "object",
                        "properties": {
                            "status": {
                                "type": "string",
                                "enum": ["draft", "needs_clarification"],
                            },
                            "draft": {
                                "type": "object",
                                "properties": {
                                    "name": {
                                        "type": "string",
                                        "description": "Short useful clip name.",
                                    },
                                    "start_line_id": {"type": "string"},
                                    "end_line_id": {"type": "string"},
                                    "rationale": {
                                        "type": "string",
                                        "description": "One sentence explaining why this range was selected.",
                                    },
                                    "confidence": {
                                        "type": "string",
                                        "enum": ["low", "medium", "high"],
                                    },
                                    "warnings": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                    },
                                },
                                "required": [
                                    "name",
                                    "start_line_id",
                                    "end_line_id",
                                    "rationale",
                                    "confidence",
                                ],
                                "additionalProperties": False,
                            },
                            "message": {"type": "string"},
                        },
                        "required": ["status"],
                        "additionalProperties": False,
                    },
                }
            },
        )

        parsed = json.loads(_response_text(response))
        return _validate_response(parsed, line_by_id, ordered_ids)

    except anthropic.AuthenticationError:
        raise HTTPException(
            status_code=400,
            detail="Anthropic API key is invalid. Update it in Settings.",
        )
    except anthropic.RateLimitError:
        raise HTTPException(
            status_code=429,
            detail="Anthropic rate limit reached. Please wait a moment and try again.",
        )
    except anthropic.APIStatusError as e:
        logger.warning("Clip Assistant Anthropic API error (%s): %s", e.status_code, e)
        raise HTTPException(
            status_code=502,
            detail="Anthropic is temporarily unavailable. Please try again.",
        )
    except json.JSONDecodeError:
        logger.warning("Clip Assistant returned non-JSON content")
        return ClipAssistantClarificationResponse(
            status="needs_clarification",
            message="I could not draft a reliable clip from that request. Try a more specific page, line, time, or topic.",
        )
    except HTTPException:
        raise
    except Exception:
        logger.exception("Clip Assistant failed")
        raise HTTPException(
            status_code=500,
            detail="Clip Assistant failed. Please try again.",
        )


def _build_user_content(req: ClipAssistantRequest) -> str:
    lines = "\n".join(_format_line(line) for line in req.lines)
    selected = req.selected_line_id or "none"
    title = req.transcript_title or req.media_key
    case_id = req.case_id or "none"

    return (
        f"Transcript title: {title}\n"
        f"Media key: {req.media_key}\n"
        f"Case id: {case_id}\n"
        f"Media duration seconds: {req.media_duration:.3f}\n"
        f"Selected line id: {selected}\n\n"
        f"User request:\n{req.user_request.strip()}\n\n"
        "Transcript lines, in order:\n"
        f"{lines}"
    )


def _format_line(line: ClipAssistantLine) -> str:
    text = " ".join((line.text or "").split())
    if len(text) > 320:
        text = text[:317].rstrip() + "..."
    speaker = " ".join((line.speaker or "").split())
    page = line.page if line.page is not None else ""
    number = line.line if line.line is not None else ""
    pgln = line.pgln if line.pgln is not None else ""
    return (
        f"id={line.id} page={page} line={number} pgln={pgln} "
        f"time={line.start:.3f}-{line.end:.3f} speaker={speaker}: {text}"
    )


def _response_text(response) -> str:
    for block in getattr(response, "content", []) or []:
        text = getattr(block, "text", None)
        if text:
            return text
    return ""


def _validate_response(
    parsed: dict,
    line_by_id: dict[str, ClipAssistantLine],
    ordered_ids: list[str],
) -> ClipAssistantResponse:
    status = parsed.get("status")

    if status == "needs_clarification":
        message = str(parsed.get("message") or "").strip()
        return ClipAssistantClarificationResponse(
            status="needs_clarification",
            message=message
            or "I need a little more detail before I can draft that clip.",
        )

    if status != "draft" or not isinstance(parsed.get("draft"), dict):
        return ClipAssistantClarificationResponse(
            status="needs_clarification",
            message="I could not draft a reliable clip from that request. Try a more specific page, line, time, or topic.",
        )

    draft = parsed["draft"]
    start_line_id = str(draft.get("start_line_id") or "").strip()
    end_line_id = str(draft.get("end_line_id") or "").strip()
    if start_line_id not in line_by_id or end_line_id not in line_by_id:
        return ClipAssistantClarificationResponse(
            status="needs_clarification",
            message="I could not match the drafted range to transcript lines. Try a more specific request.",
        )

    start_index = ordered_ids.index(start_line_id)
    end_index = ordered_ids.index(end_line_id)
    if start_index > end_index:
        return ClipAssistantClarificationResponse(
            status="needs_clarification",
            message="I could not produce a valid forward clip range. Try a more specific request.",
        )

    start_line = line_by_id[start_line_id]
    end_line = line_by_id[end_line_id]
    if end_line.end <= start_line.start:
        return ClipAssistantClarificationResponse(
            status="needs_clarification",
            message="The drafted clip did not have a valid start and end time.",
        )

    confidence = str(draft.get("confidence") or "medium").strip().lower()
    if confidence not in CONFIDENCE_VALUES:
        confidence = "medium"

    warnings = draft.get("warnings") or []
    if not isinstance(warnings, list):
        warnings = []

    name = str(draft.get("name") or "Draft clip").strip()[:80] or "Draft clip"
    rationale = str(draft.get("rationale") or "").strip()

    return ClipAssistantDraftResponse(
        status="draft",
        draft=ClipAssistantDraft(
            name=name,
            start_line_id=start_line_id,
            end_line_id=end_line_id,
            rationale=rationale,
            confidence=confidence,  # type: ignore[arg-type]
            warnings=[str(item).strip() for item in warnings if str(item).strip()][:4],
        ),
    )

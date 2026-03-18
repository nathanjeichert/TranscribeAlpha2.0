"""
Summarize API — auto-generates a short summary and evidence type tag
for a newly transcribed file using Claude Haiku.
"""

import json
import logging

from fastapi import APIRouter, Body, HTTPException, Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()

EVIDENCE_TYPES = [
    "jail_call",
    "911_call",
    "body_worn_camera",
    "interrogation",
    "deposition",
    "other",
]

SYSTEM_PROMPT = (
    "You classify legal evidence transcripts. Given the transcript excerpt and "
    "source filename, provide a 2-3 sentence summary and classify the evidence type.\n\n"
    "Evidence types: jail_call, 911_call, body_worn_camera, interrogation, deposition, other.\n\n"
    "Respond with ONLY valid JSON matching the schema provided."
)


class SummarizeRequest(BaseModel):
    media_key: str
    media_filename: str = ""
    transcript_text: str = ""


class SummarizeResponse(BaseModel):
    ai_summary: str
    evidence_type: str


@router.post("/api/summarize", response_model=SummarizeResponse)
async def summarize_transcript(request: Request, req: SummarizeRequest = Body(...)):
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

    # Truncate transcript to first ~3000 chars for cost efficiency
    excerpt = req.transcript_text[:3000] if req.transcript_text else ""
    if not excerpt.strip():
        return SummarizeResponse(ai_summary="", evidence_type="other")

    user_content = (
        f"Filename: {req.media_filename}\n\n"
        f"Transcript excerpt:\n{excerpt}"
    )

    try:
        import anthropic
    except Exception:
        logger.exception("Anthropic SDK unavailable for summarization")
        raise HTTPException(
            status_code=500,
            detail="Summarization is temporarily unavailable.",
        )

    try:
        client = anthropic.Anthropic(api_key=api_key)

        response = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=256,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_content}],
            output_config={
                "format": {
                    "type": "json_schema",
                    "schema": {
                        "type": "object",
                        "properties": {
                            "ai_summary": {
                                "type": "string",
                                "description": "A 2-3 sentence summary of the transcript.",
                            },
                            "evidence_type": {
                                "type": "string",
                                "enum": EVIDENCE_TYPES,
                                "description": "The type of legal evidence.",
                            },
                        },
                        "required": ["ai_summary", "evidence_type"],
                        "additionalProperties": False,
                    },
                }
            },
        )

        text = response.content[0].text
        parsed = json.loads(text)

        ai_summary = parsed.get("ai_summary", "")
        evidence_type = parsed.get("evidence_type", "other")
        if evidence_type not in EVIDENCE_TYPES:
            evidence_type = "other"

        return SummarizeResponse(ai_summary=ai_summary, evidence_type=evidence_type)

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
        logger.warning("Summarize Anthropic API error (%s): %s", e.status_code, e)
        raise HTTPException(
            status_code=502,
            detail="Anthropic is temporarily unavailable. Please try again.",
        )
    except Exception:
        logger.exception("Summarize failed")
        raise HTTPException(
            status_code=500,
            detail="Summarization failed. Please try again.",
        )

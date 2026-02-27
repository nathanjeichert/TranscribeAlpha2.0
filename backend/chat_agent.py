"""
Chat Agent — orchestrates the agentic loop with Claude Sonnet,
executing tools and streaming SSE events back to the frontend.
"""

import json
import logging
import re
from typing import Any, Generator, Optional

logger = logging.getLogger(__name__)

# ─── System Prompt ────────────────────────────────────────────────────

SYSTEM_PROMPT_TEMPLATE = """\
You are a legal investigation assistant analyzing evidence transcripts for a case.

## Case Context
- Case: {case_name}
- Total transcripts: {transcript_count}

## Available Evidence
{evidence_list}

## Tool Usage Strategy
1. Call `list_transcripts` first to see all available evidence and their summaries.
2. Use `search_text` to find specific keywords, phrases, names, or topics across all transcripts.
3. Use `read_transcript` to read detailed context around search results or review specific pages.

## Citation Format
When citing specific transcript content, use this exact format:
[[CITE: media_key=MEDIA_KEY line_id=LINE_ID snippet="EXACT QUOTED TEXT"]]

Example: [[CITE: media_key=abc123 line_id=3-5 snippet="I saw him at the store"]]

## Guidelines
- NEVER fabricate or invent transcript content. Only quote what you find in the actual transcripts.
- Cite every factual claim with the [[CITE:...]] format so the user can verify.
- Clearly distinguish direct quotes from your interpretation or analysis.
- If you cannot find relevant information, say so clearly rather than guessing.
- When summarizing findings, organize by theme or chronology as appropriate.
- Be thorough but concise. Legal professionals need accuracy above all else.
"""


def _build_evidence_list(metadata: list[dict]) -> str:
    """Format transcript metadata for the system prompt."""
    if not metadata:
        return "(No transcripts available)"

    lines = []
    for m in metadata:
        parts = [f"- **{m['title']}**"]
        if m.get("evidence_type"):
            parts.append(f"[{m['evidence_type']}]")
        if m.get("date"):
            parts.append(f"({m['date']})")
        parts.append(f"| {m.get('line_count', 0)} lines")
        dur = m.get("audio_duration") or m.get("duration_seconds", 0)
        if dur:
            minutes = int(dur) // 60
            seconds = int(dur) % 60
            parts.append(f"| {minutes}:{seconds:02d}")
        if m.get("speakers"):
            parts.append(f"| Speakers: {', '.join(m['speakers'][:5])}")
        lines.append(" ".join(parts))

        if m.get("ai_summary"):
            lines.append(f"  Summary: {m['ai_summary']}")

    return "\n".join(lines)


# ─── Citation Parsing ─────────────────────────────────────────────────

CITE_PATTERN = re.compile(
    r'\[\[CITE:\s*media_key=(\S+)\s+line_id=(\S+)\s+snippet="([^"]*?)"\]\]'
)


def parse_citations(text: str, metadata_by_key: dict) -> list[dict]:
    """Parse [[CITE:...]] markers from text and enrich with metadata."""
    citations = []
    for match in CITE_PATTERN.finditer(text):
        media_key = match.group(1)
        line_id = match.group(2)
        snippet = match.group(3)

        meta = metadata_by_key.get(media_key, {})
        citations.append({
            "media_key": media_key,
            "line_id": line_id,
            "snippet": snippet,
            "title": meta.get("title", ""),
            "date": meta.get("date", ""),
        })
    return citations


# ─── Agentic Loop ─────────────────────────────────────────────────────


def run_agent(
    api_key: str,
    messages: list[dict],
    case_name: str,
    transcript_metadata: list[dict],
    workspace_path: str,
    case_id: str,
    filters: Optional[dict] = None,
) -> Generator[dict, None, None]:
    """
    Run the agentic loop. Yields SSE event dicts:
      {"event": "token", "data": {"text": "..."}}
      {"event": "tool_use", "data": {"tool": "...", "input": {...}}}
      {"event": "citation", "data": {...}}
      {"event": "done", "data": {"input_tokens": N, "output_tokens": N}}
      {"event": "error", "data": {"message": "..."}}
    """
    import anthropic

    try:
        from chat_tools import TOOL_DEFINITIONS, execute_tool
    except ImportError:
        from .chat_tools import TOOL_DEFINITIONS, execute_tool

    client = anthropic.Anthropic(api_key=api_key)

    # Build system prompt
    evidence_list = _build_evidence_list(transcript_metadata)
    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
        case_name=case_name,
        transcript_count=len(transcript_metadata),
        evidence_list=evidence_list,
    )

    # Build metadata lookup for citation enrichment
    metadata_by_key = {m["media_key"]: m for m in transcript_metadata}

    # Prepare messages for the API
    api_messages = []
    for msg in messages:
        api_messages.append({
            "role": msg["role"],
            "content": msg["content"],
        })

    # Truncate to last 10 turns if conversation is very long
    if len(api_messages) > 20:
        api_messages = api_messages[-20:]

    total_input_tokens = 0
    total_output_tokens = 0
    max_iterations = 10  # prevent runaway loops

    for iteration in range(max_iterations):
        try:
            with client.messages.stream(
                model="claude-sonnet-4-6",
                max_tokens=4096,
                system=system_prompt,
                tools=TOOL_DEFINITIONS,
                messages=api_messages,
                thinking={"type": "adaptive"},
            ) as stream:
                # Stream text tokens as they arrive
                for event in stream:
                    if event.type == "content_block_delta":
                        if event.delta.type == "text_delta":
                            yield {"event": "token", "data": {"text": event.delta.text}}

                response = stream.get_final_message()

        except anthropic.AuthenticationError:
            yield {"event": "error", "data": {"message": "Invalid Anthropic API key. Check your key in Settings."}}
            return
        except anthropic.RateLimitError:
            yield {"event": "error", "data": {"message": "Rate limited by Anthropic. Please wait a moment and try again."}}
            return
        except anthropic.APIStatusError as e:
            if e.status_code >= 500:
                yield {"event": "error", "data": {"message": "Anthropic API is temporarily unavailable. Please try again."}}
            else:
                yield {"event": "error", "data": {"message": f"API error: {e.message}"}}
            return
        except Exception as e:
            yield {"event": "error", "data": {"message": f"Unexpected error: {str(e)}"}}
            return

        # Track token usage
        if response.usage:
            total_input_tokens += response.usage.input_tokens
            total_output_tokens += response.usage.output_tokens

        # Check for tool use
        tool_use_blocks = [b for b in response.content if b.type == "tool_use"]

        if not tool_use_blocks:
            # No tool calls — agent is done.
            # Parse citations from the final text
            full_text = ""
            for block in response.content:
                if block.type == "text":
                    full_text += block.text

            citations = parse_citations(full_text, metadata_by_key)
            for citation in citations:
                yield {"event": "citation", "data": citation}

            yield {
                "event": "done",
                "data": {
                    "input_tokens": total_input_tokens,
                    "output_tokens": total_output_tokens,
                },
            }
            return

        # Execute tools and continue the loop
        api_messages.append({"role": "assistant", "content": response.content})

        tool_results = []
        for tool_block in tool_use_blocks:
            yield {
                "event": "tool_use",
                "data": {
                    "tool": tool_block.name,
                    "input": tool_block.input,
                },
            }

            result = execute_tool(
                tool_block.name,
                tool_block.input,
                workspace_path,
                case_id,
                filters,
            )

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tool_block.id,
                "content": result,
            })

        api_messages.append({"role": "user", "content": tool_results})

    # Hit max iterations
    yield {
        "event": "done",
        "data": {
            "input_tokens": total_input_tokens,
            "output_tokens": total_output_tokens,
        },
    }

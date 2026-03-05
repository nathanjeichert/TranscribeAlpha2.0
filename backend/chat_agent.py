"""
Chat Agent — orchestrates the agentic loop with Claude Haiku,
executing tools and streaming SSE events back to the frontend.

Uses Anthropic's native search_result citations instead of custom
[[CITE:...]] markers. Tool results containing search_result blocks
cause the API to automatically generate structured citations.
"""

import json
import logging
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

## Guidelines
- NEVER fabricate or invent transcript content. Only quote what you find in the actual transcripts.
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


def _serialize_citation(citation, search_result_registry: list[dict] | None = None) -> dict:
    """Convert an Anthropic citation object to a JSON-serializable dict.

    search_result_registry maps search_result_index → the original search_result
    block we sent, so we can recover source/title for navigation.
    """
    idx = getattr(citation, "search_result_index", None)
    source = ""
    title = ""
    if search_result_registry and idx is not None and 0 <= idx < len(search_result_registry):
        sr = search_result_registry[idx]
        source = sr.get("source", "")
        title = sr.get("title", "")

    return {
        "type": getattr(citation, "type", ""),
        "source": source,
        "title": title,
        "cited_text": getattr(citation, "cited_text", ""),
        "search_result_index": idx or 0,
        "start_block_index": getattr(citation, "start_block_index", 0),
        "end_block_index": getattr(citation, "end_block_index", 0),
    }


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

    # Build system prompt with cache control for prompt caching
    evidence_list = _build_evidence_list(transcript_metadata)
    system_text = SYSTEM_PROMPT_TEMPLATE.format(
        case_name=case_name,
        transcript_count=len(transcript_metadata),
        evidence_list=evidence_list,
    )
    system = [
        {
            "type": "text",
            "text": system_text,
            "cache_control": {"type": "ephemeral"},
        }
    ]

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
    tool_summaries: list[str] = []  # Track tool calls for context in subsequent turns
    # Registry of search_result blocks from tool results, ordered by appearance.
    # The API's citation.search_result_index maps into this list.
    search_result_registry: list[dict] = []
    max_iterations = 10  # prevent runaway loops

    for iteration in range(max_iterations):
        try:
            # First, make a non-streaming call to see if the model wants tools
            response = client.messages.create(
                model="claude-haiku-4-5",
                max_tokens=4096,
                system=system,
                tools=TOOL_DEFINITIONS,
                messages=api_messages,
            )

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
            # No tool calls — agent is done. Emit text and citations.
            all_citations = []
            for block in response.content:
                if block.type == "text":
                    # Emit text as tokens for streaming feel
                    text = block.text
                    chunk_size = 12
                    for i in range(0, len(text), chunk_size):
                        yield {"event": "token", "data": {"text": text[i:i + chunk_size]}}
                    # Collect citations from this block
                    if hasattr(block, "citations") and block.citations:
                        for citation in block.citations:
                            all_citations.append(citation)

            # Deduplicate citations by source+cited_text and emit
            seen = set()
            for citation in all_citations:
                source = getattr(citation, "source", "")
                cited_text = getattr(citation, "cited_text", "")
                key = f"{source}|{cited_text}"
                if key in seen:
                    continue
                seen.add(key)
                logger.info("Citation: type=%s source=%s title=%s cited_text=%s",
                            getattr(citation, "type", "?"),
                            source,
                            getattr(citation, "title", "?"),
                            cited_text[:80] if cited_text else "")
                yield {"event": "citation", "data": _serialize_citation(citation, search_result_registry)}

            yield {
                "event": "done",
                "data": {
                    "input_tokens": total_input_tokens,
                    "output_tokens": total_output_tokens,
                    "tool_history": tool_summaries if tool_summaries else None,
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
                cached_metadata=transcript_metadata,
            )

            # Build compact summary for multi-turn context
            tool_input_str = json.dumps(tool_block.input, default=str)
            tool_summaries.append(f"{tool_block.name}({tool_input_str})")

            # Track search_result blocks for citation source mapping
            for block in result:
                if block.get("type") == "search_result":
                    search_result_registry.append(block)

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
            "tool_history": tool_summaries if tool_summaries else None,
        },
    }

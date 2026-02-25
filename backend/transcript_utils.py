import base64
import logging
import os
import re
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

# Viewer module for criminal variant
try:
    from .viewer import render_viewer_html
except ImportError:
    try:
        from viewer import render_viewer_html
    except ImportError:
        try:
            import viewer as viewer_module
            render_viewer_html = viewer_module.render_viewer_html
        except ImportError:
            render_viewer_html = None  # Viewer not available

try:
    from .models import TranscriptTurn, WordTimestamp
except ImportError:
    try:
        from models import TranscriptTurn, WordTimestamp
    except ImportError:
        import models
        TranscriptTurn = models.TranscriptTurn
        WordTimestamp = models.WordTimestamp

try:
    from .transcript_formatting import (
        create_pdf,
        generate_oncue_xml_from_line_entries,
        compute_transcript_line_entries,
        seconds_to_timestamp,
    )
except ImportError:
    try:
        from transcript_formatting import (
            create_pdf,
            generate_oncue_xml_from_line_entries,
            compute_transcript_line_entries,
            seconds_to_timestamp,
        )
    except ImportError:
        import transcript_formatting as transcript_formatting_module
        create_pdf = transcript_formatting_module.create_pdf
        generate_oncue_xml_from_line_entries = transcript_formatting_module.generate_oncue_xml_from_line_entries
        compute_transcript_line_entries = transcript_formatting_module.compute_transcript_line_entries
        seconds_to_timestamp = transcript_formatting_module.seconds_to_timestamp

logger = logging.getLogger(__name__)
_SPEAKER_LETTER_RE = re.compile(r"^[A-Z]$")
_SPEAKER_NUMERIC_RE = re.compile(r"^[0-9]+$")


def normalize_speaker_label(raw_value: Any, fallback: str = "SPEAKER") -> str:
    """Normalize diarization labels so exports consistently use SPEAKER X."""
    fallback_value = str(fallback or "").strip().upper() or "SPEAKER"
    candidate = str(raw_value or "").strip()
    candidate = re.sub(r":+$", "", candidate).strip().upper()

    if not candidate:
        candidate = fallback_value

    if candidate == "UNKNOWN":
        return fallback_value

    if candidate.startswith("SPEAKER"):
        suffix = candidate[len("SPEAKER"):].strip()
        return f"SPEAKER {suffix}" if suffix else "SPEAKER"

    if _SPEAKER_LETTER_RE.fullmatch(candidate) or _SPEAKER_NUMERIC_RE.fullmatch(candidate):
        return f"SPEAKER {candidate}"

    return candidate


def serialize_transcript_turns(turns: List[TranscriptTurn]) -> List[dict]:
    serialized: List[dict] = []
    for turn in turns:
        turn_dict = turn.model_dump()
        if turn_dict.get("words"):
            sanitized_words = []
            for word in turn_dict["words"]:
                sanitized_words.append(
                    {
                        "text": word.get("text"),
                        "start": float(word.get("start", 0.0)),
                        "end": float(word.get("end", 0.0)),
                        "confidence": word.get("confidence"),
                        "speaker": word.get("speaker"),
                    }
                )
            turn_dict["words"] = sanitized_words
        serialized.append(turn_dict)
    return serialized


def format_transcript_text(turns: List[TranscriptTurn]) -> str:
    return "\n\n".join(
        [
            f"{(turn.timestamp + ' ') if turn.timestamp else ''}{turn.speaker.upper()}:\t\t{turn.text}"
            for turn in turns
        ]
    )


def serialize_line_entries(line_entries: List[dict]) -> List[dict]:
    """Convert line entry timestamps to float for JSON serialization."""
    serialized = []
    for entry in line_entries:
        serialized.append(
            {
                **entry,
                "start": float(entry.get("start", 0.0)),
                "end": float(entry.get("end", 0.0)),
                "timestamp_error": bool(entry.get("timestamp_error", False)),
            }
        )
    return serialized


def build_session_artifacts(
    turns: List[TranscriptTurn],
    title_data: dict,
    audio_duration: float,
    lines_per_page: int,
    enforce_min_line_duration: bool = True,
) -> Tuple[bytes, str, str, List[dict]]:
    line_entries, _ = compute_transcript_line_entries(
        turns,
        audio_duration,
        lines_per_page,
        enforce_min_duration=enforce_min_line_duration,
    )
    pdf_bytes = create_pdf(title_data, line_entries, lines_per_page=lines_per_page)
    oncue_xml = generate_oncue_xml_from_line_entries(
        line_entries,
        title_data,
        audio_duration,
        lines_per_page,
    )
    transcript_text = format_transcript_text(turns)
    serialized_entries = serialize_line_entries(line_entries)
    return pdf_bytes, oncue_xml, transcript_text, serialized_entries


def build_viewer_payload(
    line_entries: List[dict],
    title_data: dict,
    audio_duration: float,
    lines_per_page: int,
    media_filename: str = "media.mp4",
    media_content_type: str = "video/mp4",
) -> Dict[str, Any]:
    """
    Build the JSON payload for the standalone HTML viewer.

    Args:
        line_entries: Serialized line entries from compute_transcript_line_entries
        title_data: Metadata dict (CASE_NAME, FILE_NAME, DATE, LOCATION, etc.)
        audio_duration: Total duration in seconds
        lines_per_page: Lines per page for pagination
        media_filename: Relative path to media file
        media_content_type: MIME type of media file

    Returns:
        Dict payload ready for render_viewer_html
    """
    # Format duration as HH:MM:SS
    total_secs = int(audio_duration)
    hours, remainder = divmod(total_secs, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours > 0:
        duration_str = f"{hours:02d}:{minutes:02d}:{secs:02d}"
    else:
        duration_str = f"{minutes:02d}:{secs:02d}"

    # Build title metadata
    meta_title = {
        "CASE_NAME": title_data.get("CASE_NAME", ""),
        "CASE_NUMBER": title_data.get("CASE_NUMBER", ""),
        "FIRM_OR_ORGANIZATION_NAME": title_data.get("FIRM_OR_ORGANIZATION_NAME", ""),
        "DATE": title_data.get("DATE", ""),
        "TIME": title_data.get("TIME", ""),
        "LOCATION": title_data.get("LOCATION", ""),
        "FILE_NAME": title_data.get("FILE_NAME", media_filename),
        "FILE_DURATION": duration_str,
    }

    # Extract unique speakers
    speakers = list(set(
        entry.get("speaker", "")
        for entry in line_entries
        if entry.get("speaker")
    ))

    # Build lines array for viewer
    lines = []
    for idx, entry in enumerate(line_entries):
        lines.append({
            "id": entry.get("id", f"line-{idx}"),
            "speaker": entry.get("speaker", ""),
            "text": entry.get("text", ""),
            "rendered_text": entry.get("rendered_text", ""),
            "start": entry.get("start", 0),
            "end": entry.get("end", 0),
            "page_number": entry.get("page", 1),  # Fixed: was "page_number", should be "page"
            "line_number": entry.get("line", idx + 1),  # Fixed: was "line_number", should be "line"
            "pgln": entry.get("pgln", 101 + idx),
            "is_continuation": entry.get("is_continuation", False),
        })

    # Build pages array
    pages = []
    page_lines: Dict[int, List[int]] = {}
    for idx, line in enumerate(lines):
        page_num = line.get("page_number", 1)
        if page_num not in page_lines:
            page_lines[page_num] = []
        page_lines[page_num].append(idx)

    for page_num in sorted(page_lines.keys()):
        line_indexes = page_lines[page_num]
        pages.append({
            "page_number": page_num,
            "line_indexes": line_indexes,
            "pgln_start": lines[line_indexes[0]]["pgln"] if line_indexes else 101,
            "pgln_end": lines[line_indexes[-1]]["pgln"] if line_indexes else 101,
        })

    return {
        "meta": {
            "title": meta_title,
            "duration_seconds": audio_duration,
            "lines_per_page": lines_per_page,
            "speakers": speakers,
        },
        "media": {
            "filename": media_filename,
            "content_type": media_content_type,
            "relative_path": media_filename,
        },
        "lines": lines,
        "pages": pages,
    }


def generate_viewer_html_from_artifacts(
    line_entries: List[dict],
    title_data: dict,
    audio_duration: float,
    lines_per_page: int,
    media_filename: str = "media.mp4",
    media_content_type: str = "video/mp4",
) -> str:
    """
    Generate standalone HTML viewer from session artifacts.

    Returns:
        HTML string for the standalone viewer

    Raises:
        RuntimeError: If viewer module is not available
    """
    if render_viewer_html is None:
        raise RuntimeError("Viewer module not available")

    payload = build_viewer_payload(
        line_entries,
        title_data,
        audio_duration,
        lines_per_page,
        media_filename,
        media_content_type,
    )
    return render_viewer_html(payload)


def resolve_media_filename(title_data: dict, media_blob_name: Optional[str] = None, fallback: str = "media.mp4") -> str:
    if isinstance(title_data, dict):
        name = title_data.get("FILE_NAME")
        if isinstance(name, str) and name.strip():
            return os.path.basename(name.strip())
    if isinstance(fallback, str) and fallback.strip():
        return os.path.basename(fallback.strip())
    if media_blob_name:
        return os.path.basename(str(media_blob_name).strip())
    return "media.mp4"


def build_variant_exports(
    line_entries: List[dict],
    title_data: dict,
    audio_duration: float,
    lines_per_page: int,
    media_filename: str,
    media_content_type: Optional[str],
    oncue_xml: Optional[str] = None,
) -> Dict[str, str]:
    """Build base64 XML + standalone viewer exports."""
    if oncue_xml is None:
        raise ValueError("oncue_xml is required")

    viewer_html = generate_viewer_html_from_artifacts(
        line_entries,
        title_data,
        audio_duration,
        lines_per_page,
        media_filename=media_filename,
        media_content_type=media_content_type or "video/mp4",
    )

    return {
        "oncue_xml_base64": base64.b64encode(oncue_xml.encode("utf-8")).decode("ascii"),
        "viewer_html_base64": base64.b64encode(viewer_html.encode("utf-8")).decode("ascii"),
    }


def normalize_line_payloads(
    lines_payload: List[dict],
    duration_seconds: float,
) -> Tuple[List[dict], float]:
    normalized_lines = []
    max_end = duration_seconds

    for idx, line in enumerate(lines_payload):
        try:
            start_val = float(line.get("start", 0.0))
            end_val = float(line.get("end", start_val))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"Invalid start/end for line index {idx}")

        if end_val < start_val:
            end_val = start_val

        if duration_seconds > 0:
            start_val = max(0.0, min(start_val, duration_seconds))
            end_val = max(0.0, min(end_val, duration_seconds))
        else:
            start_val = max(0.0, start_val)
            end_val = max(start_val, end_val)

        speaker_name = normalize_speaker_label(line.get("speaker", ""), fallback="SPEAKER")
        text_value = str(line.get("text", "")).strip()

        normalized_line = {
            "id": line.get("id") or f"{idx}",
            "speaker": speaker_name.upper(),
            "text": text_value,
            "start": start_val,
            "end": end_val,
            "is_continuation": bool(line.get("is_continuation", False)),
            "timestamp_error": bool(line.get("timestamp_error", False)),
        }

        # Pass through word-level timestamps if present
        if "words" in line and isinstance(line["words"], list):
            normalized_line["words"] = line["words"]

        normalized_lines.append(normalized_line)

        max_end = max(max_end, end_val)

    if duration_seconds == 0 and max_end > 0:
        duration_seconds = max_end
    elif max_end > duration_seconds:
        duration_seconds = max_end

    if any(line.get("timestamp_error") for line in normalized_lines):
        return normalized_lines, duration_seconds

    normalized_lines = sorted(
        enumerate(normalized_lines),
        key=lambda item: (item[1]["start"], item[0]),
    )

    return [item[1] for item in normalized_lines], duration_seconds


def construct_turns_from_lines(normalized_lines: List[dict]) -> List[TranscriptTurn]:
    turns: List[TranscriptTurn] = []
    current_speaker: Optional[str] = None
    current_text_parts: List[str] = []
    current_words: List[WordTimestamp] = []
    current_start: Optional[float] = None

    def flush_turn():
        nonlocal current_speaker, current_text_parts, current_words, current_start
        if current_speaker is None:
            return
        full_text = " ".join([part for part in current_text_parts if part]).strip()
        timestamp_str = seconds_to_timestamp(current_start) if current_start is not None else None
        turns.append(
            TranscriptTurn(
                speaker=current_speaker,
                text=full_text,
                timestamp=timestamp_str,
                words=current_words if current_words else None,
            )
        )
        current_speaker = None
        current_text_parts = []
        current_words = []
        current_start = None

    for line in normalized_lines:
        speaker = normalize_speaker_label(line.get("speaker", ""), fallback="SPEAKER")
        text_val = str(line.get("text", "")).strip()
        start_val = float(line.get("start", 0.0))
        end_val = float(line.get("end", start_val))

        should_start_new = current_speaker is None or speaker.upper() != current_speaker

        if should_start_new:
            flush_turn()
            current_speaker = speaker.upper()
            current_start = start_val

        current_text_parts.append(text_val)

        line_words = line.get("words")
        if isinstance(line_words, list) and len(line_words) > 0:
            for word_data in line_words:
                if not isinstance(word_data, dict):
                    continue
                word_text = str(word_data.get("text", "")).strip()
                if not word_text:
                    continue
                word_start = float(word_data.get("start", 0.0))
                word_end = float(word_data.get("end", word_start))
                current_words.append(
                    WordTimestamp(
                        text=word_text,
                        start=word_start * 1000.0,
                        end=max(word_end * 1000.0, word_start * 1000.0),
                        confidence=None,
                        speaker=current_speaker,
                    )
                )
        else:
            tokens = [tok for tok in text_val.split() if tok]
            if not tokens:
                continue
            line_duration = max(end_val - start_val, 0.01)
            word_count = len(tokens)
            for word_idx, token in enumerate(tokens):
                token_start = start_val + (line_duration * word_idx / word_count)
                if word_idx < word_count - 1:
                    token_end = start_val + (line_duration * (word_idx + 1) / word_count)
                else:
                    token_end = end_val
                current_words.append(
                    WordTimestamp(
                        text=token,
                        start=token_start * 1000.0,
                        end=token_end * 1000.0,
                        confidence=None,
                        speaker=current_speaker,
                    )
                )

    flush_turn()

    # Mark continuation turns (same speaker as previous)
    prev_speaker = None
    for turn in turns:
        if prev_speaker is not None and turn.speaker.strip().upper() == prev_speaker:
            turn.is_continuation = True
        else:
            turn.is_continuation = False
        prev_speaker = turn.speaker.strip().upper()

    return turns


def parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None

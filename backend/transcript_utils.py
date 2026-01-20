import base64
import json
import logging
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

try:
    from .config import DEFAULT_LINES_PER_PAGE
except ImportError:
    try:
        from config import DEFAULT_LINES_PER_PAGE
    except ImportError:
        import config as config_module
        DEFAULT_LINES_PER_PAGE = config_module.DEFAULT_LINES_PER_PAGE

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
        create_docx,
        generate_oncue_xml,
        compute_transcript_line_entries,
        seconds_to_timestamp,
    )
except ImportError:
    try:
        from transcript_formatting import (
            create_docx,
            generate_oncue_xml,
            compute_transcript_line_entries,
            seconds_to_timestamp,
        )
    except ImportError:
        import transcript_formatting as transcript_formatting_module
        create_docx = transcript_formatting_module.create_docx
        generate_oncue_xml = transcript_formatting_module.generate_oncue_xml
        compute_transcript_line_entries = transcript_formatting_module.compute_transcript_line_entries
        seconds_to_timestamp = transcript_formatting_module.seconds_to_timestamp

logger = logging.getLogger(__name__)


def _extract_media_key(data: dict) -> str:
    """Extract media key from session/payload data using priority chain.

    Priority: media_key field > title_data.MEDIA_ID > XML mediaId > filename > blob name > "unknown"
    """
    title_data = data.get("title_data") or {}

    # Direct media_key field
    if data.get("media_key"):
        return str(data["media_key"])

    # MEDIA_ID from title data
    if title_data.get("MEDIA_ID"):
        return str(title_data["MEDIA_ID"])

    # Try to extract from OnCue XML
    xml_filename = title_data.get("FILE_NAME") or title_data.get("CASE_NAME")
    media_id_from_xml = None
    xml_b64 = data.get("oncue_xml_base64")
    if xml_b64:
        try:
            xml_text = base64.b64decode(xml_b64).decode("utf-8", errors="replace")
            root = ET.fromstring(xml_text)
            deposition = root.find(".//deposition")
            if deposition is not None:
                media_id_from_xml = deposition.get("mediaId") or deposition.get("mediaID")
        except Exception:
            media_id_from_xml = None

    # Fallback chain
    key = media_id_from_xml or xml_filename or data.get("media_blob_name") or "unknown"
    return str(key)


def snapshot_media_key(session_data: dict) -> str:
    """Extract media key from session data. Wrapper for backwards compatibility."""
    return _extract_media_key(session_data)


def derive_media_key_from_payload(payload: dict) -> str:
    """Extract media key from payload data. Wrapper for backwards compatibility."""
    return _extract_media_key(payload)


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
    """Generate DOCX, OnCue XML, transcript text, and line entries for a session."""
    docx_bytes = create_docx(title_data, turns)
    oncue_xml = generate_oncue_xml(
        turns,
        title_data,
        audio_duration,
        lines_per_page,
        enforce_min_duration=enforce_min_line_duration,
    )
    transcript_text = format_transcript_text(turns)
    line_entries, _ = compute_transcript_line_entries(
        turns,
        audio_duration,
        lines_per_page,
        enforce_min_duration=enforce_min_line_duration,
    )
    serialized_entries = serialize_line_entries(line_entries)
    return docx_bytes, oncue_xml, transcript_text, serialized_entries


def ensure_session_clip_list(session_data: dict) -> List[dict]:
    clips_list = session_data.get("clips")
    if not isinstance(clips_list, list):
        clips_list = []
        session_data["clips"] = clips_list
    return clips_list


def parse_timecode_to_seconds(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)

    text = str(value).strip()
    if not text:
        return None

    if ":" not in text:
        try:
            return float(text)
        except ValueError:
            return None

    parts = text.split(":")
    if len(parts) > 3:
        return None

    try:
        parts = [float(part) for part in parts]
    except ValueError:
        return None

    if len(parts) == 3:
        hours, minutes, seconds = parts
    elif len(parts) == 2:
        hours = 0.0
        minutes, seconds = parts
    else:
        hours = 0.0
        minutes = 0.0
        seconds = parts[0]

    return hours * 3600 + minutes * 60 + seconds


def parse_pgln(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def find_line_index_by_id(lines: List[dict], line_id: Any) -> Optional[int]:
    if line_id is None:
        return None
    for idx, line in enumerate(lines):
        if line.get("id") == line_id:
            return idx
    return None


def find_line_index_by_pgln(lines: List[dict], pgln: Optional[int]) -> Optional[int]:
    if pgln is None:
        return None
    for idx, line in enumerate(lines):
        if parse_pgln(line.get("pgln")) == pgln:
            return idx
    return None


def find_line_index_by_time(
    lines: List[dict],
    time_seconds: Optional[float],
    prefer_start: bool,
) -> Optional[int]:
    if time_seconds is None:
        return None
    best_idx = None
    best_delta = None
    for idx, line in enumerate(lines):
        start_val = float(line.get("start", 0.0) or 0.0)
        end_val = float(line.get("end", start_val) or start_val)
        target = start_val if prefer_start else end_val
        delta = abs(target - time_seconds)
        if best_delta is None or delta < best_delta:
            best_delta = delta
            best_idx = idx
    return best_idx


def resolve_line_index(
    lines: List[dict],
    line_id: Any,
    pgln: Optional[int],
    time_seconds: Optional[float],
    prefer_start: bool,
) -> Optional[int]:
    candidate = find_line_index_by_id(lines, line_id)
    if candidate is not None:
        return candidate

    candidate = find_line_index_by_pgln(lines, parse_pgln(pgln))
    if candidate is not None:
        return candidate

    candidate = find_line_index_by_time(lines, time_seconds, prefer_start)
    if candidate is not None:
        return candidate

    return None


def sanitize_clip_label(label: Optional[str], default_name: str) -> str:
    if not label:
        return default_name
    cleaned = str(label).strip()
    if not cleaned:
        return default_name
    # Collapse whitespace and limit length for storage
    cleaned = re.sub(r"\s+", " ", cleaned)
    if len(cleaned) > 120:
        cleaned = cleaned[:120].rstrip()
    return cleaned


def slugify_filename(name: str, default: str = "clip") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", name.strip()) if name else ""
    cleaned = cleaned.strip("-._")
    return cleaned or default


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

        speaker_name = str(line.get("speaker", "")).strip() or "SPEAKER"
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
        speaker = str(line.get("speaker", "")).strip() or "SPEAKER"
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


def parse_oncue_xml(xml_text: str) -> Dict[str, Any]:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid OnCue XML: {exc}")

    deposition = root.find(".//deposition")
    depo_video = root.find(".//depoVideo")

    def first_attr(element: Optional[ET.Element], keys: List[str]) -> str:
        if element is None:
            return ""
        for key in keys:
            value = element.attrib.get(key)
            if value:
                return value.strip()
        return ""

    def first_text(keys: List[str]) -> str:
        for key in keys:
            node = root.find(f".//{key}")
            if node is not None and node.text:
                text_value = node.text.strip()
                if text_value:
                    return text_value
        return ""

    case_name = first_attr(deposition, ["caseName", "case", "case_name", "caption"]) or first_text(
        ["caseName", "case", "caption", "case_name"]
    )
    case_number = first_attr(deposition, ["caseNumber", "caseNo", "case_number"]) or first_text(
        ["caseNumber", "caseNo", "case_number"]
    )
    firm_name = first_attr(
        deposition,
        ["firm", "firmName", "organization", "organizationName", "firmOrOrganization"],
    ) or first_text(["firm", "firmName", "organization", "organizationName", "firmOrOrganization"])
    date_value = first_attr(deposition, ["date"]) or first_text(["date"])
    time_value = first_attr(deposition, ["time"]) or first_text(["time"])
    location_value = first_attr(deposition, ["location", "place"]) or first_text(["location", "place"])
    file_name = (
        first_attr(depo_video, ["filename"])
        or first_attr(deposition, ["filename", "fileName", "file_name"])
        or first_text(["FILE_NAME", "fileName", "file_name"])
    )

    title_data = {
        "CASE_NAME": case_name,
        "CASE_NUMBER": case_number,
        "FIRM_OR_ORGANIZATION_NAME": firm_name,
        "DATE": date_value,
        "TIME": time_value,
        "LOCATION": location_value,
        "FILE_NAME": file_name or "imported.xml",
        "FILE_DURATION": "",
    }

    lines: List[dict] = []
    current_speaker: Optional[str] = None
    max_end = 0.0

    for line_idx, line_elem in enumerate(root.findall(".//depoLine")):
        raw_text = line_elem.attrib.get("text", "")
        video_start = float(line_elem.attrib.get("videoStart", "0") or 0)
        video_stop = float(line_elem.attrib.get("videoStop", "0") or video_start)
        page = line_elem.attrib.get("page")
        line_number = line_elem.attrib.get("line")
        pgln = line_elem.attrib.get("pgLN")

        trimmed = raw_text.lstrip()
        speaker = current_speaker
        text_content = trimmed
        is_continuation = True

        if trimmed:
            if ":   " in trimmed:
                potential_speaker, remainder = trimmed.split(":   ", 1)
                if potential_speaker.strip():
                    speaker = potential_speaker.strip().upper()
                    text_content = remainder.strip()
                    is_continuation = False
            elif current_speaker is None:
                speaker = "SPEAKER"
                text_content = trimmed.strip()
                is_continuation = False
        else:
            text_content = ""

        if speaker is None:
            speaker = "SPEAKER"

        current_speaker = speaker
        max_end = max(max_end, video_stop)

        lines.append(
            {
                "id": line_elem.attrib.get("pgLN", f"{line_idx}"),
                "speaker": speaker,
                "text": text_content,
                "start": video_start,
                "end": video_stop,
                "page": int(page) if page and page.isdigit() else None,
                "line": int(line_number) if line_number and line_number.isdigit() else None,
                "pgln": int(pgln) if pgln and pgln.isdigit() else None,
                "is_continuation": is_continuation,
            }
        )

    duration_seconds = max_end
    hours, rem = divmod(duration_seconds, 3600)
    minutes, seconds = divmod(rem, 60)
    title_data["FILE_DURATION"] = "{:0>2}:{:0>2}:{:0>2}".format(int(hours), int(minutes), int(round(seconds)))

    return {
        "lines": lines,
        "title_data": title_data,
        "audio_duration": duration_seconds,
    }


def build_snapshot_payload(
    session_data: dict,
    lines_override: Optional[List[dict]] = None,
    title_override: Optional[dict] = None,
    is_manual_save: bool = False,
) -> dict:
    """Create a snapshot payload with XML + lines + media references."""
    xml_b64 = session_data.get("oncue_xml_base64")
    title_data = title_override or session_data.get("title_data") or {}
    lines_per_page = session_data.get("lines_per_page", DEFAULT_LINES_PER_PAGE)
    audio_duration = float(session_data.get("audio_duration") or 0.0)
    source_lines = lines_override if lines_override is not None else session_data.get("lines") or []

    # CRITICAL FIX: Always include media references for playback recovery
    media_blob_name = session_data.get("media_blob_name")
    media_content_type = session_data.get("media_content_type")

    if not xml_b64:
        # Rebuild XML from lines as a fallback
        normalized_lines, audio_duration = normalize_line_payloads(source_lines, audio_duration)
        turns = construct_turns_from_lines(normalized_lines)
        if not turns:
            raise HTTPException(status_code=400, detail="Unable to build snapshot XML from transcript lines")
        _, oncue_xml, _, updated_lines = build_session_artifacts(
            turns,
            title_data,
            audio_duration,
            lines_per_page,
            enforce_min_line_duration=False,
        )
        xml_b64 = base64.b64encode(oncue_xml.encode("utf-8")).decode()
        source_lines = updated_lines

    created_at = datetime.now(timezone.utc).isoformat()
    snapshot_payload = {
        "media_key": snapshot_media_key(session_data),
        "created_at": created_at,
        "title_data": title_data,
        "title_label": title_data.get("CASE_NAME") or title_data.get("FILE_NAME") or "",
        "audio_duration": audio_duration,
        "lines_per_page": lines_per_page,
        "lines": source_lines,
        "oncue_xml_base64": xml_b64,
        "line_count": len(source_lines),
        "is_manual_save": is_manual_save,
        "user_id": session_data.get("user_id"),
        # CRITICAL: Include media references for playback recovery
        "media_blob_name": media_blob_name,
        "media_content_type": media_content_type,
    }
    if session_data.get("source_turns"):
        snapshot_payload["source_turns"] = session_data["source_turns"]
    return snapshot_payload


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

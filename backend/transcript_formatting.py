import io
import logging
import os
import re
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

try:
    from .models import TranscriptTurn, WordTimestamp
except ImportError:
    try:
        from models import TranscriptTurn, WordTimestamp
    except ImportError:
        import models
        TranscriptTurn = models.TranscriptTurn
        WordTimestamp = models.WordTimestamp

logger = logging.getLogger(__name__)


# Shared layout constants used for XML generation and editor exports
SPEAKER_PREFIX_SPACES = 10  # Leading spaces before speaker name in XML (visual simulation)
CONTINUATION_SPACES = 0     # Leading spaces for continuation lines in XML (visual simulation)
SPEAKER_COLON = ":   "      # Colon and spaces after speaker name (total 4 chars)
MAX_TOTAL_LINE_WIDTH = 64   # Maximum total characters per XML line for speaker lines
MAX_CONTINUATION_WIDTH = 64 # Maximum total characters per XML line for continuation lines
MIN_LINE_DURATION_SECONDS = 1.25

# OnCue XML constants
ONCUE_FIRST_PGLN = 101      # First page-line number (page 1, line 1 = 101)
DEFAULT_VIDEO_ID = "1"      # Default video ID for single-video transcripts

# PDF layout constants (mirrors transcript_template.docx transcript section)
PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT = letter
PDF_MARGIN_LEFT = 1.0 * inch
PDF_MARGIN_RIGHT = 1.0 * inch
PDF_MARGIN_TOP = 0.75 * inch
PDF_MARGIN_BOTTOM = 0.75 * inch
PDF_LINE_NUMBER_GUTTER = 0.7 * inch
PDF_LINE_HEIGHT = 24.0  # 12pt Courier at double spacing
PDF_TEXT_FONT = "Courier"
PDF_TEXT_FONT_BOLD = "Courier-Bold"
PDF_TEXT_SIZE = 12
PDF_LINE_NUMBER_SIZE = 10
PDF_BORDER_INSET = 0.33 * inch
PDF_BORDER_GAP = 4.0


def timestamp_to_seconds(timestamp: Optional[str]) -> float:
    """Convert timestamp like '[MM:SS]' or 'MM:SS' to seconds."""
    if not timestamp:
        return 0.0
    ts = timestamp.strip('[]').strip()
    parts = ts.split(':')
    try:
        if len(parts) == 3:
            h, m, s = map(float, parts)
            return h * 3600 + m * 60 + s
        if len(parts) == 2:
            m, s = map(float, parts)
            return m * 60 + s
        return float(ts)
    except ValueError:
        return 0.0


def seconds_to_timestamp(seconds: float) -> str:
    """Convert seconds float to OnCue-style [MM:SS] or [HH:MM:SS] timestamp."""
    if seconds < 0:
        seconds = 0.0
    total_seconds = int(round(seconds))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours > 0:
        return f"[{hours:02d}:{minutes:02d}:{secs:02d}]"
    return f"[{minutes:02d}:{secs:02d}]"


def wrap_text_for_transcript(text: str, max_width: int) -> List[str]:
    """
    Wrap text to fit within max_width characters, preserving word boundaries.

    Args:
        text: The text to wrap
        max_width: Maximum characters per line of text content

    Returns:
        List of wrapped lines
    """
    if not text:
        return [""]

    if max_width <= 0:
        return [text]

    words = text.split()
    lines = []
    current_line = []
    current_length = 0

    for word in words:
        word_length = len(word)
        # +1 for space before word (except first word)
        space_needed = word_length + (1 if current_line else 0)

        if current_length + space_needed <= max_width:
            current_line.append(word)
            current_length += space_needed
        else:
            if current_line:
                lines.append(" ".join(current_line))
            current_line = [word]
            current_length = word_length

    if current_line:
        lines.append(" ".join(current_line))

    return lines if lines else [""]


def _safe_text(value: Optional[str]) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _draw_double_page_border(pdf_canvas: canvas.Canvas) -> None:
    outer_x = PDF_BORDER_INSET
    outer_y = PDF_BORDER_INSET
    outer_w = PDF_PAGE_WIDTH - (2 * PDF_BORDER_INSET)
    outer_h = PDF_PAGE_HEIGHT - (2 * PDF_BORDER_INSET)

    inner_x = outer_x + (PDF_BORDER_GAP / 2.0)
    inner_y = outer_y + (PDF_BORDER_GAP / 2.0)
    inner_w = outer_w - PDF_BORDER_GAP
    inner_h = outer_h - PDF_BORDER_GAP

    pdf_canvas.setStrokeColor(colors.black)
    pdf_canvas.setLineWidth(0.8)
    pdf_canvas.rect(outer_x, outer_y, outer_w, outer_h, stroke=1, fill=0)
    pdf_canvas.rect(inner_x, inner_y, inner_w, inner_h, stroke=1, fill=0)


def _draw_title_page(pdf_canvas: canvas.Canvas, title_data: dict) -> None:
    center_x = PDF_PAGE_WIDTH / 2.0
    y = PDF_PAGE_HEIGHT - (1.7 * inch)

    firm_name = _safe_text(title_data.get("FIRM_OR_ORGANIZATION_NAME"))
    if firm_name:
        pdf_canvas.setFont(PDF_TEXT_FONT_BOLD, 14)
        pdf_canvas.drawCentredString(center_x, y, firm_name)
        y -= 0.6 * inch

    pdf_canvas.setFont(PDF_TEXT_FONT_BOLD, 18)
    pdf_canvas.drawCentredString(center_x, y, "Generated Transcript")
    y -= 0.6 * inch

    metadata_lines = [
        f"Case Name: {_safe_text(title_data.get('CASE_NAME'))}",
        f"Case Number: {_safe_text(title_data.get('CASE_NUMBER'))}",
        "",
        f"Date: {_safe_text(title_data.get('DATE'))}",
        f"Time: {_safe_text(title_data.get('TIME'))}",
        f"Location: {_safe_text(title_data.get('LOCATION'))}",
        "",
        f"Original File: {_safe_text(title_data.get('FILE_NAME'))}",
        f"Duration: {_safe_text(title_data.get('FILE_DURATION'))}",
    ]

    pdf_canvas.setFont(PDF_TEXT_FONT, PDF_TEXT_SIZE)
    for line in metadata_lines:
        if line:
            pdf_canvas.drawCentredString(center_x, y, line)
        y -= 0.35 * inch


def _draw_transcript_page(
    pdf_canvas: canvas.Canvas,
    page_entries: List[dict],
    lines_per_page: int,
) -> None:
    _draw_double_page_border(pdf_canvas)

    if not page_entries:
        return

    top_baseline = PDF_PAGE_HEIGHT - PDF_MARGIN_TOP - PDF_TEXT_SIZE
    number_right_x = PDF_MARGIN_LEFT - 6.0
    text_x = PDF_MARGIN_LEFT

    sorted_entries = sorted(page_entries, key=lambda entry: (int(entry.get("line", 0) or 0), entry.get("id", "")))
    for entry in sorted_entries:
        try:
            line_number = int(entry.get("line", 0) or 0)
        except (TypeError, ValueError):
            line_number = 0
        if line_number <= 0 or line_number > lines_per_page:
            continue

        y = top_baseline - ((line_number - 1) * PDF_LINE_HEIGHT)
        if y < PDF_MARGIN_BOTTOM:
            continue

        pdf_canvas.setFillColor(colors.Color(0.45, 0.45, 0.45))
        pdf_canvas.setFont(PDF_TEXT_FONT, PDF_LINE_NUMBER_SIZE)
        pdf_canvas.drawRightString(number_right_x, y, str(line_number))

        line_text = str(entry.get("rendered_text", ""))
        pdf_canvas.setFillColor(colors.black)
        pdf_canvas.setFont(PDF_TEXT_FONT, PDF_TEXT_SIZE)
        pdf_canvas.drawString(text_x, y, line_text)


def create_pdf(title_data: dict, line_entries: List[dict], lines_per_page: int = 25) -> bytes:
    """
    Create a deterministic PDF transcript from precomputed line entries.

    The PDF uses the same wrapped line/page assignments as XML and HTML outputs.
    """
    output = io.BytesIO()
    pdf_canvas = canvas.Canvas(output, pagesize=letter, pageCompression=1)

    _draw_title_page(pdf_canvas, title_data)
    pdf_canvas.showPage()

    pages: Dict[int, List[dict]] = defaultdict(list)
    for entry in line_entries:
        try:
            page_number = int(entry.get("page", 1) or 1)
        except (TypeError, ValueError):
            page_number = 1
        pages[page_number].append(entry)

    if not pages:
        pages[1] = []

    for page_number in sorted(pages):
        _draw_transcript_page(pdf_canvas, pages[page_number], lines_per_page)
        pdf_canvas.showPage()

    pdf_canvas.save()
    output.seek(0)
    return output.read()


def calculate_line_timestamps_from_words(
    text_line: str,
    all_words: List[WordTimestamp],
    start_offset: int = 0,
) -> Tuple[float, float, int, bool]:
    """
    Calculate accurate start/stop timestamps for a wrapped line using word-level data.

    This function matches words in the text line to their precise timestamps from
    word-level data, eliminating the need for linear interpolation.

    Args:
        text_line: The text content of the line (without speaker prefix)
        all_words: List of WordTimestamp objects for the entire speaker turn
        start_offset: Index in all_words to start searching from (for continuation lines)

    Returns:
        Tuple of (start_seconds, stop_seconds, words_consumed, boundary_missing)
        - start_seconds: Start time of first word in line (seconds, float)
        - stop_seconds: End time of last word in line (seconds, float)
        - words_consumed: Number of words from all_words that were used
        - boundary_missing: True if the first or last word in the line lacks a valid timestamp
    """
    if not all_words or not text_line.strip():
        logger.debug("calculate_line_timestamps: empty words or text_line")
        return (0.0, 0.0, 0, True)

    line_text_clean = text_line.strip().lower()
    if not line_text_clean:
        return (0.0, 0.0, 0, True)

    raw_line_words = line_text_clean.split()

    def normalize_word_for_match(word: str) -> str:
        normalized = word.lower()
        normalized = normalized.replace("’", "'").replace("‘", "'")
        normalized = re.sub(r"[^\w]+", "", normalized)
        return normalized.strip("_")

    line_words = [word for word in raw_line_words if normalize_word_for_match(word)]
    if not line_words:
        return (0.0, 0.0, 0, True)

    # Matching words in order with flexible punctuation handling
    matched_words: List[WordTimestamp] = []
    word_idx = start_offset
    line_idx = 0

    while word_idx < len(all_words) and line_idx < len(line_words):
        line_word = normalize_word_for_match(line_words[line_idx])
        if not line_word:
            line_idx += 1
            continue

        current_word = all_words[word_idx]
        current_word_clean = normalize_word_for_match(current_word.text)

        if current_word_clean == line_word:
            matched_words.append(current_word)
            line_idx += 1
        else:
            if line_word in current_word_clean or current_word_clean in line_word:
                matched_words.append(current_word)
                line_idx += 1

        word_idx += 1

    if not matched_words:
        logger.debug("No words matched for line: %s", text_line)
        return (0.0, 0.0, 0, True)

    first_word = matched_words[0]
    last_word = matched_words[-1]

    start_seconds = (first_word.start or 0.0) / 1000.0
    stop_seconds = (last_word.end or 0.0) / 1000.0
    words_consumed = len(matched_words)

    boundary_missing = False
    if first_word.start is None or last_word.end is None:
        boundary_missing = True

    return (start_seconds, stop_seconds, words_consumed, boundary_missing)


def enforce_min_line_durations(
    line_entries: List[dict],
    audio_duration: float,
    min_duration: float = MIN_LINE_DURATION_SECONDS,
) -> List[dict]:
    if not line_entries or min_duration <= 0:
        return line_entries

    starts: List[float] = []
    ends: List[float] = []
    for entry in line_entries:
        try:
            start_val = float(entry.get("start", 0.0))
        except (TypeError, ValueError):
            start_val = 0.0
        try:
            end_val = float(entry.get("end", start_val))
        except (TypeError, ValueError):
            end_val = start_val
        if end_val < start_val:
            end_val = start_val
        starts.append(start_val)
        ends.append(end_val)

    count = len(line_entries)
    gaps: List[float] = []
    for idx in range(count - 1):
        gap = starts[idx + 1] - ends[idx]
        gaps.append(gap if gap > 0 else 0.0)

    left_gap = [0.0] * count
    right_gap = [0.0] * count

    left_gap[0] = starts[0] if starts[0] > 0 else 0.0
    for idx in range(1, count):
        left_gap[idx] = gaps[idx - 1]
    for idx in range(count - 1):
        right_gap[idx] = gaps[idx]
    if audio_duration and audio_duration > 0:
        right_gap[count - 1] = max(audio_duration - ends[count - 1], 0.0)
    else:
        right_gap[count - 1] = 0.0

    desired_left = [0.0] * count
    desired_right = [0.0] * count

    for idx in range(count):
        duration = ends[idx] - starts[idx]
        if duration >= min_duration:
            continue
        need = min_duration - duration
        half = need / 2.0
        left_take = min(half, left_gap[idx])
        right_take = min(half, right_gap[idx])
        remaining = need - (left_take + right_take)
        if remaining > 0:
            left_cap = max(left_gap[idx] - left_take, 0.0)
            right_cap = max(right_gap[idx] - right_take, 0.0)
            if right_cap > left_cap:
                extra_right = min(remaining, right_cap)
                right_take += extra_right
                remaining -= extra_right
            extra_left = min(remaining, left_cap)
            left_take += extra_left
        desired_left[idx] = left_take
        desired_right[idx] = right_take

    left_alloc = [0.0] * count
    right_alloc = [0.0] * count
    left_alloc[0] = min(desired_left[0], left_gap[0])
    right_alloc[count - 1] = min(desired_right[count - 1], right_gap[count - 1])

    for idx in range(count - 1):
        gap = gaps[idx]
        total = desired_right[idx] + desired_left[idx + 1]
        if total <= 0:
            right_alloc[idx] = 0.0
            left_alloc[idx + 1] = 0.0
        elif total <= gap:
            right_alloc[idx] = desired_right[idx]
            left_alloc[idx + 1] = desired_left[idx + 1]
        else:
            scale = gap / total if total > 0 else 0.0
            right_alloc[idx] = desired_right[idx] * scale
            left_alloc[idx + 1] = desired_left[idx + 1] * scale

    for idx, entry in enumerate(line_entries):
        new_start = starts[idx] - left_alloc[idx]
        new_end = ends[idx] + right_alloc[idx]
        if new_start < 0:
            new_start = 0.0
        if audio_duration and audio_duration > 0 and new_end > audio_duration:
            new_end = audio_duration
        if new_end < new_start:
            new_end = new_start
        entry["start"] = new_start
        entry["end"] = new_end

    return line_entries


def compute_transcript_line_entries(
    transcript_turns: List[TranscriptTurn],
    audio_duration: float,
    lines_per_page: int = 25,
    enforce_min_duration: bool = True,
) -> Tuple[List[dict], int]:
    """
    Build per-line timing/layout data from transcript turns for re-use in XML and editor exports.
    """
    line_entries: List[dict] = []
    page = 1
    line_in_page = 1
    last_pgln = ONCUE_FIRST_PGLN

    for turn_idx, turn in enumerate(transcript_turns):
        start_sec = timestamp_to_seconds(turn.timestamp)
        stop_sec: Optional[float] = None

        if turn.words:
            word_starts = [word.start for word in turn.words if word.start is not None and word.start >= 0]
            word_ends = [word.end for word in turn.words if word.end is not None and word.end >= 0]
            if word_starts and word_ends:
                start_sec = min(word_starts) / 1000.0
                stop_sec = max(word_ends) / 1000.0

        if stop_sec is None:
            if turn_idx < len(transcript_turns) - 1:
                stop_sec = timestamp_to_seconds(transcript_turns[turn_idx + 1].timestamp)
            else:
                stop_sec = audio_duration

        if stop_sec < start_sec:
            stop_sec = start_sec

        speaker_name = turn.speaker.upper()
        text = turn.text.strip()

        # Check if this turn is a continuation of the same speaker
        is_turn_continuation = getattr(turn, 'is_continuation', False)

        if is_turn_continuation:
            # Continuation turn: no speaker prefix, use continuation formatting
            speaker_prefix = ""
            max_first_line_text = MAX_CONTINUATION_WIDTH - CONTINUATION_SPACES
        else:
            # New speaker: include speaker prefix
            speaker_prefix = " " * SPEAKER_PREFIX_SPACES + speaker_name + SPEAKER_COLON
            max_first_line_text = MAX_TOTAL_LINE_WIDTH - len(speaker_prefix)

        wrapped_lines = wrap_text_for_transcript(text, max_first_line_text)
        if not wrapped_lines:
            wrapped_lines = [""]

        max_continuation_text = MAX_CONTINUATION_WIDTH - CONTINUATION_SPACES
        remaining_text = " ".join(wrapped_lines[1:])
        continuation_wrapped = []
        if remaining_text:
            continuation_wrapped = wrap_text_for_transcript(remaining_text, max_continuation_text)

        all_lines = [wrapped_lines[0]] + continuation_wrapped
        total_lines = len(all_lines)

        def interpolate_line_block(block_start: float, block_end: float, count: int) -> List[Tuple[float, float]]:
            if count <= 0:
                return []
            if block_end < block_start:
                block_end = block_start
            duration = block_end - block_start
            step = duration / count if count > 0 else duration
            return [(block_start + step * idx, block_start + step * (idx + 1)) for idx in range(count)]

        line_timings: List[Optional[Tuple[float, float]]] = []
        line_errors: List[bool] = []

        if turn.words:
            word_offset = 0

            for line_text in all_lines:
                line_start, line_stop, words_used, boundary_missing = calculate_line_timestamps_from_words(
                    line_text,
                    turn.words,
                    word_offset,
                )
                if words_used == 0:
                    line_timings.append(None)
                    line_errors.append(True)
                else:
                    line_timings.append((line_start, line_stop))
                    line_errors.append(boundary_missing)
                    word_offset += words_used
        else:
            logger.warning("Turn %d has NO word data, using interpolation", turn_idx)
            line_timings = [None for _ in range(total_lines)]
            line_errors = [True for _ in range(total_lines)]

        if any(timing is None for timing in line_timings):
            filled_timings: List[Tuple[float, float]] = []
            idx = 0
            prev_end = start_sec
            while idx < total_lines:
                timing = line_timings[idx]
                if timing is not None:
                    filled_timings.append(timing)
                    prev_end = timing[1]
                    idx += 1
                    continue

                next_idx = idx
                while next_idx < total_lines and line_timings[next_idx] is None:
                    next_idx += 1
                next_start = line_timings[next_idx][0] if next_idx < total_lines else stop_sec
                block = interpolate_line_block(prev_end, next_start, next_idx - idx)
                filled_timings.extend(block)
                if block:
                    prev_end = block[-1][1]
                idx = next_idx

            line_timings = [timing for timing in filled_timings]

        first_line_start, first_line_stop = line_timings[0] if line_timings else (start_sec, start_sec)
        continuation_timings: List[Tuple[float, float]] = []
        for cont_idx in range(1, total_lines):
            continuation_timings.append(line_timings[cont_idx])

        # First line of turn (with or without speaker prefix depending on continuation status)
        pgln = page * 100 + line_in_page
        last_pgln = pgln

        if is_turn_continuation:
            # Continuation turn: format like a continuation line (no speaker)
            rendered_first_line = " " * CONTINUATION_SPACES + wrapped_lines[0]
        else:
            # New speaker: include speaker prefix
            rendered_first_line = speaker_prefix + wrapped_lines[0]

        line_entries.append(
            {
                "id": f"{turn_idx}-0",
                "turn_index": turn_idx,
                "line_index": 0,
                "speaker": speaker_name,
                "text": wrapped_lines[0],
                "rendered_text": rendered_first_line,
                "start": first_line_start,
                "end": first_line_stop,
                "page": page,
                "line": line_in_page,
                "pgln": pgln,
                "is_continuation": is_turn_continuation,
                "total_lines_in_turn": total_lines,
                "timestamp_error": line_errors[0] if line_errors else False,
            }
        )

        line_in_page += 1
        if line_in_page > lines_per_page:
            page += 1
            line_in_page = 1

        # Continuation lines
        for cont_idx, continuation_text in enumerate(continuation_wrapped):
            line_start, line_stop = continuation_timings[cont_idx]

            pgln = page * 100 + line_in_page
            last_pgln = pgln
            line_entries.append(
                {
                    "id": f"{turn_idx}-{cont_idx + 1}",
                    "turn_index": turn_idx,
                    "line_index": cont_idx + 1,
                    "speaker": speaker_name,
                    "text": continuation_text,
                    "rendered_text": " " * CONTINUATION_SPACES + continuation_text,
                    "start": line_start,
                    "end": line_stop,
                    "page": page,
                    "line": line_in_page,
                    "pgln": pgln,
                    "is_continuation": True,
                    "total_lines_in_turn": total_lines,
                    "timestamp_error": line_errors[cont_idx + 1] if line_errors else False,
                }
            )

            line_in_page += 1
            if line_in_page > lines_per_page:
                page += 1
                line_in_page = 1

    if enforce_min_duration:
        enforce_min_line_durations(line_entries, audio_duration, MIN_LINE_DURATION_SECONDS)

    return line_entries, last_pgln


def generate_oncue_xml(
    transcript_turns: List[TranscriptTurn],
    metadata: dict,
    audio_duration: float,
    lines_per_page: int = 25,
    enforce_min_duration: bool = True,
    precomputed_line_entries: Optional[List[dict]] = None,
) -> str:
    """Generate OnCue-compatible XML from transcript turns or precomputed line entries."""
    if precomputed_line_entries is None:
        line_entries, _ = compute_transcript_line_entries(
            transcript_turns,
            audio_duration,
            lines_per_page,
            enforce_min_duration=enforce_min_duration,
        )
    else:
        line_entries = precomputed_line_entries

    return generate_oncue_xml_from_line_entries(
        line_entries,
        metadata,
        audio_duration,
        lines_per_page,
    )


def generate_oncue_xml_from_line_entries(
    line_entries: List[dict],
    metadata: dict,
    audio_duration: float,
    lines_per_page: int = 25,
) -> str:
    """Generate OnCue-compatible XML from already-computed line entries."""
    from xml.etree.ElementTree import Element, SubElement, tostring

    root = Element(
        "onCue",
        {
            "xmlns:xsd": "http://www.w3.org/2001/XMLSchema",
            "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
        },
    )

    media_id = metadata.get("MEDIA_ID") or os.path.splitext(metadata.get("FILE_NAME", "deposition"))[0]
    depo_attrs = {
        "mediaId": str(media_id),
        "linesPerPage": str(lines_per_page),
    }
    if metadata.get("DATE"):
        depo_attrs["date"] = metadata["DATE"]

    deposition = SubElement(root, "deposition", depo_attrs)

    video_attrs = {
        "ID": DEFAULT_VIDEO_ID,
        "filename": metadata.get("FILE_NAME", "audio.mp3"),
        "startTime": "0",
        "stopTime": str(int(round(audio_duration))),
        "firstPGLN": str(ONCUE_FIRST_PGLN),
        "lastPGLN": "0",  # placeholder
        "startTuned": "no",
        "stopTuned": "no",
    }
    depo_video = SubElement(deposition, "depoVideo", video_attrs)

    for entry in line_entries:
        page_value = int(entry.get("page", 1) or 1)
        line_value = int(entry.get("line", 1) or 1)
        pgln_value = int(entry.get("pgln", (page_value * 100) + line_value) or ((page_value * 100) + line_value))
        start_value = float(entry.get("start", 0.0) or 0.0)
        stop_value = float(entry.get("end", start_value) or start_value)
        SubElement(
            depo_video,
            "depoLine",
            {
                "prefix": "",
                "text": str(entry.get("rendered_text", "")),
                "page": str(page_value),
                "line": str(line_value),
                "pgLN": str(pgln_value),
                "videoID": DEFAULT_VIDEO_ID,
                "videoStart": f"{start_value:.2f}",
                "videoStop": f"{stop_value:.2f}",
                "isEdited": "no",
                "isSynched": "yes",
                "isRedacted": "no",
            },
        )

    last_pgln = ONCUE_FIRST_PGLN
    if line_entries:
        try:
            last_pgln = int(line_entries[-1].get("pgln", ONCUE_FIRST_PGLN) or ONCUE_FIRST_PGLN)
        except (TypeError, ValueError):
            last_pgln = ONCUE_FIRST_PGLN

    depo_video.set("lastPGLN", str(last_pgln))

    xml_bytes = tostring(root, encoding="utf-8", method="xml")
    xml_str = xml_bytes.decode("utf-8")
    xml_str = "".join(xml_str.splitlines())  # single line like sample
    return xml_str

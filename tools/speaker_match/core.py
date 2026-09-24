"""Read TranscribeAlpha desktop storage and apply speaker renames the way the app does.

Records live at ~/Library/Application Support/com.transcribealpha.app/
  cases/<case_id>/meta.json
  cases/<case_id>/transcripts/<media_key>.json
  uncategorized/<media_key>.json

A rename updates every place the label appears (lines, turns, words, transcript text)
and regenerates the PDF, OnCue XML and standalone viewer with the backend's own
builders, so the app sees the same result as if it had been edited and saved there.
"""
from __future__ import annotations

import base64
import bisect
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))

from transcript_formatting import create_pdf, generate_oncue_xml_from_line_entries  # noqa: E402
from transcript_utils import generate_viewer_html_from_artifacts  # noqa: E402

# TA_DATA_ROOT lets you point the tool at a copy of the data for testing.
DATA_ROOT = Path(os.environ.get("TA_DATA_ROOT") or os.path.expanduser("~/Library/Application Support/com.transcribealpha.app"))
TOOL_ROOT = Path(__file__).resolve().parent
BACKUP_ROOT = TOOL_ROOT / "backups"

UNCATEGORIZED = "uncategorized"
_GENERIC_LABEL_RE = re.compile(r"^SPEAKER [A-Z0-9]+$")
_CAMERA_RE = re.compile(r"_(D[0-9A-Z]{6,})\.[A-Za-z0-9]+$")


def is_generic_label(label: str) -> bool:
    return bool(_GENERIC_LABEL_RE.match((label or "").strip().upper()))


def camera_serial(filename: str) -> Optional[str]:
    match = _CAMERA_RE.search(filename or "")
    return match.group(1) if match else None


# ── Storage ──────────────────────────────────────────────────────────────


def list_cases() -> List[dict]:
    cases = []
    for meta_path in sorted((DATA_ROOT / "cases").glob("*/meta.json")):
        meta = json.loads(meta_path.read_text())
        count = len(list((meta_path.parent / "transcripts").glob("*.json")))
        cases.append({"case_id": meta.get("case_id") or meta_path.parent.name, "name": meta.get("name") or "(unnamed)", "count": count})
    uncategorized = list((DATA_ROOT / UNCATEGORIZED).glob("*.json"))
    if uncategorized:
        cases.append({"case_id": UNCATEGORIZED, "name": "Uncategorized", "count": len(uncategorized)})
    return cases


def transcript_paths(case_id: str) -> List[Path]:
    folder = DATA_ROOT / UNCATEGORIZED if case_id == UNCATEGORIZED else DATA_ROOT / "cases" / case_id / "transcripts"
    return sorted(folder.glob("*.json"))


def load_record(path: Path) -> dict:
    return json.loads(path.read_text())


def record_path(case_id: str, media_key: str) -> Path:
    if case_id == UNCATEGORIZED:
        return DATA_ROOT / UNCATEGORIZED / f"{media_key}.json"
    return DATA_ROOT / "cases" / case_id / "transcripts" / f"{media_key}.json"


def media_path_for(record: dict) -> Optional[str]:
    path = record.get("media_absolute_path")
    return path if path and os.path.isfile(path) else None


# ── Clean speech runs ────────────────────────────────────────────────────
#
# Line and turn spans can't be trusted for audio: ASR occasionally stretches one word
# across many seconds of speech it didn't transcribe (e.g. "what" timed at 19.6 s), and
# span edges run into other speakers. So runs are built from word timings instead, and
# only kept when every word has a plausible duration and no other speaker is talking
# nearby. The current label for each word comes from the editor's lines (the app's
# source of truth, since renames there don't touch word-level labels).

MAX_WORD_S = 1.5
MIN_WORD_S = 0.02
MAX_WORD_GAP_S = 0.35
CLEARANCE_S = 0.3
STRETCH_LOOKBACK_S = 60.0


def _line_label_lookup(record: dict):
    spans = []
    for line in record.get("lines") or []:
        try:
            spans.append((float(line["start"]), float(line["end"]), (line.get("speaker") or "").strip()))
        except (KeyError, TypeError, ValueError):
            continue
    spans.sort()
    starts = [s[0] for s in spans]

    def label_at(t: float) -> Optional[str]:
        i = bisect.bisect_right(starts, t) - 1
        if i >= 0 and spans[i][0] <= t <= spans[i][1] + 0.05:
            return spans[i][2]
        return None

    return label_at


def speech_runs(record: dict) -> List[dict]:
    """Isolated single-speaker runs with trustworthy word timing.

    Each run: {speaker, start, end, text, words:[{text,start,end}], confidence}.
    """
    label_at = _line_label_lookup(record)
    words = []
    for turn in record.get("turns") or []:
        for w in turn.get("words") or []:
            try:
                start, end = w["start"] / 1000.0, w["end"] / 1000.0
            except (KeyError, TypeError):
                continue
            label = label_at((start + end) / 2) or label_at(start) or (turn.get("speaker") or "").strip()
            words.append({
                "text": w.get("text") or "",
                "start": start,
                "end": end,
                "conf": float(w.get("confidence") or 0.0),
                "speaker": label,
                "valid": MIN_WORD_S <= end - start <= MAX_WORD_S,
            })
    if not words:
        return _runs_from_lines(record)
    words.sort(key=lambda w: w["start"])

    runs, current = [], None
    for w in words:
        if not w["valid"] or not w["speaker"]:
            current = None
            continue
        if current and current["speaker"] == w["speaker"] and w["start"] - current["end"] <= MAX_WORD_GAP_S:
            current["words"].append(w)
            current["end"] = max(current["end"], w["end"])
        else:
            current = {"speaker": w["speaker"], "start": w["start"], "end": w["end"], "words": [w]}
            runs.append(current)

    # Drop runs with another speaker (or an untrustworthy stretched word) nearby.
    starts = [w["start"] for w in words]
    clean = []
    for run in runs:
        lo, hi = run["start"] - CLEARANCE_S, run["end"] + CLEARANCE_S
        # look back far enough to catch a stretched word that began earlier but runs into this window
        i = bisect.bisect_left(starts, lo - STRETCH_LOOKBACK_S)
        contaminated = False
        while i < len(words) and words[i]["start"] <= hi:
            w = words[i]
            if w["end"] >= lo and (w["speaker"] != run["speaker"] or not w["valid"]):
                contaminated = True
                break
            i += 1
        if contaminated:
            continue
        run["text"] = " ".join(w["text"] for w in run["words"])
        run["confidence"] = sum(w["conf"] for w in run["words"]) / len(run["words"])
        run["words"] = [{"text": w["text"], "start": w["start"], "end": w["end"]} for w in run["words"]]
        clean.append(run)
    return clean


def _runs_from_lines(record: dict) -> List[dict]:
    """Fallback for transcripts without word timings: single lines with a plausible speech rate."""
    runs = []
    for line in record.get("lines") or []:
        try:
            start, end = float(line["start"]), float(line["end"])
        except (KeyError, TypeError, ValueError):
            continue
        text = line.get("text") or ""
        n = len(text.split())
        if end > start and n and 1.2 <= n / (end - start) <= 6:
            runs.append({"speaker": (line.get("speaker") or "").strip(), "start": start, "end": end,
                         "text": text, "words": [], "confidence": 0.5})
    return runs


# ── Rename + export regeneration ─────────────────────────────────────────


def _rendered_text(speaker: str, text: str, is_continuation: bool) -> str:
    # Mirrors buildRenderedText() in frontend-next/src/components/TranscriptEditor/editorUtils.ts
    speaker = speaker.strip().rstrip(":")
    if is_continuation or not speaker:
        return text
    if text.lstrip().upper().startswith(f"{speaker.upper()}:"):
        return text
    return f"          {speaker}:   {text}"


def rename_speakers_in_record(record: dict, mapping: Dict[str, str]) -> int:
    """Rename speaker labels in place. mapping: {old_label: new_name}. Returns lines changed."""
    norm = {old.strip().upper(): new.strip().upper() for old, new in mapping.items() if old.strip() and new.strip()}
    norm = {old: new for old, new in norm.items() if old != new}
    if not norm:
        return 0

    changed = 0
    for line in record.get("lines") or []:
        old = (line.get("speaker") or "").strip().upper()
        if old in norm:
            line["speaker"] = norm[old]
            changed += 1
        line["rendered_text"] = _rendered_text(line.get("speaker") or "", line.get("text") or "", bool(line.get("is_continuation")))

    for key in ("turns", "source_turns"):
        for turn in record.get(key) or []:
            old = (turn.get("speaker") or "").strip().upper()
            if old in norm:
                turn["speaker"] = norm[old]
            for word in turn.get("words") or []:
                w_old = (word.get("speaker") or "").strip().upper()
                if w_old in norm:
                    word["speaker"] = norm[w_old]

    def _swap_text(text: str) -> str:
        def repl(m: re.Match) -> str:
            label = m.group(2).strip().upper()
            return f"{m.group(1)}{norm.get(label, m.group(2))}:"
        return re.sub(r"^(\[[\d:]+\] )([^:\n]+):", repl, text, flags=re.MULTILINE)

    for key in ("transcript_text", "transcript"):
        if isinstance(record.get(key), str):
            record[key] = _swap_text(record[key])

    return changed


def regenerate_exports(record: dict) -> None:
    lines = record.get("lines") or []
    title_data = record.get("title_data") or {}
    lpp = int(record.get("lines_per_page") or 25)
    duration = float(record.get("audio_duration") or 0)
    media_filename = record.get("media_filename") or title_data.get("FILE_NAME") or "media.mp4"
    media_type = record.get("media_content_type") or "video/mp4"

    record["pdf_base64"] = base64.b64encode(create_pdf(title_data, lines, lines_per_page=lpp)).decode("ascii")
    oncue = generate_oncue_xml_from_line_entries(lines, title_data, duration, lpp)
    record["oncue_xml_base64"] = base64.b64encode(oncue.encode("utf-8")).decode("ascii")
    viewer = generate_viewer_html_from_artifacts(lines, title_data, duration, lpp, media_filename, media_type)
    record["viewer_html_base64"] = base64.b64encode(viewer.encode("utf-8")).decode("ascii")


def _write_atomic(path: Path, record: dict) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record, indent=2, ensure_ascii=False))
    os.replace(tmp, path)


def apply_renames(case_id: str, renames: Iterable[dict]) -> dict:
    """renames: [{media_key, from, to}]. Backs up each file before writing."""
    by_key: Dict[str, Dict[str, str]] = {}
    for item in renames:
        if item.get("to", "").strip():
            by_key.setdefault(item["media_key"], {})[item["from"]] = item["to"]

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = BACKUP_ROOT / stamp
    results = []
    for media_key, mapping in by_key.items():
        path = record_path(case_id, media_key)
        try:
            record = load_record(path)
            backup_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, backup_dir / path.name)
            changed = rename_speakers_in_record(record, mapping)
            if changed:
                regenerate_exports(record)
                record["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                _write_atomic(path, record)
            results.append({"media_key": media_key, "file": record.get("media_filename"), "lines_changed": changed, "ok": True})
        except Exception as exc:  # report per file, keep going
            results.append({"media_key": media_key, "ok": False, "error": str(exc)})
    return {"backup_dir": str(backup_dir) if backup_dir.exists() else None, "results": results}


def reassign_lines(case_id: str, media_key: str, line_ids: Iterable[str], target_label: str) -> dict:
    """Move specific lines to another speaker label (used to split a mixed label).
    Backs up the file, regenerates exports. Turns are relabeled only when all their lines moved."""
    target = target_label.strip().upper()
    wanted = set(line_ids)
    path = record_path(case_id, media_key)
    record = load_record(path)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = BACKUP_ROOT / stamp
    backup_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup_dir / path.name)

    moved_per_turn: Dict[int, int] = {}
    lines_per_turn: Dict[int, int] = {}
    changed = 0
    for line in record.get("lines") or []:
        ti = line.get("turn_index")
        if isinstance(ti, int):
            lines_per_turn[ti] = lines_per_turn.get(ti, 0) + 1
        if line.get("id") in wanted:
            line["speaker"] = target
            changed += 1
            if isinstance(ti, int):
                moved_per_turn[ti] = moved_per_turn.get(ti, 0) + 1
        line["rendered_text"] = _rendered_text(line.get("speaker") or "", line.get("text") or "", bool(line.get("is_continuation")))

    for key in ("turns", "source_turns"):
        turns = record.get(key) or []
        for ti, n in moved_per_turn.items():
            if n == lines_per_turn.get(ti) and ti < len(turns):
                turns[ti]["speaker"] = target
                for word in turns[ti].get("words") or []:
                    word["speaker"] = target

    if changed:
        regenerate_exports(record)
        record["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        _write_atomic(path, record)
    return {"lines_changed": changed, "backup_dir": str(backup_dir)}

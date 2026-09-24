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


# ── Speaker segments (from the editor's line list, the app's source of truth) ─


def speaker_segments(record: dict, max_gap: float = 0.6) -> Dict[str, List[dict]]:
    """Group consecutive same-speaker lines into timed segments per speaker label."""
    segments: Dict[str, List[dict]] = {}
    current = None
    for line in record.get("lines") or []:
        speaker = (line.get("speaker") or "").strip()
        try:
            start, end = float(line.get("start") or 0), float(line.get("end") or 0)
        except (TypeError, ValueError):
            continue
        if not speaker or end <= start:
            continue
        if current and current["speaker"] == speaker and start - current["end"] <= max_gap:
            current["end"] = max(current["end"], end)
            current["text"] += " " + (line.get("text") or "")
        else:
            current = {"speaker": speaker, "start": start, "end": end, "text": line.get("text") or ""}
            segments.setdefault(speaker, []).append(current)
    return segments


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

"""Speaker Match — local tester for naming speakers across a whole TranscribeAlpha case.

Run:  tools/speaker_match/run.sh   (then open http://127.0.0.1:8765)
"""
from __future__ import annotations

import subprocess
import threading
from pathlib import Path
from typing import Callable, List

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, Response
from pydantic import BaseModel

import align
import analyze
import core
import split

app = FastAPI(title="Speaker Match")
STATIC = Path(__file__).resolve().parent / "static"

# One background job at a time (analysis or split review); the UI polls /api/status.
_job = {"running": False, "kind": None, "case_id": None, "message": "", "done": 0, "total": 0,
        "error": None, "result": None}
_job_lock = threading.Lock()


def _start_job(kind: str, case_id: str, work: Callable[[Callable], object]) -> dict:
    with _job_lock:
        if _job["running"]:
            raise HTTPException(409, "Another task is still running")
        _job.update(running=True, kind=kind, case_id=case_id, message="Starting", done=0, total=0,
                    error=None, result=None)

    def progress(message: str, done: int, total: int):
        _job.update(message=message, done=done, total=total)

    def run():
        try:
            _job["result"] = work(progress)
        except Exception as exc:
            _job["error"] = str(exc)
        finally:
            _job["running"] = False

    threading.Thread(target=run, daemon=True).start()
    return {"started": True}


@app.get("/", response_class=HTMLResponse)
def index():
    return (STATIC / "index.html").read_text()


@app.get("/api/cases")
def cases():
    return [{**c, "analyzed": len(analyze.load_index(c["case_id"]))} for c in core.list_cases()]


@app.post("/api/analyze/{case_id}")
def start_analysis(case_id: str):
    return _start_job("analyze", case_id, lambda progress: (analyze.analyze_case(case_id, progress), None)[1])


@app.get("/api/status")
def status():
    return _job


@app.get("/api/groups/{case_id}")
def groups(case_id: str, threshold: float = 0.42):
    index = analyze.load_index(case_id)
    records, stale, files = {}, [], []
    for path in core.transcript_paths(case_id):
        record = core.load_record(path)
        key = record["media_key"]
        records[key] = record
        cached = index.get(key)
        if (not cached or cached.get("updated_at") != record.get("updated_at")
                or cached.get("version") != analyze.ANALYSIS_VERSION):
            stale.append(record.get("media_filename"))
        talk = {}
        for line in record.get("lines") or []:
            lbl = (line.get("speaker") or "").strip()
            talk[lbl] = talk.get(lbl, 0.0) + max(0.0, float(line.get("end") or 0) - float(line.get("start") or 0))
        files.append({"media_key": key, "file": record.get("media_filename"),
                      "labels": [{"label": l, "talk_seconds": round(t, 1)} for l, t in sorted(talk.items()) if l]})

    flags = {}
    for key, entry in index.items():
        for label in entry.get("speakers", {}):
            f = split.flag(case_id, key, label)
            if f:
                flags[(key, label)] = f
    linked = align.speaker_links(case_id, {k: r for k, r in records.items() if k in index})
    errors = [{"file": e["file"], "error": e["error"]} for e in index.values() if e.get("error")]
    return {**analyze.cluster(index, threshold, linked["links"], flags), "files": sorted(files, key=lambda f: f["file"]),
            "alignments": linked["pairs"], "stale": stale, "errors": errors, "analyzed": len(index)}


@app.get("/clips/{case_id}/{media_key}/{name}")
def clip(case_id: str, media_key: str, name: str):
    path = (analyze.CACHE_ROOT / case_id / "clips" / media_key / name).resolve()
    if analyze.CACHE_ROOT.resolve() not in path.parents or not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="audio/mpeg")


@app.get("/api/line_audio/{case_id}/{media_key}")
def line_audio(case_id: str, media_key: str, start: float, end: float):
    """Audio for any stretch of a transcript, cut straight from the source media."""
    record = core.load_record(core.record_path(case_id, media_key))
    media = core.media_path_for(record)
    if not media:
        raise HTTPException(404, "Media file not found")
    start = max(0.0, start - 0.1)
    dur = min(max(0.3, end - start + 0.2), 30.0)
    cmd = [analyze._ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.2f}", "-i", media,
           "-t", f"{dur:.2f}", "-map", "0:a:0", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3", "-"]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return Response(out, media_type="audio/mpeg")


@app.post("/api/split/{case_id}/{media_key}")
def start_split_review(case_id: str, media_key: str, label: str):
    index = analyze.load_index(case_id)
    return _start_job("split", case_id, lambda progress: split.propose(case_id, media_key, label, index, progress))


class SplitApply(BaseModel):
    media_key: str
    line_ids: List[str]
    target_label: str


@app.post("/api/split_apply/{case_id}")
def split_apply(case_id: str, req: SplitApply):
    if not req.line_ids:
        raise HTTPException(400, "No lines selected")
    result = core.reassign_lines(case_id, req.media_key, req.line_ids, req.target_label)
    # Refresh that transcript's voiceprints so the moved lines show up under their new label.
    _start_job("analyze", case_id, lambda progress: (analyze.analyze_case(case_id, progress), None)[1])
    return result


class Rename(BaseModel):
    media_key: str
    from_label: str
    to: str


class ApplyRequest(BaseModel):
    renames: List[Rename]


@app.post("/api/apply/{case_id}")
def apply(case_id: str, req: ApplyRequest):
    renames = [{"media_key": r.media_key, "from": r.from_label, "to": r.to} for r in req.renames if r.to.strip()]
    if not renames:
        raise HTTPException(400, "Nothing to rename")
    result = core.apply_renames(case_id, renames)
    ok = [r for r in renames if any(x["ok"] and x["media_key"] == r["media_key"] for x in result["results"])]
    analyze.refresh_labels(case_id, analyze.load_index(case_id), ok)
    return result


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")

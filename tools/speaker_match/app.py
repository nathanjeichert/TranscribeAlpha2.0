"""Speaker Match — local tester for naming speakers across a whole TranscribeAlpha case.

Run:  tools/speaker_match/run.sh   (then open http://127.0.0.1:8765)
"""
from __future__ import annotations

import threading
from pathlib import Path
from typing import List

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

import analyze
import core

app = FastAPI(title="Speaker Match")
STATIC = Path(__file__).resolve().parent / "static"

_job = {"running": False, "case_id": None, "message": "", "done": 0, "total": 0, "error": None}
_job_lock = threading.Lock()


@app.get("/", response_class=HTMLResponse)
def index():
    return (STATIC / "index.html").read_text()


@app.get("/api/cases")
def cases():
    out = []
    for case in core.list_cases():
        index = analyze.load_index(case["case_id"])
        out.append({**case, "analyzed": len(index)})
    return out


@app.post("/api/analyze/{case_id}")
def start_analysis(case_id: str):
    with _job_lock:
        if _job["running"]:
            raise HTTPException(409, "An analysis is already running")
        _job.update(running=True, case_id=case_id, message="Starting", done=0, total=0, error=None)

    def progress(message: str, done: int, total: int):
        _job.update(message=message, done=done, total=total)

    def run():
        try:
            analyze.analyze_case(case_id, progress)
        except Exception as exc:
            _job["error"] = str(exc)
        finally:
            _job["running"] = False

    threading.Thread(target=run, daemon=True).start()
    return {"started": True}


@app.get("/api/status")
def status():
    return _job


@app.get("/api/groups/{case_id}")
def groups(case_id: str, threshold: float = 0.5):
    index = analyze.load_index(case_id)
    stale = []
    for path in core.transcript_paths(case_id):
        record = core.load_record(path)
        cached = index.get(record["media_key"])
        if (not cached or cached.get("updated_at") != record.get("updated_at")
                or cached.get("version") != analyze.ANALYSIS_VERSION):
            stale.append(record.get("media_filename"))
    errors = [{"file": e["file"], "error": e["error"]} for e in index.values() if e.get("error")]
    return {**analyze.cluster(index, threshold), "stale": stale, "errors": errors, "analyzed": len(index)}


@app.get("/clips/{case_id}/{media_key}/{name}")
def clip(case_id: str, media_key: str, name: str):
    path = (analyze.CACHE_ROOT / case_id / "clips" / media_key / name).resolve()
    if analyze.CACHE_ROOT.resolve() not in path.parents or not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="audio/mpeg")


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

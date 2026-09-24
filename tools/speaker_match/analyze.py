"""Voiceprints per (transcript, speaker) and cross-file grouping.

For each transcript: decode the media's audio once (16 kHz mono), cut each speaker's
clean speech runs (see core.speech_runs), embed them with SpeechBrain's ECAPA-TDNN model,
and average into one voiceprint per speaker. Short sample clips are kept for listening; the full decoded
audio is not. Everything is cached under cache/<case_id>/ and only transcripts whose
record changed are re-analyzed.

Voiceprints are biometric data: they stay on this machine, in this folder. Delete
cache/<case_id>/ when the case is done.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Callable, Dict, List, Optional

import numpy as np

import core

CACHE_ROOT = core.TOOL_ROOT / "cache"
MODEL_DIR = core.TOOL_ROOT / "models" / "spkrec-ecapa-voxceleb"
SAMPLE_RATE = 16000

MIN_SEGMENT_S = 1.0       # shorter utterances give unreliable voiceprints
WINDOW_S = 8.0            # long segments are embedded in windows of this size
MAX_AUDIO_PER_SPEAKER_S = 120.0
SAMPLE_CLIPS = 3
SAMPLE_CLIP_MAX_S = 7.0
SAMPLE_CLIP_MIN_S = 1.2
SAMPLE_CLIP_MIN_WORDS = 4  # one-word clips ("Okay") don't help anyone recognize a voice
SAMPLE_SPACING_S = 20.0   # spread sample clips across the recording
CLIP_PAD_S = 0.15         # runs have >= core.CLEARANCE_S of silence from other speakers
ANALYSIS_VERSION = 4      # bump to re-analyze cached transcripts after changing the method
MIN_TALK_FOR_MATCH_S = 3.0  # clean speech below this: listed but not auto-grouped

_model = None
_model_lock = threading.Lock()


def _ffmpeg() -> str:
    bundled = "/Applications/TranscribeAlpha.app/Contents/MacOS/ffmpeg"
    return bundled if Path(bundled).exists() else (shutil.which("ffmpeg") or "ffmpeg")


def _load_model():
    global _model
    with _model_lock:
        if _model is None:
            from speechbrain.inference.speaker import EncoderClassifier
            _model = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb", savedir=str(MODEL_DIR), run_opts={"device": "cpu"}
            )
    return _model


def _decode_audio(media_path: str) -> np.ndarray:
    cmd = [_ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-i", media_path,
           "-map", "0:a:0", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32)


def _write_clip(samples: np.ndarray, dest: Path) -> None:
    peak = float(np.max(np.abs(samples))) or 1.0
    gain = min(8.0, 0.9 / peak)  # body-cam bystanders are often very quiet
    cmd = [_ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", str(SAMPLE_RATE),
           "-ac", "1", "-i", "-", "-c:a", "libmp3lame", "-b:a", "48k", "-y", str(dest)]
    subprocess.run(cmd, input=(samples * gain).astype(np.float32).tobytes(), check=True, capture_output=True)


def _embed(chunks: List[np.ndarray]) -> np.ndarray:
    import torch
    model = _load_model()
    vecs = []
    for chunk in chunks:
        with torch.no_grad():
            emb = model.encode_batch(torch.from_numpy(chunk).unsqueeze(0)).squeeze().numpy()
        vecs.append(emb / (np.linalg.norm(emb) + 1e-9))
    return np.stack(vecs)


def _rms_db(x: np.ndarray) -> float:
    return float(20 * np.log10(np.sqrt(np.mean(np.square(x))) + 1e-9))


def _pick_clips(runs: List[dict]) -> List[dict]:
    """Best few clips: confident, reasonably long runs, spread out across the recording.
    Each clip is trimmed at a word boundary so its quote is exactly what is heard."""
    candidates = []
    for run in runs:
        words = run["words"]
        if words:
            kept = [w for w in words if w["end"] - words[0]["start"] <= SAMPLE_CLIP_MAX_S]
            start, end, text = kept[0]["start"], kept[-1]["end"], " ".join(w["text"] for w in kept)
        else:
            start, end, text = run["start"], min(run["end"], run["start"] + SAMPLE_CLIP_MAX_S), run["text"]
        if end - start < SAMPLE_CLIP_MIN_S or len(text.split()) < SAMPLE_CLIP_MIN_WORDS:
            continue
        candidates.append({"start": start, "end": end, "text": text,
                           "score": run["confidence"] * min(end - start, 5.0)})
    candidates.sort(key=lambda c: c["score"], reverse=True)
    chosen: List[dict] = []
    for c in candidates:
        if all(abs(c["start"] - o["start"]) >= SAMPLE_SPACING_S for o in chosen):
            chosen.append(c)
        if len(chosen) == SAMPLE_CLIPS:
            break
    if len(chosen) < SAMPLE_CLIPS:  # short recordings: relax spacing
        for c in candidates:
            if c not in chosen:
                chosen.append(c)
            if len(chosen) == SAMPLE_CLIPS:
                break
    return sorted(chosen, key=lambda c: c["start"])


def analyze_record(record: dict, case_cache: Path) -> dict:
    media_key = record["media_key"]
    media_path = core.media_path_for(record)
    result = {
        "media_key": media_key,
        "file": record.get("media_filename") or media_key,
        "camera": core.camera_serial(record.get("media_filename") or ""),
        "updated_at": record.get("updated_at"),
        "version": ANALYSIS_VERSION,
        "speakers": {},
        "error": None,
    }
    if not media_path:
        result["error"] = "Media file not found (is the drive connected?)"
        return result

    audio = _decode_audio(media_path)
    clip_dir = case_cache / "clips" / media_key
    if clip_dir.exists():
        shutil.rmtree(clip_dir)
    clip_dir.mkdir(parents=True)

    runs_by_speaker: Dict[str, List[dict]] = {}
    for run in core.speech_runs(record):
        runs_by_speaker.setdefault(run["speaker"], []).append(run)
    talk_by_speaker: Dict[str, float] = {}
    for line in record.get("lines") or []:
        label = (line.get("speaker") or "").strip()
        try:
            talk_by_speaker[label] = talk_by_speaker.get(label, 0.0) + max(0.0, float(line["end"]) - float(line["start"]))
        except (KeyError, TypeError, ValueError):
            pass

    def cut(start: float, end: float) -> np.ndarray:
        return audio[max(0, int(start * SAMPLE_RATE)):int(end * SAMPLE_RATE)]

    for label in sorted(set(talk_by_speaker) | set(runs_by_speaker)):
        if not label:
            continue
        runs = runs_by_speaker.get(label, [])
        usable = sorted((r for r in runs if r["end"] - r["start"] >= MIN_SEGMENT_S),
                        key=lambda r: r["confidence"] * (r["end"] - r["start"]), reverse=True)
        chunks, weights, budget = [], [], MAX_AUDIO_PER_SPEAKER_S
        for run in usable:
            if budget <= 0:
                break
            t = run["start"]
            while t < run["end"] and budget > 0:
                end = min(run["end"], t + WINDOW_S)
                piece = cut(t, end)
                if end - t >= MIN_SEGMENT_S and len(piece) >= MIN_SEGMENT_S * SAMPLE_RATE:
                    chunks.append(piece)
                    weights.append(end - t)
                    budget -= end - t
                t = end

        speaker = {
            "label": label,
            "talk_seconds": round(talk_by_speaker.get(label, 0.0), 1),
            "embedded_seconds": round(sum(weights), 1),
            "loudness_db": round(_rms_db(np.concatenate(chunks)), 1) if chunks else None,
            "centroid": None,
            "consistency": None,
            "samples": [],
        }
        if chunks:
            vecs = _embed(chunks)
            centroid = np.average(vecs, axis=0, weights=np.array(weights))
            centroid /= np.linalg.norm(centroid) + 1e-9
            speaker["centroid"] = centroid.round(5).tolist()
            speaker["consistency"] = round(float(np.mean(vecs @ centroid)), 3)

        # One folder per transcript, so clip names must include the speaker.
        safe_label = re.sub(r"[^A-Za-z0-9]+", "_", label).strip("_") or "speaker"
        for i, c in enumerate(_pick_clips(runs)):
            name = f"{safe_label}_{i}.mp3"
            _write_clip(cut(c["start"] - CLIP_PAD_S, c["end"] + CLIP_PAD_S), clip_dir / name)
            speaker["samples"].append({"clip": f"{media_key}/{name}", "start": round(c["start"], 2),
                                       "duration": round(c["end"] - c["start"], 1), "text": c["text"]})
        result["speakers"][label] = speaker

    # Hint: the camera wearer is usually much louder than everyone else in the file.
    loud = sorted(((s["loudness_db"], lbl) for lbl, s in result["speakers"].items() if s["loudness_db"] is not None), reverse=True)
    if loud and (len(loud) == 1 or loud[0][0] - loud[1][0] >= 6):
        result["speakers"][loud[0][1]]["likely_wearer"] = True
    return result


def analyze_case(case_id: str, progress: Callable[[str, int, int], None] = lambda *a: None) -> dict:
    case_cache = CACHE_ROOT / case_id
    case_cache.mkdir(parents=True, exist_ok=True)
    index_path = case_cache / "voiceprints.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}

    paths = core.transcript_paths(case_id)
    progress("Loading voice model", 0, len(paths))
    _load_model()
    keep = set()
    for i, path in enumerate(paths, 1):
        record = core.load_record(path)
        key = record["media_key"]
        keep.add(key)
        cached = index.get(key)
        if (cached and cached.get("updated_at") == record.get("updated_at") and not cached.get("error")
                and cached.get("version") == ANALYSIS_VERSION):
            progress(f"Cached: {record.get('media_filename')}", i, len(paths))
            continue
        progress(f"Analyzing: {record.get('media_filename')}", i, len(paths))
        try:
            index[key] = analyze_record(record, case_cache)
        except Exception as exc:
            index[key] = {"media_key": key, "file": record.get("media_filename"), "speakers": {}, "error": str(exc)}
        index_path.write_text(json.dumps(index))
    index = {k: v for k, v in index.items() if k in keep}
    index_path.write_text(json.dumps(index))
    progress("Done", len(paths), len(paths))
    return index


def load_index(case_id: str) -> Dict[str, dict]:
    path = CACHE_ROOT / case_id / "voiceprints.json"
    return json.loads(path.read_text()) if path.exists() else {}


def refresh_labels(case_id: str, index: Dict[str, dict], renames: List[dict]) -> None:
    """After renames are applied, carry voiceprints over to the new labels."""
    for item in renames:
        entry = index.get(item["media_key"])
        new = (item.get("to") or "").strip().upper()
        if not entry or not new or item["from"] not in entry["speakers"]:
            continue
        spk = entry["speakers"].pop(item["from"])
        spk["label"] = new
        entry["speakers"][new] = spk
    for entry in index.values():
        path = core.record_path(case_id, entry["media_key"])
        if path.exists():
            entry["updated_at"] = core.load_record(path).get("updated_at")
    (CACHE_ROOT / case_id / "voiceprints.json").write_text(json.dumps(index))


# ── Grouping ─────────────────────────────────────────────────────────────


def cluster(index: Dict[str, dict], threshold: float) -> dict:
    """Average-linkage agglomerative clustering on cosine similarity, with the
    constraint that two speakers from the same file are never merged."""
    nodes, vecs, small = [], [], []
    for key, entry in index.items():
        for label, spk in entry.get("speakers", {}).items():
            node = {"media_key": key, "file": entry["file"], "camera": entry.get("camera"), "label": label,
                    "talk_seconds": spk["talk_seconds"], "consistency": spk.get("consistency"),
                    "loudness_db": spk.get("loudness_db"), "likely_wearer": bool(spk.get("likely_wearer")),
                    "samples": spk.get("samples", [])}
            if spk.get("centroid") and spk["embedded_seconds"] >= MIN_TALK_FOR_MATCH_S:
                nodes.append(node)
                vecs.append(np.array(spk["centroid"]))
            else:
                small.append(node)

    groups: List[List[int]] = [[i] for i in range(len(nodes))]
    if nodes:
        X = np.stack(vecs)
        sim = X @ X.T
        while True:
            best, pair = threshold, None
            for a in range(len(groups)):
                keys_a = {nodes[i]["media_key"] for i in groups[a]}
                for b in range(a + 1, len(groups)):
                    if keys_a & {nodes[i]["media_key"] for i in groups[b]}:
                        continue  # cannot-link: same file, different diarized speakers
                    score = float(np.mean(sim[np.ix_(groups[a], groups[b])]))
                    if score > best:
                        best, pair = score, (a, b)
            if not pair:
                break
            a, b = pair
            groups[a] += groups.pop(b)

        for g in groups:
            centroid = X[g].mean(axis=0)
            centroid /= np.linalg.norm(centroid) + 1e-9
            for i in g:
                nodes[i]["match"] = round(float(X[i] @ centroid), 3) if len(g) > 1 else None

    people = []
    for g in sorted(groups, key=lambda g: (-len(g), -sum(nodes[i]["talk_seconds"] for i in g))):
        members = sorted((nodes[i] for i in g), key=lambda n: n["file"])
        named = [m["label"] for m in members if not core.is_generic_label(m["label"])]
        people.append({"members": members, "suggested_name": max(set(named), key=named.count) if named else ""})
    return {"people": people, "unmatched": sorted(small, key=lambda n: (n["file"], n["label"]))}

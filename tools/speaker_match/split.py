"""Detect speaker labels that probably hold two voices, and propose line-by-line splits.

Detection runs on the per-window voiceprints saved during analysis: two-means clustering
of one label's windows; if the two halves sound clearly different and the smaller one is
substantial, the label is flagged. Review then embeds every line of that label and
proposes, per line, whether it belongs to the minority voice. Nothing moves until the
user approves each line.
"""
from __future__ import annotations

import bisect
import string
from typing import Dict, List, Optional

import numpy as np

import analyze
import core

SPLIT_SIM = 0.45            # two halves less similar than this -> likely two voices (tuned on synthetic mixes)
MIN_MINORITY_SHARE = 0.15
MIN_MINORITY_S = 10.0
MIN_WINDOWS = 8
MIN_COHERENCE = 0.4       # the second voice's windows must sound like each other
LINE_MIN_S = 0.8
LINE_MARGIN = 0.05          # similarity gap needed to propose move/keep for a line
EXISTING_TARGET_SIM = 0.6   # minority voice this close to another label in the file -> suggest it


def two_voices(vecs: np.ndarray, spans: np.ndarray, restarts: int = 12) -> Optional[dict]:
    """Best spherical 2-means split of one label's windows (several starts, best fit wins).

    Returns centroids plus stats. A split driven by a few noise windows has a tiny, incoherent
    minority; a real second speaker is substantial and consistent with itself (see flag())."""
    if len(vecs) < MIN_WINDOWS:
        return None
    X = vecs.astype(np.float32)
    X /= np.linalg.norm(X, axis=1, keepdims=True) + 1e-9
    dur = (spans[:, 1] - spans[:, 0]).astype(np.float32)
    rng = np.random.default_rng(0)
    best = None
    for r in range(restarts):
        i, j = rng.choice(len(X), size=2, replace=False)
        c0, c1 = X[i], X[j]
        for _ in range(30):
            assign = (X @ c1) > (X @ c0)
            if assign.all() or (~assign).all():
                break
            n0 = (X[~assign] * dur[~assign, None]).sum(0)
            n1 = (X[assign] * dur[assign, None]).sum(0)
            c0, c1 = n0 / (np.linalg.norm(n0) + 1e-9), n1 / (np.linalg.norm(n1) + 1e-9)
        if assign.all() or (~assign).all():
            continue
        fit = float((np.maximum(X @ c0, X @ c1) * dur).sum())
        if best is None or fit > best[0]:
            best = (fit, c0, c1, assign)
    if best is None:
        return None
    _, c0, c1, assign = best
    s0, s1 = float(dur[~assign].sum()), float(dur[assign].sum())
    if s1 > s0:  # c0 is always the majority voice
        c0, c1, s0, s1, assign = c1, c0, s1, s0, ~assign
    minor = X[assign]
    coherence = float((minor @ c1).mean()) if len(minor) else 0.0
    return {"major": c0, "minor": c1, "sim": float(c0 @ c1), "minor_share": s1 / (s0 + s1),
            "minor_seconds": s1, "minor_windows": int(assign.sum()), "coherence": coherence}


def flag(case_id: str, media_key: str, label: str) -> Optional[dict]:
    arrays = analyze.load_arrays(case_id, media_key)
    if arrays is None:
        return None
    mask = arrays["labels"] == label
    tv = two_voices(arrays["vecs"][mask], arrays["spans"][mask])
    if (tv and tv["sim"] < SPLIT_SIM and tv["minor_share"] >= MIN_MINORITY_SHARE
            and tv["minor_seconds"] >= MIN_MINORITY_S and tv["coherence"] >= MIN_COHERENCE):
        return {"sim": round(tv["sim"], 2), "minor_share": round(tv["minor_share"], 2),
                "minor_seconds": round(tv["minor_seconds"], 1)}
    return None


def _next_label(existing: List[str]) -> str:
    used = {lbl.upper() for lbl in existing}
    for letter in string.ascii_uppercase:
        if f"SPEAKER {letter}" not in used:
            return f"SPEAKER {letter}"
    return f"SPEAKER {len(used) + 1}"


def _seeded_voices(vecs: np.ndarray, spans: np.ndarray, seed: np.ndarray, fallback_major: np.ndarray) -> dict:
    """Two voices anchored on a clip the user says is a different person."""
    X = vecs.astype(np.float32)
    X /= np.linalg.norm(X, axis=1, keepdims=True) + 1e-9
    minor_mask = (X @ seed) > (X @ fallback_major) if len(X) else np.zeros(0, dtype=bool)
    major = X[~minor_mask].mean(0) if (~minor_mask).sum() >= 3 else fallback_major
    major = major / (np.linalg.norm(major) + 1e-9)
    minor = seed + (X[minor_mask].mean(0) if minor_mask.sum() >= 3 else 0)  # keep the user's clip as the anchor
    minor = minor / (np.linalg.norm(minor) + 1e-9)
    return {"major": major, "minor": minor, "sim": float(major @ minor)}


def propose(case_id: str, media_key: str, label: str, index: Dict[str, dict],
            progress=lambda *a: None, seed: Optional[tuple] = None) -> dict:
    """Per-utterance split proposals for one label. With `seed` (start, end of a clip the user
    marked as a different person), that clip's voice defines the second voice."""
    record = core.load_record(core.record_path(case_id, media_key))
    arrays = analyze.load_arrays(case_id, media_key)
    mask = arrays["labels"] == label
    audio = None
    if seed:
        media = core.media_path_for(record)
        if not media:
            raise ValueError("Media file not found (is the drive connected?)")
        progress("Decoding audio", 0, 1)
        audio = analyze._decode_audio(media)
        seed_vec = analyze._embed([audio[int(seed[0] * analyze.SAMPLE_RATE):int(seed[1] * analyze.SAMPLE_RATE)]])[0]
        centroid = index.get(media_key, {}).get("speakers", {}).get(label, {}).get("centroid")
        fallback = np.array(centroid, dtype=np.float32) if centroid else -seed_vec
        tv = _seeded_voices(arrays["vecs"][mask], arrays["spans"][mask], seed_vec, fallback)
    else:
        tv = two_voices(arrays["vecs"][mask], arrays["spans"][mask])
        if not tv:
            raise ValueError("Not enough clean speech to separate two voices for this speaker.")

    labels_in_file = sorted({(l.get("speaker") or "").strip() for l in record.get("lines") or []} - {""})
    entry = index.get(media_key, {})
    target, best_sim = None, 0.0
    for other, spk in entry.get("speakers", {}).items():
        if other != label and spk.get("centroid"):
            sim = float(np.array(spk["centroid"]) @ tv["minor"])
            if sim > best_sim:
                target, best_sim = other, sim
    new_label = _next_label(labels_in_file)
    suggested = target if target and best_sim >= EXISTING_TARGET_SIM else new_label

    if audio is None:
        progress("Decoding audio", 0, 1)
        media = core.media_path_for(record)
        if not media:
            raise ValueError("Media file not found (is the drive connected?)")
        audio = analyze._decode_audio(media)

    words = []
    for turn in record.get("turns") or []:
        for w in turn.get("words") or []:
            try:
                s, e = w["start"] / 1000.0, w["end"] / 1000.0
            except (KeyError, TypeError):
                continue
            if core.MIN_WORD_S <= e - s <= core.MAX_WORD_S:
                words.append((s, e))
    words.sort()
    starts = [w[0] for w in words]

    # Judge each printed line by voice, then merge neighbours from the same turn that got the
    # same verdict. Voices can change mid-turn (diarization ran two people together), so line
    # precision is kept where it matters, while the user reviews whole sentences elsewhere.
    lines = [l for l in record.get("lines") or [] if (l.get("speaker") or "").strip() == label]
    judged = []
    for i, line in enumerate(lines):
        if i % 25 == 0:
            progress(f"Comparing lines ({i}/{len(lines)})", i, len(lines))
        ls, le = float(line["start"]), float(line["end"])
        j = bisect.bisect_left(starts, ls - 0.01)
        inside = []
        while j < len(words) and words[j][0] <= le:
            if words[j][1] <= le + 0.05:
                inside.append(words[j])
            j += 1
        proposal = "unsure"
        if inside:
            s, e = inside[0][0], min(inside[-1][1], inside[0][0] + analyze.WINDOW_S)
            if e - s >= LINE_MIN_S:
                v = analyze._embed([audio[int(s * analyze.SAMPLE_RATE):int(e * analyze.SAMPLE_RATE)]])[0]
                a, b = float(v @ tv["major"]), float(v @ tv["minor"])
                proposal = "move" if b - a >= LINE_MARGIN else "keep" if a - b >= LINE_MARGIN else "unsure"
        judged.append((line, proposal))

    out: List[dict] = []
    for line, proposal in judged:
        prev = out[-1] if out else None
        same_turn = prev and line.get("turn_index") is not None and line.get("turn_index") == prev["turn_index"]
        if same_turn and prev["proposal"] == proposal:
            prev["line_ids"].append(line["id"])
            prev["end"] = max(prev["end"], float(line["end"]))
            prev["text"] += " " + (line.get("text") or "")
        else:
            out.append({"id": line["id"], "line_ids": [line["id"]], "turn_index": line.get("turn_index"),
                        "start": float(line["start"]), "end": float(line["end"]),
                        "text": line.get("text") or "", "proposal": proposal})
    items = out
    for item in items:
        item.pop("turn_index")
    progress("Done", len(items), len(items))
    return {
        "media_key": media_key, "file": record.get("media_filename"), "label": label,
        "seed": {"start": seed[0], "end": seed[1]} if seed else None,
        "voices_similarity": round(tv["sim"], 2), "suggested_target": suggested,
        "target_options": [l for l in labels_in_file if l != label] + [new_label],
        "new_label": new_label, "lines": out,
    }


ODD_CLIP_SIM = 0.4


def odd_clips(case_id: str, index: Dict[str, dict]) -> set:
    """(media_key, label, clip) for sample clips whose voice doesn't match the rest of their label."""
    odd = set()
    for key, entry in index.items():
        arrays = analyze.load_arrays(case_id, key)
        if arrays is None or not len(arrays["vecs"]):
            continue
        V = arrays["vecs"].astype(np.float32)
        V /= np.linalg.norm(V, axis=1, keepdims=True) + 1e-9
        for label, spk in entry.get("speakers", {}).items():
            if not spk.get("centroid"):
                continue
            c = np.array(spk["centroid"], dtype=np.float32)
            m = arrays["labels"] == label
            spans, vecs = arrays["spans"][m], V[m]
            for sample in spk.get("samples", []):
                hit = [i for i, (a, b) in enumerate(spans) if a - 0.5 <= sample["start"] <= b]
                if hit and float(vecs[hit[0]] @ c) < ODD_CLIP_SIM:
                    odd.add(sample["clip"])
    return odd

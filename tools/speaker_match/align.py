"""Link speakers across simultaneous recordings (e.g. two body cams in the same room).

If two files were recording at the same time, the same conversation appears in both.
We find the exact offset by cross-correlating their loudness envelopes (searching around
the offset implied by the start times in the filenames), then check which speaker labels
talk at the same moments in both transcripts. A label pair that co-occurs most of the
time is the same person, which is far stronger evidence than voice similarity.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from itertools import combinations
from typing import Dict, List, Optional, Tuple

import numpy as np

import analyze
import core

HZ = analyze.ENVELOPE_HZ
SEARCH_S = 180.0          # filename times are to the minute; search +/- this around it
MIN_OVERLAP_S = 60.0      # need at least this much shared time to trust an alignment
MIN_PEAK_Z = 8.0          # correlation peak must stand far above the search window's noise
MIN_COOCCUR = 0.5         # share of the quieter label's speech that coincides with the other
ALIGN_VERSION = 1

_START_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})")


def start_time(filename: str) -> Optional[datetime]:
    m = _START_RE.search(filename or "")
    if not m:
        return None
    y, mo, d, h, mi = map(int, m.groups())
    return datetime(y, mo, d, h, mi)


def _prep(env: np.ndarray) -> np.ndarray:
    """Emphasize speech onsets: subtract a 2 s moving average, then z-score."""
    x = env.astype(np.float32)
    k = 2 * HZ
    kernel = np.ones(k, dtype=np.float32) / k
    x = x - np.convolve(x, kernel, mode="same")
    return (x - x.mean()) / (x.std() + 1e-6)


def find_offset(env_a: np.ndarray, env_b: np.ndarray, predicted_s: float) -> Optional[dict]:
    """Offset (seconds) such that time t in B corresponds to t + offset in A."""
    a, b = _prep(env_a), _prep(env_b)
    n = len(a) + len(b)
    size = 1 << (n - 1).bit_length()
    corr = np.fft.irfft(np.fft.rfft(a, size) * np.conj(np.fft.rfft(b, size)), size)
    lags = np.arange(size)
    lags = np.where(lags > size // 2, lags - size, lags)  # corr[lag] = sum a[t+lag] * b[t]
    lo, hi = int((predicted_s - SEARCH_S) * HZ), int((predicted_s + SEARCH_S) * HZ)
    mask = (lags >= lo) & (lags <= hi)
    if not mask.any():
        return None
    window_lags, window = lags[mask], corr[mask]
    overlap = np.minimum(len(a), window_lags + len(b)) - np.maximum(0, window_lags)
    valid = overlap >= MIN_OVERLAP_S * HZ
    if not valid.any():
        return None
    score = np.where(valid, window / np.maximum(overlap, 1), -np.inf)
    best = int(np.argmax(score))
    finite = score[np.isfinite(score)]
    med = float(np.median(finite))
    mad = float(np.median(np.abs(finite - med))) + 1e-9
    z = (float(score[best]) - med) / (1.4826 * mad)
    return {"offset_s": float(window_lags[best]) / HZ, "z": round(z, 1),
            "corr": round(float(score[best]), 3), "overlap_s": round(float(overlap[best]) / HZ, 1)}


def _activity(record: dict, n_frames: int) -> Dict[str, np.ndarray]:
    """Per-label boolean speech activity at HZ, from plausibly-timed words."""
    label_at = core._line_label_lookup(record)
    act: Dict[str, np.ndarray] = {}
    for turn in record.get("turns") or []:
        for w in turn.get("words") or []:
            try:
                s, e = w["start"] / 1000.0, w["end"] / 1000.0
            except (KeyError, TypeError):
                continue
            if not core.MIN_WORD_S <= e - s <= core.MAX_WORD_S:
                continue
            label = label_at((s + e) / 2) or (turn.get("speaker") or "").strip()
            if not label:
                continue
            arr = act.setdefault(label, np.zeros(n_frames, dtype=bool))
            arr[max(0, int(s * HZ)):min(n_frames, int(e * HZ) + 1)] = True
    return act


def speaker_links(case_id: str, records: Dict[str, dict]) -> dict:
    """Returns {"pairs": [...alignments...], "links": [{a:(key,label), b:(key,label), cooccur}]}.
    Offsets are cached (they don't change when speakers are renamed); label links are
    recomputed from the current transcripts every time."""
    cache_path = analyze.CACHE_ROOT / case_id / "alignments.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    if cache.get("version") != ALIGN_VERSION:
        cache = {"version": ALIGN_VERSION, "pairs": {}}

    meta = {}
    for key, rec in records.items():
        st = start_time(rec.get("media_filename") or "")
        dur = float(rec.get("audio_duration") or 0)
        if st and dur:
            meta[key] = (st, dur)

    pairs, links = [], []
    for ka, kb in combinations(sorted(meta), 2):
        (sa, da), (sb, db) = meta[ka], meta[kb]
        predicted = (sb - sa).total_seconds()  # B starts this many seconds into A
        if predicted > da + SEARCH_S or -predicted > db + SEARCH_S:
            continue  # recordings don't overlap in time
        pair_id = f"{ka}|{kb}"
        if pair_id not in cache["pairs"]:
            arr_a, arr_b = analyze.load_arrays(case_id, ka), analyze.load_arrays(case_id, kb)
            if arr_a is None or arr_b is None:
                continue
            cache["pairs"][pair_id] = find_offset(arr_a["envelope"], arr_b["envelope"], predicted)
        found = cache["pairs"][pair_id]
        if not found or found["z"] < MIN_PEAK_Z:
            continue
        pairs.append({"a": ka, "b": kb, **found})

        # Which labels talk at the same moments?
        off = found["offset_s"]
        n_a = int(da * HZ) + 1
        act_a = _activity(records[ka], n_a)
        act_b_raw = _activity(records[kb], int(db * HZ) + 1)
        shift = int(round(off * HZ))
        act_b = {}
        for lbl, arr in act_b_raw.items():
            shifted = np.zeros(n_a, dtype=bool)
            src_lo, dst_lo = max(0, -shift), max(0, shift)
            length = min(len(arr) - src_lo, n_a - dst_lo)
            if length > 0:
                shifted[dst_lo:dst_lo + length] = arr[src_lo:src_lo + length]
            act_b[lbl] = shifted
        window = np.zeros(n_a, dtype=bool)
        window[max(0, shift):min(n_a, shift + int(db * HZ))] = True

        scores: Dict[Tuple[str, str], float] = {}
        for la, xa in act_a.items():
            xa_w = xa & window
            for lb, xb in act_b.items():
                denom = min(int(xa_w.sum()), int(xb.sum()))
                if denom < 2 * HZ:  # under 2 s of speech in the shared window
                    continue
                scores[(la, lb)] = int((xa_w & xb).sum()) / denom
        for (la, lb), sc in scores.items():
            best_for_a = max(v for (x, _), v in scores.items() if x == la)
            best_for_b = max(v for (_, y), v in scores.items() if y == lb)
            if sc >= MIN_COOCCUR and sc == best_for_a and sc == best_for_b:
                links.append({"a": [ka, la], "b": [kb, lb], "cooccur": round(sc, 2)})

    cache_path.write_text(json.dumps(cache))
    return {"pairs": pairs, "links": links}

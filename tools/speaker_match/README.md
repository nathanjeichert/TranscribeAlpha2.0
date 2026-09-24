# Speaker Match (tester)

Name speakers across a whole TranscribeAlpha case by voice, like face grouping in a photo app.

```bash
tools/speaker_match/run.sh   # first run creates .venv; opens http://127.0.0.1:8765
```

1. Pick a case and click **Analyze voices**. Each transcript's media is decoded once, each
   diarized speaker gets a voiceprint (SpeechBrain ECAPA-TDNN, runs locally on CPU), and
   short sample clips are saved. Only changed transcripts are re-analyzed on later runs.

   Voiceprints and clips use only *clean* speech: runs of one speaker's words with plausible
   word timings and ~0.3 s of clearance from anyone else. Line spans aren't used directly
   because ASR occasionally stretches a single word over many seconds of untranscribed
   speech. Each clip is cut at word boundaries and shown with exactly the words it contains.
2. Every AssemblyAI speaker label in every file is one row, so naming every person names every
   label in the case (the **Files** tab shows "N of M labels named" per file). Rows are grouped
   into people by:
   - **Simultaneous recordings** (`align.py`): files whose filename times overlap are lined up by
     cross-correlating their loudness, and labels that talk at the same moments in both are linked.
     This is near-certain and shown as "same moments as …".
   - **Voice similarity** (average-linkage on cosine similarity). Default strictness 0.42 was tuned
     on this data: the same person on two cameras scored 0.49–0.98, different people in one file
     0.13 median / 0.30 at the 95th percentile.
   - Two labels from the **same file** can merge (diarization often splits one person), but only at
     a stricter bar, and they're shown as suggestions. Weak voice-only matches are suggestions too;
     each gets **✓ Same person / ✗ Not them**.
3. Labels that hold **two voices** (`split.py`) are flagged "may be 2 people". Review judges every
   line by voice, merges neighbouring lines of the same turn with the same verdict, and pre-selects
   the ones that sound like the second voice; you approve each one and pick where they go (an
   existing label or a new one). On synthetic mixes it caught 42/47, and wrongly proposed moving
   under 3% of the other speaker's lines.
   If a sample clip is clearly someone else, click **Different person?** on it: the same review runs
   with that clip's voice as the second voice (on synthetic mixes it wrongly proposed under 3% of the
   other speaker's lines). Clips whose voice doesn't match the rest of their label are tagged
   "sounds different".
4. Listen to the clips, fix groups, type names. Names and decisions are kept in the browser, so they
   survive regrouping and re-analysis.
5. **Review & apply** renames the labels in the desktop app's stored transcripts and regenerates
   each PDF, OnCue XML and viewer export with the backend's own builders. Every changed file is
   backed up to `backups/<timestamp>/` first.

Close the transcript in TranscribeAlpha's editor before applying, or the editor may overwrite it.

## Data and privacy

Voiceprints are biometric data. They and the sample clips stay on this machine in `cache/<case_id>/`
(gitignored); delete that folder when the case is closed. `TA_DATA_ROOT` points the tool at a copy of
the app data for testing.

## Files

- `core.py` – reads app storage, renames speakers, regenerates exports
- `analyze.py` – voiceprints, sample clips, grouping
- `align.py` – lining up simultaneous recordings and linking their speakers
- `split.py` – two-voice detection and per-line split proposals
- `app.py`, `static/index.html` – local web UI

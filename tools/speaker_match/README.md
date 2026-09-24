# Speaker Match (tester)

Name speakers across a whole TranscribeAlpha case by voice, like face grouping in a photo app.

```bash
tools/speaker_match/run.sh   # first run creates .venv; opens http://127.0.0.1:8765
```

1. Pick a case and click **Analyze voices**. Each transcript's media is decoded once, each
   diarized speaker gets a voiceprint (SpeechBrain ECAPA-TDNN, runs locally on CPU), and
   short sample clips are saved. Only changed transcripts are re-analyzed on later runs.
2. Speakers are grouped across files (average-linkage on cosine similarity; two speakers from
   the same file are never merged). Adjust **Match strictness** to regroup.
3. Listen to the clips, fix groups (untick, **Move…**, or split into a new person), type names.
4. **Review & apply** renames the labels in the desktop app's stored transcripts and regenerates
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
- `app.py`, `static/index.html` – local web UI

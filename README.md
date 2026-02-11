# TranscribeAlpha

A simple transcript generator powered by AssemblyAI. The original Streamlit prototype has been replaced with a small FastAPI backend and a static HTML front-end.

## Cloud Run-Parity Local Testing (Recommended)

Run locally in Docker (same build/runtime model as Cloud Run) so you can test without Cloud Build costs.

1. Install Docker Desktop (or Docker Engine).
2. Copy env template and fill required values:

```bash
cp .env.cloudrun.example .env.cloudrun.local
```

3. If you want auth and Secret Manager parity, configure local ADC:

```bash
gcloud auth application-default login
```

4. Start the app using the helper script:

```bash
./scripts/run_cloudrun_local.sh oncue
```

For criminal variant:

```bash
./scripts/run_cloudrun_local.sh criminal
```

Then open [http://localhost:8080](http://localhost:8080).

## Fast Dev Loop (Non-Parity)

If you want faster iteration (less Cloud Run-like), run directly with Python:

1. Install system dependencies (`ffmpeg`, `libsndfile1`).
2. Install Python dependencies:

```bash
pip install -r requirements.txt
```

3. Export API key(s), then start:

```bash
uvicorn backend.server:app --reload
```

4. Open [http://localhost:8000](http://localhost:8000).

## Notes

The backend relies on the [AssemblyAI Python SDK](https://github.com/AssemblyAI/assemblyai-python-sdk) for transcription and formatting.
- Transcriptions run on AssemblyAI's `slam-1` model to take advantage of its speaker-and-language-aware accuracy.

## File Size & Duration Limits

- Maximum upload size enforced by the backend: **2 GB** (requests larger than this return HTTP 413).
- Files larger than **100 MB** are automatically stored in **Google Cloud Storage** (`transcribealpha-uploads-1750110926`) before processing; Cloud Storage itself supports multi‑terabyte objects, so it is not the limiting factor.
- Cloud Run's default 32 MB HTTP/1 request limit is bypassed via HTTP/2 and Cloud Storage, so the app-level 2 GB cap is the effective size limit.
- Maximum audio duration is effectively bounded by what AssemblyAI accepts for a single transcription job and by container resources; AssemblyAI supports multi‑hour recordings, but for current hard limits you should refer to their docs: https://www.assemblyai.com/docs.

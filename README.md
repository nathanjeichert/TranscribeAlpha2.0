# TranscribeAlpha

A simple transcript generator powered by AssemblyAI. The original Streamlit prototype has been replaced with a small FastAPI backend and a static HTML front-end.

## Running Locally

1. Install system packages listed in `packages.txt` (ffmpeg and libsndfile1).
2. Install Python dependencies:

```bash
pip install -r requirements.txt
```

3. Export your AssemblyAI API key:

```bash
export ASSEMBLYAI_API_KEY="YOUR_ASSEMBLYAI_KEY_HERE"
```

4. Start the server:

```bash
uvicorn backend.server:app --reload
```

5. Open [http://localhost:8000](http://localhost:8000) in your browser and interact with the app.

## Notes

The backend relies on the [AssemblyAI Python SDK](https://github.com/AssemblyAI/assemblyai-python-sdk) for transcription and formatting.
- Transcriptions run on AssemblyAI's `slam-1` model to take advantage of its speaker-and-language-aware accuracy.

## File Size & Duration Limits

- Maximum upload size enforced by the backend: **2 GB** (requests larger than this return HTTP 413).
- Files larger than **100 MB** are automatically stored in **Google Cloud Storage** (`transcribealpha-uploads-1750110926`) before processing; Cloud Storage itself supports multi‑terabyte objects, so it is not the limiting factor.
- Cloud Run's default 32 MB HTTP/1 request limit is bypassed via HTTP/2 and Cloud Storage, so the app-level 2 GB cap is the effective size limit.
- Maximum audio duration is effectively bounded by what AssemblyAI accepts for a single transcription job and by container resources; AssemblyAI supports multi‑hour recordings, but for current hard limits you should refer to their docs: https://www.assemblyai.com/docs.

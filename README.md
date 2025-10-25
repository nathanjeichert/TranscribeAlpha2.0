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

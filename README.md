# TranscribeAlpha

A simple transcript generator using Google's Gemini models. The original Streamlit prototype has been replaced with a small FastAPI backend and a static HTML front-end.

## Running Locally

1. Install system packages listed in `packages.txt` (ffmpeg and libsndfile1).
2. Install Python dependencies:

```bash
pip install -r requirements.txt
```

3. Export your Gemini API key:

```bash
export GEMINI_API_KEY="YOUR_KEY_HERE"
```

4. Start the server:

```bash
uvicorn backend.server:app --reload
```

5. Open [http://localhost:8000](http://localhost:8000) in your browser and interact with the app.

## Notes

The backend relies on the [Google Gen AI Python SDK](https://googleapis.github.io/python-genai/) for Gemini access.

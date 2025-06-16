import os
import json
import base64
from typing import List, Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .transcriber import process_transcription, TranscriptTurn

# Environment-based CORS configuration
ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
ALLOWED_ORIGINS = ["*"] if ENVIRONMENT == "development" else [
    "https://transcribealpha.railway.app",
    "https://transcribealpha.onrender.com",
    # Add your production domains here
]

app = FastAPI(
    title="TranscribeAlpha API",
    description="Professional Legal Transcript Generator using Google Gemini AI",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.post("/api/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    case_name: str = Form("") ,
    case_number: str = Form(""),
    firm_name: str = Form(""),
    input_date: str = Form(""),
    input_time: str = Form(""),
    location: str = Form(""),
    speaker_names: Optional[str] = Form(None),
    include_timestamps: Optional[str] = Form(None),
):
    file_bytes = await file.read()
    speaker_list: Optional[List[str]] = None
    if speaker_names:
        # Handle both comma-separated and JSON formats for backward compatibility
        speaker_names = speaker_names.strip()
        if speaker_names.startswith('[') and speaker_names.endswith(']'):
            # JSON format
            try:
                speaker_list = json.loads(speaker_names)
            except json.JSONDecodeError:
                raise HTTPException(status_code=400, detail="Invalid JSON format for speaker names")
        else:
            # Comma-separated format
            speaker_list = [name.strip() for name in speaker_names.split(',') if name.strip()]

    title_data = {
        "CASE_NAME": case_name,
        "CASE_NUMBER": case_number,
        "FIRM_OR_ORGANIZATION_NAME": firm_name,
        "DATE": input_date,
        "TIME": input_time,
        "LOCATION": location,
        "FILE_NAME": file.filename,
        "FILE_DURATION": "Calculating...",
    }

    # Convert checkbox value to boolean
    timestamps_enabled = include_timestamps == "on"
    
    try:
        turns, docx_bytes = process_transcription(file_bytes, file.filename, speaker_list, title_data, timestamps_enabled)
    except Exception as e:
        import traceback
        error_detail = f"Error: {str(e)}\nTraceback: {traceback.format_exc()}"
        print(f"Transcription error: {error_detail}")  # This will show in the server logs
        raise HTTPException(status_code=500, detail=str(e))

    transcript_text = "\n\n".join([f"{t.speaker.upper()}:\t\t{t.text}" for t in turns])
    encoded = base64.b64encode(docx_bytes).decode()
    return JSONResponse({"transcript": transcript_text, "docx_base64": encoded})

frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")

@app.get("/health")
async def health_check():
    """Health check endpoint for deployment platforms"""
    return {"status": "healthy", "service": "TranscribeAlpha"}

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)


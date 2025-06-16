import os
import json
import base64
from typing import List, Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .transcriber import process_transcription, TranscriptTurn

app = FastAPI(title="TranscribeAlpha API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
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
):
    file_bytes = await file.read()
    speaker_list: Optional[List[str]] = None
    if speaker_names:
        try:
            speaker_list = json.loads(speaker_names)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="speaker_names must be JSON array")

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

    try:
        turns, docx_bytes = process_transcription(file_bytes, file.filename, speaker_list, title_data)
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


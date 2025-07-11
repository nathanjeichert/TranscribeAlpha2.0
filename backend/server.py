import os
import json
import base64
import logging
import uuid
import tempfile
import hashlib
from typing import List, Optional, Dict

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
import mimetypes

import sys
import os

# Add current directory and backend directory to path
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.insert(0, current_dir)
sys.path.insert(0, parent_dir)

try:
    from .transcriber import process_transcription, TranscriptTurn
except ImportError:
    try:
        from transcriber import process_transcription, TranscriptTurn
    except ImportError:
        import transcriber
        process_transcription = transcriber.process_transcription
        TranscriptTurn = transcriber.TranscriptTurn

# Environment-based CORS configuration
ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
ALLOWED_ORIGINS = ["*"] if ENVIRONMENT == "development" else [
    "https://transcribealpha-*.cloudfunctions.net",
    "https://transcribealpha-*.appspot.com",
    "https://transcribealpha-*.run.app",
    # Add your production domains here
]

# Cloud Storage configuration (commented out for local development)
# BUCKET_NAME = "transcribealpha-uploads-1750110926"
# storage_client = storage.Client()

# Temporary file storage for media preview (use Redis or database in production)
temp_file_storage: Dict[str, bytes] = {}
temp_subtitle_storage: Dict[str, str] = {}
temp_transcript_cache: Dict[str, dict] = {}

def create_cache_key(file_bytes: bytes, speaker_list: Optional[List[str]], ai_model: str) -> str:
    """Create a cache key based on file content and transcription settings"""
    # Create hash of file content
    file_hash = hashlib.md5(file_bytes).hexdigest()
    
    # Create hash of settings
    settings_str = f"{ai_model}_{speaker_list or []}"
    settings_hash = hashlib.md5(settings_str.encode()).hexdigest()
    
    return f"{file_hash}_{settings_hash}"

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
    ai_model: str = Form("flash"),
):
    logger.info(f"Received transcription request for file: {file.filename}")
    
    # Check if GEMINI_API_KEY is set
    if not os.getenv("GEMINI_API_KEY"):
        logger.error("GEMINI_API_KEY environment variable not set")
        raise HTTPException(status_code=500, detail="Server configuration error: API key not configured")
    
    # Check file size
    file_size = len(await file.read())
    await file.seek(0)  # Reset file pointer
    logger.info(f"File size: {file_size / (1024*1024):.2f} MB")
    
    if file_size > 500 * 1024 * 1024:  # 500MB limit
        raise HTTPException(status_code=413, detail="File too large. Maximum size is 500MB.")
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
    
    # Check cache first
    cache_key = create_cache_key(file_bytes, speaker_list, ai_model)
    
    if cache_key in temp_transcript_cache:
        logger.info(f"Using cached transcription for model: {ai_model}")
        cached_result = temp_transcript_cache[cache_key]
        turns = cached_result["turns"]
        srt_content = cached_result["srt_content"]
        webvtt_content = cached_result["webvtt_content"]
        
        # Re-generate docx with current timestamp setting
        try:
            from .transcriber import create_docx
        except ImportError:
            try:
                from transcriber import create_docx
            except ImportError:
                import transcriber
                create_docx = transcriber.create_docx
        
        docx_bytes = create_docx(title_data, turns, timestamps_enabled)
        logger.info(f"Used cached transcription with {len(turns)} turns.")
    else:
        # Generate new transcription
        logger.info(f"Starting new transcription process with model: {ai_model}...")
        try:
            result = process_transcription(file_bytes, file.filename, speaker_list, title_data, timestamps_enabled, ai_model, force_timestamps_for_subtitles=True)
            if len(result) == 4:
                turns, docx_bytes, srt_content, webvtt_content = result
            else:
                # Backward compatibility for old version
                turns, docx_bytes = result
                srt_content, webvtt_content = None, None
                
            # Cache the transcript results (not the docx, as that depends on timestamp setting)
            temp_transcript_cache[cache_key] = {
                "turns": turns,
                "srt_content": srt_content,
                "webvtt_content": webvtt_content
            }
            logger.info(f"Transcription completed and cached. Generated {len(turns)} turns.")
        except Exception as e:
            import traceback
            error_detail = f"Error: {str(e)}\nTraceback: {traceback.format_exc()}"
            logger.error(f"Transcription error: {error_detail}")
            raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

    # Format transcript text based on user's timestamp preference
    if timestamps_enabled:
        transcript_text = "\n\n".join([f"{t.timestamp + ' ' if t.timestamp else ''}{t.speaker.upper()}:\t\t{t.text}" for t in turns])
    else:
        transcript_text = "\n\n".join([f"{t.speaker.upper()}:\t\t{t.text}" for t in turns])
    encoded = base64.b64encode(docx_bytes).decode()
    
    response_data = {
        "transcript": transcript_text, 
        "docx_base64": encoded,
        "has_subtitles": srt_content is not None
    }
    
    # Include subtitles if available
    if srt_content:
        response_data["srt_content"] = srt_content
        response_data["webvtt_content"] = webvtt_content
    
    return JSONResponse(response_data)

# Large file upload functions (disabled for local development - requires Google Cloud Storage)
# In production, these would handle chunked uploads for files larger than 30MB

# Store for temporary media files and subtitles (in production, use Redis or similar)
temporary_files = {}

@app.post("/api/upload-preview")
async def upload_media_preview(file: UploadFile = File(...)):
    """Upload media file for preview purposes"""
    try:
        # Generate unique file ID
        file_id = str(uuid.uuid4())
        file_bytes = await file.read()
        
        # Store file temporarily (in memory for now, use persistent storage in production)
        temporary_files[file_id] = {
            'filename': file.filename,
            'content': file_bytes,
            'content_type': file.content_type or mimetypes.guess_type(file.filename)[0]
        }
        
        logger.info(f"Uploaded media file for preview: {file.filename} ({len(file_bytes)} bytes)")
        
        return JSONResponse({
            "file_id": file_id,
            "filename": file.filename,
            "size": len(file_bytes),
            "content_type": file.content_type
        })
        
    except Exception as e:
        logger.error(f"Media preview upload failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

@app.get("/api/media/{file_id}")
async def serve_media_file(file_id: str):
    """Serve media file for preview"""
    if file_id not in temporary_files:
        raise HTTPException(status_code=404, detail="Media file not found")
    
    file_data = temporary_files[file_id]
    
    # Get content type
    content_type = file_data['content_type'] or 'application/octet-stream'
    
    # Create streaming response for large files
    def generate():
        yield file_data['content']
    
    return StreamingResponse(
        generate(),
        media_type=content_type,
        headers={
            "Accept-Ranges": "bytes",
            "Content-Length": str(len(file_data['content'])),
            "Cache-Control": "public, max-age=3600"
        }
    )

@app.post("/api/generate-subtitles")
async def generate_subtitles_preview(
    file_id: str = Form(...),
    speaker_names: Optional[str] = Form(None),
    ai_model: str = Form("flash")
):
    """Generate subtitles for media preview"""
    if file_id not in temporary_files:
        raise HTTPException(status_code=404, detail="Media file not found")
    
    file_data = temporary_files[file_id]
    
    # Process speaker names
    speaker_list: Optional[List[str]] = None
    if speaker_names:
        speaker_names = speaker_names.strip()
        if speaker_names.startswith('[') and speaker_names.endswith(']'):
            try:
                speaker_list = json.loads(speaker_names)
            except json.JSONDecodeError:
                raise HTTPException(status_code=400, detail="Invalid JSON format for speaker names")
        else:
            speaker_list = [name.strip() for name in speaker_names.split(',') if name.strip()]
    
    # Basic title data for subtitle generation
    title_data = {
        "FILE_NAME": file_data['filename'],
        "FILE_DURATION": "Calculating...",
    }
    
    try:
        # Process with timestamps enabled
        result = process_transcription(
            file_data['content'], 
            file_data['filename'], 
            speaker_list, 
            title_data, 
            include_timestamps=True,  # Always include timestamps for subtitles
            ai_model=ai_model
        )
        
        if len(result) == 4:
            turns, _, srt_content, webvtt_content = result
        else:
            # Fallback if subtitles not generated
            turns, _ = result
            srt_content, webvtt_content = None, None
        
        if not srt_content:
            # Generate subtitles from turns if not already generated
            try:
                from .transcriber import generate_srt_from_transcript, srt_to_webvtt
            except ImportError:
                try:
                    from transcriber import generate_srt_from_transcript, srt_to_webvtt
                except ImportError:
                    import transcriber
                    generate_srt_from_transcript = transcriber.generate_srt_from_transcript
                    srt_to_webvtt = transcriber.srt_to_webvtt
            srt_content = generate_srt_from_transcript(turns)
            webvtt_content = srt_to_webvtt(srt_content)
        
        # Store subtitles with the file
        temporary_files[file_id]['srt_content'] = srt_content
        temporary_files[file_id]['webvtt_content'] = webvtt_content
        
        return JSONResponse({
            "file_id": file_id,
            "has_subtitles": bool(srt_content),
            "subtitle_count": len([t for t in turns if t.timestamp]),
            "webvtt_content": webvtt_content
        })
        
    except Exception as e:
        logger.error(f"Subtitle generation failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Subtitle generation failed: {str(e)}")

@app.get("/api/subtitles/{file_id}")
async def serve_subtitles(file_id: str, format: str = "webvtt"):
    """Serve subtitle file in requested format"""
    if file_id not in temporary_files:
        raise HTTPException(status_code=404, detail="Media file not found")
    
    file_data = temporary_files[file_id]
    
    if format.lower() == "srt":
        content = file_data.get('srt_content')
        media_type = "text/plain"
        filename = f"{file_data['filename']}.srt"
    else:  # webvtt
        content = file_data.get('webvtt_content')
        media_type = "text/vtt"
        filename = f"{file_data['filename']}.vtt"
    
    if not content:
        raise HTTPException(status_code=404, detail="Subtitles not found for this file")
    
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": f"attachment; filename=\"{filename}\"",
            "Cache-Control": "public, max-age=3600"
        }
    )

@app.post("/api/upload-preview")
async def upload_preview_file(file: UploadFile = File(...)):
    """Upload a file for preview without full transcription processing"""
    try:
        file_id = str(uuid.uuid4())
        file_bytes = await file.read()
        
        # Store in temporary storage
        temp_file_storage[file_id] = file_bytes
        
        # Get file info
        file_size = len(file_bytes)
        mime_type, _ = mimetypes.guess_type(file.filename)
        
        # Determine if it's video or audio
        is_video = mime_type and mime_type.startswith('video')
        is_audio = mime_type and mime_type.startswith('audio')
        
        if not (is_video or is_audio):
            # Try to determine by extension
            ext = file.filename.split('.')[-1].lower() if '.' in file.filename else ''
            is_video = ext in ['mp4', 'avi', 'mov', 'mkv', 'webm']
            is_audio = ext in ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'aiff']
        
        logger.info(f"Uploaded preview file: {file.filename} ({file_size} bytes)")
        
        return JSONResponse({
            "file_id": file_id,
            "filename": file.filename,
            "file_size": file_size,
            "mime_type": mime_type or "application/octet-stream",
            "is_video": is_video,
            "is_audio": is_audio,
            "status": "uploaded"
        })
        
    except Exception as e:
        logger.error(f"Preview upload failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")


@app.get("/api/media/{file_id}")
async def get_media_file(file_id: str):
    """Stream media file for preview"""
    if file_id not in temp_file_storage:
        raise HTTPException(status_code=404, detail="File not found")
    
    file_bytes = temp_file_storage[file_id]
    
    # Try to determine content type
    # For now, we'll use a generic type and let the browser figure it out
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(len(file_bytes))
    }
    
    return Response(
        content=file_bytes,
        media_type="application/octet-stream",
        headers=headers
    )





@app.get("/health")
async def health_check():
    """Health check endpoint for deployment platforms"""
    api_key_configured = bool(os.getenv("GEMINI_API_KEY"))
    return {
        "status": "healthy", 
        "service": "TranscribeAlpha",
        "api_key_configured": api_key_configured
    }

# Mount static files LAST so API routes take precedence
frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")

if __name__ == "__main__":
    # Cloud Run uses PORT environment variable, defaults to 8080
    port = int(os.getenv("PORT", 8080))
    host = os.getenv("HOST", "0.0.0.0")
    
    # Use Hypercorn for HTTP/2 support on Cloud Run
    import hypercorn.asyncio
    import hypercorn.config
    import asyncio
    
    config = hypercorn.config.Config()
    config.bind = [f"{host}:{port}"]
    config.application_path = "backend.server:app"
    
    # Enable HTTP/2 support
    config.h2 = True
    
    # Run the server
    asyncio.run(hypercorn.asyncio.serve(app, config))


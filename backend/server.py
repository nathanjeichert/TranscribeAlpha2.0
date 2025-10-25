import os
import json
import base64
import logging
import uuid
import tempfile
import hashlib
from datetime import datetime, timedelta
from typing import List, Optional, Dict
from google.cloud import storage

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import mimetypes

import sys

# Add current directory and backend directory to path
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.insert(0, current_dir)
sys.path.insert(0, parent_dir)

try:
    from .transcriber import process_transcription, TranscriptTurn, generate_oncue_xml
except ImportError:
    try:
        from transcriber import process_transcription, TranscriptTurn, generate_oncue_xml
    except ImportError:
        import transcriber
        process_transcription = transcriber.process_transcription
        TranscriptTurn = transcriber.TranscriptTurn
        generate_oncue_xml = transcriber.generate_oncue_xml

# Environment-based CORS configuration
ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
ALLOWED_ORIGINS = ["*"] if ENVIRONMENT == "development" else [
    "https://transcribealpha-*.cloudfunctions.net",
    "https://transcribealpha-*.appspot.com",
    "https://transcribealpha-*.run.app",
    # Add your production domains here
]

# Cloud Storage configuration
BUCKET_NAME = "transcribealpha-uploads-1750110926"
storage_client = storage.Client()

# Cache for transcription results
temp_transcript_cache: Dict[str, dict] = {}

# Default transcript layout configuration
DEFAULT_LINES_PER_PAGE = 25

# Track last cleanup time for periodic cleanup
last_cleanup_time = datetime.now()

def create_cache_key(
    file_bytes: bytes,
    speaker_list: Optional[List[str]],
    ai_model: str,
    transcription_engine: str = "gemini"
) -> str:
    """Create a cache key based on file content and transcription settings"""
    # Create hash of file content
    file_hash = hashlib.md5(file_bytes).hexdigest()
    
    # Create hash of settings
    settings_str = f"{transcription_engine}_{ai_model}_{speaker_list or []}"
    settings_hash = hashlib.md5(settings_str.encode()).hexdigest()
    
    return f"{file_hash}_{settings_hash}"

def cleanup_old_files():
    """Clean up files older than 1 day from Cloud Storage to prevent billing issues"""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        cutoff_date = datetime.now() - timedelta(days=1)
        
        blobs = bucket.list_blobs()
        deleted_count = 0
        
        for blob in blobs:
            # Check if blob is older than 1 day
            if blob.time_created and blob.time_created.replace(tzinfo=None) < cutoff_date:
                blob.delete()
                deleted_count += 1
                logger.info(f"Deleted old file: {blob.name}")
        
        logger.info(f"Cleanup completed. Deleted {deleted_count} old files.")
    except Exception as e:
        logger.error(f"Error during cleanup: {str(e)}")

def upload_to_cloud_storage(file_bytes: bytes, filename: str) -> str:
    """Upload file to Cloud Storage and return the blob name"""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}_{filename}"
        blob = bucket.blob(blob_name)
        blob.upload_from_string(file_bytes)
        logger.info(f"Uploaded {filename} to Cloud Storage as {blob_name}")
        return blob_name
    except Exception as e:
        logger.error(f"Error uploading to Cloud Storage: {str(e)}")
        raise

def download_from_cloud_storage(blob_name: str) -> bytes:
    """Download file from Cloud Storage"""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(blob_name)
        return blob.download_as_bytes()
    except Exception as e:
        logger.error(f"Error downloading from Cloud Storage: {str(e)}")
        raise

def get_blob_metadata(blob_name: str) -> dict:
    """Get metadata for a blob in Cloud Storage"""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob = bucket.blob(blob_name)
        if not blob.exists():
            return None
        
        # Parse metadata from blob name and custom metadata
        metadata = blob.metadata or {}
        return {
            'filename': metadata.get('original_filename', blob_name.split('_')[-1]),
            'content_type': blob.content_type or metadata.get('content_type', 'application/octet-stream'),
            'size': blob.size,
            'created': blob.time_created,
        }
    except Exception as e:
        logger.error(f"Error getting blob metadata: {str(e)}")
        return None

def upload_preview_file_to_cloud_storage(file_bytes: bytes, filename: str, content_type: str = None) -> str:
    """Upload preview file to Cloud Storage with metadata"""
    try:
        bucket = storage_client.bucket(BUCKET_NAME)
        blob_name = f"preview_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}_{filename}"
        blob = bucket.blob(blob_name)
        
        # Set metadata
        blob.metadata = {
            'original_filename': filename,
            'content_type': content_type or 'application/octet-stream',
            'file_type': 'preview'
        }
        
        if content_type:
            blob.content_type = content_type
            
        blob.upload_from_string(file_bytes)
        logger.info(f"Uploaded preview file {filename} to Cloud Storage as {blob_name}")
        return blob_name
    except Exception as e:
        logger.error(f"Error uploading preview file to Cloud Storage: {str(e)}")
        raise

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

@app.on_event("startup")
async def startup_event():
    """Run cleanup on startup and log Cloud Storage status"""
    logger.info("Starting TranscribeAlpha with Cloud Storage enabled")
    cleanup_old_files()


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
    transcription_engine: str = Form("assemblyai"),
):
    logger.info(f"Received transcription request for file: {file.filename}")
    
    # Check API key based on selected transcription engine
    if transcription_engine == "assemblyai":
        if not os.getenv("ASSEMBLYAI_API_KEY"):
            logger.error("ASSEMBLYAI_API_KEY environment variable not set")
            raise HTTPException(
                status_code=500,
                detail="Server configuration error: AssemblyAI API key not configured"
            )
    elif transcription_engine == "gemini":
        if not os.getenv("GEMINI_API_KEY"):
            logger.error("GEMINI_API_KEY environment variable not set")
            raise HTTPException(
                status_code=500,
                detail="Server configuration error: Gemini API key not configured"
            )
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid transcription engine: {transcription_engine}. Must be 'gemini' or 'assemblyai'"
        )
    
    # Check file size and handle large files with Cloud Storage
    file_size = len(await file.read())
    await file.seek(0)  # Reset file pointer
    logger.info(f"File size: {file_size / (1024*1024):.2f} MB")
    
    # Increase limit to 2GB for Cloud Storage handling
    if file_size > 2 * 1024 * 1024 * 1024:  # 2GB limit
        raise HTTPException(status_code=413, detail="File too large. Maximum size is 2GB.")
    
    file_bytes = await file.read()
    
    # For large files (>100MB), use Cloud Storage
    use_cloud_storage = file_size > 100 * 1024 * 1024
    blob_name = None
    
    if use_cloud_storage:
        logger.info(f"Large file detected ({file_size / (1024*1024):.2f} MB), uploading to Cloud Storage")
        blob_name = upload_to_cloud_storage(file_bytes, file.filename)
        # Run cleanup after upload to manage storage costs
        cleanup_old_files()
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
    cache_key = create_cache_key(file_bytes, speaker_list, ai_model, transcription_engine)
    
    if cache_key in temp_transcript_cache:
        logger.info(f"Using cached transcription for engine {transcription_engine} and model {ai_model}")
        cached_result = temp_transcript_cache[cache_key]
        turns = cached_result["turns"]
        duration_seconds = cached_result.get("duration")
        
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
        logger.info(f"Starting new transcription process with model: {ai_model} and engine: {transcription_engine}...")
        try:
            turns, docx_bytes, duration_seconds = process_transcription(
                file_bytes,
                file.filename,
                speaker_list,
                title_data,
                timestamps_enabled,
                ai_model,
                force_timestamps_for_subtitles=True,
                transcription_engine=transcription_engine
            )

            # Cache the transcript results (not the docx, as that depends on timestamp setting)
            temp_transcript_cache[cache_key] = {
                "turns": turns,
                "duration": duration_seconds,
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

    oncue_xml = generate_oncue_xml(turns, title_data, duration_seconds or 0, DEFAULT_LINES_PER_PAGE)
    oncue_b64 = base64.b64encode(oncue_xml.encode("utf-8")).decode()

    response_data = {
        "transcript": transcript_text,
        "docx_base64": encoded,
        "oncue_xml_base64": oncue_b64,
    }

    return JSONResponse(response_data)

@app.post("/api/upload-preview")
async def upload_media_preview(file: UploadFile = File(...)):
    """Upload media file for preview purposes"""
    try:
        file_bytes = await file.read()
        content_type = file.content_type or mimetypes.guess_type(file.filename)[0]
        
        # Upload to Cloud Storage
        blob_name = upload_preview_file_to_cloud_storage(
            file_bytes, 
            file.filename, 
            content_type
        )
        
        logger.info(f"Uploaded media file for preview: {file.filename} ({len(file_bytes)} bytes)")
        
        return JSONResponse({
            "file_id": blob_name,
            "filename": file.filename,
            "size": len(file_bytes),
            "content_type": content_type
        })
        
    except Exception as e:
        logger.error(f"Media preview upload failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

@app.get("/api/media/{file_id}")
async def serve_media_file(file_id: str):
    """Serve media file for preview"""
    try:
        # Get file metadata
        metadata = get_blob_metadata(file_id)
        if not metadata:
            raise HTTPException(status_code=404, detail="Media file not found")
        
        # Download file from Cloud Storage
        file_bytes = download_from_cloud_storage(file_id)
        
        # Create streaming response for large files
        def generate():
            yield file_bytes
        
        return StreamingResponse(
            generate(),
            media_type=metadata['content_type'],
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(len(file_bytes)),
                "Cache-Control": "public, max-age=3600"
            }
        )
    except Exception as e:
        logger.error(f"Error serving media file {file_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error serving media file")

@app.get("/health")
async def health_check():
    """Health check endpoint for deployment platforms"""
    global last_cleanup_time
    
    # Run cleanup every 12 hours
    current_time = datetime.now()
    if current_time - last_cleanup_time > timedelta(hours=12):
        try:
            cleanup_old_files()
            last_cleanup_time = current_time
            logger.info("Periodic cleanup completed via health check")
        except Exception as e:
            logger.error(f"Periodic cleanup failed: {str(e)}")
    
    gemini_api_key_configured = bool(os.getenv("GEMINI_API_KEY"))
    assemblyai_api_key_configured = bool(os.getenv("ASSEMBLYAI_API_KEY"))

    return {
        "status": "healthy",
        "service": "TranscribeAlpha",
        "gemini_api_key_configured": gemini_api_key_configured,
        "assemblyai_api_key_configured": assemblyai_api_key_configured,
        "transcription_engines_available": {
            "gemini": gemini_api_key_configured,
            "assemblyai": assemblyai_api_key_configured
        },
        "last_cleanup": last_cleanup_time.isoformat()
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

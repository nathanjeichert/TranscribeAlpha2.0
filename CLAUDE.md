# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TranscribeAlpha is a legal transcript generation web application that converts audio/video files into professionally formatted legal transcripts using Google Gemini AI.

**Architecture**: FastAPI backend + static HTML frontend
**Purpose**: Audio/video → AI transcription → formatted Word document
**Deployment**: Configured for Google Cloud Run

## Development Commands

### Setup & Installation
```bash
# Backend setup
cd backend
pip install -r requirements.txt

# Environment setup (required)
export GEMINI_API_KEY="your_api_key_here"

# System dependencies (Ubuntu/Debian)
sudo apt update
sudo apt install ffmpeg libsndfile1-dev
```

### Running the Application
```bash
# Method 1: Direct execution (recommended)
cd TranscribeAlpha2.0
python main.py
# Server runs on http://0.0.0.0:8080

# Method 2: Using uvicorn directly
uvicorn backend.server:app --host 0.0.0.0 --port 8080 --reload

# Frontend is static - access at http://localhost:8080/
```

### Testing
```bash
# No automated test suite currently exists
# Manual testing: upload audio/video files via frontend form
```

## Code Architecture

### Backend Structure (`backend/`)
- **`server.py`**: FastAPI application with single `/api/transcribe` endpoint
- **`transcriber.py`**: Core transcription logic using Google Gemini 2.5 Pro
- **`requirements.txt`**: Python dependencies
- **`templates/`**: Word document templates for transcript formatting

### Frontend Structure (`frontend/`)
- **`index.html`**: Professional HTML form for file upload and case metadata input
- **Direct JavaScript**: Fetch integration with backend API

### Key Components

**Transcription Pipeline**:
1. File upload → temporary storage
2. Video files → audio conversion (ffmpeg)
3. Audio → Google Gemini AI transcription with timestamps
4. Raw transcript → legal formatting
5. Template-based Word document generation
6. Download response to user

**Media Processing**:
- Supports: mp4, avi, mov, mkv, wav, mp3, m4a, flac, ogg
- Automatic video-to-audio conversion using ffmpeg
- Audio duration calculation for processing estimates
- Cross-platform ffmpeg path detection

**AI Integration**:
- Google Gemini 2.5 Pro Preview model
- Structured JSON output for speaker identification
- Speaker diarization (automatic detection or manual assignment)
- Native timestamp generation support
- Retry logic for API failures

**Document Generation**:
- Professional legal transcript formatting (double-spaced, Courier New)
- Template placeholder replacement system
- Automatic case metadata integration
- Optional timestamp inclusion in transcripts

## Important Implementation Details

### Environment Requirements
- `GEMINI_API_KEY` environment variable is mandatory
- System ffmpeg installation required for media processing
- Python 3.x with specific package versions in requirements.txt

### Error Handling
- Comprehensive try-catch blocks throughout transcription pipeline
- User-friendly error messages for common failure scenarios
- API retry logic with exponential backoff

### Security Considerations
- CORS enabled for Cloud Run domains in production
- Temporary file cleanup after processing
- No authentication/authorization currently implemented

### Performance Notes
- Single-threaded processing (no async queue system)
- Files processed synchronously
- Memory usage scales with audio file size during processing
- 500MB file size limit for uploads

### Cloud Run Optimizations
- **Cross-platform compatibility**: Works on containerized Linux environments
- **Environment variables**: `PORT` defaults to 8080, `HOST` to 0.0.0.0
- **Health checks**: `/health` endpoint for container orchestration
- **Docker support**: Multi-stage build with ffmpeg installation
- **Auto-scaling**: Configured for 0-10 instances based on CPU usage

## Deployment Instructions

### Google Cloud Run (Recommended)
1. **Prerequisites**: 
   - Google Cloud account with billing enabled
   - Google Cloud CLI installed and authenticated
   - Docker installed locally (optional for local testing)

2. **Deploy to Cloud Run**:
   ```bash
   # Set your project ID
   gcloud config set project YOUR_PROJECT_ID
   
   # Deploy directly from source
   gcloud run deploy transcribealpha \
     --source . \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --set-env-vars GEMINI_API_KEY=your_gemini_api_key \
     --memory 2Gi \
     --cpu 1 \
     --max-instances 10
   ```

3. **Alternative: Deploy with Docker**:
   ```bash
   # Build and push to Google Container Registry
   gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/transcribealpha
   
   # Deploy from container
   gcloud run deploy transcribealpha \
     --image gcr.io/YOUR_PROJECT_ID/transcribealpha \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --set-env-vars GEMINI_API_KEY=your_gemini_api_key
   ```

### Railway (Alternative - see railway-deployment branch)
For Railway deployment, switch to the `railway-deployment` branch:
```bash
git checkout railway-deployment
```
That branch contains Railway-specific configuration files.

### Environment Variables for Production
- `GEMINI_API_KEY`: Required - Your Google Gemini API key
- `PORT`: Optional - Defaults to 8080 (Cloud Run standard)
- `HOST`: Optional - Defaults to 0.0.0.0
- `ENVIRONMENT`: Set to "production" for CORS restrictions

## Development Tips

### Adding New Features
- New audio formats: Update `ALLOWED_EXTENSIONS` in `server.py`
- Template modifications: Edit files in `backend/templates/`
- Frontend changes: Modify `frontend/index.html` and associated files

### Debugging
- Backend logs print to console during development
- Check ffmpeg installation if audio conversion fails
- Verify Gemini API key if transcription requests fail
- Use `/health` endpoint to verify API key configuration

### Common Tasks
- **Add new document template**: Place in `backend/templates/` and update template loading logic
- **Modify transcript formatting**: Edit the formatting section in `transcriber.py`
- **Change AI model**: Update model name in Gemini client initialization
- **Adjust timestamp format**: Modify timestamp prompt and formatting logic

### Local Development with Docker
```bash
# Build locally
docker build -t transcribealpha .

# Run locally
docker run -p 8080:8080 -e GEMINI_API_KEY=your_key transcribealpha
```

## Branch Structure

### Main Branch (master)
- **Purpose**: Google Cloud Run deployment
- **Configuration**: Dockerfile, app.yaml, .gcloudignore
- **Port**: 8080 (Cloud Run standard)
- **CORS**: Configured for Cloud Run domains

### Railway Deployment Branch
- **Purpose**: Railway platform deployment
- **Configuration**: railway.json, packages.txt
- **Port**: 8000 (Railway default)
- **Switch command**: `git checkout railway-deployment`

## Cost Considerations

### Google Cloud Run Pricing
- **Free Tier**: 2 million requests/month, 400,000 GB-seconds/month
- **CPU/Memory**: Pay per 100ms of CPU time and memory usage
- **Typically**: $0.10-$0.50 per transcription for average files
- **Large files**: May cost more due to processing time

### Gemini API Pricing
- **Audio Input**: ~$0.125 per minute of audio
- **File size limits**: 2GB max file size
- **Processing time**: Usually 1-3x real-time speed

## Troubleshooting

### Common Issues
- **502 errors**: Usually ffmpeg installation or memory limits
- **Timeout errors**: Large files exceeding Cloud Run timeout (15 min max)
- **Import errors**: Python path issues in containerized deployment
- **CORS errors**: Check ENVIRONMENT variable and allowed origins

### Debug Commands
```bash
# Check health endpoint
curl https://your-app.run.app/health

# Local debug
export GEMINI_API_KEY=your_key
python main.py

# Container debug
docker run -it --entrypoint=/bin/bash transcribealpha
```
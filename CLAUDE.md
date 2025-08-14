# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TranscribeAlpha is a legal transcript generation web application that converts audio/video files into professionally formatted legal transcripts using Google Gemini AI.

**Architecture**: FastAPI backend + Next.js frontend with Tailwind CSS
**Purpose**: Audio/video → AI transcription → formatted Word document
**Deployment**: Configured for Google Cloud Run with multi-stage Docker build

## Development Commands

### Deployment
This application is designed for **Google Cloud Run deployment only**. No local setup required.

#### Prerequisites
1. **Create Artifact Registry repository**:
```bash
gcloud artifacts repositories create transcribealpha \
  --repository-format=docker \
  --location=us-central1
```

2. **Set up GitHub integration** in Google Cloud Console:
   - Go to Cloud Build → Triggers
   - Connect your GitHub repository
   - Configure trigger to use `cloudbuild.yaml`
   - Set substitution variable: `_GEMINI_API_KEY=your_actual_api_key`

#### Manual Deployment (if needed)
```bash
# Deploy using Cloud Build
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_GEMINI_API_KEY=your_gemini_api_key

# Or deploy directly from source
gcloud run deploy transcribealpha \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=your_gemini_api_key \
  --memory 2Gi \
  --cpu 1 \
  --max-instances 10 \
  --port 8080 \
  --http2
```

#### Image Name for CI/CD
**Artifact Registry**: `us-central1-docker.pkg.dev/YOUR_PROJECT_ID/transcribealpha/app`

### Testing
```bash
# Testing via deployed Cloud Run instance
# Access the deployed URL and test file upload functionality
# Check /health endpoint for system status
```

## Code Architecture

### Backend Structure (`backend/`)
- **`server.py`**: FastAPI application with `/api/transcribe` endpoint, HTTP/2 H2C support via Hypercorn
- **`transcriber.py`**: Core transcription logic using Google Gemini 2.5 Pro
- **`requirements.txt`**: Python dependencies including Hypercorn for HTTP/2
- **`templates/`**: Word document templates for transcript formatting

### Frontend Structure (`frontend-next/`)
- **Next.js 14**: React-based framework with TypeScript
- **Tailwind CSS**: Professional black/white design system consistent with portfolio
- **`src/app/`**: App Router with layout.tsx and page.tsx
- **`src/components/TranscribeForm.tsx`**: Main form component with all functionality
- **Static export**: Built to `out/` directory for production serving

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
- 2GB file size limit for uploads
- **Large file handling**: Files >100MB automatically use Cloud Storage
- **HTTP/2 support**: Bypasses Cloud Run's 32MB HTTP/1 request limit
- **Auto-cleanup**: Daily cleanup of Cloud Storage files to manage costs

### Cloud Storage & Caching
- **Bucket**: `transcribealpha-uploads-1750110926` - Files >100MB stored here
- **Auto-cleanup**: Deletes files >1 day old on startup and after large uploads
- **Cache**: MD5 hash of (file + AI model + speakers) avoids re-transcribing
- **Pipeline**: Upload → Size check → Cache check → Process → Generate outputs → Cleanup

### API Endpoints
- **`/api/transcribe`**: Main transcription (POST) - returns DOCX, SRT, WebVTT, OnCue XML
- **`/api/upload-preview`**: Upload for preview without processing (POST)
- **`/api/media/{file_id}`**: Stream media files (GET)
- **`/health`**: Health check (GET)

### Cloud Run Optimizations
- **Cross-platform compatibility**: Works on containerized Linux environments
- **Environment variables**: `PORT` defaults to 8080, `HOST` to 0.0.0.0
- **Health checks**: `/health` endpoint for container orchestration
- **Docker support**: Multi-stage build with ffmpeg installation
- **Auto-scaling**: Configured for 0-10 instances based on CPU usage
- **HTTP/2 H2C**: End-to-end HTTP/2 support using Hypercorn for large file uploads

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
   
   # Deploy directly from source with HTTP/2 support
   gcloud run deploy transcribealpha \
     --source . \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --set-env-vars GEMINI_API_KEY=your_gemini_api_key \
     --memory 2Gi \
     --cpu 1 \
     --max-instances 10 \
     --port 8080 \
     --http2
   ```

3. **Alternative: Deploy with Docker**:
   ```bash
   # Build and push to Google Container Registry
   gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/transcribealpha
   
   # Deploy from container with HTTP/2 support
   gcloud run deploy transcribealpha \
     --image gcr.io/YOUR_PROJECT_ID/transcribealpha \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --set-env-vars GEMINI_API_KEY=your_gemini_api_key \
     --port 8080 \
     --http2
   ```

4. **Using Cloud Build (Automated)**:
   ```bash
   # The cloudbuild.yaml file includes HTTP/2 configuration
   gcloud builds submit --config cloudbuild.yaml
   ```


### Environment Variables for Production
- `GEMINI_API_KEY`: Required - Your Google Gemini API key
- `PORT`: Optional - Defaults to 8080 (Cloud Run standard)
- `HOST`: Optional - Defaults to 0.0.0.0
- `ENVIRONMENT`: Set to "production" for CORS restrictions

## Development Tips

### Adding New Features
- New audio formats: Update `ALLOWED_EXTENSIONS` in `server.py`
- Template modifications: Edit files in `backend/templates/`
- Frontend changes: Modify components in `frontend-next/src/components/`
- UI styling: Update Tailwind classes or add custom CSS in `globals.css`

### Debugging
- Check Cloud Run logs via Google Cloud Console
- Use `/health` endpoint to verify API key configuration and system status
- Verify Cloud Storage permissions if file upload issues occur
- Check ffmpeg availability in container environment

### Common Tasks
- **Add new document template**: Place in `backend/templates/` and update template loading logic
- **Modify transcript formatting**: Edit the formatting section in `transcriber.py`
- **Change AI model**: Update model name in Gemini client initialization
- **Adjust timestamp format**: Modify timestamp prompt and formatting logic

### Cloud Run Deployment Details
The application uses automated deployment via `cloudbuild.yaml`:
1. **Multi-stage Docker build**: Node.js builds frontend → Python backend setup
2. **Artifact Registry**: Images stored in `us-central1-docker.pkg.dev`
3. **Automated deployment**: GitHub push triggers Cloud Build → Cloud Run deployment
4. **Configuration**: All Cloud Run settings defined in `cloudbuild.yaml`

## Branch Structure

### Main Branch (master)
- **Purpose**: Google Cloud Run deployment
- **Configuration**: Dockerfile, cloudbuild.yaml, .gcloudignore
- **Port**: 8080 (Cloud Run standard)
- **CORS**: Configured for Cloud Run domains

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

## HTTP/2 Implementation
- **Purpose**: Bypass Cloud Run's 32MB HTTP/1 limit for 2GB uploads
- **Server**: Hypercorn ASGI with H2C (HTTP/2 cleartext)
- **Key Files**: `main.py`, `cloudbuild.yaml` with `--http2` flag
- **Test**: `curl -v --http2 https://your-app.run.app/health`

## Troubleshooting

### Common Issues
- **502 errors**: Usually ffmpeg installation or memory limits
- **Timeout errors**: Large files exceeding Cloud Run timeout (15 min max)
- **Import errors**: Python path issues in containerized deployment
- **CORS errors**: Check ENVIRONMENT variable and allowed origins
- **413 errors**: Should be resolved with HTTP/2 implementation (files >32MB)
- **HTTP/2 not working**: Verify `--http2` flag in deployment and Hypercorn configuration

### Debug Commands
```bash
# Check health endpoint
curl https://your-app.run.app/health

# View Cloud Run logs
gcloud run logs read transcribealpha --region us-central1

# Test deployment
gcloud run services describe transcribealpha --region us-central1
```

## Development Guidelines for AI Coding Agents
- **File Storage**: Cloud Storage for all files (transcription + preview), 12-hour cleanup via health endpoint
- **Frontend**: Next.js 14 + TypeScript + Tailwind CSS, static export for production
- **Import Pattern**: Multiple try/except blocks for different execution contexts
- **Cache Logic**: MD5 of (file + model + speakers) - include all transcription parameters
- **Error Handling**: Wrap Cloud Storage ops in try/catch, use HTTPException for API errors
- **Key Dependencies**: google-cloud-storage, hypercorn (HTTP/2), fastapi, next.js, tailwindcss
- **Build Process**: Multi-stage Docker (Node.js frontend build → Python backend)
- **Testing**: Verify both storage paths, frontend/backend integration, file size limits
- **Debug**: Check `/health`, verify ffmpeg, Cloud Storage permissions, CORS config, frontend build
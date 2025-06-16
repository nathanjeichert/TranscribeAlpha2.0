# TranscribeAlpha - Claude Code Documentation

## Project Overview

TranscribeAlpha is a legal transcript generation application that converts audio/video files into formatted legal transcripts using Google's Gemini 2.5 Pro model. The project consists of a FastAPI backend and a static HTML frontend, designed specifically for legal proceedings such as depositions.

## Architecture

### High-Level Structure
- **Type**: Web application with REST API backend
- **Frontend**: Static HTML/JavaScript served via FastAPI StaticFiles
- **Backend**: FastAPI with Google Gemini AI integration
- **Document Generation**: Word document (.docx) templates with placeholder replacement

### Directory Structure
```
TranscribeAlpha2.0/
├── README.md                    # Basic setup and running instructions
├── requirements.txt             # Python dependencies
├── packages.txt                # System dependencies (ffmpeg, libsndfile1)
├── transcript_template.docx     # Word template for output formatting
├── backend/
│   ├── server.py               # FastAPI application and API endpoints
│   └── transcriber.py          # Core transcription logic and AI integration
└── frontend/
    └── index.html              # Static HTML frontend
```

## Technology Stack

### Backend Dependencies (requirements.txt)
- **FastAPI**: Web framework for the REST API
- **uvicorn**: ASGI server for running FastAPI
- **google-genai**: Google Generative AI SDK for Gemini access
- **google-generativeai**: Additional Google AI library
- **python-docx**: Word document manipulation
- **ffmpeg-python**: Video/audio processing
- **pydub**: Audio file handling
- **python-multipart**: File upload support
- **pydantic**: Data validation and serialization

### System Dependencies (packages.txt)
- **ffmpeg**: Media conversion and processing
- **libsndfile1**: Audio file format support

### AI Model
- **Gemini 2.5 Pro Preview (06-05)**: Used for speech-to-text transcription with speaker diarization

## Key Components

### 1. FastAPI Server (`backend/server.py`)
- **Main endpoint**: `POST /api/transcribe`
- **Accepts**: Multipart form data with audio/video file and metadata
- **Returns**: JSON with transcript text and base64-encoded DOCX file
- **Static file serving**: Serves frontend from `/frontend/` directory
- **CORS**: Configured for all origins (development setup)

### 2. Transcription Engine (`backend/transcriber.py`)
- **Media processing**: Converts video to audio using ffmpeg
- **AI integration**: Uploads files to Gemini and generates structured transcripts
- **Document generation**: Creates formatted Word documents from templates
- **Speaker diarization**: Supports both automatic and manual speaker identification
- **Error handling**: Comprehensive error handling for media processing and AI calls

### 3. Frontend (`frontend/index.html`)
- **Form interface**: Collects case metadata and file upload
- **API integration**: Calls transcription endpoint via fetch API
- **Document download**: Provides direct download of generated DOCX files
- **Minimal styling**: Basic form styling with Arial font

## Key Features

### Audio/Video Support
- **Video formats**: mp4, mov, avi, mkv (converted to audio via ffmpeg)
- **Audio formats**: mp3, wav, m4a, flac, ogg, aac, aiff
- **Duration calculation**: Automatic media duration detection

### Transcript Generation
- **AI-powered**: Uses Gemini 2.5 Pro for accurate speech recognition
- **Speaker diarization**: Automatic speaker identification or manual speaker names
- **Legal formatting**: Structured as deposition-style transcripts
- **JSON output**: Structured data format for processing

### Document Processing
- **Template-based**: Uses Word template with placeholder replacement
- **Legal formatting**: Double-spaced, indented paragraphs with Courier New font
- **Metadata integration**: Case information, duration, and file details
- **Professional output**: Formatted for legal documentation standards

## Environment Setup

### Required Environment Variables
- `GEMINI_API_KEY`: Google Gemini API key (required)

### Development Setup
1. Install system dependencies: `ffmpeg` and `libsndfile1`
2. Install Python dependencies: `pip install -r requirements.txt`
3. Set Gemini API key: `export GEMINI_API_KEY="your_key_here"`
4. Run server: `uvicorn backend.server:app --reload`
5. Access at: `http://localhost:8000`

## Important Implementation Details

### FFmpeg Configuration
- **Windows-specific paths**: Hard-coded common Windows ffmpeg installation paths
- **Dynamic detection**: Uses `where` command and `shutil.which` for ffmpeg discovery
- **pydub integration**: Configures pydub with detected ffmpeg paths
- **Subprocess calls**: Direct ffmpeg/ffprobe subprocess execution for reliability

### Gemini AI Integration
- **File upload**: Uploads audio files to Gemini for processing
- **Processing wait**: Polls file status until ACTIVE before transcription
- **Safety settings**: Disabled all content filtering for legal content
- **Structured output**: Uses JSON schema validation for transcript format
- **Cleanup**: Automatically deletes uploaded files after processing

### Error Handling
- **Media conversion**: Graceful fallbacks for ffmpeg detection
- **AI processing**: Retry logic and validation for Gemini responses
- **File handling**: Temporary directories and proper cleanup
- **API errors**: Structured error responses with detailed logging

## Working with This Codebase

### Common Tasks
- **Add new audio/video formats**: Update `SUPPORTED_*_TYPES` lists in `transcriber.py`
- **Modify transcript formatting**: Edit the Word template or document generation logic
- **Enhance frontend**: Modify `frontend/index.html` for UI improvements
- **Add new endpoints**: Extend `backend/server.py` with additional API routes

### Testing Considerations
- No formal test suite currently exists
- Manual testing requires:
  - Valid Gemini API key
  - Sample audio/video files
  - Word template file in correct location

### Deployment Notes
- Requires system-level ffmpeg installation
- Environment variable for Gemini API key
- Consider security implications of CORS configuration for production
- Static file serving may need adjustment for production deployment

## Potential Areas for Enhancement
- Add automated testing suite
- Implement proper logging configuration
- Add input validation and file size limits
- Implement async processing for large files
- Add progress indicators for long transcriptions
- Consider containerization for deployment consistency
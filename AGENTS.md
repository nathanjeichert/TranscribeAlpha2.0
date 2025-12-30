# AGENTS.md

Instructions for AI coding agents (Claude Code, Cursor, Copilot, etc.) working on this repository.

## Project Overview

**TranscribeAlpha** is a legal transcript generation web application that converts audio/video files into professionally formatted legal transcripts.

| Component | Technology |
|-----------|------------|
| Backend | FastAPI (Python 3.x) |
| Frontend | Next.js 14 + TypeScript + Tailwind CSS |
| Transcription | AssemblyAI (slam-1) or Gemini 3.0 Pro |
| Timestamp Alignment | Rev AI Forced Alignment API |
| Deployment | Google Cloud Run + Cloud Storage |
| HTTP Server | Hypercorn (HTTP/2 support) |

## Codebase Architecture

```
TranscribeAlpha/
├── backend/                    # Python backend (FastAPI)
│   ├── server.py              # Main FastAPI app (~1400 lines)
│   │                          # - All API endpoints
│   │                          # - Cloud Storage operations
│   │                          # - Snapshot/session management
│   │                          # - Static file serving
│   ├── transcriber.py         # Transcription pipeline
│   │                          # - AssemblyAI integration
│   │                          # - DOCX generation
│   │                          # - OnCue XML generation
│   │                          # - ffmpeg media processing
│   ├── rev_ai_sync.py         # Rev AI forced alignment
│   │                          # - Initial transcription timestamp alignment
│   │                          # - Re-sync transcript with audio after edits
│   │                          # - Word-level timestamp correction
│   ├── auth.py                # JWT authentication
│   │                          # - Google Secret Manager integration
│   │                          # - User management
│   ├── templates/             # Word document templates
│   └── requirements.txt       # Python dependencies
│
├── frontend-next/             # Next.js frontend
│   ├── src/
│   │   ├── app/               # App Router (layout, page)
│   │   ├── components/        # React components
│   │   │   ├── TranscribeForm.tsx    # Main upload/transcribe UI
│   │   │   ├── TranscriptEditor.tsx  # Line-by-line editor
│   │   │   ├── ClipCreator.tsx       # Video clip extraction
│   │   │   ├── AuthProvider.tsx      # Auth context
│   │   │   └── LoginModal.tsx        # Login UI
│   │   └── utils/             # Utility functions
│   └── out/                   # Static export (production)
│
├── scripts/                   # Admin utility scripts
│   ├── add_user.sh           # Add user to Secret Manager
│   ├── list_users.sh         # List all users
│   └── remove_user.sh        # Remove user
│
├── main.py                    # Entry point (Hypercorn server)
├── Dockerfile                 # Multi-stage build
├── cloudbuild.yaml            # Cloud Build configuration
└── AGENTS.md                  # This file
```

## Key Design Decisions

### Why server.py is Large
The `server.py` file intentionally consolidates:
- All API endpoints in one place for easy navigation
- Cloud Storage operations close to the endpoints that use them
- Session/snapshot logic with the APIs that manage them

**Do not split this file** without explicit user request. The current structure works well for a single-service deployment.

### Module Responsibilities

| Module | Responsibility | Should Contain |
|--------|----------------|----------------|
| `server.py` | HTTP layer, routing, storage | Endpoints, request/response handling, GCS ops |
| `transcriber.py` | Core transcription logic | AI integration, document generation, media processing |
| `rev_ai_sync.py` | Forced alignment | Rev AI API calls, timestamp correction |
| `auth.py` | Authentication | JWT, Secret Manager, user verification |

### Transcription Pipeline

The transcription flow uses a two-stage process for optimal accuracy:

```
Audio/Video → ASR (AssemblyAI or Gemini) → Rev AI Alignment → DOCX/XML
```

1. **ASR Stage**: AssemblyAI or Gemini extracts text and speaker labels
2. **Alignment Stage**: Rev AI forced alignment provides accurate word-level timestamps
3. **Artifact Generation**: DOCX and OnCue XML generated with aligned timestamps

If `REV_AI_API_KEY` is not configured, native ASR timestamps are used as fallback.
The alignment step preserves original text (punctuation, capitalization) while only updating timestamps.

### Import Pattern
The codebase uses a multi-context import pattern to work in different execution contexts:
```python
try:
    from .module import func  # Package import
except ImportError:
    try:
        from module import func  # Direct import
    except ImportError:
        import module
        func = module.func  # Fallback
```
**Do not simplify** this pattern - it's necessary for Cloud Run deployment.

## API Endpoints Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/transcribe` | POST | Main transcription (file → DOCX + XML) |
| `/api/upload-preview` | POST | Upload media for preview |
| `/api/media/{file_id}` | GET | Stream media files |
| `/api/login` | POST | User authentication |
| `/api/save-session` | POST | Save editor session |
| `/api/load-session` | GET | Load editor session |
| `/api/resync` | POST | Re-align transcript with audio (Rev AI) |
| `/api/clips/*` | Various | Clip creation/management |
| `/health` | GET | Health check + cleanup trigger |

## Development Guidelines

### Before Making Changes
1. **Read relevant files first** - Understand the existing code before modifying
2. **Check for existing patterns** - Follow established conventions
3. **Avoid over-engineering** - Only add what's explicitly needed

### Code Style
- **Python**: Follow existing patterns (logging, error handling)
- **TypeScript**: Use existing component structure
- **No unnecessary abstractions** - Direct code is preferred
- **No premature optimization** - Working code first

### What to Avoid
- Creating new modules without explicit request
- Adding features beyond what was asked
- Refactoring unrelated code during a fix
- Adding extensive comments to existing code
- Creating documentation files unless requested

### Safe Refactoring Checklist
Before any refactor, verify:
- [ ] All existing tests pass (if any)
- [ ] `/health` endpoint responds correctly
- [ ] File upload → transcription flow works
- [ ] Editor save/load cycle works
- [ ] Media playback functions

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ASSEMBLYAI_API_KEY` | Yes* | AssemblyAI transcription |
| `GEMINI_API_KEY` | Yes* | Gemini transcription (alt: `GOOGLE_API_KEY`) |
| `REV_AI_API_KEY` | Recommended | Forced alignment for accurate timestamps |
| `JWT_SECRET_KEY` | For auth | Token signing |
| `GOOGLE_CLOUD_PROJECT` | For auth | Secret Manager access |
| `PORT` | No | Server port (default: 8080) |
| `ENVIRONMENT` | No | "production" for strict CORS |

*At least one transcription API key required (AssemblyAI or Gemini).

## Deployment

This app is designed for **Google Cloud Run only**.

```bash
# Deploy via Cloud Build (recommended)
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_ASSEMBLYAI_API_KEY=your_key

# Or direct deploy
gcloud run deploy transcribealpha \
  --source . \
  --platform managed \
  --region us-central1 \
  --port 8080 \
  --http2
```

## Common Tasks

### Add New API Endpoint
1. Add route handler in `backend/server.py`
2. Use existing patterns for error handling
3. Add authentication if needed: `current_user: dict = Depends(get_current_user)`

### Modify Transcript Formatting
- Edit `backend/transcriber.py`
- Functions: `create_docx()`, `generate_oncue_xml()`

### Update Frontend Component
- Edit files in `frontend-next/src/components/`
- Run `npm run build` in `frontend-next/` to regenerate static output

### Add User Management Script
- See existing scripts in `scripts/` for pattern
- Use `gcloud secrets` for Secret Manager operations

## Troubleshooting

| Issue | Solution |
|-------|----------|
| 502 errors | Check ffmpeg installation, memory limits |
| Import errors | Verify Python path setup in deployment |
| CORS errors | Check `ENVIRONMENT` variable |
| Auth failures | Verify `JWT_SECRET_KEY` and Secret Manager access |
| Large file upload fails | Ensure HTTP/2 is enabled |

## Testing Checklist

After any change, verify:
1. `curl https://your-app.run.app/health` returns 200
2. File upload completes without error
3. Transcript download works (DOCX + XML)
4. Editor loads and saves correctly
5. Media playback functions

---

*Last updated: 2025-12-30*

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
| Storage Model | Local-first (File System Access API + IndexedDB) |
| Deployment | Google Cloud Run (backend proxy) |
| HTTP Server | Hypercorn (HTTP/2 support) |

## App Variants

This codebase supports **two deployment variants** controlled by the `APP_VARIANT` environment variable:

| Variant | Value | Export Formats | Target Users |
|---------|-------|----------------|--------------|
| **OnCue** | `oncue` (default) | PDF + OnCue XML + HTML Viewer | Legal software integration |
| **Criminal** | `criminal` | PDF + HTML Viewer + OnCue XML | DA/PD offices |

**What differs between variants:**
- Export action priority/labeling (`oncue` emphasizes XML first; `criminal` emphasizes HTML viewer first)

**What stays the same:**
- All features (transcription, editor, Gemini refinement, Rev AI resync, clips, cases)
- Local workspace + IndexedDB persistence model
- PDF export formatting
- Branding ("TranscribeAlpha")
- Lines per page (25)

## Codebase Architecture

```
TranscribeAlpha/
├── backend/                    # Python backend (FastAPI)
│   ├── server.py              # FastAPI app wiring (routers, middleware, static files)
│   ├── config.py              # Env-driven constants (CORS, APP_VARIANT, environment)
│   ├── models.py              # Pydantic models (TranscriptTurn, WordTimestamp, Gemini structs)
│   ├── transcript_formatting.py # PDF/XML generation + line timing helpers
│   ├── transcript_utils.py    # Session serialization + viewer HTML generation
│   ├── word_legacy.py         # Deprecated Word/DOCX helpers (legacy import path)
│   ├── storage.py             # Temp upload helper for stateless endpoints
│   ├── gemini.py              # Gemini transcription + refine flow
│   ├── api/                   # FastAPI routers
│   │   ├── auth.py            # Auth endpoints
│   │   ├── transcripts.py     # Stateless ASR/refine/export/resync endpoints
│   │   └── health.py          # Health + cleanup endpoints
│   ├── viewer/                # HTML viewer module (shared by both variants)
│   │   ├── __init__.py        # render_viewer_html() function
│   │   └── template.html      # Standalone HTML viewer template
│   ├── transcriber.py         # AssemblyAI integration + media probing
│   ├── rev_ai_sync.py         # Rev AI forced alignment
│   ├── auth.py                # JWT authentication
│   ├── templates/             # Legacy Word templates (deprecated)
│   └── requirements.txt       # Python dependencies
│
├── frontend-next/             # Next.js frontend
│   ├── src/
│   │   ├── app/               # App Router
│   │   │   ├── layout.tsx           # Root layout (AuthProvider)
│   │   │   └── (dashboard)/         # Dashboard route group
│   │   │       ├── layout.tsx       # Dashboard layout with Sidebar
│   │   │       ├── page.tsx         # Dashboard home (quick-start)
│   │   │       ├── transcribe/      # Wizard transcription flow
│   │   │       ├── editor/          # Transcript editor (?key=)
│   │   │       ├── viewer/          # Transcript viewer + clips/sequences (?key=)
│   │   │       ├── converter/       # Local media converter
│   │   │       ├── cases/           # Cases list
│   │   │       ├── case-detail/     # Case detail page (?id=...)
│   │   │       └── settings/        # App settings
│   │   ├── components/        # React components
│   │   │   ├── TranscriptEditor.tsx  # Line-by-line editor
│   │   │   ├── MediaMissingBanner.tsx # Media re-import banner
│   │   │   ├── AuthProvider.tsx      # Auth context
│   │   │   ├── LoginModal.tsx        # Login UI
│   │   │   └── layout/              # Layout components
│   │   │       └── Sidebar.tsx      # Dashboard sidebar navigation
│   │   ├── context/           # React contexts
│   │   │   └── DashboardContext.tsx # Shared dashboard state
│   │   └── utils/             # Utility functions
│   └── out/                   # Static export (production)
│
├── scripts/                   # Admin utility scripts
│   ├── add_user.sh           # Add user to Secret Manager
│   ├── list_users.sh         # List all users
│   └── remove_user.sh        # Remove user
│
├── main.py                    # Entry point (Hypercorn server)
├── Dockerfile                 # Multi-stage build (accepts APP_VARIANT build arg)
├── cloudbuild-oncue.yaml      # Cloud Build for oncue variant
├── cloudbuild-criminal.yaml   # Cloud Build for criminal variant
└── AGENTS.md                  # This file
```

## Key Design Decisions

### App Variant System

The variant is determined at both build-time and runtime:

**Dockerfile:**
```dockerfile
ARG APP_VARIANT=oncue
ENV APP_VARIANT=${APP_VARIANT}
```

**config.py:**
```python
APP_VARIANT = os.getenv("APP_VARIANT", "oncue")
```

**API export logic (transcripts.py):**
```python
# Always generate both export formats
transcript_data["oncue_xml_base64"] = ...
transcript_data["viewer_html_base64"] = ...
```

**Frontend detection:**
- Frontend fetches `/api/config` on mount to determine variant
- Uses variant only to prioritize export actions/labels in UI

### HTML Viewer (Shared)

The HTML viewer (`backend/viewer/template.html`) is designed to match PDF transcript formatting for both variants:
- Font: Courier New 12pt
- Line spacing: 2.0 (double-spaced)
- First-line indent: 1 inch for speaker lines
- 25 lines per page
- Line-level timestamp highlighting (no word-level - edited transcripts only have line timestamps)

### Router-first HTTP layer
The HTTP layer is organized around routers under `backend/api/`, with `backend/server.py`
kept intentionally thin to wire middleware, include routers, and mount the static frontend.

### Module Responsibilities

| Module | Responsibility | Should Contain |
|--------|----------------|----------------|
| `server.py` | HTTP app wiring | Router inclusion, middleware, static mount |
| `backend/api/*.py` | HTTP layer | Endpoints and request/response handling |
| `transcriber.py` | Core transcription logic | AssemblyAI integration, media probing, transcription flow |
| `transcript_formatting.py` | Transcript rendering | PDF/XML generation, line timing rules |
| `transcript_utils.py` | Transcript/session helpers | Line normalization, export payload generation, viewer HTML generation |
| `storage.py` | Upload helper | Temporary file handling for stateless endpoints |
| `gemini.py` | Gemini flows | ASR and refinement logic |
| `rev_ai_sync.py` | Forced alignment | Rev AI API calls, timestamp correction |
| `auth.py` | Authentication | JWT, Secret Manager, user verification |
| `viewer/` | HTML viewer | Template rendering for shared viewer export |

### Transcription Pipeline

The transcription flow uses ASR timestamps first, with optional Rev AI alignment later:

```
Audio/Video → ASR (AssemblyAI or Gemini) → PDF + OnCue XML + HTML Viewer
                         ↘ Rev AI Alignment (re-sync only)
```

1. **ASR Stage**: AssemblyAI or Gemini extracts text + word timestamps
2. **Artifact Generation**: PDF + OnCue XML + HTML viewer generated from shared line entries
3. **Alignment Stage (optional)**: Rev AI forced alignment re-syncs edited transcripts

If `REV_AI_API_KEY` is not configured, re-sync is skipped.
The alignment step preserves original text (punctuation, capitalization) while only updating timestamps.

**Line timing rules**
- Generated line timestamps enforce a 1.25s minimum duration by expanding into adjacent gaps without overlap.
- User-edited line timings are preserved (minimum-duration enforcement is skipped during manual saves).

**Speaker label display**
- The editor shows a speaker label on every line for easy reassignment.
- PDF/XML outputs collapse consecutive identical speakers by omitting repeated labels (via `is_continuation`).

### Dashboard UI

The frontend uses a dashboard layout with a persistent sidebar:

**Route Structure:**
- `/` - Dashboard home (quick-start landing page)
- `/transcribe` - 3-step wizard flow (Upload → Configure → Transcribe)
- `/editor?key=` - Transcript editor (loads by media_key)
- `/viewer?key=` - Transcript viewer + clips/sequences tool
- `/converter` - Local media converter
- `/cases` - Cases list
- `/case-detail/?id=` - Case detail with transcript list
- `/settings` - App settings

**Key UI Patterns:**
- Collapsible sidebar with recent transcripts and cases
- Settings/tools tucked away in collapsible panels
- Clean header toolbars with primary actions visible
- Media player embedded in sidebar for editor/clip pages

### Cases System

Cases are folders for organizing transcripts:

**Storage Structure:**
```
cases/
  {case_id}/
    meta.json                     # Case metadata (name, description)
    transcripts/
      {media_key}.json            # Full transcript payload + exports
uncategorized/
  {media_key}.json                # Transcripts not assigned to a case
```

Media handles are persisted in IndexedDB and relinked via File System Access handles.
There is no backend TTL cleanup for cases, transcripts, or media.

**Case-Wide Search:**
- Searches across all transcripts in a case
- Matches text content and speaker names
- Returns results grouped by transcript

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
| `/api/config` | GET | Returns app variant and feature flags |
| `/api/viewer-template` | GET | Returns standalone HTML viewer template |
| `/api/convert` | POST | Stateless ffmpeg conversion to browser-playable media |
| `/api/format-pdf` | POST | Stateless PDF regeneration from line entries |
| `/api/transcribe` | POST | Main transcription (file → PDF + XML + HTML) |
| `/api/resync` | POST | Re-align transcript with audio (Rev AI, multipart) |
| `/api/gemini-refine` | POST | Gemini refinement pass (multipart) |
| `/api/auth/login` | POST | User authentication |
| `/api/auth/refresh` | POST | Refresh access token |
| `/api/auth/logout` | POST | Logout (client deletes tokens) |
| `/api/auth/me` | GET | Current user info |
| `/health` | GET | Health check |

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
| `APP_VARIANT` | No | `oncue` (default) or `criminal` |
| `ASSEMBLYAI_API_KEY` | Yes* | AssemblyAI transcription |
| `GEMINI_API_KEY` | Yes* | Gemini transcription (alt: `GOOGLE_API_KEY`) |
| `REV_AI_API_KEY` | Recommended | Forced alignment for accurate timestamps |
| `JWT_SECRET_KEY` | For auth | Token signing |
| `GOOGLE_CLOUD_PROJECT` | For auth | Secret Manager access |
| `PORT` | No | Server port (default: 8080) |
| `ENVIRONMENT` | No | "production" for strict CORS |

*At least one transcription API key required (AssemblyAI or Gemini).

## Deployment

This app is designed for **Google Cloud Run** with two separate deployments from the same codebase.

### Two Cloud Build Triggers

Set up two triggers in Google Cloud Console, each pointing to a different cloudbuild file:

| Trigger | Cloudbuild File | Service Name | APP_VARIANT |
|---------|-----------------|--------------|-------------|
| OnCue | `cloudbuild-oncue.yaml` | `transcribealpha-assemblyai` | `oncue` |
| Criminal | `cloudbuild-criminal.yaml` | `transcribealpha-criminal` | `criminal` |

### Manual Deployment

```bash
# Deploy oncue variant
gcloud builds submit --config cloudbuild-oncue.yaml \
  --substitutions=_ASSEMBLYAI_API_KEY=your_key

# Deploy criminal variant
gcloud builds submit --config cloudbuild-criminal.yaml \
  --substitutions=_ASSEMBLYAI_API_KEY=your_key
```

### Local Testing with Docker

```bash
# Build oncue variant
docker build --build-arg APP_VARIANT=oncue -t transcribealpha-oncue .

# Build criminal variant
docker build --build-arg APP_VARIANT=criminal -t transcribealpha-criminal .

# Run locally
docker run -p 8080:8080 \
  -e APP_VARIANT=oncue \
  -e ASSEMBLYAI_API_KEY=xxx \
  transcribealpha-oncue
```

## Common Tasks

### Add New API Endpoint
1. Add the route handler in the appropriate `backend/api/*.py` router
2. Use existing patterns for error handling
3. Add authentication if needed: `current_user: dict = Depends(get_current_user)`
4. If you add a new router module, include it in `backend/server.py`

### Modify Transcript Formatting
- Edit `backend/transcript_formatting.py`
- Functions: `create_pdf()`, `generate_oncue_xml_from_line_entries()`, `compute_transcript_line_entries()`

### Legacy Word Path (Deprecated)
- Word/DOCX logic is isolated in `backend/word_legacy.py`
- Deprecated behavior notes live in `docs/word-export-deprecated.md`
- New export changes should target the PDF pipeline, not DOCX generation

### Modify HTML Viewer
- Edit `backend/viewer/template.html`
- Viewer payload built in `backend/transcript_utils.py` → `build_viewer_payload()`

### Update Frontend Component
- Edit files in `frontend-next/src/components/`
- Run `npm run build` in `frontend-next/` to regenerate static output

### Add Variant-Specific Logic
```python
from config import APP_VARIANT

# Keep variant branching limited to export emphasis/default UI ordering.
primary_export = "xml" if APP_VARIANT == "oncue" else "viewer"
```

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
| Wrong export priority | Check `APP_VARIANT` env var and `/api/config` response |

## Testing Checklist

After any change, verify:
1. `curl https://your-app.run.app/health` returns 200
2. `curl https://your-app.run.app/api/config` returns correct variant
3. File upload completes without error
4. Transcript download works (PDF + XML + HTML viewer for both variants)
5. Editor loads and saves correctly
6. Media playback functions
7. Workspace gate appears when no local workspace is configured

---

*Last updated: 2026-02-09*

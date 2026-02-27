# AGENTS.md

Instructions for AI coding agents (Claude Code, Cursor, Copilot, etc.) working on this repository.

## Project Overview

**TranscribeAlpha** is a legal transcript generation web application that converts audio/video files into professionally formatted legal transcripts.

| Component | Technology |
|-----------|------------|
| Backend | FastAPI (Python 3.x) |
| Frontend | Next.js 14 + TypeScript + Tailwind CSS |
| Desktop App | Tauri v2 (Rust shell + Python sidecar via PyInstaller) |
| Transcription | AssemblyAI (slam-1) or Gemini 3.0 Pro |
| Timestamp Alignment | Rev AI Forced Alignment API |
| AI Investigation | Anthropic Claude API — Sonnet 4.6 (chat agent) + Haiku 4.5 (auto-summary) |
| Storage Model | Local-first (File System Access API + IndexedDB) |
| Deployment | Google Cloud Run (backend proxy), GitHub Actions (Tauri desktop releases) |
| HTTP Server | Hypercorn (HTTP/2 support) |

## Export Formats

All transcripts generate three export formats: PDF, OnCue XML, and HTML Viewer.

- **PDF** and **HTML Viewer** exports are always visible in the editor toolbar.
- **OnCue XML** export is gated by a user setting ("Enable OnCue XML Export") in Settings, off by default. The XML is always generated server-side regardless of this setting, so enabling it is retroactive for existing transcripts.
- The setting is stored in `localStorage` (`ta_oncue_xml_enabled`) and exposed via `DashboardContext`.

## Branch & Release Workflow

Use these branches consistently:

| Branch | Purpose | Deploy Expectation |
|--------|---------|--------------------|
| `main` | Production/live website source of truth | May trigger Cloud Build/Cloud Run deploys |
| `alpha` | Pre-live integration/testing branch | Should be safe for ongoing work not ready for production |

Agent commit/PR rules:
- Default all new work to the `alpha` branch unless explicitly told to target `main`.
- Do not open PRs directly to `main` unless the change is approved for live deployment.
- Promote changes with a deliberate PR from `alpha` to `main` after validation.
- Keep Cloud Build triggers scoped to `main` branch only to avoid build-cost churn from `alpha` commits.

## Codebase Architecture

```
TranscribeAlpha/
├── backend/                    # Python backend (FastAPI)
│   ├── server.py              # FastAPI app wiring (routers, middleware, static files)
│   ├── config.py              # Env-driven constants (CORS, environment)
│   ├── standalone_config.py   # Standalone (Tauri) config (API keys incl. anthropic_api_key)
│   ├── models.py              # Pydantic models (TranscriptTurn, WordTimestamp, Gemini structs)
│   ├── chat_agent.py          # Investigation agent loop (Sonnet + tools + SSE events)
│   ├── chat_tools.py          # Agent tool definitions + execution (list, search, read)
│   ├── chat_models.py         # Pydantic models for chat/summarize endpoints
│   ├── workspace_reader.py    # Reads transcript files from workspace (traversal-safe)
│   ├── transcript_formatting.py # PDF/XML generation + line timing helpers
│   ├── transcript_utils.py    # Session serialization + viewer HTML generation
│   ├── word_legacy.py         # Deprecated Word/DOCX helpers (legacy import path)
│   ├── storage.py             # Temp upload helper for stateless endpoints
│   ├── gemini.py              # Gemini transcription + refine flow
│   ├── api/                   # FastAPI routers
│   │   ├── auth.py            # Auth endpoints
│   │   ├── chat.py            # POST /api/chat — SSE streaming agent endpoint
│   │   ├── summarize.py       # POST /api/summarize — Haiku classification
│   │   ├── settings.py        # API key management (includes anthropic_api_key)
│   │   ├── transcripts.py     # Stateless ASR/refine/export/resync endpoints
│   │   └── health.py          # Health + cleanup endpoints
│   ├── viewer/                # HTML viewer module
│   │   ├── __init__.py        # render_viewer_html() function
│   │   └── template.html      # Standalone HTML viewer template
│   ├── transcriber.py         # AssemblyAI integration + media probing
│   ├── rev_ai_sync.py         # Rev AI forced alignment
│   ├── auth.py                # JWT authentication
│   ├── templates/             # Legacy Word templates (deprecated)
│   └── requirements.txt       # Python dependencies (includes anthropic>=0.42.0)
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
│   │   │       ├── case-detail/     # Case detail + Investigate tab
│   │   │       │   ├── page.tsx           # Tabbed layout (Transcripts | Investigate)
│   │   │       │   ├── InvestigateTab.tsx # AI chat container
│   │   │       │   ├── InvestigateFilterBar.tsx # Filter controls + pills
│   │   │       │   ├── ChatMessage.tsx    # User/assistant message rendering
│   │   │       │   └── CitationCard.tsx   # Clickable citation → viewer deep-link
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
│   │   ├── hooks/             # Custom React hooks
│   │   │   ├── useChat.ts           # Chat state + SSE stream consumption
│   │   │   ├── useChatHistory.ts    # Conversation persistence to workspace
│   │   │   └── useInvestigateFilters.ts # Filter state + available options
│   │   ├── lib/               # Shared utilities
│   │   │   ├── chatApi.ts           # API client for chat + summarize
│   │   │   ├── citationParser.ts    # [[CITE:...]] marker → TextSegment[]
│   │   │   └── storage.ts          # Workspace storage (includes EvidenceType, ai_summary)
│   │   └── utils/             # Utility functions
│   └── out/                   # Static export (production)
│
├── scripts/                   # Admin utility scripts
│   ├── add_user.sh           # Add user to Secret Manager
│   ├── list_users.sh         # List all users
│   ├── remove_user.sh        # Remove user
│   └── run_cloudrun_local.sh # Build/run local container with Cloud Run-like settings
│
├── main.py                    # Entry point (Hypercorn server)
├── Dockerfile                 # Multi-stage build
├── cloudbuild-criminal.yaml   # Cloud Build config
└── AGENTS.md                  # This file
```

## Key Design Decisions

### HTML Viewer

The HTML viewer (`backend/viewer/template.html`) is designed to match PDF transcript formatting:
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
| `chat_agent.py` | Investigation orchestrator | System prompt, agentic loop, streaming, citation parsing |
| `chat_tools.py` | Agent tool definitions | Tool schemas, execution dispatch, filter application |
| `chat_models.py` | Chat/summarize models | Pydantic request/filter models |
| `workspace_reader.py` | Workspace file access | Transcript metadata loading, search, page reading (traversal-safe) |
| `standalone_config.py` | Standalone config | API key storage for Tauri sidecar mode |

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

**Rev AI integration detail:** The alignment API requires both audio and transcript served as URLs (not inline text). The `/api/resync` endpoint writes cleaned transcript text to a temp file and serves it via `/api/resync-transcript/{token}`, matching the pattern used for media files.

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
- `/case-detail/?id=` - Case detail with transcript list + Investigate tab (Tauri only)
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
    chat_history.json             # Investigate conversation history (auto-persisted)
    transcripts/
      {media_key}.json            # Full transcript payload + exports + ai_summary + evidence_type
uncategorized/
  {media_key}.json                # Transcripts not assigned to a case
```

Media handles are persisted in IndexedDB and relinked via File System Access handles.
There is no backend TTL cleanup for cases, transcripts, or media.

**Case-Wide Search:**
- Searches across all transcripts in a case
- Matches text content and speaker names
- Returns results grouped by transcript

### AI-Powered Investigation Chat (Tauri Only)

The case-detail page has an "Investigate" tab (gated behind `isTauri()`) that provides an AI-powered chat interface for asking natural-language questions across all transcripts in a case. The AI agent uses Claude Sonnet with custom tools to search, read, and cite transcript content.

**This feature uses the Anthropic Python SDK (`anthropic`) with tool use — not the Agent SDK.** The backend implements a manual agentic loop.

#### Architecture

```
Frontend (Next.js in Tauri)          Backend (Python Sidecar :18080)
┌─────────────────────────┐          ┌──────────────────────────┐
│ InvestigateTab          │─── SSE ──│ POST /api/chat           │
│  ├─ InvestigateFilterBar│          │  └─ chat_agent.py        │
│  ├─ ChatMessage[]       │          │      ├─ list_transcripts │
│  ├─ CitationCard[]      │          │      ├─ search_text      │
│  └─ Input + Send        │          │      └─ read_transcript  │
│                         │          │                          │
│ Settings: API key input │── PUT ──→│ /api/settings/keys       │
│                         │          │                          │
│ After transcription:    │── POST ─→│ POST /api/summarize      │
│  (non-blocking)         │          │  └─ Haiku classification │
└─────────────────────────┘          └──────────────────────────┘
         │                                      │
         └── reads/writes workspace ────────────┘
              via X-Workspace-Path header
```

#### Models Used

| Model | Purpose | Cost Profile |
|-------|---------|-------------|
| `claude-sonnet-4-6` | Chat agent (tool use + streaming + adaptive thinking) | ~$3/$15 per 1M tokens |
| `claude-haiku-4-5` | Auto-summary + evidence type classification | ~$1/$5 per 1M tokens |

#### Data Flow: Auto-Summary After Transcription

After each successful transcription, the frontend fires a **non-blocking** POST to `/api/summarize`:

1. Frontend calls `summarizeTranscript()` in `useTranscriptionQueue.ts` (fire-and-forget, failure doesn't block)
2. Backend truncates transcript to first 3,000 characters
3. Haiku classifies with **structured output** (`output_config.format` with `json_schema`)
4. Returns `{ ai_summary: string, evidence_type: EvidenceType }`
5. Frontend merges `ai_summary` and `evidence_type` into the saved transcript JSON

Evidence types: `jail_call | 911_call | body_worn_camera | interrogation | deposition | other`

#### Data Flow: Chat Investigation

1. User types a question in the Investigate tab
2. `useChat` hook builds message history and POSTs to `/api/chat` with:
   - Conversation messages (truncated to last 20 for long chats)
   - `case_id`
   - Active user filters (evidence type, date range, speakers, location)
   - `X-Workspace-Path` header (from `getPlatformFS().getWorkspaceBasePath()`)
3. Backend validates API key + workspace path, loads transcript metadata from disk
4. `chat_agent.run_agent()` runs the agentic loop (max 10 iterations):
   - Builds system prompt with case context + transcript metadata summaries
   - Calls `client.messages.stream()` with Claude Sonnet 4.6, adaptive thinking, and 3 tool definitions
   - Streams text tokens as SSE `token` events
   - On `tool_use` stop reason: executes the tool, emits `tool_use` SSE event, feeds result back
   - On `end_turn`: parses `[[CITE:...]]` markers from response, emits `citation` events, then `done`
5. Frontend's `useChat` hook processes the SSE stream:
   - `token` events → accumulates into assistant message content
   - `tool_use` events → shows tool activity spinner ("Using search_text...")
   - `citation` events → stores citation metadata for enriching CitationCards
   - `done` events → records token usage
   - `error` events → displays error banner (with Settings link for API key errors)

#### SSE Event Protocol

The `/api/chat` endpoint returns `text/event-stream` with these event types:

```
event: token\ndata: {"text": "..."}\n\n
event: tool_use\ndata: {"tool": "search_text", "input": {...}}\n\n
event: citation\ndata: {"media_key": "...", "line_id": "...", "snippet": "...", "title": "...", "date": "..."}\n\n
event: done\ndata: {"input_tokens": N, "output_tokens": N}\n\n
event: error\ndata: {"message": "..."}\n\n
```

#### Agent Tools

The agent has three tools defined in `backend/chat_tools.py`:

| Tool | Purpose | Limits |
|------|---------|--------|
| `list_transcripts` | Returns metadata for all/filtered transcripts (title, date, evidence_type, speakers, summary, duration, line_count) | N/A |
| `search_text` | Case-insensitive keyword search across all transcript lines. Returns matching lines with 1 line of context before/after. | Default 20 results, max 50 |
| `read_transcript` | Reads a specific transcript by `media_key`. Supports page range or time range filtering. | Default first 5 pages, max 20 pages per call, 500 line hard cap for time ranges |

All tools receive `workspace_path`, `case_id`, and user-level filters as injected context (not agent-provided). Filters are applied server-side via `_apply_filters()` which handles evidence_type, date range, speaker, location, and transcript key filtering.

#### Citation System

1. The system prompt instructs the agent to format citations as: `[[CITE: media_key=abc123 line_id=3-5 snippet="exact quote"]]`
2. Backend `chat_agent.py` parses markers via regex (`CITE_PATTERN`) after the agent finishes, enriches them with transcript title/date from metadata, and emits `citation` SSE events
3. Frontend `citationParser.ts` has `splitTextAndCitations(text)` which splits agent text into alternating `TextSegment` objects (`{type: 'text', content}` and `{type: 'citation', citation}`)
4. `ChatMessage.tsx` renders text segments normally and citation segments as `CitationCard` components
5. `CitationCard.tsx` renders a clickable card that links to `/viewer?key={media_key}&case={case_id}&highlight={line_id}` using the existing viewer deep-link support (`queryHighlightLineId`)

#### Workspace Path Communication

The frontend sends the user's local workspace folder path via the `X-Workspace-Path` HTTP header on chat requests. The backend validates it with `validate_workspace_path()` (checks it's a real directory) and uses `_safe_subpath()` to prevent directory traversal attacks (verifies all resolved paths stay under the workspace root).

Transcript files are read from: `{workspace}/cases/{case_id}/transcripts/{media_key}.json`

#### User Filters

The Investigate tab includes a collapsible `InvestigateFilterBar` with:
- Evidence type: multi-select checkboxes (auto-populated from case transcripts)
- Date range: from/to date inputs
- Speakers: multi-select checkboxes (excludes generic "Speaker 1" etc. via `GENERIC_SPEAKER_PATTERN`)
- Location: dropdown (auto-populated from `title_data.LOCATION`)
- Active filters shown as dismissible pills with "Clear all" button

Filter state is managed by `useInvestigateFilters` hook, which derives available options from the transcript list. Active filters are sent with each chat request as `ChatFilters` and applied server-side before the agent sees any transcript data.

#### Conversation History

Managed by `useChatHistory` hook. Conversations are persisted to `cases/{case_id}/chat_history.json` in the workspace via the storage layer.

Structure: `{ conversations: [{ id, title, created_at, updated_at, messages }] }`

- Auto-saves after each complete assistant response
- Auto-titles from first user message (truncated to 60 chars)
- History dropdown in the Investigate tab header with "New conversation" button
- Delete conversation support
- Sorted by most recent first

#### Evidence Type Badge Editing

On the Transcripts tab of case-detail, each transcript card shows a colored evidence type badge. In Tauri mode, clicking the badge opens a dropdown to change the evidence type. The change is persisted immediately to the transcript JSON file. In web mode, the badge is display-only.

#### Backend Module Responsibilities

| Module | Responsibility |
|--------|----------------|
| `api/chat.py` | SSE endpoint — validates inputs, loads metadata, wires up `run_agent()` generator into `StreamingResponse` |
| `api/summarize.py` | Haiku classification endpoint — truncated transcript → structured JSON output |
| `chat_agent.py` | Orchestrator — system prompt template, agentic loop (stream → detect tool_use → execute → feed back → repeat), citation parsing, error handling |
| `chat_tools.py` | Tool definitions (Anthropic API format) + execution dispatch with filter application |
| `chat_models.py` | Pydantic models: `ChatRequest`, `ChatFilters`, `ChatMessageModel` |
| `workspace_reader.py` | Reads transcript JSONs from workspace with directory traversal prevention. Functions: `list_case_transcript_metadata`, `search_transcript_lines`, `read_transcript_pages` |

#### Frontend Module Responsibilities

| Module | Responsibility |
|--------|----------------|
| `lib/chatApi.ts` | API client — `summarizeTranscript()` for summary, `streamChat()` returns `ReadableStream<SSEEvent>` from SSE response |
| `lib/citationParser.ts` | Parses `[[CITE:...]]` markers into structured `TextSegment[]` for rendering |
| `hooks/useChat.ts` | Chat state management — messages array, streaming state, SSE consumption, abort support |
| `hooks/useChatHistory.ts` | Conversation persistence to workspace JSON files |
| `hooks/useInvestigateFilters.ts` | Filter state + available option computation from transcript metadata |
| `case-detail/InvestigateTab.tsx` | Main container — chat UI, filter bar, history dropdown, starter questions, input area |
| `case-detail/ChatMessage.tsx` | Message rendering — user bubbles, assistant text with inline citations, tool activity spinner, typing indicator |
| `case-detail/CitationCard.tsx` | Clickable citation card with title, date, snippet, and "View in transcript" link |
| `case-detail/InvestigateFilterBar.tsx` | Collapsible filter controls with active filter pills |

#### Error Handling

| Scenario | Behavior |
|----------|----------|
| Missing Anthropic API key | SSE `error` event: "Anthropic API key not configured. Add it in Settings." Error banner includes Settings link. |
| Invalid/missing workspace path | SSE `error` event, 400 status |
| Anthropic `AuthenticationError` | SSE `error`: "Invalid Anthropic API key. Check your key in Settings." |
| Anthropic `RateLimitError` | SSE `error`: "Rate limited by Anthropic. Please wait a moment and try again." |
| Anthropic 500+ errors | SSE `error`: "Anthropic API is temporarily unavailable." |
| Tool execution failure | Caught, returned as JSON `{"error": "..."}` tool result — agent can retry or explain |
| Summary failure after transcription | Non-blocking, transcript saved without `ai_summary`/`evidence_type` fields (backward-compatible) |
| Chat history corruption | Caught, starts fresh, logs warning |
| Stream abort (user cancels) | `AbortController.abort()` — stream closes cleanly |

#### Cost Efficiency Measures

- System prompt includes transcript summaries (~200 tokens each) instead of full text
- Agent strategy: `list_transcripts` first → `search_text` for keywords → `read_transcript` for context
- `read_transcript` caps at 20 pages per call to prevent context blowout
- Haiku for summaries (~$0.001/transcript), Sonnet for chat
- Conversation messages truncated to last 20 for long chats

#### API Key Storage

The Anthropic API key is stored alongside other API keys in the standalone config system:
- `backend/standalone_config.py` — `anthropic_api_key` in `DEFAULT_CONFIG`
- `backend/api/settings.py` — included in the managed keys list for `/api/settings/keys`
- `frontend-next/src/app/(dashboard)/settings/page.tsx` — Anthropic API Key input field in the API Keys section (Tauri only)

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
| `/api/config` | GET | Returns enabled feature flags |
| `/api/viewer-template` | GET | Returns standalone HTML viewer template |
| `/api/convert` | POST | Stateless ffmpeg conversion to browser-playable media |
| `/api/format-pdf` | POST | Stateless PDF regeneration from line entries |
| `/api/transcribe` | POST | Main transcription (file → PDF + XML + HTML) |
| `/api/resync` | POST | Re-align transcript with audio (Rev AI, multipart) |
| `/api/gemini-refine` | POST | Gemini refinement pass (multipart) |
| `/api/summarize` | POST | AI summary + evidence type classification (Haiku) |
| `/api/chat` | POST | Agentic chat SSE stream (Sonnet + tools) |
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
| `ASSEMBLYAI_API_KEY` | Yes* | AssemblyAI transcription |
| `GEMINI_API_KEY` | Yes* | Gemini transcription (alt: `GOOGLE_API_KEY`) |
| `REV_AI_API_KEY` | Recommended | Forced alignment for accurate timestamps |
| `ANTHROPIC_API_KEY` | For Investigate | Anthropic API (chat agent + auto-summary). In Tauri mode, stored in standalone config via Settings page. |
| `JWT_SECRET_KEY` | For auth | Token signing |
| `GOOGLE_CLOUD_PROJECT` | For auth | Secret Manager access |
| `PORT` | No | Server port (default: 8080) |
| `ENVIRONMENT` | No | "production" for strict CORS |

*At least one transcription API key required (AssemblyAI or Gemini).

## Deployment

This app is designed for **Google Cloud Run**.

### Cloud Build

A single Cloud Build trigger deploys from the `main` branch using `cloudbuild-criminal.yaml`:

| Cloudbuild File | Service Name |
|-----------------|--------------|
| `cloudbuild-criminal.yaml` | `transcribealpha-criminal` |

Important trigger configuration:
- Restrict trigger branch filters to `^main$`.
- Do not auto-deploy from `alpha`.

### Manual Deployment

```bash
gcloud builds submit --config cloudbuild-criminal.yaml \
  --substitutions=_ASSEMBLYAI_API_KEY=your_key
```

### Local Testing with Docker (Cloud Run Parity)

Preferred one-command path:

```bash
cp .env.cloudrun.example .env.cloudrun.local
./scripts/run_cloudrun_local.sh
```

This helper script:
- Builds from the same `Dockerfile` used for Cloud Run
- Uses Cloud Run-like runtime settings (`ENVIRONMENT=production`, `PORT=8080`, `HOST=0.0.0.0`)
- Applies Cloud Run-like container limits (`--cpus=1`, `--memory=2g`)

Manual fallback:

```bash
docker build -t transcribealpha .
docker run --rm -it -p 8080:8080 \
  --cpus=1 --memory=2g \
  -e ENVIRONMENT=production \
  -e PORT=8080 \
  -e HOST=0.0.0.0 \
  --env-file .env.cloudrun.local \
  transcribealpha
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
| OnCue XML not showing | Check "Enable OnCue XML Export" setting in Settings page |

## Testing Checklist

After any change, verify:
1. `curl https://your-app.run.app/health` returns 200
2. `curl https://your-app.run.app/api/config` returns feature flags
3. File upload completes without error
4. Transcript download works (PDF + HTML viewer; XML when setting is enabled)
5. Editor loads and saves correctly
6. Media playback functions
7. Workspace gate appears when no local workspace is configured

---

*Last updated: 2026-02-27*

import logging
import os
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Add current directory and backend directory to path
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.insert(0, current_dir)
sys.path.insert(0, parent_dir)

try:
    from .config import ALLOWED_ORIGINS, APP_VARIANT
except ImportError:
    try:
        from config import ALLOWED_ORIGINS, APP_VARIANT
    except ImportError:
        import config as config_module
        ALLOWED_ORIGINS = config_module.ALLOWED_ORIGINS
        APP_VARIANT = config_module.APP_VARIANT

try:
    from .storage import cleanup_expired_clip_sessions, cleanup_old_files
except ImportError:
    try:
        from storage import cleanup_expired_clip_sessions, cleanup_old_files
    except ImportError:
        import storage as storage_module
        cleanup_expired_clip_sessions = storage_module.cleanup_expired_clip_sessions
        cleanup_old_files = storage_module.cleanup_old_files

try:
    from .api.auth import router as auth_router
except ImportError:
    try:
        from api.auth import router as auth_router
    except ImportError:
        import api.auth as auth_module
        auth_router = auth_module.router

try:
    from .api.transcripts import router as transcripts_router
except ImportError:
    try:
        from api.transcripts import router as transcripts_router
    except ImportError:
        import api.transcripts as transcripts_module
        transcripts_router = transcripts_module.router

try:
    from .api.clips import router as clips_router
except ImportError:
    try:
        from api.clips import router as clips_router
    except ImportError:
        import api.clips as clips_module
        clips_router = clips_module.router

try:
    from .api.media import router as media_router
except ImportError:
    try:
        from api.media import router as media_router
    except ImportError:
        import api.media as media_module
        media_router = media_module.router

try:
    from .api.health import router as health_router
except ImportError:
    try:
        from api.health import router as health_router
    except ImportError:
        import api.health as health_module
        health_router = health_module.router

try:
    from .api.cases import router as cases_router
except ImportError:
    try:
        from api.cases import router as cases_router
    except ImportError:
        import api.cases as cases_module
        cases_router = cases_module.router


app = FastAPI(
    title="TranscribeAlpha API",
    description="Professional Legal Transcript Generator using AssemblyAI",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event():
    """Run cleanup on startup and log Cloud Storage status."""
    if APP_VARIANT == "criminal":
        logger.info("Starting TranscribeAlpha in criminal (local-first) mode — skipping GCS cleanup")
    else:
        logger.info("Starting TranscribeAlpha with Cloud Storage enabled")
        cleanup_old_files()
        cleanup_expired_clip_sessions()


app.include_router(auth_router)
app.include_router(transcripts_router)
app.include_router(health_router)

# Only mount cases, clips, media routers for non-criminal variant
if APP_VARIANT != "criminal":
    app.include_router(cases_router)
    app.include_router(clips_router)
    app.include_router(media_router)

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

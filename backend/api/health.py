import logging
import os
from datetime import datetime, timedelta

from fastapi import APIRouter

try:
    from ..config import APP_VARIANT
except ImportError:
    try:
        from config import APP_VARIANT
    except ImportError:
        import config as config_module
        APP_VARIANT = config_module.APP_VARIANT

try:
    from ..storage import cleanup_expired_clip_sessions, cleanup_old_files
except ImportError:
    try:
        from storage import cleanup_expired_clip_sessions, cleanup_old_files
    except ImportError:
        import storage as storage_module
        cleanup_expired_clip_sessions = storage_module.cleanup_expired_clip_sessions
        cleanup_old_files = storage_module.cleanup_old_files

router = APIRouter()
logger = logging.getLogger(__name__)

# Track last cleanup time for periodic cleanup
last_cleanup_time = datetime.now()


@router.get("/health")
async def health_check():
    """Health check endpoint for deployment platforms"""
    global last_cleanup_time

    # Skip cleanup for criminal variant (nothing stored in GCS)
    if APP_VARIANT != "criminal":
        # Run cleanup every 12 hours
        current_time = datetime.now()
        if current_time - last_cleanup_time > timedelta(hours=12):
            try:
                cleanup_old_files()
                cleanup_expired_clip_sessions()
                last_cleanup_time = current_time
                logger.info("Periodic cleanup completed via health check")
            except Exception as e:
                logger.error("Periodic cleanup failed: %s", str(e))

    return {
        "status": "healthy",
        "service": "TranscribeAlpha",
        "assemblyai_api_key_configured": bool(os.getenv("ASSEMBLYAI_API_KEY")),
        "last_cleanup": last_cleanup_time.isoformat(),
    }

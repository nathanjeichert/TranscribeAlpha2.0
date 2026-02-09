import os

from fastapi import APIRouter

try:
    from ..config import APP_VARIANT
except ImportError:
    from config import APP_VARIANT

router = APIRouter()


@router.get("/health")
async def health_check():
    """Health check endpoint for deployment platforms."""
    return {
        "status": "healthy",
        "service": "TranscribeAlpha",
        "variant": APP_VARIANT,
        "assemblyai_api_key_configured": bool(os.getenv("ASSEMBLYAI_API_KEY")),
    }

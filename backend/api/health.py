import os

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health_check():
    """Health check endpoint for deployment platforms."""
    return {
        "status": "healthy",
        "service": "TranscribeAlpha",
        "assemblyai_api_key_configured": bool(os.getenv("ASSEMBLYAI_API_KEY")),
    }

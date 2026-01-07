import os

# Environment-based CORS configuration
ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
ALLOWED_ORIGINS = ["*"] if ENVIRONMENT == "development" else [
    "https://transcribealpha-*.cloudfunctions.net",
    "https://transcribealpha-*.appspot.com",
    "https://transcribealpha-*.run.app",
    # Add your production domains here
]

# Cloud Storage configuration
BUCKET_NAME = "transcribealpha-uploads-1750110926"

# Default transcript layout configuration
DEFAULT_LINES_PER_PAGE = 25

# Session / cleanup configuration
EDITOR_SESSION_TTL_DAYS = int(os.getenv("EDITOR_SESSION_TTL_DAYS", "7"))
CLIP_SESSION_PREFIX = "clip_sessions/"
CLIP_SESSION_TTL_DAYS = int(os.getenv("CLIP_SESSION_TTL_DAYS", str(EDITOR_SESSION_TTL_DAYS)))
SNAPSHOT_TTL_DAYS = int(os.getenv("SNAPSHOT_TTL_DAYS", "14"))
MEDIA_TTL_DAYS = int(os.getenv("MEDIA_TTL_DAYS", "1"))
MEDIA_CLEANUP_PREFIXES = ("preview_", "clip_", "raw_")

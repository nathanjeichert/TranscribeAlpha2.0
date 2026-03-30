import os

ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
STANDALONE_MODE = os.getenv("STANDALONE_MODE", "").lower() in ("true", "1", "yes")


def is_standalone_mode() -> bool:
    return STANDALONE_MODE

STANDALONE_ALLOWED_ORIGINS = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]

ALLOWED_ORIGINS = ["*"] if ENVIRONMENT == "development" else (
    STANDALONE_ALLOWED_ORIGINS if STANDALONE_MODE else [
    "https://transcribealpha-*.cloudfunctions.net",
    "https://transcribealpha-*.appspot.com",
    "https://transcribealpha-*.run.app",
]
)

DEFAULT_LINES_PER_PAGE = 25

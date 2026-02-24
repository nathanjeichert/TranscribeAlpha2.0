import os

ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
STANDALONE_MODE = os.getenv("STANDALONE_MODE", "").lower() in ("true", "1", "yes")

ALLOWED_ORIGINS = ["*"] if (ENVIRONMENT == "development" or STANDALONE_MODE) else [
    "https://transcribealpha-*.cloudfunctions.net",
    "https://transcribealpha-*.appspot.com",
    "https://transcribealpha-*.run.app",
]

DEFAULT_LINES_PER_PAGE = 25

import os

# App variant configuration
# "oncue" and "criminal" now share the same local-first data architecture.
APP_VARIANT = os.getenv("APP_VARIANT", "oncue")

ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
ALLOWED_ORIGINS = ["*"] if ENVIRONMENT == "development" else [
    "https://transcribealpha-*.cloudfunctions.net",
    "https://transcribealpha-*.appspot.com",
    "https://transcribealpha-*.run.app",
]

DEFAULT_LINES_PER_PAGE = 25

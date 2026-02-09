import asyncio
import logging
import os
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.insert(0, current_dir)
sys.path.insert(0, parent_dir)

try:
    from .config import ALLOWED_ORIGINS
except ImportError:
    from config import ALLOWED_ORIGINS

try:
    from .api.auth import router as auth_router
except ImportError:
    from api.auth import router as auth_router

try:
    from .api.transcripts import router as transcripts_router
except ImportError:
    from api.transcripts import router as transcripts_router

try:
    from .api.health import router as health_router
except ImportError:
    from api.health import router as health_router


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

app.include_router(auth_router)
app.include_router(transcripts_router)
app.include_router(health_router)

frontend_candidates = [
    os.path.join(os.path.dirname(__file__), "..", "frontend"),
    os.path.join(os.path.dirname(__file__), "..", "frontend-next", "out"),
]
mounted_frontend = False
for candidate in frontend_candidates:
    if os.path.isdir(candidate):
        app.mount("/", StaticFiles(directory=candidate, html=True), name="frontend")
        mounted_frontend = True
        break

if not mounted_frontend:
    logger.warning("No static frontend directory found; skipping root static mount")


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    host = os.getenv("HOST", "0.0.0.0")

    import hypercorn.asyncio
    import hypercorn.config

    config = hypercorn.config.Config()
    config.bind = [f"{host}:{port}"]
    config.application_path = "backend.server:app"
    config.h2 = True

    asyncio.run(hypercorn.asyncio.serve(app, config))

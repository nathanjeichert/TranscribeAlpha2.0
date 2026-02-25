#!/usr/bin/env python3
"""
Standalone entry point for the TranscribeAlpha Tauri sidecar server.
Runs on port 18080 with STANDALONE_MODE enabled.
"""

import asyncio
import logging
import os
import sys

# Set standalone mode before any other imports
os.environ.setdefault("STANDALONE_MODE", "true")
os.environ.setdefault("PORT", "18080")
os.environ.setdefault("HOST", "127.0.0.1")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Resolve paths for PyInstaller frozen exe
if getattr(sys, "frozen", False):
    # Running as compiled exe - sys._MEIPASS is the temp bundle dir
    bundle_dir = sys._MEIPASS
    app_dir = os.path.dirname(sys.executable)
else:
    bundle_dir = os.path.dirname(os.path.abspath(__file__))
    app_dir = os.path.dirname(bundle_dir)

sys.path.insert(0, bundle_dir)
sys.path.insert(0, app_dir)

logger.info("TranscribeAlpha sidecar starting (standalone mode)")
logger.info("Bundle dir: %s", bundle_dir)

try:
    from server import app
    logger.info("Imported app from server")
except ImportError:
    try:
        from backend.server import app
        logger.info("Imported app from backend.server")
    except ImportError as e:
        logger.error("Could not import app: %s", e)
        sys.exit(1)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 18080))
    host = os.environ.get("HOST", "127.0.0.1")
    logger.info("Listening on %s:%d", host, port)

    import uvicorn

    uvicorn.run(app, host=host, port=port, log_level="info")

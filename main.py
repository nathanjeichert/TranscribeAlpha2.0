#!/usr/bin/env python3
"""
Main entry point for TranscribeAlpha application.
This file provides a direct import path for deployment platforms.

Build trigger: 2026-01-26
"""

import sys
import os
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

logger.info("TranscribeAlpha starting up")

# Ensure we can import from current directory and backend
current_dir = os.path.dirname(os.path.abspath(__file__))
backend_dir = os.path.join(current_dir, 'backend')

sys.path.insert(0, current_dir)
sys.path.insert(0, backend_dir)

# Import the app
try:
    from backend.server import app
    logger.info("Imported app from backend.server")
except ImportError as e:
    logger.warning("Failed to import from backend.server: %s", e)
    try:
        os.chdir(backend_dir)
        sys.path.insert(0, backend_dir)
        from server import app
        logger.info("Imported app from server")
    except ImportError as e2:
        logger.error("Failed to import app: %s, %s", e, e2)
        raise ImportError(f"Could not import app: {e}, {e2}")

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    host = os.getenv("HOST", "0.0.0.0")
    logger.info("Starting server on %s:%d", host, port)

    import hypercorn.asyncio
    import hypercorn.config
    import asyncio

    config = hypercorn.config.Config()
    config.bind = [f"{host}:{port}"]
    config.h2 = True

    asyncio.run(hypercorn.asyncio.serve(app, config))
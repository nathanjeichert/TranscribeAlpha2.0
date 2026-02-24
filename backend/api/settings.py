"""
Settings API for standalone (Tauri desktop) mode.
Allows users to manage API keys via the settings page.
"""

import logging
import os
from typing import Dict

from fastapi import APIRouter, Body, HTTPException

logger = logging.getLogger(__name__)

router = APIRouter()


def _is_standalone() -> bool:
    return os.getenv("STANDALONE_MODE", "").lower() in ("true", "1", "yes")


@router.get("/api/settings/keys")
async def get_api_keys():
    """Get current API key configuration (values are masked)."""
    if not _is_standalone():
        raise HTTPException(status_code=404, detail="Not available")

    try:
        from standalone_config import load_config
    except ImportError:
        from ..standalone_config import load_config

    config = load_config()

    # Return masked keys (only show last 4 chars)
    masked = {}
    for key, value in config.items():
        if key.endswith("_api_key") and value:
            masked[key] = "****" + value[-4:] if len(value) > 4 else "****"
            masked[f"{key}_configured"] = True
        elif key.endswith("_api_key"):
            masked[key] = ""
            masked[f"{key}_configured"] = False
        else:
            masked[key] = value

    return masked


@router.put("/api/settings/keys")
async def update_api_keys(keys: Dict = Body(...)):
    """Update API key configuration."""
    if not _is_standalone():
        raise HTTPException(status_code=404, detail="Not available")

    try:
        from standalone_config import load_config, save_config
    except ImportError:
        from ..standalone_config import load_config, save_config

    config = load_config()

    # Only update keys that are provided and not masked placeholders
    for key in ["assemblyai_api_key", "gemini_api_key", "rev_ai_api_key"]:
        if key in keys:
            value = keys[key].strip()
            # Don't overwrite with masked value
            if value and not value.startswith("****"):
                config[key] = value
            elif not value:
                config[key] = ""

    save_config(config)

    logger.info("API keys updated via settings endpoint")
    return {"status": "ok"}

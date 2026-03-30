"""
Settings API for standalone (Tauri desktop) mode.
Allows users to manage API keys via the settings page.
"""

import logging
from typing import Dict

from fastapi import APIRouter, Body, HTTPException, Request

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/settings/keys")
async def get_api_keys(request: Request):
    """Get current API key configuration (values are masked)."""
    try:
        from config import is_standalone_mode
    except ImportError:
        from ..config import is_standalone_mode
    if not is_standalone_mode():
        raise HTTPException(status_code=404, detail="Not available")

    try:
        from auth import require_standalone_session
    except ImportError:
        from ..auth import require_standalone_session

    require_standalone_session(request)

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
async def update_api_keys(request: Request, keys: Dict = Body(...)):
    """Update API key configuration."""
    try:
        from config import is_standalone_mode
    except ImportError:
        from ..config import is_standalone_mode
    if not is_standalone_mode():
        raise HTTPException(status_code=404, detail="Not available")

    try:
        from auth import require_standalone_session
    except ImportError:
        from ..auth import require_standalone_session

    require_standalone_session(request)

    try:
        from standalone_config import load_config, save_config
    except ImportError:
        from ..standalone_config import load_config, save_config

    config = load_config()

    # Only update keys that are provided and not masked placeholders
    for key in ["assemblyai_api_key", "gemini_api_key", "rev_ai_api_key", "anthropic_api_key"]:
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

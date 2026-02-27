"""
Standalone configuration for Tauri desktop mode.
Reads/writes API keys from a local config file (~/.transcribealpha/config.json).
"""

import json
import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

CONFIG_DIR = Path.home() / ".transcribealpha"
CONFIG_FILE = CONFIG_DIR / "config.json"

DEFAULT_CONFIG = {
    "assemblyai_api_key": "",
    "gemini_api_key": "",
    "rev_ai_api_key": "",
    "anthropic_api_key": "",
}


def _ensure_config_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def load_config() -> dict:
    """Load the local config file, returning defaults if it doesn't exist."""
    try:
        if CONFIG_FILE.exists():
            with open(CONFIG_FILE, "r") as f:
                data = json.load(f)
            # Merge with defaults to handle newly added keys
            merged = {**DEFAULT_CONFIG, **data}
            return merged
    except Exception as e:
        logger.warning("Failed to load standalone config: %s", e)
    return dict(DEFAULT_CONFIG)


def save_config(data: dict) -> None:
    """Save configuration to the local config file."""
    _ensure_config_dir()
    # Only save known keys
    filtered = {k: data.get(k, v) for k, v in DEFAULT_CONFIG.items()}
    with open(CONFIG_FILE, "w") as f:
        json.dump(filtered, f, indent=2)
    logger.info("Standalone config saved to %s", CONFIG_FILE)


def get_api_key(key_name: str) -> Optional[str]:
    """
    Get an API key. In standalone mode, reads from local config.
    Falls back to environment variable if not set in config.
    """
    standalone = os.getenv("STANDALONE_MODE", "").lower() in ("true", "1", "yes")
    if standalone:
        config = load_config()
        value = config.get(key_name, "").strip()
        if value:
            return value
    # Fall back to environment variable
    env_name = key_name.upper()
    return os.getenv(env_name) or None

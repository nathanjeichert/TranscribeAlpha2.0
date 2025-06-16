#!/usr/bin/env python3
"""
Main entry point for TranscribeAlpha application.
This file provides a direct import path for deployment platforms.
"""

from backend.server import app

if __name__ == "__main__":
    import uvicorn
    import os
    
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
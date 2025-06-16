#!/usr/bin/env python3
"""
Main entry point for TranscribeAlpha application.
This file provides a direct import path for deployment platforms.
"""

import sys
import os

# Add the current directory to Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from backend.server import app
except ImportError:
    # Fallback - try adding backend to path
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend'))
    from server import app

if __name__ == "__main__":
    import uvicorn
    
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
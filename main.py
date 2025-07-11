#!/usr/bin/env python3
"""
Main entry point for TranscribeAlpha application.
This file provides a direct import path for deployment platforms.
"""

import sys
import os

# Ensure we can import from current directory and backend
current_dir = os.path.dirname(os.path.abspath(__file__))
backend_dir = os.path.join(current_dir, 'backend')

sys.path.insert(0, current_dir)
sys.path.insert(0, backend_dir)

# Import the app
try:
    from backend.server import app
    print("Successfully imported app from backend.server")
except ImportError as e:
    print(f"Failed to import from backend.server: {e}")
    try:
        # Change to backend directory and import
        os.chdir(backend_dir)
        sys.path.insert(0, backend_dir)
        from server import app
        print("Successfully imported app from server")
    except ImportError as e2:
        print(f"Failed to import from server: {e2}")
        raise ImportError(f"Could not import app: {e}, {e2}")

if __name__ == "__main__":
    # Cloud Run uses PORT environment variable, defaults to 8080
    port = int(os.getenv("PORT", 8080))
    host = os.getenv("HOST", "0.0.0.0")
    print(f"Starting server on {host}:{port}")
    
    # Use Hypercorn for HTTP/2 support on Cloud Run
    import hypercorn.asyncio
    import hypercorn.config
    import asyncio
    
    config = hypercorn.config.Config()
    config.bind = [f"{host}:{port}"]
    
    # Enable HTTP/2 support
    config.h2 = True
    
    # Run the server
    asyncio.run(hypercorn.asyncio.serve(app, config))
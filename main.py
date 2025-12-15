#!/usr/bin/env python3
"""
Main entry point for TranscribeAlpha application.
This file provides a direct import path for deployment platforms.
"""

import sys
import os
import traceback

print("=== TranscribeAlpha Startup ===")
print(f"Python version: {sys.version}")
print(f"Working directory: {os.getcwd()}")

# Ensure we can import from current directory and backend
current_dir = os.path.dirname(os.path.abspath(__file__))
backend_dir = os.path.join(current_dir, 'backend')

print(f"Current dir: {current_dir}")
print(f"Backend dir: {backend_dir}")
print(f"Backend exists: {os.path.exists(backend_dir)}")

sys.path.insert(0, current_dir)
sys.path.insert(0, backend_dir)

# Test critical imports first
print("Testing critical imports...")
try:
    import bcrypt
    print(f"bcrypt imported OK: {bcrypt.__version__ if hasattr(bcrypt, '__version__') else 'version unknown'}")
except Exception as e:
    print(f"bcrypt import FAILED: {e}")
    traceback.print_exc()

try:
    from jose import jwt
    print("python-jose imported OK")
except Exception as e:
    print(f"python-jose import FAILED: {e}")
    traceback.print_exc()

try:
    from google.cloud import secretmanager
    print("google-cloud-secret-manager imported OK")
except Exception as e:
    print(f"google-cloud-secret-manager import FAILED: {e}")
    traceback.print_exc()

# Import the app
print("Importing app...")
try:
    from backend.server import app
    print("Successfully imported app from backend.server")
except ImportError as e:
    print(f"Failed to import from backend.server: {e}")
    traceback.print_exc()
    try:
        # Change to backend directory and import
        os.chdir(backend_dir)
        sys.path.insert(0, backend_dir)
        from server import app
        print("Successfully imported app from server")
    except ImportError as e2:
        print(f"Failed to import from server: {e2}")
        traceback.print_exc()
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
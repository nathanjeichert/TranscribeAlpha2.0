# PyInstaller spec for TranscribeAlpha sidecar server
# Run from repo root: pyinstaller backend/sidecar.spec
# Set TAURI_TRIPLE env var to override the target triple, e.g.:
#   TAURI_TRIPLE=aarch64-apple-darwin pyinstaller backend/sidecar.spec

import os
import platform
import sys
from pathlib import Path

block_cipher = None
root = Path(SPECPATH).parent  # repo root

# Determine Tauri-compatible target triple
_triple = os.environ.get("TAURI_TRIPLE")
if not _triple:
    _machine = platform.machine().lower()
    _system = platform.system()
    if _system == "Windows":
        _triple = "x86_64-pc-windows-msvc"
    elif _system == "Darwin":
        _arch = "aarch64" if _machine == "arm64" else "x86_64"
        _triple = f"{_arch}-apple-darwin"
    else:
        _triple = "x86_64-unknown-linux-gnu"

a = Analysis(
    [str(root / "backend" / "sidecar_main.py")],
    pathex=[str(root), str(root / "backend")],
    binaries=[],
    datas=[
        # Include backend Python source files so relative imports work
        (str(root / "backend"), "backend"),
    ],
    hiddenimports=[
        "uvicorn",
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "fastapi",
        "fastapi.middleware.cors",
        "fastapi.staticfiles",
        "starlette",
        "starlette.routing",
        "starlette.middleware",
        "starlette.middleware.cors",
        "starlette.formparsers",
        "multipart",
        "multipart.multipart",
        "multipart.decoders",
        "multipart.exceptions",
        "pydantic",
        "pydantic.v1",
        "anyio",
        "anyio._backends._asyncio",
        "asyncio",
        "email.mime.multipart",
        "email.mime.text",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name=f"transcribealpha-server-{_triple}",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # console=True so logs are visible; set False for silent
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

#!/usr/bin/env bash
# update-desktop.sh — Pulls latest main, rebuilds the Tauri desktop app.
# Run from the repo root: bash scripts/update-desktop.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
FRONTEND_DIR="$REPO_ROOT/frontend-next"
BINARIES_DIR="$FRONTEND_DIR/src-tauri/binaries"

SKIP_PYTHON=false
SKIP_INSTALL=false
for arg in "$@"; do
  case "$arg" in
    --skip-python) SKIP_PYTHON=true ;;
    --skip-install) SKIP_INSTALL=true ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

log() { echo -e "\033[36m[update-desktop]\033[0m $1"; }
die() { echo -e "\033[31m[ERROR]\033[0m $1"; exit 1; }

# Detect target triple
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) TRIPLE="aarch64-apple-darwin" ;;
  x86_64) TRIPLE="x86_64-apple-darwin" ;;
  *) die "Unsupported architecture: $ARCH" ;;
esac

# ── 1. Pull latest main ──────────────────────────────────────────────────────
log "Pulling latest from origin/main..."
cd "$REPO_ROOT"
BEFORE=$(git rev-parse HEAD)
git fetch origin main
git reset --hard origin/main
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  log "Already up to date ($AFTER). Nothing changed — skipping rebuild."
  exit 0
fi
log "Updated $BEFORE -> $AFTER"

# ── 2. Python sidecar ────────────────────────────────────────────────────────
if [ "$SKIP_PYTHON" = false ]; then
  log "Installing Python requirements..."
  pip install -r requirements.txt --quiet

  log "Building Python sidecar with PyInstaller..."
  mkdir -p "$BINARIES_DIR"
  TAURI_TRIPLE="$TRIPLE" pyinstaller backend/sidecar.spec \
    --distpath "$BINARIES_DIR" \
    --workpath "$REPO_ROOT/.pyinstaller-build" \
    --noconfirm

  SIDECAR="$BINARIES_DIR/transcribealpha-server-$TRIPLE"
  if [ ! -f "$SIDECAR" ]; then
    die "PyInstaller did not produce $SIDECAR"
  fi
  log "Python sidecar built: $SIDECAR"
fi

# ── 3. FFmpeg sidecar ────────────────────────────────────────────────────────
FFMPEG_DST="$BINARIES_DIR/ffmpeg-$TRIPLE"
if [ ! -f "$FFMPEG_DST" ]; then
  log "FFmpeg sidecar not found — downloading..."
  if ! command -v 7z &> /dev/null; then
    log "Installing p7zip via Homebrew..."
    brew install p7zip
  fi
  curl -L -o /tmp/ffmpeg.7z "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/7z"
  7z x /tmp/ffmpeg.7z -o/tmp/ffmpeg-extract -y
  cp /tmp/ffmpeg-extract/ffmpeg "$FFMPEG_DST"
  chmod +x "$FFMPEG_DST"
  log "FFmpeg sidecar ready: $FFMPEG_DST"
else
  log "FFmpeg sidecar already present — skipping download."
fi

# ── 4. npm install ────────────────────────────────────────────────────────────
log "Running npm install..."
cd "$FRONTEND_DIR"
npm install

# ── 5. Tauri build ────────────────────────────────────────────────────────────
log "Building Tauri app (this takes a few minutes)..."
npm run tauri:build -- --target "$TRIPLE"

# ── 6. Open bundle directory ──────────────────────────────────────────────────
if [ "$SKIP_INSTALL" = false ]; then
  BUNDLE_DIR="$FRONTEND_DIR/src-tauri/target/$TRIPLE/release/bundle"
  if [ -d "$BUNDLE_DIR" ]; then
    log "Opening bundle directory..."
    open "$BUNDLE_DIR"
  else
    log "Bundle directory not found at $BUNDLE_DIR — check build output."
  fi
fi

log "Done!"

#!/usr/bin/env bash
# Speaker Match tester: bulk-name speakers across a TranscribeAlpha case by voice.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Setting up Python environment (first run only)..."
  python3.11 -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r ../../requirements.txt -r requirements.txt
fi
(sleep 2 && open "http://127.0.0.1:8765") &
exec .venv/bin/python app.py

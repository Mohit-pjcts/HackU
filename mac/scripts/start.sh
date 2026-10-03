#!/usr/bin/env bash
# One command for everything: the panel (http://127.0.0.1:3000) and the overlay (menu bar), together.
#   bash scripts/start.sh            normal: the overlay never appears in screenshots or screen recordings
#   bash scripts/start.sh --record   recording a demo: cursors, widgets and drawings show up in screen recordings
# Ctrl+C stops both. Running it again first stops a copy that is already running.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
PORT="${PORT:-3000}"
REC=""; [[ "${1:-}" == "--record" ]] && REC="--record"
APP="overlay/build/Backstage Overlay.app"

# stop what's already running (an old panel on the port, the overlay)
lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
pkill -f "Backstage Overlay.app/Contents/MacOS/BackstageOverlay" 2>/dev/null || true
sleep 0.5

# build the overlay only if it's missing or older than its source (a rebuild is a new app to macOS unless signed)
if [[ ! -x "$APP/Contents/MacOS/BackstageOverlay" || overlay/Overlay.swift -nt "$APP/Contents/MacOS/BackstageOverlay" ]]; then
  bash scripts/build-overlay.sh
fi

stop() { pkill -f "Backstage Overlay.app/Contents/MacOS/BackstageOverlay" 2>/dev/null; kill "$PANEL" 2>/dev/null; exit 0; }
trap stop INT TERM

OVERLAY=off PORT="$PORT" bun run src/main.ts &
PANEL=$!
sleep 2
open -g "$APP" --args --port "$PORT" $REC
[[ -n "$REC" ]] && echo "recording mode: the overlay shows up in screen recordings"
echo "panel: http://127.0.0.1:$PORT   (Ctrl+C stops the panel and the overlay)"
wait "$PANEL"
stop

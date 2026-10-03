#!/usr/bin/env bash
# Backstage: start the right engine for this computer.
#   macOS:   bash start.sh            (or: bash start.sh --record, to record a demo video)
#   Windows: powershell -ExecutionPolicy Bypass -File start.ps1
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -s)" in
  Darwin) exec bash "$ROOT/mac/scripts/start.sh" "$@" ;;
  *) echo "This is the macOS launcher. On Windows run:  powershell -ExecutionPolicy Bypass -File start.ps1"; exit 1 ;;
esac

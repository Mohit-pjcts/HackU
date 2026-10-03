#!/usr/bin/env bash
# (Re)start the Cua Driver daemon the way this project needs it:
#  - CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=300  -> actions wait 300 ms instead of 1000 ms for new windows
#  - it MUST be started like this by us: `cua-driver mcp` would auto-start it WITHOUT this variable
# Run it after granting permissions (a grant only takes effect after a restart) and whenever clicks feel slow.
set -u
cua-driver stop >/dev/null 2>&1 || true
pkill -f 'CuaDriver.app/Contents/MacOS/cua-driver' 2>/dev/null || true
sleep 1
open -n -g --env CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=300 -a CuaDriver --args serve
for i in $(seq 1 20); do
  if cua-driver permissions status 2>&1 | grep -q "Accessibility:.*granted"; then
    echo "daemon up, tuned (window-change timeout 300 ms)"; cua-driver permissions status; exit 0
  fi
  sleep 1
done
echo "daemon did not report granted permissions. Run: cua-driver permissions grant   (then re-run this script)"; exit 1

#!/usr/bin/env bash
# Put the Mac in a known state before running the test prompts (docs/TEST-PROMPTS.md):
#  - fresh test folders with loose files to sort (so Finder tasks never find "nothing to sort")
#  - the test apps open, with their windows restored if minimised (agents only use windows on this desktop)
# Optional: --minimise-calculator minimises Calculator afterwards, to show that an agent restores it.
set -u
ROOT="$HOME/backstage-test"

reset_folder() { # folder, files...
  local dir="$1"; shift
  rm -rf "$dir"; mkdir -p "$dir"
  for f in "$@"; do printf 'dummy test file\n' > "$dir/$f"; done
}
reset_folder "$ROOT/by-type" "Lecture 3 slides.pdf" "Assignment 2.pdf" "Receipt Sept.pdf" "team photo.png" \
  "screenshot 2026-10-02.png" "logo.jpg" "notes.txt" "todo.txt" "budget.csv" "pitch draft.docx"
reset_folder "$ROOT/by-name" "Lecture 3 slides.pdf" "Lecture 4 notes.pdf" "Assignment 2.pdf" "Assignment 3 brief.docx" \
  "Receipt Sept.pdf" "Receipt taxi.png" "team photo.png"
echo "test folders reset: $ROOT/by-type (10 files), $ROOT/by-name (7 files)"

FRONT=$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>/dev/null)
for app in Calculator Safari Finder; do
  open -g -a "$app"
  sleep 0.5
  osascript -e "tell application \"System Events\" to tell process \"$app\"
    repeat with w in (every window whose value of attribute \"AXMinimized\" is true)
      set value of attribute \"AXMinimized\" of w to false
    end repeat
  end tell" >/dev/null 2>&1 || true
done
[ -n "$FRONT" ] && osascript -e "tell application \"$FRONT\" to activate" >/dev/null 2>&1 || true
echo "Calculator, Safari and Finder open, windows restored"

if [[ "${1:-}" == "--minimise-calculator" ]]; then
  sleep 1
  osascript -e 'tell application "System Events" to tell process "Calculator" to set value of attribute "AXMinimized" of window 1 to true' >/dev/null 2>&1 \
    && echo "Calculator minimised on purpose (prompt 1 should restore it)"
fi

cua-driver permissions status 2>&1 | grep -q "Accessibility:.*granted" && echo "Cua Driver: ok" \
  || echo "Cua Driver not ready: run  bash scripts/daemon.sh"

#!/usr/bin/env bash
# Build the explain-mode overlay (overlay/Overlay.swift) into a small menu-bar app:
#   overlay/build/Backstage Overlay.app
# A real app bundle is needed so macOS can ask for Microphone + Speech Recognition permission (hold ⌃⌥ to talk), and
# Screen Recording (the live previews of the agents' windows in their widgets).
# The bundle is signed ad hoc; after a rebuild macOS may ask for those permissions again.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="overlay/build/Backstage Overlay.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -swift-version 5 overlay/Overlay.swift -o "$APP/Contents/MacOS/BackstageOverlay" \
  -framework AppKit -framework AVFoundation -framework Speech -framework NaturalLanguage -framework ScreenCaptureKit
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.backstage.overlay</string>
  <key>CFBundleName</key><string>Backstage Overlay</string>
  <key>CFBundleExecutable</key><string>BackstageOverlay</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Backstage listens only while you hold Control + Option, to hear your question.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Backstage turns your spoken question into text, on this Mac.</string>
</dict>
</plist>
PLIST
# Sign with a stable identity, so macOS keeps the permissions (Screen Recording, Microphone, Speech) across
# rebuilds: with an ad-hoc signature every build is a new app to macOS and the old grant silently stops applying.
# `bash scripts/make-signing-identity.sh` creates "Backstage Local Signing" (a local certificate, once per Mac).
ID="${BACKSTAGE_SIGN_ID:-Backstage Local Signing}"
if security find-identity -p codesigning 2>/dev/null | grep -q "\"$ID\""; then
  codesign --force --sign "$ID" "$APP" >/dev/null 2>&1 && echo "signed with \"$ID\" (permissions survive rebuilds)"
else
  codesign --force --sign - "$APP" >/dev/null
  echo "signed ad hoc: macOS will ask for its permissions again after every rebuild (run scripts/make-signing-identity.sh once)"
fi
echo "built: $APP"

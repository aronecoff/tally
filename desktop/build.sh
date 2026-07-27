#!/bin/bash
# Build/refresh the native macOS Tally.app (WKWebView wrapper, no Chrome) into
# ~/Applications and refresh the Dock. Re-run after editing desktop/Tally.swift.
# Fully reproducible from a fresh clone: the bundle's Info.plist and Tally.icns
# are versioned here in desktop/ and installed on every build. Regenerate the
# icns after a logo change with scripts/icons.mjs + sips/iconutil.
set -e
APP="$HOME/Applications/Tally.app"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$DIR/desktop/Info.plist" "$APP/Contents/Info.plist"
cp "$DIR/desktop/Tally.icns" "$APP/Contents/Resources/Tally.icns"
swiftc -O -o "$APP/Contents/MacOS/Tally" "$DIR/desktop/Tally.swift" \
  -framework Cocoa -framework WebKit
touch "$APP"
killall Dock 2>/dev/null || true
echo "Built native app → $APP"

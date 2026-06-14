#!/bin/bash
# Rebuild the native macOS Tally.app (WKWebView wrapper, no Chrome) into
# ~/Applications and refresh the Dock. Re-run after editing desktop/Tally.swift.
# The bundle's Info.plist and Tally.icns are created once during initial setup;
# this just recompiles the binary in place.
set -e
APP="$HOME/Applications/Tally.app"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -o "$APP/Contents/MacOS/Tally" "$DIR/desktop/Tally.swift" \
  -framework Cocoa -framework WebKit
touch "$APP"
killall Dock 2>/dev/null || true
echo "Built native app → $APP"

#!/bin/sh
# The smoke tests, in a simulator, from a fresh install. They drive the real app, so they
# take a few minutes. DEVICE names another simulator.
set -eu
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
DEVICE="${DEVICE:-iPhone 18 Pro}"

npm run build:public
xcrun simctl boot "$DEVICE" 2>/dev/null || true
xcrun simctl uninstall "$DEVICE" com.aronecoff.plainsum
# A failure has twice left this waiting for good, on `simctl diagnose` and on a snapshot of
# the screen. The last two lines stop both.
xcodebuild test -project ios/Tally.xcodeproj -scheme Plainsum \
  -destination "platform=iOS Simulator,name=$DEVICE" -derivedDataPath ios/build/ui-tests \
  -collect-test-diagnostics never \
  -test-timeouts-enabled YES -default-test-execution-time-allowance 300

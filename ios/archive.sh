#!/bin/sh
# What goes to App Store Connect: a fresh web bundle with a fresh build number, an archive,
# and the checks on what came out. Xcode's Organizer opens the result for upload. Anything
# after `--` goes to xcodebuild, so `npm run archive:public -- CODE_SIGNING_ALLOWED=NO`
# makes one with no signing, to look at.
set -eu
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
ARCHIVE=ios/build/Plainsum.xcarchive

npm run build:public
rm -rf "$ARCHIVE"
xcodebuild archive -project ios/Tally.xcodeproj -scheme Plainsum -destination generic/platform=iOS \
  -archivePath "$ARCHIVE" -allowProvisioningUpdates "$@"
node scripts/verify-store-build.mjs "$ARCHIVE"

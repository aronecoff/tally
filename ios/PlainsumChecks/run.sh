#!/bin/sh
# Compiles the scheme handler, the allowlist, the bank link, the lock and the alerts' record with their checks,
# for this Mac. Vault.swift is left out: the Keychain it uses needs a signed app.
set -eu
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
xcrun --sdk macosx swiftc -swift-version 5 -o "$OUT/checks" \
  PlainsumChecks/main.swift Plainsum/AppSchemeHandler.swift Plainsum/Allowlist.swift \
  Plainsum/SimpleFINClient.swift Plainsum/FirstLaunch.swift Plainsum/Erase.swift \
  Shared/Backups.swift Shared/PageOrigin.swift Shared/LockMachine.swift Shared/AlertBook.swift \
  WidgetData/WidgetSnapshot.swift
"$OUT/checks"

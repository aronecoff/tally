# Tally — native iOS app

A thin native wrapper: a full-screen `WKWebView` (Apple WebKit) that loads the
deployed Tally PWA (`https://aronecoff.github.io/tally/`). Same app and same
synced ledger as the Mac app and the browser — sign in once and it all matches.
Its own home-screen icon, own process, persistent storage (your session + data
survive between launches).

Mirrors `desktop/Tally.swift` (the macOS wrapper) for iPhone/iPad.

## Run it on your iPhone (⌘R)

1. Open **`ios/Tally.xcodeproj`** in Xcode.
2. Select the **Tally** target → **Signing & Capabilities** → set **Team** to your
   Apple ID (add it under Xcode → Settings → Accounts if it's not there).
   Automatic signing will provision it. If the bundle id `com.aronecoff.tally`
   is taken, change it to something unique.
3. Plug in your iPhone via USB (or same-network wireless). Pick it as the run
   destination in the toolbar (top, next to the scheme).
4. Press **⌘R**. First run: on the phone, go to **Settings → General → VPN &
   Device Management → [your Apple ID] → Trust**, then relaunch the app.
5. In the app, tap the **cloud icon** → sign in with the **same email + password
   as the Mac** → your accounts, transactions, and budgets sync down.

## Free vs paid Apple account

- **Free Apple ID:** works, but the build **expires after 7 days** — just ⌘R
  again to refresh it (data persists; it's signed, not wiped).
- **Apple Developer Program ($99/yr):** builds don't expire; also required for
  TestFlight / App Store.

## Validate without a device (no signing)

```sh
xcodebuild -project ios/Tally.xcodeproj -scheme Tally \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  build CODE_SIGNING_ALLOWED=NO
```

## Notes

- The project uses Xcode's file-system-synchronized folder format — just drop new
  `.swift` files into `ios/Tally/` and they're picked up automatically.
- App icon: `ios/Tally/Assets.xcassets/AppIcon.appiconset/icon-1024.png`
  (generated from `public/icon.svg`).
- The wrapper tags its user agent `TallyNative` so the web app hides the
  "Add to Home Screen" hint inside the app.
- Safe areas (notch / home indicator) are handled by the web app's CSS
  (`viewport-fit=cover` + `env(safe-area-inset-*)`); the WKWebView runs
  edge-to-edge with `contentInsetAdjustmentBehavior = .never`.

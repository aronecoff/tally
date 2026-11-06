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

## The bridge to the page

`Tally/TallyBridge.swift` answers the page's calls through one handler, `tally`.
Only the main frame of the app's own page, in the app's own web view, is answered:
a connect portal's popup and any iframe are refused. `Shared/` holds what both apps
do the same way (backups in `Documents/Backups`, the share sheet, haptics, Add expense),
and is a member of both targets. In a browser and in the Mac app the page finds no handler and does
without it.

## The lock

Both apps run `Shared/AppLock.swift` the same way: Face ID or the passcode, and a
cover that keeps figures out of the app switcher. The cover is always on. The lock
starts off, and the page's only part is the setting (`src/lib/appLock.ts`). Nothing in
the page is gated by it.

`Shared/LockMachine.swift` decides when to ask and when to cover, and touches neither
UIKit nor the clock, so `npm run test:swift` walks it through what the system does.
Four rules there are worth keeping:

- The prompt moves the scene too, so only a launch, a trip to the background or a
  long absence may start a prompt. A cancelled prompt leaves the cover and its Unlock
  button, and never asks again by itself.
- Time away is measured on a clock that keeps counting while the phone sleeps. A
  launch always locks, so nothing about it needs saving.
- Inactive is not away. Control Center and permission alerts only make the scene
  inactive, so they relock after a minute whatever the setting says.
- With no passcode on the device there is nothing to ask, so the app opens. Anything
  else that stops the prompt stays covered.

The cover is its own window above the app's, so it is above portals, share sheets and
alerts too. To drive the prompt in a simulator:

```sh
xcrun simctl spawn booted notifyutil -s com.apple.BiometricKit.enrollmentChanged 1
xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit.enrollmentChanged
xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit_Sim.pearl.match   # or .nomatch
```

To try a local build of the page in a simulator, launch a Debug build with
`SIMCTL_CHILD_TALLY_WEB_URL=http://localhost:5180/tally/ xcrun simctl launch …`.
A Release build has no way to load anything but the live site.

## The alerts

Both apps run `Shared/BudgetAlerts.swift` the same way, and both start with everything
off. The system prompt shows the first time a switch in Settings turns on, and at no other
time. Local notifications need no entitlement.

`src/lib/budgetAlerts.ts` reads the rows Home reads, runs them through Home's own
`src/lib/homeFigures.ts`, and words each alert. Swift never sees a ledger: `alerts.post`
carries finished text, and `Shared/AlertBook.swift` only keeps the settings and which
alerts have gone, in `UserDefaults.standard`, so Erase clears it and no backup carries it.

Rules worth keeping:

- A category or the month fires at 80% and at 100%, once each per month. `<key>-<month>-<line>`
  is the id. Past both at once, only the higher is said and the lower is marked with it, so
  a refund that drops back under cannot bring the lower one out later.
- 100% means reached. A fixed bill landing on its budget is the expected outcome, so a
  fixed bill only ever says it went over.
- Turning budget alerts on starts from what is true now. What has already crossed goes
  with the change in `seen`, and is marked before the setting counts as on.
- More than three at once read as one alert.
- With the app lock on, an alert names no category and shows no figure, because it can
  land over the lock's cover. A page that cannot read the lock says less, not more.

The page only runs while the app is open, so a budget alert goes out when the app sees the
figures, not when the money moves: about a second and a half after a change, or on leaving.
Most of them land with the app in front, where the system drops a notification unless the
delegate asks for it, so the delegate is set from the App's init. Only the weekly reminder
fires by itself. It is a repeating calendar trigger, put back at each launch because
pending requests do not move to a new phone with the app's settings.

To try one in a simulator, tap Allow on the prompt, then add a transaction that crosses a
line. `simctl privacy` has no service for notifications. If they were refused, the
simulator's Settings has no Notifications page at its root, so `Open Settings` stops there:
the switch is under Apps, then the app's name, then Notifications.

## Haptics

`Shared/Haptics.swift` plays three kinds through UIKit's feedback generators, and the page
asks with `haptic.play` (`src/lib/haptics.ts`). Only those generators, because they are
what follows System Haptics. There is no setting in the app.

A haptic marks a change that landed, so it comes after the write. A Save with nothing to
save, the first tap on Delete and a write that failed all stay still.

## Add expense

`Shared/AddExpenseIntent.swift` is an App Intent, so Siri, Shortcuts and Spotlight can open
the add sheet with the amount and note filled in. It needs no entitlement. It writes
nothing: a row only exists once someone taps Add, through the same form as any other.

The ask waits in `AddExpenseInbox`, in memory, until the page takes it with
`addExpense.take`. A launch can run the intent before the web view exists, so the page asks
as it starts. A page already up is nudged with a bare event, which carries nothing, so the
figures only cross the bridge that checks who is calling.

It opens its own sheet over whatever is open, so a half-made edit underneath survives.
With the lock on, it waits behind the cover like everything else. Phrases use
`.applicationName`, so a rename needs no change here.

The system reads the intent at build time and the tile appears in the Shortcuts app under
the app's name, so that is the way to try it in a simulator. Siri itself needs a device.

## The widgets

Both apps have a "Left to spend" widget: small and medium on the Home Screen,
rectangular, circular and inline on the Lock Screen. Each app has its own extension and
its own App Group (`group.` and the app's bundle id), so the two never see each other's
figures. `Widgets/` is the code both extensions share, and `WidgetData/` is also in both
apps, because the app writes what the widget reads.

The widget works nothing out. `src/lib/widgetSnapshot.ts` reads the rows Home reads,
runs them through Home's own `src/lib/homeFigures.ts`, and hands over the formatted hero
through `widget.publish`. Swift keeps the fields it knows, writes them to `snapshot.json`
in the group and reloads the timeline. The page publishes when the app opens, about a
second and a half after a change, and on leaving if anything is different.

The app only runs while it is open, so the figures age where they sit. `WidgetFace` says
what to show as they do, and the timeline holds each moment that changes it:

- The same day says `Updated 3:12 PM`, and later days say the date.
- After 48 hours the figure stays but dims, and the state word gives way to
  `Open <name> to update`.
- A new month shows no figure at all, because last month's means nothing.
- With no budget it says `Set a budget in <name>`.

The figures are totals only, and `.privacySensitive()` hides them on a locked phone. The
app lock does not cover a widget: someone who adds one has chosen to see it.

Colors come from `src/styles/tokens.css`, and `src/styles/widgetPalette.test.ts` holds
`Widgets/Palette.swift` to them. `InstrumentSerif-Regular.ttf` is the web bundle's font
as a TTF, which is what iOS can load. The iOS 27 simulator lays a gradient of its own
over a dark widget, so the canvas reads lighter there than `#09090B`.

To try a state in a simulator, write `snapshot.json` into the group
(`xcrun simctl get_app_container booted <bundle id> <group id>`) and install the app
again, which reloads the widget. Opening the app replaces the file.

A device build needs `com.aronecoff.tally.widgets`, `com.aronecoff.plainsum.widgets` and
`group.com.aronecoff.tally` registered first, which changes the Apple account. A
simulator build does not.

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

---

# Plainsum — the public iOS app

The same project holds a second target, **Plainsum** (`com.aronecoff.plainsum`,
iPhone only). The Tally target above does not change. Plainsum does not load a
website: the web app ships inside it and is served from `plainsum://app` by
`AppSchemeHandler`, so it opens with no network. `Allowlist.swift` is the one table
of everything the app may open, and external links go to Safari. The page's CSP
stops it reaching anything but its own origin.

## Rename it

The name is written once, in `ios/PublicApp.xcconfig`. Change that line, rebuild the
web bundle and the app, and the Home Screen name, the Face ID prompt, the native
failure line and every string in the web app follow. The bundle id, the
`plainsum://` scheme and the storage keys are never shown, so they stay.

## Build it

Xcode does not run npm, so build the web bundle first:

```sh
npm run build:public
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project ios/Tally.xcodeproj -scheme Plainsum -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' build
```

The "Embed web bundle" phase copies `dist-public` into the app as `Web/`, and fails
if the folder is missing, if `scripts/verify-public-bundle.mjs` has not stamped it, if
the stamp names anything but `PUBLIC_APP_NAME`, as it does after a rename until the web
bundle is built again, or if the folder no longer hashes to its stamp, as it does when
anything changes after the gate ran. No generated web file enters the repo.

A device build needs `com.aronecoff.plainsum` and `group.com.aronecoff.plainsum`
registered first, which changes the Apple account. A simulator build does not.

## The bank link

SimpleFIN runs on the phone. `NativeBridge` is the one door between the page and the
app: it refuses anything but the main frame of `plainsum://app`, and nothing it
offers returns the access URL. `SimpleFINClient` does the HTTP and nothing else,
`Vault` keeps the access URL in the Keychain, and `FirstLaunch` clears what a
deleted install left there. What an answer means is decided in the web app, in
`src/lib/simplefinNormalize.ts`.

Three limits matter, because SimpleFIN can disable a token that goes past them:

- 24 requests a day. `RequestBudget` enforces it in Swift, where the page cannot
  skip it. At the cap the app answers 429 and sends nothing.
- 90 days a request, also enforced in Swift. Past 45 days the answer carries a
  warning that the app would have to show on every pull, so the page asks for 44
  (`src/flavor/public/bankTransport.ts`). A request with no end date counts to a day
  past now, which is why it is 44 and not 45.
- Four automatic pulls a day, by the 6-hour floor in `src/lib/banks.ts`.

A pull is one request. A first link reads the history once, and a long absence reads
the days it missed. A line in SimpleFIN's `errors` holds back only the catch-up for
the connection that is down: pulls stay at one request, and the first clean answer
reads on. A request that provably never left the phone is not counted. A timeout is.

The window moves every day, so a pull cannot tell a row the bank dropped from one
that has only fallen out of reach. `bankTransport.ts` sends `reconcileFrom` with
each answer, 8 days inside the oldest window that answered in full, and
`src/lib/banks.ts` retires nothing older. A hold is the exception, because a hold
that is no longer listed is gone.

The same days are where a transfer's other leg may have just fallen off the feed, and
a lone `DEPOSIT` would read as income for good. So `bankTransport.ts` also sends
`edgeTo`, 8 days inside the oldest window it read, and rows no rule can name stay out
of the ledger before it. Each pull reaches 22 days past the last one, so a new row
always starts clear of those days.

`version=1` is pinned. Left out, the server chooses, and protocol 2 drops the `org`
that accounts and rows are keyed by.

## Check it

`npm run test:swift` compiles `AppSchemeHandler`, `Allowlist`, `SimpleFINClient` and
`FirstLaunch` for this Mac and runs `ios/PlainsumChecks`: what the handler will
serve, what the app may open, what the bank link will send, where and how often,
when the lock asks, what a widget shows as its figures age, and what the alerts remember.
`Vault` needs a signed app, so it is checked in the simulator.

## Smoke tests

`npm run test:ui` builds the web bundle, removes the app from the `iPhone 18 Pro` simulator
and runs `PlainsumUITests`, which takes a few minutes. They are the Plainsum scheme's Test
action, so Cmd-U in Xcode runs them too. `DEVICE` names another simulator. Every test starts
at a first run, through the app's own Erase, and every figure is the sample ledger's.

- `testColdLaunchWithNoNetwork`: the first run, a relaunch and every screen, cut off.
- `testWidgetSnapshotFollowsHome`: what the widget reads matches Home, through the widget's
  own decoder and `WidgetFace`, and Erase takes it back to `Set a budget in <name>`.
- `testBackupAndRestore`: a copy the app saved by itself brings back rows that have gone,
  with a preview and a second tap first.
- `testLockAsksForAFace`: a failed face changes nothing, a launch and a return are covered, a
  tap on the cover does not reach the page, and turning the lock off asks too.
- `testWhatIsTypedStaysOnScreen`: with the keyboard up, the field being typed in and the
  button that saves it stay on screen, before and after a key is pressed. It needs the
  on-screen keyboard, so turn off Connect Hardware Keyboard if it says there is none.

What they cannot do, and what they do instead:

- A simulator shares the Mac's connection. `PLAINSUM_NO_NETWORK` makes a Debug build point
  the web view at a proxy nothing answers. Release has no such path, and
  `verify-store-build` refuses a binary that does. Airplane mode is a check for a phone.
- The runner gets no entitlements, so it finds the group container by the label the system
  leaves in each one. That only works on a simulator, and the tests skip anywhere else.
- Face ID is driven with `notify_post`, which reaches the simulator because the test runs
  inside it. A simulator never asked permission for Face ID, even on its first sight of the
  app, so that alert is a check for a phone. The system's sheet outlives its own label by a
  second or two, the app is inactive until it has gone, and a tap in that time goes nowhere.
  So a test waits for the cover (`lock-cover`) to go, not for the label.
- `isHittable` says yes for a page element under the cover, so the test taps and looks.
- An open sheet takes the page behind it out of the accessibility tree.
- The cover in the app switcher and a widget on the Home Screen are not in reach. The
  widget's picture is checked by hand.

## Build numbers

The app and its widget read one number from `PublicApp.xcconfig`, so they cannot differ.
`npm run build:public` writes it last, into `BuildNumber.xcconfig`, which is not committed:
the UTC minute of the build (`202611052049`), or one more than the last number if that is
higher. It needs no counter, and Xcode's own Archive picks it up too. With no file it
is 1, and `verify-store-build` refuses that. `MARKETING_VERSION` is set by hand. Tally keeps
its own settings and goes nowhere near this.

## Privacy manifests

`Plainsum/PrivacyInfo.xcprivacy` and `Widgets/PrivacyInfo.xcprivacy` say no tracking and no
collected data. The widget's lists no required-reason API, because it uses none. The app's
lists one:

| Reason | Used | Why |
|---|---|---|
| `CA92.1` | yes | `UserDefaults.standard`: the theme, the lock, the alerts, the bank link's request count |
| `1C8F.1` | no | The widget's figures are a file in the group, so no suite is ever opened |
| `C617.1` | no | `Backups` goes by file name, and nothing reads a file's dates |

`AppLock` reads `clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)`, which is not on Apple's list.
If an upload ever names it, `35F9.1` is the reason that fits. `TallyWidgets` carries the same
widget manifest from the shared folder. Tally is never uploaded and does collect data, so
its app target has none, and one saying otherwise would be false.

`scripts/verify-store-build.mjs` holds this table to the binaries. It reads what each one
imports, as an upload does, and fails on a used API with no reason and on a reason with no
API. It also fails if the app and widget numbers differ, if the number is 1, if the app is
not iPhone only, and on a Debug switch. Update its list when Apple's changes.

## Make the archive

`npm run archive:public` makes `ios/build/Plainsum.xcarchive` from a fresh web bundle and
number, then runs that check. `npm run archive:public -- CODE_SIGNING_ALLOWED=NO` skips
signing, to look at one. A signed archive needs Xcode signed in to the account, and the app,
widget and group ids registered. In Xcode's Organizer, right-click the archive and choose
Generate Privacy Report before uploading.

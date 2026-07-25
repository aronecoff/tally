// Native iOS wrapper for Tally — a real iPhone app: a full-screen WKWebView
// (Apple's built-in WebKit) that loads the deployed PWA. Its own home-screen
// icon, own process, own persistent storage (localStorage + IndexedDB), so your
// sign-in and synced ledger survive between launches. Same website as the Mac
// app and the browser — one shared account when you sign in.
//
// Build/run: open ios/Tally.xcodeproj in Xcode, set your Team under
// Signing & Capabilities, plug in your iPhone, pick it as the run destination,
// and press ⌘R.
import SwiftUI

@main
struct TallyApp: App {
    var body: some Scene {
        WindowGroup {
            WebView(url: URL(string: "https://aronecoff.github.io/tally/")!)
                .ignoresSafeArea()          // let the web app own the notch / home-bar insets
                .preferredColorScheme(.dark) // Tally defaults to its dark liquid-glass theme
                .statusBarHidden(false)
        }
    }
}

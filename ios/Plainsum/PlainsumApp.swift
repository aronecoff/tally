// The public, on-device build of the budget app. A full-screen WKWebView
// that serves the web bundle from inside the app, so it opens with no network,
// and nothing it shows was fetched from anywhere.
//
// Build the web bundle first (`npm run build:public`). Xcode does not run npm:
// its "Embed web bundle" phase copies dist-public into the app and fails without it.
//
// The entry point must stay a SwiftUI App: iOS 27 traps on an app that has not
// adopted the scene lifecycle.
import SwiftUI

@main
struct PlainsumApp: App {
    init() {
        BudgetAlerts.shared.start()
        AppLock.shared.start {
            let theme = PlainsumTheme.saved
            return CoverTheme(canvas: theme.canvas, ink: theme.ink, accent: theme.sage, style: theme.style)
        }
    }

    var body: some Scene {
        WindowGroup {
            PlainsumWebView()
                .ignoresSafeArea()          // let the web app own the notch / home-bar insets
                .statusBarHidden(false)
            // No .preferredColorScheme: the page reports its theme over the
            // "theme" message handler and the web view applies it to the window.
        }
    }
}

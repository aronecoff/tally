// Native macOS wrapper for Tally — a real app (no Chrome): an NSWindow hosting
// a WKWebView (Apple's built-in WebKit) that loads the deployed PWA. Its own
// process, own Dock icon, own persistent storage (localStorage + IndexedDB).
//
// Build:
//   swiftc -O -o Tally.app/Contents/MacOS/Tally desktop/Tally.swift \
//          -framework Cocoa -framework WebKit
import Cocoa
import WebKit

let APP_URL = "https://aronecoff.github.io/tally/"

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var web: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 0, y: 0, width: 1180, height: 820)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Tally"
        window.minSize = NSSize(width: 380, height: 600)
        window.center()
        window.setFrameAutosaveName("TallyMainWindow")

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // persist localStorage + IndexedDB

        web = WKWebView(frame: frame, configuration: config)
        web.autoresizingMask = [.width, .height]
        if let url = URL(string: APP_URL) {
            web.load(URLRequest(url: url))
        }

        window.contentView = web
        window.makeKeyAndOrderFront(nil)

        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()

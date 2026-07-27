// Native macOS wrapper for Tally — a real app (no Chrome): an NSWindow hosting
// a WKWebView (Apple's built-in WebKit) that loads the deployed PWA. Its own
// process, own Dock icon, own persistent storage (localStorage + IndexedDB).
//
// Loads from the service-worker cache for an instant start and offline
// resilience. The deployed SW skips waiting, so a new build auto-updates on the
// next launch — no need to wipe the cache each time (wiping removes the offline
// fallback and turns a transient network blip into a blank error page).
// ⌘R reloads; ⇧⌘R force-refreshes (clear caches + reload) if a cache ever sticks.
//
// Build:
//   swiftc -O -o Tally.app/Contents/MacOS/Tally desktop/Tally.swift \
//          -framework Cocoa -framework WebKit
import Cocoa
import WebKit

let APP_URL = "https://aronecoff.github.io/tally/"

// The layers that go stale. Clearing these forces a fresh fetch; localStorage +
// IndexedDB are deliberately NOT included, so the session and data survive.
let STALE_TYPES: Set<String> = [
    WKWebsiteDataTypeServiceWorkerRegistrations,
    WKWebsiteDataTypeDiskCache,
    WKWebsiteDataTypeMemoryCache,
    WKWebsiteDataTypeFetchCache,
]

class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    // Child windows opened via window.open() / target=_blank (e.g. the SnapTrade
    // connect portal) — kept alive here so WKWebView pop-ups actually work
    // instead of being silently blocked.
    var popups: [ObjectIdentifier: NSWindow] = [:]

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
        web.uiDelegate = self

        window.contentView = web
        window.makeKeyAndOrderFront(nil)

        setupMenu()

        // Load straight from the (service-worker) cache: instant start, works
        // offline, and the skip-waiting SW auto-updates to new builds on the next
        // launch. No blanket cache-wipe — that removed the offline fallback.
        load()

        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func load() {
        if let url = URL(string: APP_URL) {
            web.load(URLRequest(url: url))
        }
    }

    func clearStaleCaches(_ done: @escaping () -> Void) {
        WKWebsiteDataStore.default().removeData(
            ofTypes: STALE_TYPES,
            modifiedSince: Date(timeIntervalSince1970: 0)
        ) { done() }
    }

    @objc func reloadPage() { web.reload() }

    @objc func forceRefresh() { clearStaleCaches { [weak self] in self?.load() } }

    func setupMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "Quit Tally", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // Without an Edit menu, none of the standard editing keys reach the web
        // view — no ⌘V to paste a password or SimpleFIN token. First responder
        // routing handles the rest.
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        viewItem.submenu = viewMenu

        let reloadItem = NSMenuItem(title: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        reloadItem.target = self
        viewMenu.addItem(reloadItem)

        let hardItem = NSMenuItem(title: "Force Refresh (clear cache)", action: #selector(forceRefresh), keyEquivalent: "r")
        hardItem.keyEquivalentModifierMask = [.command, .shift]
        hardItem.target = self
        viewMenu.addItem(hardItem)

        let windowItem = NSMenuItem()
        mainMenu.addItem(windowItem)
        let windowMenu = NSMenu(title: "Window")
        windowItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    // Support window.open() / target=_blank so in-app connect portals (SnapTrade,
    // etc.) open in a child window instead of being blocked. The popup shares the
    // passed `configuration`, so it carries the same session/cookies.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        let rect = NSRect(x: 0, y: 0, width: 480, height: 720)
        let popup = WKWebView(frame: rect, configuration: configuration)
        popup.autoresizingMask = [.width, .height]
        popup.uiDelegate = self

        let win = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        win.title = "Tally"
        win.isReleasedWhenClosed = false
        win.center()
        win.contentView = popup
        win.makeKeyAndOrderFront(nil)
        popups[ObjectIdentifier(popup)] = win

        // target=_blank links arrive with a URL to load here; window.open('')
        // arrives blank and the page navigates the popup itself.
        if let url = navigationAction.request.url,
           !url.absoluteString.isEmpty, url.absoluteString != "about:blank" {
            popup.load(navigationAction.request)
        }
        return popup
    }

    // Let a popup close itself (window.close(), or when the portal finishes).
    func webViewDidClose(_ webView: WKWebView) {
        let key = ObjectIdentifier(webView)
        popups[key]?.close()
        popups.removeValue(forKey: key)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()

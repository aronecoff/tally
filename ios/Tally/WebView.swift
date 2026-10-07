import SwiftUI
import WebKit

/// Tally's brand canvas colors, matching the web app's --bg in each theme.
enum TallyTheme: String {
    case dark, light

    static let key = "tally.theme"
    /// Last theme the page reported, so a cold launch paints the right canvas
    /// before the page has loaded (no black-then-ink or ink-then-paper flash).
    static var saved: TallyTheme {
        TallyTheme(rawValue: UserDefaults.standard.string(forKey: key) ?? "") ?? .dark
    }

    var canvas: UIColor {
        self == .dark
            ? UIColor(red: 0.035, green: 0.035, blue: 0.043, alpha: 1) // canvas #09090B (the web --bg)
            : UIColor(red: 0.957, green: 0.937, blue: 0.894, alpha: 1) // Paper #F4EFE4
    }
    /// Type colour: Paper on the dark canvas, Deep Ink #0C0414 on Paper.
    var ink: UIColor {
        self == .dark
            ? TallyTheme.light.canvas
            : UIColor(red: 0.047, green: 0.016, blue: 0.078, alpha: 1)
    }
    var sage: UIColor {
        self == .dark
            ? UIColor(red: 0.561, green: 0.627, blue: 0.514, alpha: 1) // #8FA083
            : UIColor(red: 0.361, green: 0.416, blue: 0.322, alpha: 1) // #5C6A52
    }
    var style: UIUserInterfaceStyle { self == .dark ? .dark : .light }
}

/// WKUserContentController retains its handlers strongly; this breaks the
/// controller → coordinator → web view → controller cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

/// Full-screen WKWebView hosting the deployed Tally PWA. Persistent data store
/// keeps the session + Dexie data across launches; `contentInsetAdjustmentBehavior
/// = .never` hands safe-area handling to the web app's CSS (viewport-fit=cover +
/// env(safe-area-inset-*)), so the header clears the notch and the tab bar clears
/// the home indicator.
struct WebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.websiteDataStore = .default() // persist localStorage + IndexedDB
        config.applicationNameForUserAgent = "TallyNative" // web app hides the "install" hint inside the app
        // The page posts "light" / "dark" whenever its theme changes.
        config.userContentController.add(WeakMessageHandler(context.coordinator), name: "theme")

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        let theme = TallyTheme.saved
        web.backgroundColor = theme.canvas
        web.scrollView.backgroundColor = theme.canvas
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false          // no outer rubber-band; the web app owns scrolling
        web.scrollView.alwaysBounceVertical = false
        context.coordinator.attach(web)
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate,
                             UIAdaptivePresentationControllerDelegate, WKScriptMessageHandler {
        private let appURL: URL
        private weak var web: WKWebView?
        // Popup sheets keyed by their web view, so window.close() can dismiss them.
        private var popups: [ObjectIdentifier: UINavigationController] = [:]
        private var offlineView: UIView?
        private var offlineDetail: UILabel?
        private var offlineDetailText = "Reconnecting automatically."
        // One-shot retry with backoff. A repeating timer restarted every load
        // in flight, so a recovery slower than the interval never finished.
        private var retryTimer: Timer?
        private var attempt = 0
        private let backoff: [TimeInterval] = [6, 12, 30]
        /// The page has booted (React mounted and posted its theme) since the
        /// main frame last committed. didFinish only means index.html and its
        /// subresources settled: a bundle that 404s or resets still finishes.
        private var booted = false
        private var bootWatchdog: Timer?
        private var traitReg: UITraitChangeRegistration?

        init(url: URL) { self.appURL = url }

        func attach(_ webView: WKWebView) {
            self.web = webView
            // Apply the remembered theme as soon as the view joins a window.
            DispatchQueue.main.async { [weak self] in self?.apply(TallyTheme.saved) }
        }

        // ---- Theme bridge ------------------------------------------------------
        func userContentController(_ controller: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            // Only the app's own page may set the theme: the handler is visible
            // to every frame and to the connect portals' popups too.
            let origin = message.frameInfo.securityOrigin
            guard message.name == "theme",
                  message.webView === web,                 // not a popup / portal sheet
                  message.frameInfo.isMainFrame,           // not an iframe
                  origin.protocol == appURL.scheme,
                  origin.host == appURL.host,
                  origin.port == (appURL.port ?? 0),       // WKSecurityOrigin reports 0 for the default port
                  let raw = message.body as? String,
                  let theme = TallyTheme(rawValue: raw) else { return }
            // useTheme posts on mount, so the first post means the app booted.
            booted = true
            bootWatchdog?.invalidate()
            bootWatchdog = nil
            hideOffline()
            UserDefaults.standard.set(theme.rawValue, forKey: TallyTheme.key)
            apply(theme)
        }

        private var theme: TallyTheme = TallyTheme.saved

        private func apply(_ theme: TallyTheme) {
            self.theme = theme
            guard let web else { return }
            web.backgroundColor = theme.canvas
            web.scrollView.backgroundColor = theme.canvas
            // The page's prefers-color-scheme comes from the web view's traits.
            // Pin those to the real OS style (the scene's, which the window
            // override below does not touch), or 'System' would follow the last
            // theme the page posted instead of the iPhone. Set before the window
            // override so the page never sees a passing wrong value.
            if let scene = web.window?.windowScene {
                web.overrideUserInterfaceStyle = scene.traitCollection.userInterfaceStyle
                if traitReg == nil {
                    traitReg = scene.registerForTraitChanges([UITraitUserInterfaceStyle.self]) {
                        [weak self] (scene: UIWindowScene, _: UITraitCollection) in
                        self?.web?.overrideUserInterfaceStyle = scene.traitCollection.userInterfaceStyle
                    }
                }
            }
            // The window's interface style drives the status bar: light content
            // on ink, dark content on paper.
            web.window?.overrideUserInterfaceStyle = theme.style
            web.window?.rootViewController?.setNeedsStatusBarAppearanceUpdate()
            offlineView?.removeFromSuperview()
            if offlineView != nil { offlineView = nil; showOffline() }
        }

        // ---- Connect portals: window.open() / target=_blank -------------------
        // SnapTrade (and future connectors) open their portal with window.open and
        // close it with window.close() when the link completes. Present the popup
        // as a modal sheet; loading it over the main view would strand the app
        // inside the portal and break the "popup closed → refresh accounts" flow.
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            // WebKit requires the returned web view to be built from the passed
            // configuration (it carries the opener relationship + session).
            let popup = WKWebView(frame: .zero, configuration: configuration)
            popup.uiDelegate = self
            popup.navigationDelegate = self
            popup.allowsBackForwardNavigationGestures = true

            let vc = UIViewController()
            vc.view = popup
            vc.navigationItem.rightBarButtonItem = UIBarButtonItem(
                systemItem: .done,
                primaryAction: UIAction { [weak self, weak popup] _ in
                    guard let popup else { return }
                    self?.closePopup(popup)
                }
            )
            let nav = UINavigationController(rootViewController: vc)
            nav.presentationController?.delegate = self // catch swipe-down dismissal
            popups[ObjectIdentifier(popup)] = nav
            topController()?.present(nav, animated: true)

            // target=_blank links arrive with a URL to load here; window.open('')
            // arrives blank and the page navigates the popup itself.
            if let url = navigationAction.request.url,
               !url.absoluteString.isEmpty, url.absoluteString != "about:blank" {
                popup.load(navigationAction.request)
            }
            return popup
        }

        // The portal calls window.close() when it finishes.
        func webViewDidClose(_ webView: WKWebView) {
            closePopup(webView)
        }

        private func closePopup(_ webView: WKWebView) {
            if let nav = popups.removeValue(forKey: ObjectIdentifier(webView)) {
                nav.dismiss(animated: true)
            }
        }

        // Swipe-down on the sheet: drop our reference so the popup can deallocate.
        func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
            popups = popups.filter { $0.value !== presentationController.presentedViewController }
        }

        private func topController() -> UIViewController? {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
                ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            var top = scene?.keyWindow?.rootViewController
            while let presented = top?.presentedViewController { top = presented }
            return top
        }

        // ---- JavaScript dialogs ------------------------------------------------
        // WKWebView shows nothing for alert()/confirm() unless the host app
        // implements these, and confirm() then silently returns false — which
        // is why Delete used to do nothing in the app. The web UI now confirms
        // in-sheet; these are the native backstop.
        // The handlers are @MainActor to match the SDK (WK_SWIFT_UI_ACTOR). In
        // Swift 6 mode a plain closure type no longer matches the protocol, the
        // methods drop out of what WebKit sees, and confirm() returns false.
        func webView(_ webView: WKWebView,
                     runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping @MainActor () -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            guard let top = topController() else { completionHandler(); return }
            top.present(alert, animated: true)
        }

        func webView(_ webView: WKWebView,
                     runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping @MainActor (Bool) -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .destructive) { _ in completionHandler(true) })
            guard let top = topController() else { completionHandler(false); return }
            top.present(alert, animated: true)
        }

        // ---- Navigation policy -------------------------------------------------
        // Non-web schemes (mailto:, tel:, bank apps' deep links from a portal)
        // belong to the system, not the web view.
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            if let url = navigationAction.request.url,
               let scheme = url.scheme?.lowercased(),
               !["http", "https", "about", "blob", "data"].contains(scheme) {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            // The app's own view stays on the app. A page inside a connect portal
            // could otherwise send it to a look-alike sign-in page, and the app has
            // no address bar to give that away. Other web pages open in Safari,
            // which shows where they are. Popups (the portals) are not affected.
            if webView === web,
               navigationAction.targetFrame?.isMainFrame == true,
               let url = navigationAction.request.url,
               let scheme = url.scheme?.lowercased(),
               scheme == "http" || scheme == "https",
               !isAppURL(url) {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        /// Same scheme, host and port as the app, under the app's path.
        private func isAppURL(_ url: URL) -> Bool {
            guard url.scheme?.lowercased() == appURL.scheme?.lowercased(),
                  url.host?.lowercased() == appURL.host?.lowercased(),
                  url.port == appURL.port else { return false }
            func trimmed(_ p: String) -> String {
                var p = p
                while p.hasSuffix("/") { p.removeLast() }
                return p
            }
            let base = trimmed(appURL.path)
            let path = trimmed(url.path)
            return path == base || path.hasPrefix(base + "/")
        }

        // ---- Resilience ---------------------------------------------------------
        // iOS reclaims the web content process in the background under memory
        // pressure; without this the app resumes to a frozen blank view.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            guard webView === web else { return }
            setOfflineDetail("Connecting…")
        }

        // Reset at commit, not at didFinish: the page can post its theme
        // seconds before didFinish when a subresource (the manifest) is slow.
        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            guard webView === web else { return }
            booted = false
            bootWatchdog?.invalidate()
            bootWatchdog = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if webView === web {
                // index.html loaded; the theme post says the app itself did.
                // A bundle that failed leaves a blank canvas, so give it 10 s
                // and then fall back to the offline screen and its retries.
                guard !booted else { hideOffline(); return }
                bootWatchdog?.invalidate()
                bootWatchdog = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { [weak self] _ in
                    MainActor.assumeIsolated {
                        guard let self, !self.booted else { return }
                        self.bootWatchdog = nil
                        self.failed()
                    }
                }
            } else if let nav = popups[ObjectIdentifier(webView)] {
                nav.topViewController?.navigationItem.title = webView.url?.host
            }
        }

        // WKWebView has no service worker here (app-bound-domain limits would
        // block the connect portals' bank redirects), so a cold launch without
        // network needs a native fallback instead of a silent black screen.
        func webView(_ webView: WKWebView,
                     didFailProvisionalNavigation navigation: WKNavigation!,
                     withError error: Error) {
            handleFailure(webView, error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            handleFailure(webView, error)
        }

        private func handleFailure(_ webView: WKWebView, _ error: Error) {
            guard webView === web else { return }
            let code = (error as NSError).code
            guard code != NSURLErrorCancelled else { return }
            failed()
        }

        /// A load failed, or loaded without the app booting: show the offline
        /// screen and schedule the next attempt.
        private func failed() {
            setOfflineDetail("Reconnecting automatically.")
            showOffline()
            scheduleRetry()
        }

        private func scheduleRetry() {
            retryTimer?.invalidate()
            let delay = backoff[min(attempt, backoff.count - 1)]
            attempt += 1
            retryTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.retryTimer = nil
                    // Never cut off a load in flight: it ends in didFinish (boot
                    // or watchdog) or in a failure, and either schedules again.
                    guard let web = self.web, !web.isLoading else { return }
                    self.load()
                }
            }
        }

        private func load() {
            retryTimer?.invalidate()
            retryTimer = nil
            setOfflineDetail("Connecting…")
            // An idle timeout, not a cap on the whole load: a slow link that
            // keeps sending is never cut off, a stalled request fails and retries.
            web?.load(URLRequest(url: appURL, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 20))
        }

        private func setOfflineDetail(_ text: String) {
            offlineDetailText = text
            offlineDetail?.text = text
        }

        private func showOffline() {
            guard let web else { return }
            if offlineView == nil {
                let overlay = UIView()
                overlay.backgroundColor = theme.canvas
                overlay.translatesAutoresizingMaskIntoConstraints = false

                let title = UILabel()
                title.text = "Tally is offline"
                title.textColor = theme.ink
                title.font = .preferredFont(forTextStyle: .headline)

                let detail = UILabel()
                detail.text = offlineDetailText
                detail.textColor = theme.ink.withAlphaComponent(0.62)
                detail.font = .preferredFont(forTextStyle: .subheadline)
                detail.numberOfLines = 0
                detail.textAlignment = .center

                var buttonConfig = UIButton.Configuration.filled()
                buttonConfig.title = "Try again"
                buttonConfig.cornerStyle = .capsule
                buttonConfig.baseBackgroundColor = theme.sage
                buttonConfig.baseForegroundColor = theme.canvas
                // Always reloads, even mid-load: one deliberate tap is not a
                // loop, and it is the way out of an attempt that has stalled.
                let retry = UIButton(configuration: buttonConfig,
                                     primaryAction: UIAction { [weak self] _ in
                                         self?.attempt = 0
                                         self?.load()
                                     })

                let stack = UIStackView(arrangedSubviews: [title, detail, retry])
                stack.axis = .vertical
                stack.spacing = 12
                stack.alignment = .center
                stack.translatesAutoresizingMaskIntoConstraints = false
                overlay.addSubview(stack)

                web.addSubview(overlay)
                NSLayoutConstraint.activate([
                    overlay.topAnchor.constraint(equalTo: web.topAnchor),
                    overlay.bottomAnchor.constraint(equalTo: web.bottomAnchor),
                    overlay.leadingAnchor.constraint(equalTo: web.leadingAnchor),
                    overlay.trailingAnchor.constraint(equalTo: web.trailingAnchor),
                    stack.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
                    stack.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
                    stack.leadingAnchor.constraint(greaterThanOrEqualTo: overlay.leadingAnchor, constant: 32),
                    stack.trailingAnchor.constraint(lessThanOrEqualTo: overlay.trailingAnchor, constant: -32),
                ])
                offlineView = overlay
                offlineDetail = detail
            }
        }

        private func hideOffline() {
            retryTimer?.invalidate()
            retryTimer = nil
            attempt = 0
            offlineView?.removeFromSuperview()
            offlineView = nil
            offlineDetail = nil
        }
    }
}

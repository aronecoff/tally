import SwiftUI
import WebKit
#if DEBUG
import Network
#endif

/// WKUserContentController retains its handlers strongly; this breaks the
/// controller → coordinator → web view → controller cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

/// Full-screen WKWebView on the bundled web app. `contentInsetAdjustmentBehavior
/// = .never` hands safe-area handling to the web app's CSS (viewport-fit=cover +
/// env(safe-area-inset-*)).
///
/// `websiteDataStore = .default()` is the app's own container, per bundle id, so
/// Plainsum and Tally cannot see each other's data.
struct PlainsumWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        // Before the page exists, so it can never see what the purge removes.
        FirstLaunch.run(unlocked: UIApplication.shared.isProtectedDataAvailable, purge: Vault.purge)

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // persist localStorage + IndexedDB
        #if DEBUG
        // For the offline UI test. A simulator shares the Mac's connection, so this points
        // the web view at a proxy nothing answers, and anything that tries to leave the app
        // fails as it would in airplane mode. A Release build has no way to do this.
        if ProcessInfo.processInfo.environment["PLAINSUM_NO_NETWORK"] != nil {
            config.websiteDataStore.proxyConfigurations = [ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: 9))]
        }
        #endif
        config.applicationNameForUserAgent = "PlainsumNative"
        config.dataDetectorTypes = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let root = Bundle.main.resourceURL!.appendingPathComponent("Web", isDirectory: true)
        config.setURLSchemeHandler(AppSchemeHandler(root: root), forURLScheme: AppSchemeHandler.scheme)
        // The page posts "light" / "dark" whenever its theme changes.
        config.userContentController.add(WeakMessageHandler(context.coordinator), name: "theme")
        let bridge = NativeBridge()
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: NativeBridge.name)

        let web = WKWebView(frame: .zero, configuration: config)
        bridge.web = web
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsLinkPreview = false
        web.allowsBackForwardNavigationGestures = true // Budget to Categories uses history
        web.isOpaque = false
        #if DEBUG
        web.isInspectable = true
        #endif
        let theme = PlainsumTheme.saved
        web.backgroundColor = theme.canvas
        web.scrollView.backgroundColor = theme.canvas
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false          // no outer rubber-band; the web app owns scrolling
        web.scrollView.alwaysBounceVertical = false
        context.coordinator.attach(web)
        web.load(URLRequest(url: AppSchemeHandler.startURL))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        private weak var web: WKWebView?
        /// The page has booted (React mounted and posted its theme) since the
        /// main frame last committed. didFinish only means index.html settled.
        private var booted = false
        private var bootWatchdog: Timer?
        private var failureView: UIView?
        private var traitReg: UITraitChangeRegistration?
        private var theme: PlainsumTheme = PlainsumTheme.saved

        func attach(_ webView: WKWebView) {
            self.web = webView
            // Apply the remembered theme as soon as the view joins a window.
            DispatchQueue.main.async { [weak self] in self?.apply(PlainsumTheme.saved) }
        }

        // ---- Theme bridge ------------------------------------------------------
        func userContentController(_ controller: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            // Only the app's own main frame may set the theme.
            let origin = message.frameInfo.securityOrigin
            guard message.name == "theme",
                  message.webView === web,
                  message.frameInfo.isMainFrame,
                  AppSchemeHandler.isOwnOrigin(scheme: origin.protocol, host: origin.host, port: origin.port),
                  let raw = message.body as? String,
                  let theme = PlainsumTheme(rawValue: raw) else { return }
            // useTheme posts on mount, so the first post means the app booted.
            booted = true
            bootWatchdog?.invalidate()
            bootWatchdog = nil
            hideFailure()
            UserDefaults.standard.set(theme.rawValue, forKey: PlainsumTheme.key)
            apply(theme)
        }

        private func apply(_ theme: PlainsumTheme) {
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
            if failureView != nil {
                hideFailure()
                showFailure()
            }
        }

        // ---- Navigation policy -------------------------------------------------
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            let url = navigationAction.request.url
            let decision = Allowlist.decide(url)
            if decision == .openExternally, let url { UIApplication.shared.open(url) }
            decisionHandler(decision == .allow ? .allow : .cancel)
        }

        /// Never a second web view: `<a target="_blank">` lands here, and the
        /// same table decides.
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url, Allowlist.decide(url) == .openExternally {
                UIApplication.shared.open(url)
            }
            return nil
        }

        // ---- JavaScript dialogs ------------------------------------------------
        // WKWebView shows nothing for alert()/confirm() unless the host app
        // implements these, and confirm() then silently returns false. The web
        // UI confirms in-sheet; these are the native backstop.
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

        private func topController() -> UIViewController? {
            var top = web?.window?.rootViewController
            while let presented = top?.presentedViewController { top = presented }
            return top
        }

        // ---- Resilience ---------------------------------------------------------
        // iOS reclaims the web content process in the background under memory
        // pressure; without this the app resumes to a frozen blank view. A process
        // lost before anything committed leaves nothing to reload.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            if webView.url == nil {
                webView.load(URLRequest(url: AppSchemeHandler.startURL))
            } else {
                webView.reload()
            }
        }

        // Reset at commit, not at didFinish: the page can post its theme before
        // didFinish.
        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            booted = false
            bootWatchdog?.invalidate()
            bootWatchdog = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // index.html loaded; the theme post says the app itself did. A bundle
            // that failed leaves a blank canvas, so give it 10 s.
            guard !booted else { return }
            bootWatchdog?.invalidate()
            bootWatchdog = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, !self.booted else { return }
                    self.bootWatchdog = nil
                    self.showFailure()
                }
            }
        }

        func webView(_ webView: WKWebView,
                     didFailProvisionalNavigation navigation: WKNavigation!,
                     withError error: Error) {
            handleFailure(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            handleFailure(error)
        }

        private func handleFailure(_ error: Error) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            showFailure()
        }

        /// The app needs no network, so this is not an offline screen: the
        /// bundle itself did not start.
        private func showFailure() {
            guard let web, failureView == nil else { return }
            let overlay = UIView()
            overlay.backgroundColor = theme.canvas
            overlay.translatesAutoresizingMaskIntoConstraints = false

            let line = UILabel()
            line.text = "\(AppName.display) could not start."
            line.textColor = theme.ink
            line.font = .preferredFont(forTextStyle: .headline)
            line.numberOfLines = 0
            line.textAlignment = .center

            var buttonConfig = UIButton.Configuration.filled()
            buttonConfig.title = "Try again"
            buttonConfig.cornerStyle = .capsule
            buttonConfig.baseBackgroundColor = theme.sage
            buttonConfig.baseForegroundColor = theme.canvas
            let retry = UIButton(configuration: buttonConfig,
                                 primaryAction: UIAction { [weak self] _ in
                                     self?.hideFailure()
                                     self?.web?.load(URLRequest(url: AppSchemeHandler.startURL))
                                 })

            let stack = UIStackView(arrangedSubviews: [line, retry])
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
            failureView = overlay
        }

        private func hideFailure() {
            failureView?.removeFromSuperview()
            failureView = nil
        }
    }
}

import SwiftUI
import WebKit

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

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false          // no outer rubber-band; the web app owns scrolling
        web.scrollView.alwaysBounceVertical = false
        context.coordinator.attach(web)
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate,
                             UIAdaptivePresentationControllerDelegate {
        private let appURL: URL
        private weak var web: WKWebView?
        // Popup sheets keyed by their web view, so window.close() can dismiss them.
        private var popups: [ObjectIdentifier: UINavigationController] = [:]
        private var offlineView: UIView?
        private var retryTimer: Timer?

        init(url: URL) { self.appURL = url }

        func attach(_ webView: WKWebView) { self.web = webView }

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

        // ---- Navigation policy -------------------------------------------------
        // Non-web schemes (mailto:, tel:, bank apps' deep links from a portal)
        // belong to the system, not the web view.
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let url = navigationAction.request.url,
               let scheme = url.scheme?.lowercased(),
               !["http", "https", "about", "blob", "data"].contains(scheme) {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        // ---- Resilience ---------------------------------------------------------
        // iOS reclaims the web content process in the background under memory
        // pressure; without this the app resumes to a frozen blank view.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if webView === web {
                hideOffline()
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
            showOffline()
        }

        private func showOffline() {
            guard let web else { return }
            if offlineView == nil {
                let overlay = UIView()
                overlay.backgroundColor = .black
                overlay.translatesAutoresizingMaskIntoConstraints = false

                let title = UILabel()
                title.text = "Can't reach Tally"
                title.textColor = .white
                title.font = .preferredFont(forTextStyle: .headline)

                let detail = UILabel()
                detail.text = "Check your connection — retrying automatically."
                detail.textColor = .secondaryLabel
                detail.font = .preferredFont(forTextStyle: .subheadline)
                detail.numberOfLines = 0
                detail.textAlignment = .center

                var buttonConfig = UIButton.Configuration.filled()
                buttonConfig.title = "Retry now"
                buttonConfig.cornerStyle = .capsule
                let retry = UIButton(configuration: buttonConfig,
                                     primaryAction: UIAction { [weak self] _ in self?.retry() })

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
            }
            if retryTimer == nil {
                retryTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: true) { [weak self] _ in
                    self?.retry()
                }
            }
        }

        private func retry() {
            web?.load(URLRequest(url: appURL))
        }

        private func hideOffline() {
            retryTimer?.invalidate()
            retryTimer = nil
            offlineView?.removeFromSuperview()
            offlineView = nil
        }
    }
}

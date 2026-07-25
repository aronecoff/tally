import SwiftUI
import WebKit

/// Full-screen WKWebView hosting the deployed Tally PWA. Persistent data store
/// keeps the session + Dexie data across launches; `contentInsetAdjustmentBehavior
/// = .never` hands safe-area handling to the web app's CSS (viewport-fit=cover +
/// env(safe-area-inset-*)), so the header clears the notch and the tab bar clears
/// the home indicator.
struct WebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

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
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        // window.open() / target=_blank (e.g. the SnapTrade connect portal) would
        // otherwise be silently dropped — load it in the same web view instead.
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let u = navigationAction.request.url {
                webView.load(URLRequest(url: u))
            }
            return nil
        }
    }
}

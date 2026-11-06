import WebKit

/// What the page may ask of the app, through one handler. The page calls
/// `window.webkit.messageHandlers.tally.postMessage({ method, args })` and gets a
/// Promise (src/lib/native.ts). A failure rejects it with a code.
///
/// This app loads a live site, so who is calling matters more here than in the
/// public app: only the main frame of the app's own page, in the app's own web view,
/// is answered. A connect portal's popup shares the configuration, and the handler
/// with it, and is refused by the web view check.
@MainActor
final class TallyBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "tally"

    /// Only this web view may call. Set once it exists.
    weak var web: WKWebView?
    private let app: URL

    init(app: URL) { self.app = app }

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let frame = message.frameInfo
        let origin = frame.securityOrigin
        guard message.webView === web, frame.isMainFrame,
              PageOrigin.isAppOrigin(scheme: origin.protocol, host: origin.host, port: origin.port, app: app),
              PageOrigin.isAppURL(frame.request.url, app: app) else {
            replyHandler(nil, "denied")
            return
        }
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            replyHandler(nil, DataBridge.Failure.badArgs.rawValue)
            return
        }
        let args = body["args"] as? [String: Any] ?? [:]
        Task {
            do {
                guard let reply = try await DataBridge.call(method, args, web: web) else {
                    throw DataBridge.Failure.unavailable
                }
                replyHandler(reply, nil)
            } catch let failure as DataBridge.Failure {
                replyHandler(nil, failure.rawValue)
            } catch {
                replyHandler(nil, DataBridge.Failure.unavailable.rawValue)
            }
        }
    }
}

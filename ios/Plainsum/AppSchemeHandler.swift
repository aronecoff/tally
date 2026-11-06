import Foundation
import WebKit

/// Serves the bundled web app on plainsum://app. A custom scheme is a secure
/// context, so IndexedDB, localStorage and crypto.randomUUID all work, and the
/// page's CSP `'self'` means this origin and nothing else.
///
/// The scheme is deliberately not in CFBundleURLTypes: other apps have no reason
/// to open it.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    nonisolated static let scheme = "plainsum"
    nonisolated static let host = "app"
    nonisolated static let startURL = URL(string: "plainsum://app/index.html")!

    /// Whether a security origin is the app's own page. A page on any other host
    /// or port is not, and both native handlers refuse it.
    nonisolated static func isOwnOrigin(scheme: String, host: String, port: Int) -> Bool {
        scheme == Self.scheme && host == Self.host && port == 0
    }

    private let root: URL
    /// Tasks WebKit has not stopped. Calling a stopped task raises an exception.
    private var running = Set<ObjectIdentifier>()

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        running.insert(id)
        let request = task.request
        let root = self.root
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let reply = Self.reply(method: request.httpMethod, url: request.url, root: root)
            DispatchQueue.main.async {
                guard let self, self.running.remove(id) != nil else { return }
                task.didReceive(reply.response(for: request.url ?? Self.startURL))
                if !reply.body.isEmpty { task.didReceive(reply.body) }
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        running.remove(ObjectIdentifier(task))
    }

    struct Reply: Equatable {
        var status: Int
        var mime: String?
        var body: Data

        func response(for url: URL) -> HTTPURLResponse {
            var headers = ["Content-Length": String(body.count), "Cache-Control": "no-store"]
            headers["Content-Type"] = mime
            return HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        }
    }

    /// A wrong type on a module script stops the app, so nothing is left to guessing.
    nonisolated static func mime(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json": return "application/json"
        case "woff2": return "font/woff2"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        default: return "application/octet-stream"
        }
    }

    /// The file a request path names, or nil if it reaches outside `root`.
    /// `root` must already be standardized.
    nonisolated static func file(forPath path: String, root: URL) -> URL? {
        let relative = path.drop { $0 == "/" }
        let target = root.appendingPathComponent(relative.isEmpty ? "index.html" : String(relative)).standardizedFileURL
        return target.path.hasPrefix(root.path + "/") ? target : nil
    }

    /// Only GET, only host `app`. Anything else, a path outside the bundle or a
    /// missing file answers with a status: this never crashes on a bad request.
    nonisolated static func reply(method: String?, url: URL?, root: URL) -> Reply {
        guard method == nil || method == "GET" else { return Reply(status: 405, mime: nil, body: Data()) }
        guard let url, url.host?.lowercased() == host,
              let file = file(forPath: url.path, root: root),
              let body = try? Data(contentsOf: file) else {
            return Reply(status: 404, mime: nil, body: Data())
        }
        return Reply(status: 200, mime: mime(forExtension: file.pathExtension), body: body)
    }
}

import Foundation

/// Whether a message comes from the app's own page. Both native bridges ask this
/// before answering anything, because the handler is visible to every frame and to
/// any popup the page opens.
enum PageOrigin {
    /// Same scheme, host and port as the app, under the app's path.
    static func isAppURL(_ url: URL?, app: URL) -> Bool {
        guard let url,
              url.scheme?.lowercased() == app.scheme?.lowercased(),
              url.host?.lowercased() == app.host?.lowercased(),
              url.port == app.port else { return false }
        func trimmed(_ p: String) -> String {
            var p = p
            while p.hasSuffix("/") { p.removeLast() }
            return p
        }
        let base = trimmed(app.path)
        let path = trimmed(url.path)
        return path == base || path.hasPrefix(base + "/")
    }

    /// A security origin as WebKit reports it, which has no path: 0 is the default port.
    static func isAppOrigin(scheme: String, host: String, port: Int, app: URL) -> Bool {
        scheme == app.scheme && host == app.host && port == (app.port ?? 0)
    }
}

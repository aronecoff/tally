import Foundation

/// Everything the app may open, in one table. It lives in Swift so legal URLs
/// never enter the web bundle. External links open in Safari, never in the app,
/// which is what keeps "Unrestricted Web Access" honestly No.
enum Allowlist {
    enum Decision: Equatable {
        /// Load it in the web view: the app's own pages.
        case allow
        /// Cancel it here and hand it to the system.
        case openExternally
        /// Cancel it and do nothing.
        case drop
    }

    /// Hosts the app may hand to Safari. The legal host joins this once it is chosen.
    static let externalHosts: Set<String> = [
        "bridge.simplefin.org",
        "beta-bridge.simplefin.org",
        "www.simplefin.org",
    ]

    /// The one address `mailto:` may reach. None until a support address is chosen.
    static let supportEmail: String? = nil

    static func decide(_ url: URL?) -> Decision {
        guard let url, let scheme = url.scheme?.lowercased() else { return .drop }
        switch scheme {
        case AppSchemeHandler.scheme:
            return url.host?.lowercased() == AppSchemeHandler.host && url.port == nil ? .allow : .drop
        case "about":
            return url.absoluteString == "about:blank" ? .allow : .drop
        case "https":
            // No credentials or odd ports: a listed host is only ever its plain address.
            guard let host = url.host?.lowercased(), url.user == nil, url.password == nil, url.port == nil else { return .drop }
            return externalHosts.contains(host) ? .openExternally : .drop
        case "mailto":
            guard let supportEmail else { return .drop }
            return url.absoluteString == "mailto:\(supportEmail)" ? .openExternally : .drop
        default:
            return .drop
        }
    }
}

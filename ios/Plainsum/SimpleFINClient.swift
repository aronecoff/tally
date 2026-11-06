import Foundation

/// The rules a SimpleFIN address must meet. Pure, so ios/PlainsumChecks can run them.
enum SimpleFIN {
    /// What a request can come back with, by the code the page reads.
    enum Failure: String, Error {
        /// Not base64 of a URL.
        case badToken = "bad_token"
        /// A URL, but not SimpleFIN's, or not https. Nothing was sent.
        case notSimpleFIN = "not_simplefin"
        /// SimpleFIN's 403: the token was used already, or does not exist.
        case claimRefused = "claim_refused"
        /// Any other answer to a claim, or an access URL that fails these rules.
        case claimFailed = "claim_failed"
        case notConnected = "not_connected"
        case network
        case badArgs = "bad_args"
    }

    /// The API's own limit on one request, in seconds.
    static let maxWindow = 90 * 86_400

    /// The address and credentials of a linked bank. Lives only as long as a request.
    struct Access: Equatable {
        let base: URL
        let authorization: String
    }

    /// `simplefin.org` or a subdomain of it. The plan said to warn on any other
    /// host. This refuses, as the Edge Function does, because a warning would let
    /// a crafted token point the app, and then the user's bank data, anywhere.
    ///
    /// Give it the host as written, not decoded: `URL.host` turns
    /// `evil.test%2F.simplefin.org` into `evil.test/.simplefin.org`, so only the
    /// characters of a host name pass, and a `%` in one never does.
    static func isBridgeHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased(), host.range(of: "^[a-z0-9.-]+$", options: .regularExpression) != nil else { return false }
        return host == "simplefin.org" || host.hasSuffix(".simplefin.org")
    }

    /// A failure from before the connection was made, so SimpleFIN cannot have seen
    /// or counted the request. A timeout or a dropped connection may have reached it.
    static func neverSent(_ error: URLError) -> Bool {
        switch error.code {
        case .notConnectedToInternet, .cannotFindHost, .dnsLookupFailed, .cannotConnectToHost,
             .dataNotAllowed, .internationalRoamingOff, .callIsActive:
            return true
        default:
            return false
        }
    }

    /// A setup token is base64 of a one-time claim URL.
    static func claimURL(setupToken: String) throws -> URL {
        let compact = setupToken.filter { !$0.isWhitespace }
        let padded = compact.padding(toLength: (compact.count + 3) / 4 * 4, withPad: "=", startingAt: 0)
        guard !compact.isEmpty,
              let data = Data(base64Encoded: padded),
              let text = String(data: data, encoding: .utf8),
              let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme != nil else { throw Failure.badToken }
        let host = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedHost
        guard url.scheme?.lowercased() == "https", isBridgeHost(host), url.user == nil, url.password == nil else {
            throw Failure.notSimpleFIN
        }
        return url
    }

    /// An access URL embeds Basic credentials, which URLSession will not send from
    /// a URL, so they become a header. Nil unless it is https, on SimpleFIN's
    /// domain, with both parts of a login.
    static func access(_ text: String) -> Access? {
        guard var parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == "https",
              isBridgeHost(parts.percentEncodedHost),
              let user = parts.user, let password = parts.password,
              !user.isEmpty, !password.isEmpty else { return nil }
        parts.user = nil
        parts.password = nil
        parts.query = nil
        parts.fragment = nil
        while parts.path.hasSuffix("/") { parts.path.removeLast() }
        guard let base = parts.url else { return nil }
        return Access(base: base, authorization: "Basic " + Data("\(user):\(password)".utf8).base64EncodedString())
    }

    /// Whether one request stays inside the API's limit. Left open, the bridge
    /// measures to a day past now, so that day counts (seen on the demo bridge).
    static func windowOK(start: Int, end: Int?, now: Int) -> Bool {
        let stop = end ?? now + 86_400
        return start < stop && stop - start <= maxWindow
    }

    /// `version=1` is pinned: left out, the server chooses, and protocol 2 drops the
    /// `org` every stored account and row is keyed by, which would file each row a
    /// second time. `pending=1` is required for holds to appear at all.
    static func accountsURL(base: URL, start: Int, end: Int?) -> URL? {
        var parts = URLComponents(url: base.appendingPathComponent("accounts"), resolvingAgainstBaseURL: false)
        var items = [URLQueryItem(name: "start-date", value: String(start))]
        if let end { items.append(URLQueryItem(name: "end-date", value: String(end))) }
        items.append(URLQueryItem(name: "pending", value: "1"))
        items.append(URLQueryItem(name: "version", value: "1"))
        parts?.queryItems = items
        return parts?.url
    }
}

/// Going past SimpleFIN's 24 requests a day can get a token disabled, and a
/// stranger cannot undo that from inside the app. So the count sits here, where
/// nothing in the page can skip it. Every request counts, answered or not, unless
/// it provably never left the phone.
struct RequestBudget {
    static let cap = 24
    static let window: TimeInterval = 86_400
    static let key = "plainsum.simplefin.requests"

    let defaults: UserDefaults

    /// The last day's requests. A time still to come cannot be true (the clock
    /// moved back), and keeping it would hold the app at the cap until that time.
    private func recent(_ now: Date) -> [TimeInterval] {
        let at = now.timeIntervalSince1970
        return (defaults.array(forKey: Self.key) as? [TimeInterval] ?? []).filter { $0 > at - Self.window && $0 <= at }
    }

    func used(at now: Date = Date()) -> Int { recent(now).count }

    /// Counts one request, or refuses it at the cap.
    func take(at now: Date = Date()) -> Bool {
        let list = recent(now)
        guard list.count < Self.cap else { return false }
        defaults.set(list + [now.timeIntervalSince1970], forKey: Self.key)
        return true
    }

    /// Gives back the one taken at `now`. Otherwise a spell with no connection would
    /// use up the day and read as refresh being paused. It works on the stored list,
    /// because a request taken since `now` must stay counted.
    func refund(at now: Date) {
        var list = defaults.array(forKey: Self.key) as? [TimeInterval] ?? []
        guard let index = list.lastIndex(of: now.timeIntervalSince1970) else { return }
        list.remove(at: index)
        defaults.set(list, forKey: Self.key)
    }
}

/// A redirect would carry the request somewhere these rules never saw, and the
/// credentials with it. SimpleFIN does not use them, so it stands as the answer.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// The app's only network code. It moves bytes and nothing else: what an answer
/// means is decided in src/lib/simplefinNormalize.ts. Nothing it reads touches
/// the disk, because no cache, cookie or credential store is attached.
final class SimpleFINClient {
    static func configuration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.httpShouldSetCookies = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 60
        return config
    }

    private let session: URLSession

    init(configuration: URLSessionConfiguration = SimpleFINClient.configuration()) {
        session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }

    /// A `URLError` comes through as it is, so a caller can tell what it cost.
    private func send(_ request: URLRequest) async throws -> (status: Int, body: String) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw SimpleFIN.Failure.network }
        return (http.statusCode, String(decoding: data, as: UTF8.self))
    }

    /// Swaps a claim URL for an access URL. It works once, so the setup token is
    /// spent even if the answer turns out to be no use.
    func claim(_ url: URL) async throws -> String {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data()
        let reply: (status: Int, body: String)
        do {
            reply = try await send(request)
        } catch is URLError {
            throw SimpleFIN.Failure.network
        }
        if reply.status == 403 { throw SimpleFIN.Failure.claimRefused }
        guard reply.status == 200, SimpleFIN.access(reply.body) != nil else { throw SimpleFIN.Failure.claimFailed }
        return reply.body.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func accounts(_ access: SimpleFIN.Access, start: Int, end: Int?) async throws -> (status: Int, body: String) {
        guard let url = SimpleFIN.accountsURL(base: access.base, start: start, end: end) else { throw SimpleFIN.Failure.badArgs }
        var request = URLRequest(url: url)
        request.setValue(access.authorization, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await send(request)
    }
}

/// Where the access URL is kept. Vault.swift is the real one.
protocol SecretStore {
    func read() -> String?
    func write(_ secret: String) throws
    func delete() throws
}

/// The link to the user's bank. The access URL comes out of the store only here
/// and is never handed to the page.
@MainActor
final class BankLink {
    private let client: SimpleFINClient
    private let store: SecretStore
    private let budget: RequestBudget

    init(client: SimpleFINClient = SimpleFINClient(), store: SecretStore, defaults: UserDefaults = .standard) {
        self.client = client
        self.store = store
        self.budget = RequestBudget(defaults: defaults)
    }

    var connected: Bool { store.read() != nil }

    /// The setup token is used here and never stored.
    func claim(setupToken: String) async throws {
        let url = try SimpleFIN.claimURL(setupToken: setupToken)
        try store.write(try await client.claim(url))
    }

    /// One `GET /accounts`. At the cap it answers 429 without touching the network.
    func fetch(start: Int, end: Int?, now: Date = Date()) async throws -> (status: Int, body: String, used: Int) {
        guard SimpleFIN.windowOK(start: start, end: end, now: Int(now.timeIntervalSince1970)) else { throw SimpleFIN.Failure.badArgs }
        guard let stored = store.read() else { throw SimpleFIN.Failure.notConnected }
        guard let access = SimpleFIN.access(stored) else { throw SimpleFIN.Failure.notConnected }
        guard budget.take(at: now) else { return (429, "", budget.used(at: now)) }
        do {
            let reply = try await client.accounts(access, start: start, end: end)
            return (reply.status, reply.body, budget.used(at: now))
        } catch let error as URLError {
            if SimpleFIN.neverSent(error) { budget.refund(at: now) }
            throw SimpleFIN.Failure.network
        }
    }

    func disconnect() throws {
        try store.delete()
    }
}

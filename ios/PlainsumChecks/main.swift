// Checks for the tables the app's safety rests on: what the scheme handler will
// serve, what the web view may open, what the bank link will send and where, and
// how often, which backups are kept, who a bridge answers, when the lock asks, what
// a widget shows as its figures age, and what the alerts remember.
// Run with `npm run test:swift`. It compiles the real sources for this Mac, so no
// simulator is needed. The tokens and logins here are invented.
import Foundation

var failures = 0

func check(_ ok: Bool, _ what: String, line: Int = #line) {
    if !ok {
        failures += 1
        print("FAIL line \(line): \(what)")
    }
}

// ---- A bundle on disk, with a secret beside it ---------------------------------
let tmp = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    .appendingPathComponent("plainsum-checks-\(UUID().uuidString)", isDirectory: true)
let root = tmp.appendingPathComponent("Web", isDirectory: true).standardizedFileURL
let fm = FileManager.default
try fm.createDirectory(at: root.appendingPathComponent("assets"), withIntermediateDirectories: true)
try fm.createDirectory(at: tmp.appendingPathComponent("Web2"), withIntermediateDirectories: true)
try Data("<!doctype html>".utf8).write(to: root.appendingPathComponent("index.html"))
try Data("export {}".utf8).write(to: root.appendingPathComponent("assets/app.js"))
try Data("x".utf8).write(to: root.appendingPathComponent("assets/odd.bin"))
try Data("secret".utf8).write(to: tmp.appendingPathComponent("secret.txt"))
try Data("secret".utf8).write(to: tmp.appendingPathComponent("Web2/secret.txt"))
defer { try? fm.removeItem(at: tmp) }

// ---- Paths --------------------------------------------------------------------
func file(_ path: String) -> String? {
    AppSchemeHandler.file(forPath: path, root: root).map { String($0.path.dropFirst(root.path.count)) }
}
check(file("") == "/index.html", "an empty path is index.html")
check(file("/") == "/index.html", "/ is index.html")
check(file("/assets/app.js") == "/assets/app.js", "a file in the bundle resolves")
check(file("/assets/../index.html") == "/index.html", "dots that stay inside resolve")
check(file("/../secret.txt") == nil, "dots out of the root are refused")
check(file("/assets/../../secret.txt") == nil, "dots out through a folder are refused")
check(file("/../Web2/secret.txt") == nil, "a sibling sharing the root's prefix is refused")
check(file("/..") == nil, "the root's parent is refused")

// ---- Replies ------------------------------------------------------------------
func reply(_ url: String, method: String? = "GET") -> AppSchemeHandler.Reply {
    AppSchemeHandler.reply(method: method, url: URL(string: url), root: root)
}
check(reply("plainsum://app/index.html").status == 200, "the start URL is served")
check(reply("plainsum://app/index.html").mime == "text/html", "html is text/html")
check(reply("plainsum://app/").mime == "text/html", "/ serves the page")
check(reply("plainsum://app").status == 200, "no path serves the page")
check(reply("plainsum://app/assets/app.js").mime == "text/javascript", "a module script has its type")
check(reply("plainsum://app/assets/odd.bin").mime == "application/octet-stream", "an unknown type is opaque")
check(reply("plainsum://app/index.html", method: "POST").status == 405, "only GET")
check(reply("plainsum://app/index.html", method: nil).status == 200, "no method is a GET")
check(reply("plainsum://other/index.html").status == 404, "only host app")
check(reply("plainsum://app/nope.js").status == 404, "a missing file is a 404")
check(reply("plainsum://app/assets").status == 404, "a folder is a 404")
check(reply("plainsum://app/..%2fsecret.txt").status == 404, "an encoded slash cannot climb out")
check(reply("plainsum://app/%2e%2e/secret.txt").status == 404, "encoded dots cannot climb out")
check(AppSchemeHandler.reply(method: "GET", url: nil, root: root).status == 404, "no URL is a 404")

let served = reply("plainsum://app/assets/app.js").response(for: URL(string: "plainsum://app/assets/app.js")!)
check(served.statusCode == 200, "the response carries the status")
check(served.value(forHTTPHeaderField: "Content-Type") == "text/javascript", "Content-Type")
check(served.value(forHTTPHeaderField: "Content-Length") == "9", "Content-Length")
check(served.value(forHTTPHeaderField: "Cache-Control") == "no-store", "Cache-Control")
for (ext, type) in [("mjs", "text/javascript"), ("css", "text/css"), ("json", "application/json"), ("woff2", "font/woff2"),
                    ("svg", "image/svg+xml"), ("png", "image/png"), ("JS", "text/javascript")] {
    check(AppSchemeHandler.mime(forExtension: ext) == type, ".\(ext) is \(type)")
}

// ---- Navigation ---------------------------------------------------------------
func decide(_ url: String) -> Allowlist.Decision { Allowlist.decide(URL(string: url)) }
check(decide("plainsum://app/index.html") == .allow, "the app's own page loads")
check(decide("plainsum://app/index.html#budget") == .allow, "hash routes load")
check(decide("about:blank") == .allow, "about:blank loads")
check(decide("about:srcdoc") == .drop, "other about: pages do not")
check(decide("plainsum://other/index.html") == .drop, "another host on the scheme does not")
check(decide("https://bridge.simplefin.org/") == .openExternally, "SimpleFIN goes to Safari")
check(decide("https://beta-bridge.simplefin.org/info") == .openExternally, "the beta bridge too")
check(decide("https://www.simplefin.org/") == .openExternally, "and its site")
check(decide("HTTPS://BRIDGE.SIMPLEFIN.ORG/") == .openExternally, "case does not matter")
check(decide("http://bridge.simplefin.org/") == .drop, "plain http does not")
check(decide("https://bridge.simplefin.org.example.com/") == .drop, "a look-alike host does not")
check(decide("https://example.com/") == .drop, "any other host is dropped")
check(decide("https://user@example.com@bridge.simplefin.org.evil.test/") == .drop, "userinfo tricks are dropped")
check(decide("https://user:pw@bridge.simplefin.org/") == .drop, "a listed host with credentials is dropped")
check(decide("https://bridge.simplefin.org:8443/") == .drop, "a listed host on another port is dropped")
check(decide("plainsum://app:8080/index.html") == .drop, "the app's host on a port is not the app")
check(decide("mailto:someone@example.com") == .drop, "no mailto until a support address exists")
check(decide("tel:5551234") == .drop, "tel: is dropped")
check(decide("data:text/html,hi") == .drop, "data: is dropped")
check(decide("blob:plainsum://app/x") == .drop, "blob: is dropped")
check(decide("javascript:alert(1)") == .drop, "javascript: is dropped")
check(decide("file:///etc/passwd") == .drop, "file: is dropped")
check(Allowlist.decide(nil) == .drop, "no URL is dropped")

// ---- Origins ------------------------------------------------------------------
check(AppSchemeHandler.isOwnOrigin(scheme: "plainsum", host: "app", port: 0), "the app's own page")
check(!AppSchemeHandler.isOwnOrigin(scheme: "plainsum", host: "other", port: 0), "another host on the scheme")
check(!AppSchemeHandler.isOwnOrigin(scheme: "plainsum", host: "app", port: 8080), "the app's host on a port")
check(!AppSchemeHandler.isOwnOrigin(scheme: "https", host: "app", port: 0), "another scheme")
check(!AppSchemeHandler.isOwnOrigin(scheme: "https", host: "bridge.simplefin.org", port: 0), "a web page")

// ---- Setup tokens -------------------------------------------------------------
func token(_ url: String) -> String { Data(url.utf8).base64EncodedString() }
func claimFailure(_ t: String) -> SimpleFIN.Failure? {
    do {
        _ = try SimpleFIN.claimURL(setupToken: t)
        return nil
    } catch {
        return error as? SimpleFIN.Failure
    }
}
let claim = "https://bridge.simplefin.org/simplefin/claim/ABC123"
check((try? SimpleFIN.claimURL(setupToken: token(claim)))?.absoluteString == claim, "a token decodes to its claim URL")
check((try? SimpleFIN.claimURL(setupToken: "  \(token(claim))\n"))?.absoluteString == claim, "pasted whitespace does not matter")
let split = token(claim)
check((try? SimpleFIN.claimURL(setupToken: split.prefix(20) + "\n" + split.dropFirst(20)))?.absoluteString == claim, "a wrapped token reads")
let unpadded = token("https://bridge.simplefin.org/x").replacingOccurrences(of: "=", with: "")
check((try? SimpleFIN.claimURL(setupToken: unpadded)) != nil, "a token without padding reads, as atob does")
check((try? SimpleFIN.claimURL(setupToken: token("https://beta-bridge.simplefin.org/claim/DEMO"))) != nil, "the beta bridge is SimpleFIN")
check((try? SimpleFIN.claimURL(setupToken: token("https://simplefin.org/claim/A"))) != nil, "the bare domain is SimpleFIN")
check((try? SimpleFIN.claimURL(setupToken: token("HTTPS://BRIDGE.SIMPLEFIN.ORG/claim/A"))) != nil, "case does not matter")
for bad in ["http://bridge.simplefin.org/claim/A", "https://example.com/claim/A", "https://bridge.simplefin.org.evil.test/claim/A",
            "https://evilsimplefin.org/claim/A", "https://simplefin.org@evil.test/claim/A", "https://bridge.simplefin.org:pw@evil.test/",
            "https://user:pw@bridge.simplefin.org/claim/A", "ftp://bridge.simplefin.org/claim/A", "file:///etc/passwd",
            "http://169.254.169.254/latest/meta-data", "https://evil.test%2F.simplefin.org/", "https://evil.test%2f.SIMPLEFIN.org/",
            "https://evil.test%23.simplefin.org/", "https://evil.test%3F.simplefin.org/", "https://evil.test%00.simplefin.org/",
            "https://bridge%2Esimplefin.org/claim/A"] {
    check(claimFailure(token(bad)) == .notSimpleFIN, "refused without a request: \(bad)")
}
for host in ["evil.test/.simplefin.org", "evil.test#.simplefin.org", "evil test.simplefin.org", "evil.test%2F.simplefin.org",
             "ev\u{0131}l.simplefin.org", "", nil] as [String?] {
    check(!SimpleFIN.isBridgeHost(host), "not a host name: \(host ?? "nil")")
}
for host in ["simplefin.org", "bridge.simplefin.org", "beta-bridge.simplefin.org", "BRIDGE.SIMPLEFIN.ORG"] {
    check(SimpleFIN.isBridgeHost(host), "a host name: \(host)")
}
for junk in ["", "   ", "!!!!", token("not a url"), token("")] {
    check(claimFailure(junk) == .badToken, "not a token: \(junk)")
}

// ---- Access URLs --------------------------------------------------------------
let goodAccess = "https://user1:s3cret@bridge.simplefin.org/simplefin"
check(SimpleFIN.access(goodAccess)?.base.absoluteString == "https://bridge.simplefin.org/simplefin", "the login leaves the URL")
check(SimpleFIN.access(goodAccess)?.authorization == "Basic " + Data("user1:s3cret".utf8).base64EncodedString(), "and becomes a header")
check(SimpleFIN.access("https://us%40er:p%3Aw@bridge.simplefin.org/simplefin/")?.authorization
      == "Basic " + Data("us@er:p:w".utf8).base64EncodedString(), "a percent-encoded login is decoded")
check(SimpleFIN.access("https://u:p@bridge.simplefin.org/simplefin///")?.base.absoluteString == "https://bridge.simplefin.org/simplefin", "trailing slashes go")
check(SimpleFIN.access(" \(goodAccess)\n") != nil, "a body with a newline reads")
for bad in ["http://u:p@bridge.simplefin.org/simplefin", "https://u:p@example.com/simplefin", "https://bridge.simplefin.org/simplefin",
            "https://u@bridge.simplefin.org/simplefin", "https://:p@bridge.simplefin.org/simplefin", "https://u:@bridge.simplefin.org/simplefin",
            "https://u:p@bridge.simplefin.org.evil.test/simplefin", "https://u:p@evil.test%2F.simplefin.org/simplefin",
            "https://u:p@bridge%2Esimplefin.org/simplefin", "<html>sorry</html>", ""] {
    check(SimpleFIN.access(bad) == nil, "not an access URL: \(bad)")
}

// ---- Windows ------------------------------------------------------------------
let t0 = 2_000_000_000
let dayS = 86_400
check(SimpleFIN.windowOK(start: t0 - 90 * dayS, end: t0, now: t0), "90 days closed is allowed")
check(!SimpleFIN.windowOK(start: t0 - 90 * dayS - 1, end: t0, now: t0), "a second more is not")
check(SimpleFIN.windowOK(start: t0 - 89 * dayS, end: nil, now: t0), "89 days open is allowed")
check(!SimpleFIN.windowOK(start: t0 - 90 * dayS, end: nil, now: t0), "90 days open is not: the bridge caps it")
check(!SimpleFIN.windowOK(start: t0, end: t0 - dayS, now: t0), "an end before the start is refused")
check(!SimpleFIN.windowOK(start: t0, end: t0, now: t0), "an empty window is refused")
let accountsBase = URL(string: "https://bridge.simplefin.org/simplefin")!
check(SimpleFIN.accountsURL(base: accountsBase, start: 100, end: nil)?.absoluteString
      == "https://bridge.simplefin.org/simplefin/accounts?start-date=100&pending=1&version=1", "an open window")
check(SimpleFIN.accountsURL(base: accountsBase, start: 100, end: 200)?.absoluteString
      == "https://bridge.simplefin.org/simplefin/accounts?start-date=100&end-date=200&pending=1&version=1", "a closed window")

// ---- The day's budget ---------------------------------------------------------
func freshDefaults() -> UserDefaults {
    let name = "plainsum-checks-\(UUID().uuidString)"
    let d = UserDefaults(suiteName: name)!
    d.removePersistentDomain(forName: name)
    return d
}
let budget = RequestBudget(defaults: freshDefaults())
let at = Date(timeIntervalSince1970: TimeInterval(t0))
for i in 0..<24 { check(budget.take(at: at.addingTimeInterval(TimeInterval(i))), "request \(i + 1) of 24") }
check(!budget.take(at: at.addingTimeInterval(30)), "the 25th is refused")
check(budget.used(at: at.addingTimeInterval(30)) == 24, "and not counted")
check(!budget.take(at: at.addingTimeInterval(86_399)), "still refused just inside the day")
check(budget.take(at: at.addingTimeInterval(86_400)), "free again as the oldest leaves the day")
check(!budget.take(at: at.addingTimeInterval(86_400)), "and only by that many")
let backwards = RequestBudget(defaults: freshDefaults())
for _ in 0..<24 { _ = backwards.take(at: at) }
check(backwards.take(at: at.addingTimeInterval(-600)), "a clock moved back does not hold the app at the cap")
let returned = RequestBudget(defaults: freshDefaults())
_ = returned.take(at: at)
_ = returned.take(at: at)
_ = returned.take(at: at.addingTimeInterval(1))
returned.refund(at: at)
check(returned.used(at: at.addingTimeInterval(1)) == 2, "a refund gives back one, not every request of that moment")
returned.refund(at: at.addingTimeInterval(5))
check(returned.used(at: at.addingTimeInterval(5)) == 2, "and gives back nothing that was not taken")

// ---- The bank link, against a stub server --------------------------------------
final class Stub: URLProtocol {
    nonisolated(unsafe) static var seen: [URLRequest] = []
    nonisolated(unsafe) static var answer: (URLRequest) -> (status: Int, body: String, redirect: String?)? = { _ in nil }
    /// How a request with no answer fails.
    nonisolated(unsafe) static var failure = URLError.Code.notConnectedToInternet

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        Stub.seen.append(request)
        guard let a = Stub.answer(request), let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(Stub.failure))
            return
        }
        let headers = a.redirect.map { ["Location": $0] } ?? [:]
        let response = HTTPURLResponse(url: url, statusCode: a.status, httpVersion: "HTTP/1.1", headerFields: headers)!
        if let target = a.redirect.flatMap(URL.init(string:)) {
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: target), redirectResponse: response)
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(a.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class MemoryStore: SecretStore {
    var secret: String?
    func read() -> String? { secret }
    func write(_ s: String) throws { secret = s }
    func delete() throws { secret = nil }
}

let stubbed = SimpleFINClient.configuration()
stubbed.protocolClasses = [Stub.self]
let client = SimpleFINClient(configuration: stubbed)

@MainActor func failure(_ run: () async throws -> Void) async -> SimpleFIN.Failure? {
    do {
        try await run()
        return nil
    } catch {
        return error as? SimpleFIN.Failure
    }
}

@MainActor func checkLink() async {
    let store = MemoryStore()
    let link = BankLink(client: client, store: store, defaults: freshDefaults())
    let setup = token("https://bridge.simplefin.org/simplefin/claim/ABC123")
    check(!link.connected, "no link to begin with")

    // Claim
    Stub.seen = []
    Stub.answer = { _ in (200, "\(goodAccess)\n", nil) }
    check(await failure { try await link.claim(setupToken: setup) } == nil, "a good token claims")
    check(store.secret == goodAccess, "the access URL is stored, trimmed")
    check(link.connected, "and the link is up")
    check(Stub.seen.count == 1 && Stub.seen[0].httpMethod == "POST", "one POST")
    check(Stub.seen[0].url?.absoluteString == "https://bridge.simplefin.org/simplefin/claim/ABC123", "to the claim URL")
    check(Stub.seen[0].value(forHTTPHeaderField: "Authorization") == nil, "with no credentials")

    Stub.seen = []
    Stub.answer = { _ in (200, goodAccess.replacingOccurrences(of: "user1", with: "other"), nil) }
    check(await failure { try await link.claim(setupToken: token("https://example.com/claim/A")) } == .notSimpleFIN, "another host is refused")
    check(Stub.seen.isEmpty, "with nothing sent")
    check(store.secret == goodAccess, "and the stored link is kept")

    Stub.answer = { _ in (403, "Forbidden", nil) }
    check(await failure { try await link.claim(setupToken: setup) } == .claimRefused, "a used token")
    Stub.answer = { _ in (500, "oops", nil) }
    check(await failure { try await link.claim(setupToken: setup) } == .claimFailed, "a server error")
    Stub.answer = { _ in (200, "https://u:p@example.com/simplefin", nil) }
    check(await failure { try await link.claim(setupToken: setup) } == .claimFailed, "an access URL on another host")
    Stub.answer = { _ in (200, "http://u:p@bridge.simplefin.org/simplefin", nil) }
    check(await failure { try await link.claim(setupToken: setup) } == .claimFailed, "an access URL over http")
    Stub.answer = { _ in nil }
    check(await failure { try await link.claim(setupToken: setup) } == .network, "no connection")
    check(store.secret == goodAccess, "none of those touched the stored link")

    Stub.seen = []
    Stub.answer = { _ in (302, "", "https://example.com/steal") }
    check(await failure { try await link.claim(setupToken: setup) } == .claimFailed, "a redirect is not followed")
    check(Stub.seen.count == 1, "so nothing goes to its target")

    // Fetch
    let now = Date(timeIntervalSince1970: TimeInterval(t0))
    Stub.seen = []
    Stub.answer = { _ in (200, "{\"accounts\":[]}", nil) }
    let reply = try? await link.fetch(start: t0 - 44 * dayS, end: nil, now: now)
    check(reply?.status == 200 && reply?.body == "{\"accounts\":[]}" && reply?.used == 1, "an answer comes back whole")
    check(Stub.seen.count == 1 && Stub.seen[0].httpMethod == "GET", "one GET")
    check(Stub.seen[0].value(forHTTPHeaderField: "Authorization") == SimpleFIN.access(goodAccess)?.authorization, "the login is in the header")
    check(Stub.seen[0].url?.user == nil && Stub.seen[0].url?.password == nil, "and not in the URL")
    check(Stub.seen[0].url?.host == "bridge.simplefin.org", "sent to the stored host")

    Stub.answer = { _ in (403, "Forbidden", nil) }
    check((try? await link.fetch(start: t0 - 44 * dayS, end: nil, now: now))?.status == 403, "a refusal comes back as a status")

    Stub.seen = []
    Stub.answer = { _ in (302, "", "https://example.com/steal") }
    check((try? await link.fetch(start: t0 - 44 * dayS, end: nil, now: now))?.status == 302, "a redirect stands as the answer")
    check(Stub.seen.count == 1, "so the login never reaches its target")

    Stub.seen = []
    Stub.answer = { _ in (200, "{}", nil) }
    check(await failure { _ = try await link.fetch(start: t0 - 91 * dayS, end: t0, now: now) } == .badArgs, "a window past 90 days is refused")
    check(Stub.seen.isEmpty, "with nothing sent")

    Stub.answer = { _ in nil }
    check(await failure { _ = try await link.fetch(start: t0 - dayS, end: nil, now: now) } == .network, "no connection")

    // The cap
    let capped = BankLink(client: client, store: store, defaults: freshDefaults())
    Stub.seen = []
    Stub.answer = { _ in (200, "{}", nil) }
    var statuses: [Int] = []
    for _ in 0..<30 {
        statuses.append((try? await capped.fetch(start: t0 - dayS, end: nil, now: now))?.status ?? 0)
    }
    check(statuses.prefix(24).allSatisfy { $0 == 200 }, "24 requests go out")
    check(statuses.suffix(6).allSatisfy { $0 == 429 }, "the rest answer 429")
    check(Stub.seen.count == 24, "without touching the network")

    // Refused requests spend nothing
    let spare = freshDefaults()
    let thrifty = BankLink(client: client, store: store, defaults: spare)
    _ = try? await thrifty.fetch(start: t0 - 91 * dayS, end: t0, now: now)
    check(RequestBudget(defaults: spare).used(at: now) == 0, "a refused window costs nothing")

    // Refunds: only what never left the phone
    Stub.answer = { _ in nil }
    for code in [URLError.Code.notConnectedToInternet, .cannotFindHost, .dnsLookupFailed, .cannotConnectToHost, .dataNotAllowed] {
        let book = freshDefaults()
        let offline = BankLink(client: client, store: store, defaults: book)
        Stub.failure = code
        check(await failure { _ = try await offline.fetch(start: t0 - dayS, end: nil, now: now) } == .network, "\(code.rawValue) reads as no connection")
        check(RequestBudget(defaults: book).used(at: now) == 0, "\(code.rawValue) reached nothing, so it costs nothing")
    }
    for code in [URLError.Code.timedOut, .networkConnectionLost, .secureConnectionFailed, .badServerResponse] {
        let book = freshDefaults()
        let unsure = BankLink(client: client, store: store, defaults: book)
        Stub.failure = code
        check(await failure { _ = try await unsure.fetch(start: t0 - dayS, end: nil, now: now) } == .network, "\(code.rawValue) reads as no connection")
        check(RequestBudget(defaults: book).used(at: now) == 1, "\(code.rawValue) may have reached SimpleFIN, so it counts")
    }
    Stub.failure = .notConnectedToInternet
    let lost = BankLink(client: client, store: store, defaults: freshDefaults())
    for _ in 0..<40 { _ = try? await lost.fetch(start: t0 - dayS, end: nil, now: now) }
    Stub.answer = { _ in (200, "{}", nil) }
    check((try? await lost.fetch(start: t0 - dayS, end: nil, now: now))?.used == 1, "a day offline leaves the whole budget")
    let timedOut = freshDefaults()
    let slow = BankLink(client: client, store: store, defaults: timedOut)
    Stub.answer = { _ in nil }
    Stub.failure = .timedOut
    for _ in 0..<30 { _ = try? await slow.fetch(start: t0 - dayS, end: nil, now: now) }
    check(RequestBudget(defaults: timedOut).used(at: now) == 24, "timeouts still stop at the cap")
    Stub.failure = .notConnectedToInternet

    // A claim's failures read the same, whatever they were
    Stub.failure = .timedOut
    check(await failure { try await link.claim(setupToken: setup) } == .network, "a claim that timed out")
    Stub.failure = .notConnectedToInternet

    // Disconnect
    check(await failure { try link.disconnect() } == nil, "disconnect")
    check(store.secret == nil && !link.connected, "removes the link")
    Stub.seen = []
    check(await failure { _ = try await link.fetch(start: t0 - dayS, end: nil, now: now) } == .notConnected, "no link, no fetch")
    check(Stub.seen.isEmpty, "with nothing sent")

    store.secret = "https://u:p@example.com/simplefin"
    check(await failure { _ = try await link.fetch(start: t0 - dayS, end: nil, now: now) } == .notConnected, "a stored URL off SimpleFIN is never used")
    check(Stub.seen.isEmpty, "with nothing sent")
}
await checkLink()

let session = SimpleFINClient.configuration()
check(session.urlCache == nil && session.httpCookieStorage == nil && session.urlCredentialStorage == nil, "nothing it reads reaches the disk")
check(session.timeoutIntervalForRequest == 60, "60 second timeout")

// ---- First launch -------------------------------------------------------------
var purges = 0
let launch = freshDefaults()
FirstLaunch.run(unlocked: false, defaults: launch) { purges += 1; return true }
check(purges == 0 && !launch.bool(forKey: FirstLaunch.key), "nothing runs before the first unlock")
FirstLaunch.run(unlocked: true, defaults: launch) { purges += 1; return false }
check(purges == 1 && !launch.bool(forKey: FirstLaunch.key), "a failed purge tries again")
FirstLaunch.run(unlocked: true, defaults: launch) { purges += 1; return true }
check(purges == 2 && launch.bool(forKey: FirstLaunch.key), "a fresh install purges and remembers")
FirstLaunch.run(unlocked: true, defaults: launch) { purges += 1; return true }
check(purges == 2, "and never again")

// ---- Erase --------------------------------------------------------------------
@MainActor func checkErase() async throws {
    let box = tmp.appendingPathComponent("erase", isDirectory: true)
    let backups = box.appendingPathComponent("Backups", isDirectory: true)
    let snapshot = box.appendingPathComponent("snapshot.json")
    let kept = box.appendingPathComponent("not-ours.txt")
    let missing = box.appendingPathComponent("never-written.json")
    try fm.createDirectory(at: backups, withIntermediateDirectories: true)
    try Data("{}".utf8).write(to: backups.appendingPathComponent("backup-20261105-120000.json"))
    try Data("{}".utf8).write(to: snapshot)
    try Data("x".utf8).write(to: kept)

    let domain = "plainsum.checks.erase.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: domain)!
    defaults.set(true, forKey: "plainsum.lock")

    var steps: [String] = []
    func erase(keychain: Bool) -> Erase {
        Erase(
            secrets: { steps.append("keychain"); return keychain },
            files: [backups, snapshot, missing],
            defaults: defaults,
            defaultsDomain: domain,
            system: { steps.append("system") },
            webData: { steps.append("web") }
        )
    }

    var refused = false
    do { try await erase(keychain: false).run() } catch { refused = true }
    check(refused, "a Keychain that will not clear fails the erase")
    check(steps == ["keychain"], "and nothing after it runs, so a retry starts from an intact app")
    check(fm.fileExists(atPath: backups.path) && fm.fileExists(atPath: snapshot.path), "the files stay for that retry")
    check(defaults.bool(forKey: "plainsum.lock"), "and so do the preferences")

    steps = []
    try await erase(keychain: true).run()
    check(steps == ["keychain", "system", "web"], "the bank link first, the web data last")
    check(!fm.fileExists(atPath: backups.path), "the backups go, folder and all")
    check(!fm.fileExists(atPath: snapshot.path), "the widget's figures go")
    check(fm.fileExists(atPath: kept.path), "nothing unlisted is touched")
    check(UserDefaults(suiteName: domain)!.object(forKey: "plainsum.lock") == nil, "the preferences go")
    var purgedAfter = false
    FirstLaunch.run(unlocked: true, defaults: UserDefaults(suiteName: domain)!) { purgedAfter = true; return true }
    check(!purgedAfter, "the next launch is not a fresh install: a bank linked after erasing survives it")

    steps = []
    try await erase(keychain: true).run()
    check(steps == ["keychain", "system", "web"], "erasing twice is fine: a missing file is already gone")
}
try await checkErase()

// ---- Backups ------------------------------------------------------------------
func backupName(_ day: Int, _ time: String = "120000") -> String { String(format: "backup-202611%02d-\(time).json", day) }

do {
    check(Backups.date(of: backupName(5)) != nil, "a backup's name is read")
    check(Backups.date(of: Backups.name(at: Date(timeIntervalSince1970: 1_800_000_000)))?.timeIntervalSince1970 == 1_800_000_000, "a name stands for the moment it was written")
    for bad in ["backup-20261105-120000.txt", "../backup-20261105-120000.json", "backup-20261399-120000.json", "backup-2026110x-120000.json",
                "backup-20261105-120000.json/", "backup-20261105-120000.json.json", "backups", "", "/etc/passwd", "backup-٢٠٢٦١١٠٥-120000.json"] {
        check(Backups.date(of: bad) == nil, "\(bad) is not a backup's name")
    }

    // The newest few, then one for each earlier day.
    let morning = (10...19).map { backupName(5, "\($0)0000") }
    let week = (1...4).map { backupName($0) }
    let kept = Backups.kept(morning + week)
    check(kept.count == 7, "seven are kept")
    check(kept.isSuperset(of: morning.suffix(3)), "the three newest stay, whatever their day")
    check(kept.isSuperset(of: week), "a busy morning does not push the earlier days out")
    check(Backups.kept(morning).count == 3, "one day of backups is three, so the week is not all today")
    let month = (1...28).map { backupName($0) }
    check(Backups.kept(month) == Set(month.suffix(7)), "of many days, the latest seven stay")
    check(Backups.kept([]).isEmpty, "nothing to keep is fine")

    // On disk.
    let folder = tmp.appendingPathComponent("Docs/Backups", isDirectory: true)
    let backups = Backups(folder: folder)
    check(backups.list().isEmpty, "a folder that is not there holds none")
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    for hour in 0..<12 { _ = try backups.write("{\"n\":\(hour)}", at: start.addingTimeInterval(Double(hour) * 86400)) }
    let on = backups.list()
    check(on.count == 7, "the folder holds seven after twelve writes")
    check(on.map(\.name) == on.map(\.name).sorted(by: >), "newest first")
    check(on.first?.at == start.addingTimeInterval(11 * 86400), "the first is the last written")
    check(try backups.read(on[0].name) == "{\"n\":11}", "a backup reads back as written")
    check((try? backups.read("../secret.txt")) == nil, "a path is refused")
    check((try? backups.read(backupName(1))) == nil, "a backup that is not there is refused")
    try Data("x".utf8).write(to: folder.appendingPathComponent("notes.txt"))
    check(backups.list().count == 7, "anything else in the folder is not a backup")
    _ = try backups.write("{}", at: start.addingTimeInterval(12 * 86400))
    check(fm.fileExists(atPath: folder.appendingPathComponent("notes.txt").path), "pruning touches only backups")

    // File names from the page.
    check(Backups.safeFileName("budget-transactions-2026-11-05.csv") == "budget-transactions-2026-11-05.csv", "a plain name stands")
    check(Backups.safeFileName("../../etc/passwd") == "etcpasswd", "no path survives")
    check(Backups.safeFileName("..") == "export.txt", "nothing left is a default name")
    check(!Backups.safeFileName(".hidden").hasPrefix("."), "no hidden file")
    check(Backups.safeFileName(String(repeating: "a", count: 500)).count == 100, "a long name is cut")
}

// ---- Who may call -------------------------------------------------------------
do {
    let app = URL(string: "https://example.test/budget/")!
    func page(_ s: String) -> Bool { PageOrigin.isAppURL(URL(string: s), app: app) }
    check(page("https://example.test/budget/"), "the app's page")
    check(page("https://example.test/budget"), "without the slash")
    check(page("https://example.test/budget/index.html#home"), "a page under it")
    check(page("HTTPS://EXAMPLE.TEST/budget/"), "case does not matter")
    check(!page("https://example.test/budgets/"), "a sibling sharing its prefix")
    check(!page("https://example.test/other/"), "another page on the same host")
    check(!page("https://evil.test/budget/"), "another host")
    check(!page("https://example.test.evil.test/budget/"), "a host ending in another")
    check(!page("http://example.test/budget/"), "plain http")
    check(!page("https://example.test:8443/budget/"), "another port")
    check(!PageOrigin.isAppURL(nil, app: app), "no URL at all")
    check(PageOrigin.isAppOrigin(scheme: "https", host: "example.test", port: 0, app: app), "WebKit reports 0 for the default port")
    check(!PageOrigin.isAppOrigin(scheme: "https", host: "example.test", port: 8443, app: app), "another port's origin")
    check(!PageOrigin.isAppOrigin(scheme: "http", host: "example.test", port: 0, app: app), "another scheme's origin")
    check(!PageOrigin.isAppOrigin(scheme: "https", host: "evil.test", port: 0, app: app), "another host's origin")
}

// ---- The lock -----------------------------------------------------------------
// Walks what the system does. `prompts` counts every prompt the machine starts, and
// `prompt` is the scene moving around one: inactive, then active, with the answer
// landing on either side of the return, because the system gives no order.
struct LockWalk {
    var machine: LockMachine
    var clock: TimeInterval = 1000
    var enabled: Bool
    var after: TimeInterval
    var prompts = 0

    init(enabled: Bool = true, after: TimeInterval = 60) {
        machine = LockMachine(enabled: enabled)
        self.enabled = enabled
        self.after = after
    }

    private mutating func started(_ ask: Bool) {
        if ask {
            prompts += 1
            machine.willAuthenticate()
        }
    }

    mutating func wait(_ seconds: TimeInterval) { clock += seconds }
    mutating func deactivate() { machine.willDeactivate(now: clock) }
    mutating func activate() { started(machine.didActivate(now: clock, enabled: enabled, after: after)) }
    mutating func answer(_ passed: Bool) {
        started(machine.didAuthenticate(passed: passed, now: clock, enabled: enabled, after: after))
    }
    mutating func leave() {
        deactivate()
        machine.didEnterBackground(now: clock)
    }
    mutating func glance(_ seconds: TimeInterval = 2) {
        deactivate()
        wait(seconds)
        activate()
    }
    mutating func prompt(_ passed: Bool, answerFirst: Bool) {
        deactivate()
        wait(1)
        if answerFirst {
            answer(passed)
            activate()
        } else {
            activate()
            answer(passed)
        }
    }
    /// The Unlock button, or the Settings row: anything that asks by hand.
    mutating func askByHand() {
        machine.willAuthenticate()
        prompts += 1
    }
}

do {
    // Off: nothing ever asks, and the cover only shows while the app is away.
    var off = LockWalk(enabled: false)
    check(!off.machine.covered, "off: nothing covers the app at launch")
    off.activate()
    check(off.prompts == 0 && !off.machine.covered, "off: launch does not ask")
    off.deactivate()
    check(off.machine.covered, "off: the cover is up as soon as the app goes inactive")
    off.machine.didEnterBackground(now: off.clock)
    check(off.machine.covered, "off: still up in the background, where the switcher takes its picture")
    off.wait(3600)
    off.activate()
    check(off.prompts == 0 && !off.machine.covered, "off: back after an hour, the cover is gone and nothing asks")

    for answerFirst in [true, false] {
        let order = answerFirst ? "answer first" : "return first"

        // A launch with the lock on.
        var launch = LockWalk()
        check(launch.machine.locked && launch.machine.covered, "on: covered before the first frame")
        launch.activate()
        check(launch.prompts == 1, "on: launch asks once")
        check(launch.machine.covered, "on: covered while asking")
        launch.prompt(true, answerFirst: answerFirst)
        check(!launch.machine.locked && !launch.machine.covered, "\(order): a pass opens the app")
        check(launch.prompts == 1, "\(order): a pass does not ask again")

        // Cancelled or failed: covered, and no loop of prompts.
        var cancel = LockWalk()
        cancel.activate()
        cancel.prompt(false, answerFirst: answerFirst)
        check(cancel.machine.locked && cancel.machine.covered, "\(order): a cancel exposes nothing")
        check(cancel.prompts == 1, "\(order): a cancel does not ask again by itself")
        check(!cancel.machine.authenticating, "\(order): a cancel leaves the Unlock button live")
        for _ in 0..<5 {
            cancel.askByHand()
            cancel.prompt(false, answerFirst: answerFirst)
            check(cancel.machine.covered && !cancel.machine.authenticating, "\(order): every failed try stays covered and can try again")
        }
        check(cancel.prompts == 6, "\(order): only the taps asked")
        cancel.askByHand()
        cancel.prompt(true, answerFirst: answerFirst)
        check(!cancel.machine.covered, "\(order): the button gets back in after any number of failures")

        // A glance after a cancel is not an arrival, a trip to the background is.
        var glance = LockWalk()
        glance.activate()
        glance.prompt(false, answerFirst: answerFirst)
        glance.glance()
        check(glance.prompts == 1 && glance.machine.covered, "\(order): Control Center over the cover does not ask")
        glance.leave()
        glance.wait(5)
        glance.activate()
        check(glance.prompts == 2 && glance.machine.covered, "\(order): coming back from the background asks")

        // Right away: the relock must not read its own prompt as another return.
        var now = LockWalk(after: 0)
        now.activate()
        now.prompt(true, answerFirst: answerFirst)
        now.leave()
        now.activate()
        check(now.prompts == 2 && now.machine.locked, "\(order): right away asks on any return from the background")
        now.prompt(true, answerFirst: answerFirst)
        check(now.prompts == 2 && !now.machine.covered, "\(order): right away does not ask twice")

        // Turning it on or off from Settings: a prompt with nothing locked.
        var toggle = LockWalk(enabled: false)
        toggle.activate()
        toggle.askByHand()
        check(!toggle.machine.locked, "\(order): asking does not lock")
        toggle.enabled = true
        toggle.prompt(true, answerFirst: answerFirst)
        check(!toggle.machine.covered, "\(order): turning it on does not lock the app it was turned on in")
        check(toggle.prompts == 1, "\(order): turning it on asks once")
        toggle.askByHand()
        toggle.prompt(false, answerFirst: answerFirst)
        check(!toggle.machine.covered, "\(order): cancelling a change leaves the open app open")
        toggle.leave()
        toggle.wait(30)
        toggle.activate()
        check(!toggle.machine.covered, "\(order): a prompt in Settings starts no clock of its own")
    }

    // The timeout.
    var timeout = LockWalk()
    timeout.activate()
    timeout.prompt(true, answerFirst: true)
    timeout.leave()
    timeout.wait(59)
    timeout.activate()
    check(!timeout.machine.locked && !timeout.machine.covered, "under the timeout the app just opens")
    check(timeout.prompts == 1, "under the timeout nothing asks")
    timeout.leave()
    timeout.wait(60)
    timeout.activate()
    check(timeout.machine.locked && timeout.prompts == 2, "at the timeout it asks")
    timeout.prompt(true, answerFirst: true)
    timeout.leave()
    timeout.wait(59)
    timeout.activate()
    check(!timeout.machine.locked, "the clock starts again from each departure")

    var long = LockWalk(after: 300)
    long.activate()
    long.prompt(true, answerFirst: true)
    long.leave()
    long.wait(299)
    long.activate()
    check(!long.machine.locked, "a longer setting is honoured")
    long.leave()
    long.wait(300)
    long.activate()
    check(long.machine.locked, "and it ends")

    // Each absence is its own: time in the app between two short trips does not count.
    var twice = LockWalk()
    twice.activate()
    twice.prompt(true, answerFirst: true)
    twice.leave()
    twice.wait(50)
    twice.activate()
    twice.wait(600)
    twice.leave()
    twice.wait(5)
    twice.activate()
    check(!twice.machine.locked && twice.prompts == 1, "two short trips do not add up")

    // Only inactive: a glance is free, a long absence is not.
    var inactive = LockWalk(after: 0)
    inactive.activate()
    inactive.prompt(true, answerFirst: true)
    inactive.glance(59)
    check(!inactive.machine.locked && inactive.prompts == 1, "right away does not ask after a glance")
    inactive.glance(60)
    check(inactive.machine.locked && inactive.prompts == 2, "a minute inactive counts as away, and asks")

    // The time away starts when it left, not when it reached the background.
    var slow = LockWalk()
    slow.activate()
    slow.prompt(true, answerFirst: true)
    slow.deactivate()
    slow.wait(45)
    slow.machine.didEnterBackground(now: slow.clock)
    slow.wait(15)
    slow.activate()
    check(slow.machine.locked, "time away counts from going inactive")

    // Leaving during a prompt: the system ends it, and the answer can land anywhere.
    var mid = LockWalk()
    mid.activate()
    mid.deactivate()
    mid.machine.didEnterBackground(now: mid.clock)
    mid.answer(false)
    check(mid.machine.covered && mid.prompts == 1, "a prompt ended by leaving stays covered, and does not ask in the background")
    mid.wait(5)
    mid.activate()
    check(mid.prompts == 2 && mid.machine.covered, "the return asks again")

    var late = LockWalk()
    late.activate()
    late.deactivate()
    late.machine.didEnterBackground(now: late.clock)
    late.wait(5)
    late.activate()
    check(late.prompts == 1, "the old prompt has not answered, so nothing new starts")
    late.answer(false)
    check(late.prompts == 2 && late.machine.covered, "its late answer starts the prompt the return was owed")

    // A pass as the app leaves must not uncover it for the switcher's picture, and
    // does not count for the time away.
    var pass = LockWalk()
    pass.activate()
    pass.deactivate()
    pass.machine.didEnterBackground(now: pass.clock)
    pass.answer(true)
    check(!pass.machine.locked && pass.machine.covered, "a pass in the background keeps the cover up")
    pass.wait(120)
    pass.activate()
    check(pass.machine.locked && pass.prompts == 2, "and the time away after it still relocks")

    var quick = LockWalk()
    quick.activate()
    quick.deactivate()
    quick.machine.didEnterBackground(now: quick.clock)
    quick.answer(true)
    quick.wait(5)
    quick.activate()
    check(!quick.machine.covered && quick.prompts == 1, "a quick return after that pass just opens")

    // Inactive at the moment of a pass is the prompt closing, so the cover waits for active.
    var closing = LockWalk()
    closing.activate()
    closing.deactivate()
    closing.answer(true)
    check(closing.machine.covered, "the cover stays until the scene is back")
    closing.activate()
    check(!closing.machine.covered && closing.prompts == 1, "and goes when it is")

    // A prompt left up for minutes: passcode entry, or the phone put down. Its own scene
    // change must not read as time away, or the cancel would ask again or lock an open app.
    var slowCancel = LockWalk()
    slowCancel.activate()
    slowCancel.deactivate()
    slowCancel.wait(600)
    slowCancel.answer(false)
    slowCancel.activate()
    check(slowCancel.prompts == 1 && slowCancel.machine.covered, "a long prompt that is cancelled does not ask again")

    var slowToggle = LockWalk()
    slowToggle.activate()
    slowToggle.prompt(true, answerFirst: true)
    slowToggle.askByHand()
    slowToggle.deactivate()
    slowToggle.wait(600)
    slowToggle.answer(false)
    slowToggle.activate()
    check(!slowToggle.machine.locked && !slowToggle.machine.covered, "a long prompt in Settings does not lock the open app")

    // Locked stays locked however long, and however it is reached.
    var stuck = LockWalk()
    stuck.activate()
    stuck.prompt(false, answerFirst: true)
    stuck.wait(3600)
    stuck.leave()
    check(stuck.machine.locked && stuck.machine.covered, "locked stays locked in the background")

    // A launch that never gets a passcode to ask for opens (AppLock answers true).
    var none = LockWalk()
    none.activate()
    none.answer(true)
    check(!none.machine.covered, "a device with no passcode is let in")

    // Erase All can finish while the app sits relocked behind the cover.
    var erasedLocked = LockWalk()
    erasedLocked.activate()
    erasedLocked.prompt(false, answerFirst: true)
    erasedLocked.enabled = false
    erasedLocked.glance()
    check(!erasedLocked.machine.locked && !erasedLocked.machine.covered, "with the setting gone a locked app opens")

    // Erase All clears the setting under a running app.
    var erased = LockWalk()
    erased.activate()
    erased.prompt(true, answerFirst: true)
    erased.enabled = false
    erased.leave()
    erased.wait(3600)
    erased.activate()
    check(!erased.machine.locked && !erased.machine.covered && erased.prompts == 1, "with the setting gone nothing relocks")
}

// ---- The widget's figures -------------------------------------------------------
let pacificZone = TimeZone(identifier: "America/Los_Angeles")!
var pacific = Calendar(identifier: .gregorian)
pacific.timeZone = pacificZone
let us = Locale(identifier: "en_US")

func moment(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 0, _ min: Int = 0) -> Date {
    pacific.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
}

func wire(_ change: (inout [String: Any]) -> Void = { _ in }) -> [String: Any] {
    var args: [String: Any] = [
        "v": 1, "asOf": moment(2026, 11, 5, 15, 12).timeIntervalSince1970 * 1000, "month": "2026-11", "hasBudget": true,
        "budget": 2000, "spent": 1587.65, "left": 412.35, "over": false, "state": "ok", "label": "November · day 5 of 30",
        "stateWord": "On track", "whole": "$412", "cents": ".35", "unit": "left", "budgetLine": "of $2,000 budget",
        "forecast": "~$1,950 by month-end", "rail": 0.79, "pace": 0.17,
    ]
    change(&args)
    return args
}

let sent = WidgetSnapshot(args: wire())!
check(sent.whole == "$412" && sent.cents == ".35" && sent.state == .ok, "a snapshot from the page reads back as sent")
check(WidgetSnapshot(args: wire { $0["v"] = 2 }) == nil, "a version this build does not know is refused")
check(WidgetSnapshot(args: wire { $0["state"] = "fine" }) == nil, "an unknown state is refused")
check(WidgetSnapshot(args: wire { $0["whole"] = nil }) == nil, "a missing field is refused")
check(WidgetSnapshot(args: wire { $0["whole"] = 412 }) == nil, "a figure must arrive formatted")
check(WidgetSnapshot(args: wire { $0["rail"] = Double.nan }) == nil, "NaN is refused without trapping")
check(WidgetSnapshot(args: wire { $0["rail"] = Double.infinity }) == nil, "infinity is refused without trapping")
check(WidgetSnapshot(args: wire { $0["rail"] = 1.2 }) == nil, "a rail past the end is refused")
check(WidgetSnapshot(args: wire { $0["rail"] = 0; $0["left"] = 2050.25; $0["spent"] = -50.25 }) != nil, "a month of refunds is a snapshot")
check(WidgetSnapshot(args: wire { $0["pace"] = -0.1 }) == nil, "a pace before the start is refused")
check(WidgetSnapshot(args: wire { $0["asOf"] = 0 }) == nil, "a snapshot from no time is refused")
check(WidgetSnapshot(args: wire { $0["month"] = "2026-13" }) == nil, "a month that does not exist is refused")
check(WidgetSnapshot(args: wire { $0["month"] = "../../x" }) == nil, "a month must be a month")
check(WidgetSnapshot(args: wire { $0["label"] = String(repeating: "x", count: 81) }) == nil, "a line too long for a widget is refused")

// Only the known fields reach the file, whatever the page sends.
let widgetFile = tmp.appendingPathComponent("snapshot.json")
try WidgetSnapshot(args: wire { $0["merchant"] = "Harbor Coffee" })!.write(to: widgetFile)
let onDisk = String(decoding: try Data(contentsOf: widgetFile), as: UTF8.self)
check(!onDisk.contains("Harbor"), "a field that is not in the snapshot is not written")
check(WidgetSnapshot.read(from: widgetFile) == sent, "a snapshot reads back from its file")
try Data("{not json".utf8).write(to: widgetFile)
check(WidgetSnapshot.read(from: widgetFile) == nil, "a damaged file reads as none")
check(WidgetSnapshot.read(from: tmp.appendingPathComponent("gone.json")) == nil, "a missing file reads as none")

check(WidgetSnapshot.groupID(bundleID: "com.example.app") == "group.com.example.app", "an app's group is named after it")
check(WidgetSnapshot.groupID(bundleID: "com.example.app.widgets") == "group.com.example.app", "its widget finds the same group")

func face(_ date: Date, _ snapshot: WidgetSnapshot? = sent) -> WidgetFace {
    WidgetFace.at(date, snapshot: snapshot, app: "Example", zone: pacificZone, locale: us)
}
func figure(_ date: Date, _ snapshot: WidgetSnapshot? = sent) -> WidgetFigure? {
    if case .figure(let f) = face(date, snapshot) { return f }
    return nil
}
// The time format's space depends on the OS, so it is compared without it.
func plain(_ s: String?) -> String? { s?.replacingOccurrences(of: "\u{202F}", with: " ") }

check(plain(figure(moment(2026, 11, 5, 15, 13))?.updated) == "Updated 3:12 PM", "the same day says the time")
check(figure(moment(2026, 11, 5, 15, 13))?.headline == "On track", "fresh figures keep Home's word")
check(figure(moment(2026, 11, 5, 15, 13))?.snapshot.whole == "$412", "the figure is the page's, untouched")
check(figure(moment(2026, 11, 5, 23, 59))?.stale == false, "still fresh at the end of the day")
check(figure(moment(2026, 11, 6, 0, 0))?.updated == "Updated Nov 5", "the next day says the date")
check(figure(moment(2026, 11, 6, 0, 0))?.when == "Nov 5", "the short form says the date too")
check(figure(moment(2026, 11, 6, 9, 0))?.stale == false, "opening once a day never reads as stale")
check(figure(moment(2026, 11, 7, 15, 11))?.stale == false, "just under two days is not stale")
check(figure(moment(2026, 11, 7, 15, 12))?.stale == true, "two days is stale")
check(figure(moment(2026, 11, 7, 15, 12))?.headline == "Open Example to update", "stale figures stop claiming a state")
check(figure(moment(2026, 11, 7, 15, 12))?.updated == "Updated Nov 5", "stale figures say how old they are")
check(figure(moment(2026, 11, 30, 23, 59))?.snapshot.whole == "$412", "the figure stays until the month ends")
check(face(moment(2026, 12, 1)) == .prompt("Open Example to update"), "a new month shows no old figure")
check(face(moment(2027, 11, 5)) == .prompt("Open Example to update"), "nor does the same month a year on")
check(face(moment(2026, 10, 31, 23, 59)) == .prompt("Open Example to update"), "a clock set back shows no figure from ahead")
check(face(moment(2026, 11, 5), nil) == .prompt("Open Example to update"), "nothing written yet asks for the app")
var noBudget = sent
noBudget.hasBudget = false
check(face(moment(2026, 11, 5, 16), noBudget) == .prompt("Set a budget in Example"), "no budget asks for one")
check(face(moment(2026, 12, 2), noBudget) == .prompt("Open Example to update"), "a month old, the budget may be set")

// The face changes by itself at these moments, and the timeline must hold them.
let read = moment(2026, 11, 5, 15, 12)
check(WidgetFace.changes(after: read, snapshot: sent, zone: pacificZone) == [moment(2026, 11, 6), moment(2026, 11, 7, 15, 12), moment(2026, 12, 1)], "a day, the stale mark and the month end, in order")
check(WidgetFace.changes(after: moment(2026, 11, 6, 12), snapshot: sent, zone: pacificZone) == [moment(2026, 11, 7, 15, 12), moment(2026, 12, 1)], "only what is still to come")
check(WidgetFace.changes(after: moment(2026, 12, 2), snapshot: sent, zone: pacificZone).isEmpty, "nothing left once the month is over")
check(WidgetFace.changes(after: read, snapshot: nil, zone: pacificZone).isEmpty, "nothing to change without a snapshot")
var lateInMonth = sent
lateInMonth.asOf = moment(2026, 11, 29, 15, 12).timeIntervalSince1970 * 1000
check(WidgetFace.changes(after: moment(2026, 11, 29, 15, 12), snapshot: lateInMonth, zone: pacificZone) == [moment(2026, 11, 30), moment(2026, 12, 1), moment(2026, 12, 1, 15, 12)], "a month that ends before the stale mark stays in order")
var december = sent
december.month = "2026-12"
december.asOf = moment(2026, 12, 31, 22).timeIntervalSince1970 * 1000
check(WidgetFace.changes(after: moment(2026, 12, 31, 22), snapshot: december, zone: pacificZone).contains(moment(2027, 1, 1)), "December ends in January")
check(face(moment(2027, 1, 1), december) == .prompt("Open Example to update"), "and January shows no December figure")

// ---- The alerts' record -----------------------------------------------------------
do {
    let suite = "plainsum-checks-\(UUID().uuidString)"
    let store = UserDefaults(suiteName: suite)!
    defer { store.removePersistentDomain(forName: suite) }
    let book = AlertBook(defaults: store)
    check(!book.budgets && !book.weekly, "both start off")
    check(book.weekday == 1 && book.hour == 18, "the reminder starts on Sunday evening")
    check(book.fired.isEmpty, "nothing has gone yet")

    book.mark(["a-2026-11-80"])
    check(book.hasFired("a-2026-11-80"), "a marked line has gone")
    check(!book.hasFired("a-2026-11-100"), "and the line above it has not")
    check(!book.hasFired("a-2026-12-80"), "nor the same line next month")
    book.mark(["a-2026-11-80", "a-2026-11-100"])
    check(book.fired == ["a-2026-11-80", "a-2026-11-100"], "marking twice keeps one, in order")
    check(AlertBook(defaults: store).hasFired("a-2026-11-100"), "it outlives the app")
    book.forget(["a-2026-11-100"])
    check(book.fired == ["a-2026-11-80"], "a post that failed can go again")

    book.mark(["", String(repeating: "x", count: AlertBook.mostInOneID + 1)])
    check(book.fired == ["a-2026-11-80"], "an id that could not have come from the page is not kept")
    check(AlertBook.isID("0f3c-2026-11-100") && !AlertBook.isID(""), "ids are short and not empty")

    book.mark((0..<AlertBook.keep).map { "old-\($0)" })
    book.mark(["new-2026-12-80"])
    check(book.fired.count == AlertBook.keep, "the record stops growing")
    check(book.hasFired("new-2026-12-80"), "what was marked last stays")
    check(!book.hasFired("a-2026-11-80"), "and what falls off is the oldest")

    check((1...7).allSatisfy(AlertBook.isWeekday) && !AlertBook.isWeekday(0) && !AlertBook.isWeekday(8), "seven days from 1")
    check((0...23).allSatisfy(AlertBook.isHour) && !AlertBook.isHour(-1) && !AlertBook.isHour(24), "24 hours from 0")

    // Thursday Nov 5 2026, so Saturday is two days on and Thursday's 9 AM has passed.
    book.weekday = 7
    book.hour = 9
    let thursday = moment(2026, 11, 5, 19, 5)
    let saturday = pacific.nextDate(after: thursday, matching: book.weeklyMoment, matchingPolicy: .nextTime)
    check(saturday == moment(2026, 11, 7, 9), "the reminder lands on the hour of the day chosen")
    check(book.weeklyMoment.minute == 0, "once, at the top of the hour")
    book.weekday = 5
    let nextWeek = pacific.nextDate(after: thursday, matching: book.weeklyMoment, matchingPolicy: .nextTime)
    check(nextWeek == moment(2026, 11, 12, 9), "and a time already gone today is next week")
}

print(failures == 0 ? "plainsum checks: all passed" : "plainsum checks: \(failures) failed")
exit(failures == 0 ? 0 : 1)

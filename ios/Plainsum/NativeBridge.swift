import UserNotifications
import WebKit
import WidgetKit

/// Everything the page may ask of the app, through one handler. The page calls
/// `window.webkit.messageHandlers.plainsum.postMessage({ method, args })` and gets
/// a Promise (src/flavor/public/native.ts). A failure rejects it with a code.
///
/// Nothing here returns the access URL, and there is no general file or network
/// method, so a page that went wrong could still only ask for these.
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "plainsum"

    enum Failure: String, Error {
        case badArgs = "bad_args"
        case denied
        case unavailable
    }

    /// Only this web view may call. Set once it exists.
    weak var web: WKWebView?
    private let bank = BankLink(store: Vault())

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.webView === web, message.frameInfo.isMainFrame,
              AppSchemeHandler.isOwnOrigin(scheme: origin.protocol, host: origin.host, port: origin.port) else {
            replyHandler(nil, Failure.denied.rawValue)
            return
        }
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            replyHandler(nil, Failure.badArgs.rawValue)
            return
        }
        let args = body["args"] as? [String: Any] ?? [:]
        Task {
            do {
                replyHandler(try await call(method, args), nil)
            } catch let failure as SimpleFIN.Failure {
                replyHandler(nil, failure.rawValue)
            } catch let failure as Failure {
                replyHandler(nil, failure.rawValue)
            } catch let failure as DataBridge.Failure {
                replyHandler(nil, failure.rawValue)
            } catch {
                replyHandler(nil, Failure.unavailable.rawValue)
            }
        }
    }

    private func call(_ method: String, _ args: [String: Any]) async throws -> [String: Any] {
        switch method {
        case "simplefin.status":
            return ["connected": bank.connected]
        case "simplefin.claim":
            guard let token = args["setupToken"] as? String else { throw Failure.badArgs }
            try await bank.claim(setupToken: token)
            return ["connected": true]
        case "simplefin.fetch":
            guard let start = (args["startDate"] as? NSNumber)?.intValue else { throw Failure.badArgs }
            let reply = try await bank.fetch(start: start, end: (args["endDate"] as? NSNumber)?.intValue)
            return ["status": reply.status, "body": reply.body, "used": reply.used, "cap": RequestBudget.cap]
        case "simplefin.disconnect":
            try bank.disconnect()
            return ["connected": false]
        case "erase.all":
            try await Erase.everything().run()
            return ["erased": true]
        default:
            guard let reply = try await DataBridge.call(method, args, web: web) else { throw Failure.unavailable }
            return reply
        }
    }
}

extension Erase {
    /// What this app keeps outside the page (build-spec 8.1). The container is nil
    /// in an unsigned build, which has no widget figures to remove.
    @MainActor static func everything() -> Erase {
        let manager = FileManager.default
        var files = [ShareFile.folder]
        if let backups = Backups.standard() { files.append(backups.folder) }
        // WebKit's copies of the files that were imported, which are bank statements.
        let temporary = (try? manager.contentsOfDirectory(at: manager.temporaryDirectory, includingPropertiesForKeys: nil)) ?? []
        files += temporary.filter { $0.lastPathComponent.hasPrefix("WKFileUploadPanel") || $0.lastPathComponent.hasSuffix("-Inbox") }
        if let snapshot = WidgetSnapshot.file { files.append(snapshot) }
        return Erase(
            secrets: Vault.purge,
            files: files,
            defaults: .standard,
            defaultsDomain: Bundle.main.bundleIdentifier ?? "",
            system: {
                let center = UNUserNotificationCenter.current()
                center.removeAllPendingNotificationRequests()
                center.removeAllDeliveredNotifications()
                WidgetCenter.shared.reloadAllTimelines()
            },
            webData: {
                let store = WKWebsiteDataStore.default()
                await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
            }
        )
    }
}

import UIKit
import WebKit
import WidgetKit

/// The methods both apps answer the same way: their version, backups, the lock, the
/// widget's figures, alerts, haptics, Add expense, and handing a file to the share sheet.
/// Each app's own bridge decides who may call, then asks here. There is no method that reads or writes a path the page names.
@MainActor
enum DataBridge {
    enum Failure: String, Error {
        case badArgs = "bad_args"
        case unavailable
        case noBackup = "no_backup"
    }

    /// Nil means the method is not one of these.
    static func call(_ method: String, _ args: [String: Any], web: WKWebView?) async throws -> [String: Any]? {
        switch method {
        case "app.info":
            let info = Bundle.main.infoDictionary
            return ["version": info?["CFBundleShortVersionString"] as? String ?? "", "build": info?["CFBundleVersion"] as? String ?? ""]
        case "backup.list":
            guard let backups = Backups.standard() else { throw Failure.unavailable }
            return ["backups": backups.list().map { ["name": $0.name, "at": $0.at.timeIntervalSince1970 * 1000] }]
        case "backup.write":
            guard let json = args["json"] as? String else { throw Failure.badArgs }
            guard let backups = Backups.standard() else { throw Failure.unavailable }
            return ["name": try backups.write(json)]
        case "backup.read":
            guard let name = args["name"] as? String else { throw Failure.badArgs }
            guard let backups = Backups.standard() else { throw Failure.unavailable }
            do {
                return ["json": try backups.read(name)]
            } catch Backups.Failure.badName {
                throw Failure.badArgs
            } catch {
                throw Failure.noBackup
            }
        case "share.file":
            guard let name = args["filename"] as? String, let text = args["text"] as? String else { throw Failure.badArgs }
            guard let web else { throw Failure.unavailable }
            return ["completed": try await ShareFile.present(name: name, text: text, over: web)]
        case "lock.status":
            return AppLock.shared.status()
        case "lock.set":
            // The reply is the status, so a prompt that was cancelled just reads as no change.
            if let after = (args["after"] as? NSNumber)?.doubleValue {
                guard AppLock.choices.contains(after) else { throw Failure.badArgs }
                AppLock.shared.after = after
            }
            if let enabled = args["enabled"] as? Bool { await AppLock.shared.set(enabled: enabled) }
            return AppLock.shared.status()
        case "widget.publish":
            guard let snapshot = WidgetSnapshot(args: args) else { throw Failure.badArgs }
            guard let file = WidgetSnapshot.file else { throw Failure.unavailable }
            try snapshot.write(to: file)
            WidgetCenter.shared.reloadTimelines(ofKind: WidgetSnapshot.kind)
            return ["written": true]
        case "alerts.status":
            return await BudgetAlerts.shared.status()
        case "alerts.set":
            // The reply is the status, so a refused prompt just reads as no change.
            let weekday = (args["weekday"] as? NSNumber)?.intValue
            let hour = (args["hour"] as? NSNumber)?.intValue
            guard weekday.map(AlertBook.isWeekday) ?? true, hour.map(AlertBook.isHour) ?? true else { throw Failure.badArgs }
            try await BudgetAlerts.shared.change(budgets: args["budgets"] as? Bool, weekly: args["weekly"] as? Bool, weekday: weekday, hour: hour,
                                                 seen: args["seen"] as? [String] ?? [])
            return await BudgetAlerts.shared.status()
        case "alerts.post":
            guard let id = args["id"] as? String, AlertBook.isID(id), let title = args["title"] as? String, !title.isEmpty else { throw Failure.badArgs }
            let posted = try await BudgetAlerts.shared.post(id: id, title: title, body: args["body"] as? String ?? "", also: args["also"] as? [String] ?? [])
            return ["posted": posted]
        case "alerts.openSettings":
            BudgetAlerts.shared.openSettings()
            return ["opened": true]
        case "haptic.play":
            guard let haptic = (args["kind"] as? String).flatMap(Haptic.init(rawValue:)) else { throw Failure.badArgs }
            haptic.play()
            return ["played": true]
        case "addExpense.take":
            return AddExpenseInbox.shared.take(from: web)
        default:
            return nil
        }
    }
}

/// A file from the page, handed to the system's share sheet from the app's temporary
/// folder. It is gone again once the sheet closes.
@MainActor
enum ShareFile {
    static let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Export", isDirectory: true)

    static func present(name: String, text: String, over web: WKWebView) async throws -> Bool {
        var top = web.window?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        guard let top else { throw DataBridge.Failure.unavailable }

        let manager = FileManager.default
        try? manager.removeItem(at: folder) // a sheet the app died under
        try manager.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: folder) }
        let url = folder.appendingPathComponent(Backups.safeFileName(name))
        try Data(text.utf8).write(to: url, options: Backups.writeOptions)

        return await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            sheet.completionWithItemsHandler = { [weak sheet] activity, completed, _, _ in
                // Backing out of Save to Files leaves the share sheet up, and the file
                // has to stay for it. No activity means the sheet itself closed.
                guard completed || activity == nil else { return }
                sheet?.completionWithItemsHandler = nil
                done.resume(returning: completed)
            }
            // The iPad shows the sheet as a popover, and traps without somewhere to point.
            sheet.popoverPresentationController?.sourceView = web
            sheet.popoverPresentationController?.sourceRect = CGRect(x: web.bounds.midX, y: web.bounds.midY, width: 0, height: 0)
            top.present(sheet, animated: true)
        }
    }
}

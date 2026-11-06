import UIKit
import UserNotifications

/// Local notifications, for both apps the same way: the budget alerts the page words,
/// and a weekly reminder this file schedules. `AlertBook` keeps the settings and what
/// has gone. Nothing here sees a ledger or works out a figure: a budget alert is text
/// from src/lib/budgetAlerts.ts, and all this decides is whether it goes.
///
/// The page only runs while the app is open, so budget alerts mostly land with the app
/// in front. Without the delegate the system drops those, so it is set before any scene.
@MainActor
final class BudgetAlerts: NSObject, UNUserNotificationCenterDelegate {
    static let shared = BudgetAlerts()

    private static let weeklyID = "weekly-review"

    private let book = AlertBook(defaults: .standard)
    private let center = UNUserNotificationCenter.current()

    /// Called from the App's init. Pending requests do not move to a new phone with
    /// the app's settings, so the reminder is put back here too.
    func start() {
        center.delegate = self
        guard book.weekly else { return }
        Task { try? await scheduleWeekly() }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }

    func status() async -> [String: Any] {
        let permission: String
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined: permission = "unset"
        case .denied: permission = "denied"
        default: permission = "allowed"
        }
        return ["permission": permission, "budgets": book.budgets, "weekly": book.weekly,
                "weekday": book.weekday, "hour": book.hour, "fired": book.fired]
    }

    /// The first time anything turns on is the one moment the system prompt shows. A no
    /// leaves everything as it was. `seen` is what was already true when budget alerts
    /// came on, marked before they count as on, so no check can fire those lines.
    func change(budgets: Bool?, weekly: Bool?, weekday: Int?, hour: Int?, seen: [String]) async throws {
        if budgets == true || weekly == true {
            guard await permitted(asking: true) else { return }
        }
        if let budgets {
            if budgets { book.mark(seen) }
            book.budgets = budgets
        }
        if let weekday { book.weekday = weekday }
        if let hour { book.hour = hour }
        if let weekly { book.weekly = weekly }
        guard weekly != nil || weekday != nil || hour != nil else { return }
        do {
            try await scheduleWeekly()
        } catch {
            // On with nothing scheduled would be a reminder that never comes.
            book.weekly = false
            throw error
        }
    }

    /// `also` is what this alert stands for besides itself: the line below it, or the
    /// others in a group. All of it is marked, and unmarked if the system refuses.
    func post(id: String, title: String, body: String, also: [String]) async throws -> Bool {
        guard await permitted(asking: false), book.budgets, !book.hasFired(id) else { return false }
        let marks = [id] + also
        book.mark(marks)
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.threadIdentifier = "budgets"
        do {
            try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
        } catch {
            book.forget(marks)
            throw error
        }
        return true
    }

    func openSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private func permitted(asking: Bool) async -> Bool {
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined:
            guard asking else { return false }
            return (try? await center.requestAuthorization(options: [.alert])) == true
        case .denied:
            return false
        default:
            return true
        }
    }

    private func scheduleWeekly() async throws {
        center.removePendingNotificationRequests(withIdentifiers: [Self.weeklyID])
        guard book.weekly else { return }
        let content = UNMutableNotificationContent()
        content.title = "Weekly review"
        content.body = "Your week is ready to look over."
        content.threadIdentifier = Self.weeklyID
        let trigger = UNCalendarNotificationTrigger(dateMatching: book.weeklyMoment, repeats: true)
        try await center.add(UNNotificationRequest(identifier: Self.weeklyID, content: content, trigger: trigger))
    }
}

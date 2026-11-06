import Foundation

/// What the alerts keep: the settings, and which alerts have gone, so a line fires once
/// per budget per month. It lives in `UserDefaults.standard`, so Erase clears it and no
/// backup carries it. Nothing here touches the notification system, so the checks can
/// run it (`npm run test:swift`). `BudgetAlerts` does what it says.
struct AlertBook {
    /// About a year of a long category list. Ids only ever come in by month, so what
    /// falls off the end is never this month's.
    static let keep = 500
    static let mostInOneID = 128

    private static let budgetsKey = "alerts.budgets"
    private static let weeklyKey = "alerts.weekly"
    private static let weekdayKey = "alerts.weekday"
    private static let hourKey = "alerts.hour"
    private static let firedKey = "alerts.fired"

    let defaults: UserDefaults

    static func isID(_ id: String) -> Bool { !id.isEmpty && id.count <= mostInOneID }
    /// 1 is Sunday, as the calendar counts them.
    static func isWeekday(_ day: Int) -> Bool { (1...7).contains(day) }
    static func isHour(_ hour: Int) -> Bool { (0...23).contains(hour) }

    var budgets: Bool {
        get { defaults.bool(forKey: Self.budgetsKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.budgetsKey) }
    }

    var weekly: Bool {
        get { defaults.bool(forKey: Self.weeklyKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.weeklyKey) }
    }

    /// Sunday evening until someone chooses.
    var weekday: Int {
        get { defaults.object(forKey: Self.weekdayKey) as? Int ?? 1 }
        nonmutating set { defaults.set(newValue, forKey: Self.weekdayKey) }
    }

    var hour: Int {
        get { defaults.object(forKey: Self.hourKey) as? Int ?? 18 }
        nonmutating set { defaults.set(newValue, forKey: Self.hourKey) }
    }

    /// When the reminder comes, on the phone's own clock wherever it is.
    var weeklyMoment: DateComponents { DateComponents(hour: hour, minute: 0, weekday: weekday) }

    var fired: [String] { defaults.stringArray(forKey: Self.firedKey) ?? [] }

    func hasFired(_ id: String) -> Bool { fired.contains(id) }

    func mark(_ ids: [String]) {
        var all = fired
        for id in ids where Self.isID(id) && !all.contains(id) { all.append(id) }
        defaults.set(Array(all.suffix(Self.keep)), forKey: Self.firedKey)
    }

    /// A post that failed, so the next check can try it again.
    func forget(_ ids: [String]) {
        defaults.set(fired.filter { !ids.contains($0) }, forKey: Self.firedKey)
    }
}

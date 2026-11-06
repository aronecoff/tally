import Foundation

/// The name on the Home Screen, for any line the app or its widget says natively.
enum AppName {
    static let display = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "The app"
}

/// What the widgets show, as the page handed it over (src/lib/widgetSnapshot.ts). Every
/// figure and word about money here is Home's own, already formatted. Nothing native
/// adds, compares or rounds them. Totals only: a lock-screen widget shows on a locked
/// phone, and only the fields below ever reach the file.
///
/// Each app has its own widget extension and its own App Group, and both compile this
/// file, so the app that writes and the widget that reads cannot disagree.
struct WidgetSnapshot: Codable, Equatable {
    enum Tone: String, Codable { case ok, pace, over }

    /// WidgetKit's name for the widget, the same in both extensions.
    static let kind = "LeftToSpend"
    static let version = 1
    static let fileName = "snapshot.json"

    var v: Int
    var asOf: Double
    var month: String
    var hasBudget: Bool
    var budget: Double
    var spent: Double
    var left: Double
    var over: Bool
    var state: Tone
    var label: String
    var stateWord: String
    var whole: String
    var cents: String
    var unit: String
    var budgetLine: String
    var forecast: String
    var rail: Double
    var pace: Double

    var readAt: Date { Date(timeIntervalSince1970: asOf / 1000) }

    private var isSound: Bool {
        let words = [label, stateWord, whole, cents, unit, budgetLine, forecast]
        return v == Self.version && asOf > 0 && Self.first(ofNext: month) != nil
            && (0...1).contains(rail) && (0...1).contains(pace)
            && words.allSatisfy { $0.count <= 80 }
    }

    fileprivate static func decoded(_ data: Data) -> WidgetSnapshot? {
        guard let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data), snapshot.isSound else { return nil }
        return snapshot
    }

    /// Nil if there is none yet, or it cannot be read.
    static func read(from file: URL) -> WidgetSnapshot? {
        (try? Data(contentsOf: file)).flatMap(decoded)
    }

    /// A widget can read it while the phone is locked after its first unlock, which
    /// is when a lock-screen widget needs it.
    func write(to file: URL) throws {
        try JSONEncoder().encode(self).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// The group a target's snapshot lives in. An app's is `group.` and its bundle id,
    /// and its extension is named after it.
    static func groupID(bundleID: String) -> String {
        let suffix = ".widgets"
        return "group." + (bundleID.hasSuffix(suffix) ? String(bundleID.dropLast(suffix.count)) : bundleID)
    }

    /// This target's snapshot. Nil in a build with no entitlements, which has no group.
    static var file: URL? {
        Bundle.main.bundleIdentifier
            .flatMap { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupID(bundleID: $0)) }?
            .appendingPathComponent(fileName)
    }

    /// The first moment of the month after `month`, or nil if that is no month.
    fileprivate static func first(ofNext month: String, calendar: Calendar = WidgetFace.calendar(.current)) -> Date? {
        let parts = month.split(separator: "-")
        guard month.count == 7, parts.count == 2, parts[0].count == 4, let year = Int(parts[0]), let number = Int(parts[1]),
              (1...12).contains(number) else { return nil }
        return calendar.date(from: DateComponents(year: year, month: number + 1, day: 1))
    }
}

extension WidgetSnapshot {
    /// What the bridge was sent, or nil if it is not a snapshot this build can show.
    init?(args: [String: Any]) {
        // Asked first: serializing NaN or infinity from the page would trap.
        guard JSONSerialization.isValidJSONObject(args),
              let data = try? JSONSerialization.data(withJSONObject: args),
              let snapshot = Self.decoded(data) else { return nil }
        self = snapshot
    }
}

/// A figure on a widget, with what to say about its age.
struct WidgetFigure: Equatable {
    var snapshot: WidgetSnapshot
    /// Home's state word, or what to do about figures this old.
    var headline: String
    /// `Updated 3:12 PM`, or the date once that day has passed.
    var updated: String
    /// Just the time or date, where a line has no room for the word.
    var when: String
    var stale: Bool
}

/// What a widget shows at a given moment. The app only runs when it is opened, so the
/// figures age where they sit, and this is what the person is told about that.
enum WidgetFace: Equatable {
    case prompt(String)
    case figure(WidgetFigure)

    /// Past this, the figure stays but stops reading as current. Someone opening the
    /// app once a day never sees it, however the two times fall.
    static let staleAfter: TimeInterval = 48 * 60 * 60

    /// The page's months are Gregorian, whatever calendar the phone is set to.
    fileprivate static func calendar(_ zone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }

    static func at(_ date: Date, snapshot: WidgetSnapshot?, app: String, zone: TimeZone = .current, locale: Locale = .current) -> WidgetFace {
        let calendar = calendar(zone)
        let update = "Open \(app) to update"
        // A new month starts with a clean budget, so last month's figure means nothing.
        guard let snapshot, snapshot.month == monthKey(date, calendar: calendar) else { return .prompt(update) }
        guard snapshot.hasBudget else { return .prompt("Set a budget in \(app)") }

        let read = snapshot.readAt
        var format = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: zone)
        format = calendar.isDate(read, inSameDayAs: date) ? format.hour().minute() : format.month(.abbreviated).day()
        let when = read.formatted(format)
        let stale = date.timeIntervalSince(read) >= staleAfter
        return .figure(WidgetFigure(
            snapshot: snapshot,
            headline: stale ? update : snapshot.stateWord,
            updated: "Updated \(when)",
            when: when,
            stale: stale
        ))
    }

    /// The moments after `now` when a face changes by itself: the day the time turns
    /// into a date, the figure going stale, and the month ending.
    static func changes(after now: Date, snapshot: WidgetSnapshot?, zone: TimeZone = .current) -> [Date] {
        guard let snapshot else { return [] }
        let calendar = calendar(zone)
        let read = snapshot.readAt
        return [
            calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: read)),
            read.addingTimeInterval(staleAfter),
            WidgetSnapshot.first(ofNext: snapshot.month, calendar: calendar),
        ]
        .compactMap { $0 }
        .filter { $0 > now }
        .sorted()
    }

    private static func monthKey(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", parts.year ?? 0, parts.month ?? 0)
    }
}

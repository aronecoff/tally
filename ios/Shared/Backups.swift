import Foundation

/// Automatic copies of the ledger, as files in the app's Documents folder. The page
/// builds the JSON, so nothing here reads a figure. Both apps share this file.
///
/// A file's name says when it was written, and everything here goes by the name.
/// Reading a file's dates would be a required-reason API on the App Store.
struct Backups {
    enum Failure: Error { case badName, noBackup }

    struct Entry: Equatable {
        let name: String
        let at: Date
    }

    /// The app keeps this many, so a bad morning cannot push a good week out.
    static let keep = 7
    /// The newest few, whatever their day, so a restore can itself be undone.
    static let recent = 3
    static let folderName = "Backups"

    let folder: URL

    /// The app's own folder. iOS always has one, so a nil here means nothing to do.
    static func standard() -> Backups? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            .map { Backups(folder: $0.appendingPathComponent(folderName, isDirectory: true)) }
    }

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f
    }()

    static func name(at date: Date) -> String { "backup-\(stamp.string(from: date)).json" }

    /// The moment a name stands for, or nil for anything that is not one of ours.
    /// This is the only way to a file, so a path can never reach `read`.
    static func date(of name: String) -> Date? {
        guard name.hasPrefix("backup-"), name.hasSuffix(".json"), name.count == "backup-YYYYMMDD-HHMMSS.json".count else { return nil }
        let middle = name.dropFirst("backup-".count).dropLast(".json".count)
        guard middle.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == "-") }) else { return nil }
        return stamp.date(from: String(middle))
    }

    /// The names to hold on to: the newest few, then the newest of each earlier day.
    /// One backup a minute all morning would otherwise leave nothing from yesterday.
    static func kept(_ names: [String], keep: Int = keep, recent: Int = recent) -> Set<String> {
        let newest = names.sorted(by: >)
        var out = Set(newest.prefix(recent))
        var days = Set(out.map(day))
        for name in newest.dropFirst(recent) where out.count < keep && !days.contains(day(name)) {
            out.insert(name)
            days.insert(day(name))
        }
        return out
    }

    private static func day(_ name: String) -> Substring { name.dropFirst("backup-".count).prefix(8) }

    /// Newest first. A folder that is not there yet holds none.
    func list() -> [Entry] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        return names.compactMap { name in Backups.date(of: name).map { Entry(name: name, at: $0) } }
            .sorted { $0.name > $1.name }
    }

    /// Written whole or not at all, then the older ones are pruned. A failed prune
    /// costs nothing: the next write tries again.
    func write(_ json: String, at date: Date = Date()) throws -> String {
        let manager = FileManager.default
        try manager.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = Backups.name(at: date)
        try Data(json.utf8).write(to: folder.appendingPathComponent(name), options: Backups.writeOptions)
        let names = list().map(\.name)
        let keep = Backups.kept(names)
        for old in names where !keep.contains(old) {
            try? manager.removeItem(at: folder.appendingPathComponent(old))
        }
        return name
    }

    func read(_ name: String) throws -> String {
        guard Backups.date(of: name) != nil else { throw Failure.badName }
        let url = folder.appendingPathComponent(name)
        guard let data = try? Data(contentsOf: url) else { throw Failure.noBackup }
        return String(decoding: data, as: UTF8.self)
    }

    /// Readable while the phone is locked after its first unlock, because a backup
    /// can land as the app goes to the background.
    static let writeOptions: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]

    /// A file name the page asked for, as one safe path component. Nothing it sends
    /// can leave the folder the file is written to.
    static func safeFileName(_ raw: String) -> String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
        let name = String(raw.filter(allowed.contains).drop(while: { $0 == "." }).prefix(100))
        return name.isEmpty ? "export.txt" : name
    }
}

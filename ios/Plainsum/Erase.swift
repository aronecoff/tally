import Foundation

/// Erase all data, for the part the page cannot reach. The steps come from the
/// bridge (`NativeBridge.swift`) so this file needs nothing but Foundation and
/// the checks can run it for real.
struct Erase {
    enum Failure: Error { case keychain }

    /// True once nothing is left in the Keychain.
    var secrets: () -> Bool
    /// Files and folders that go whole. A missing one is already gone.
    var files: [URL]
    var defaults: UserDefaults
    var defaultsDomain: String
    /// Pending notifications, and the widget showing what it last read.
    var system: () -> Void
    /// The web view's own stores, last, because the page is still running.
    var webData: () async -> Void

    /// The bank link goes first: if that fails nothing else has gone, and the user
    /// can try again from an intact app.
    func run() async throws {
        guard secrets() else { throw Failure.keychain }
        let manager = FileManager.default
        for url in files where manager.fileExists(atPath: url.path) {
            try manager.removeItem(at: url)
        }
        system()
        defaults.removePersistentDomain(forName: defaultsDomain)
        // The app is still installed. Without this the next launch reads as a fresh
        // install and purges the Keychain (FirstLaunch), so a bank linked after
        // erasing would be lost, and a setup token works only once.
        defaults.set(true, forKey: FirstLaunch.key)
        await webData()
    }
}

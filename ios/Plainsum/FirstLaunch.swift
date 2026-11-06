import Foundation

/// Keychain items survive deleting the app and UserDefaults do not, so a missing
/// flag means a fresh install, and anything still in the Keychain belongs to an
/// install that is gone. It goes before the page can ask for it.
enum FirstLaunch {
    static let key = "plainsum.installed"

    /// `unlocked` is whether protected data can be read. Before the first unlock
    /// after a restart the Keychain is closed and UserDefaults reads as empty, so
    /// a missing flag proves nothing then. The flag is set only once the purge
    /// has really run, so a failed one tries again next launch.
    static func run(unlocked: Bool, defaults: UserDefaults = .standard, purge: () -> Bool) {
        guard unlocked, !defaults.bool(forKey: key), purge() else { return }
        defaults.set(true, forKey: key)
    }
}

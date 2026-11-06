import Foundation

/// When the app asks who is holding it, and when its screen is covered. Nothing here
/// touches UIKit or the clock, so the checks can walk it through what the system does
/// (`npm run test:swift`). `AppLock` feeds it events and does what it says.
///
/// The hard part is that the prompt moves the scene too: Face ID makes it inactive,
/// and closing the prompt makes it active again, before or after the answer arrives.
/// Read naively that is a return to the app, which asks again, for ever. So a prompt
/// only ever starts from a real arrival: a launch, a trip to the background, or a
/// long enough absence. A cancelled prompt leaves the cover and its Unlock button.
struct LockMachine {
    private enum Presence { case active, inactive, background }

    /// The least time away that relocks without the app having reached the background.
    /// Control Center and a permission alert only make it inactive, so a setting of
    /// right away would otherwise ask after every glance.
    static let inactiveFloor: TimeInterval = 60

    /// The page stays behind the cover until this is false.
    private(set) var locked: Bool
    /// A prompt is on screen, or about to be. Its own scene changes do not count.
    private(set) var authenticating = false
    /// Starts active: nothing shows at launch, and a cover with the lock off would
    /// only be something that could fail to go away.
    private var presence = Presence.active
    /// When the app left, on a clock that keeps counting while the phone sleeps.
    private var leftAt: TimeInterval?
    /// The next arrival may ask by itself. Set by a launch and a trip to the background.
    private var promptDue: Bool

    init(enabled: Bool) {
        locked = enabled
        promptDue = enabled
    }

    var covered: Bool { locked || presence != .active }

    mutating func willDeactivate(now: TimeInterval) {
        presence = .inactive
        if !authenticating, leftAt == nil { leftAt = now }
    }

    mutating func didEnterBackground(now: TimeInterval) {
        presence = .background
        if leftAt == nil { leftAt = now }
        promptDue = true
    }

    /// True when a prompt should start now.
    mutating func didActivate(now: TimeInterval, enabled: Bool, after: TimeInterval) -> Bool {
        presence = .active
        return settle(now: now, enabled: enabled, after: after)
    }

    mutating func willAuthenticate() {
        authenticating = true
    }

    /// True when a prompt should start now: one that was cancelled by the app leaving,
    /// and whose answer only arrived once it was back.
    mutating func didAuthenticate(passed: Bool, now: TimeInterval, enabled: Bool, after: TimeInterval) -> Bool {
        authenticating = false
        if passed {
            locked = false
            // Passed just as the app left: that pass does not cover the time away.
            if presence != .background {
                leftAt = nil
                promptDue = false
            }
        }
        return settle(now: now, enabled: enabled, after: after)
    }

    /// The app is here and nothing is asking: work out what that means.
    private mutating func settle(now: TimeInterval, enabled: Bool, after: TimeInterval) -> Bool {
        guard presence == .active, !authenticating else { return false }
        if !enabled {
            // Erase All takes the setting with it, and can finish behind a relock.
            locked = false
        } else if let leftAt, now - leftAt >= (promptDue ? after : max(after, Self.inactiveFloor)) {
            locked = true
            promptDue = true
        }
        leftAt = nil
        defer { promptDue = false }
        return locked && promptDue
    }
}

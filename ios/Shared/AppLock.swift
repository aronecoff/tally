import LocalAuthentication
import UIKit

/// What a cover is painted with: the page's theme, as each app remembers it.
struct CoverTheme {
    let canvas: UIColor
    let ink: UIColor
    let accent: UIColor
    let style: UIUserInterfaceStyle
}

/// Face ID or the passcode in front of the app, and the cover that keeps figures out
/// of the app switcher. Both apps run this the same way. It sits above the web view
/// and the page gates nothing: the page only shows the setting (src/lib/appLock.ts).
///
/// The cover is a window of its own, not a view in the app's. A portal, a share sheet
/// or an alert is presented over the app's window, so anything inside it would sit
/// underneath them and they would show in the switcher. It follows scene notifications
/// and not SwiftUI's scenePhase, because a notification runs this code as it is posted,
/// and scenePhase only reaches a view when SwiftUI next updates.
///
/// `LockMachine` decides. This file does what it says.
@MainActor
final class AppLock: NSObject {
    static let shared = AppLock()

    /// What the setting offers, in seconds away. `after` holds one of these.
    static let choices: [TimeInterval] = [0, 60, 300]
    private static let defaultAfter: TimeInterval = 60
    private static let enabledKey = "lock.enabled"
    private static let afterKey = "lock.after"

    private let defaults = UserDefaults.standard
    private var machine: LockMachine
    private var theme: () -> CoverTheme = {
        CoverTheme(canvas: .systemBackground, ink: .label, accent: .tintColor, style: .unspecified)
    }
    /// One per scene: an iPad can have two windows of Tally open.
    private var covers: [ObjectIdentifier: CoverWindow] = [:]
    /// Scenes that have left, which stay covered whatever the others are doing.
    private var away: Set<ObjectIdentifier> = []
    /// The prompt on screen, so the app leaving can end it.
    private var prompt: LAContext?

    private override init() {
        machine = LockMachine(enabled: UserDefaults.standard.bool(forKey: Self.enabledKey))
        super.init()
    }

    /// Called from the App's init, so it is listening before the first scene connects.
    func start(theme: @escaping () -> CoverTheme) {
        self.theme = theme
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(sceneWillConnect), name: UIScene.willConnectNotification, object: nil)
        center.addObserver(self, selector: #selector(sceneDidDisconnect), name: UIScene.didDisconnectNotification, object: nil)
        center.addObserver(self, selector: #selector(sceneWillDeactivate), name: UIScene.willDeactivateNotification, object: nil)
        center.addObserver(self, selector: #selector(sceneDidEnterBackground), name: UIScene.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(sceneDidActivate), name: UIScene.didActivateNotification, object: nil)
    }

    // ---- The setting ---------------------------------------------------------------

    private var enabled: Bool {
        get { defaults.bool(forKey: Self.enabledKey) }
        set { defaults.set(newValue, forKey: Self.enabledKey) }
    }

    /// Seconds away before it asks again.
    var after: TimeInterval {
        get { defaults.object(forKey: Self.afterKey) == nil ? Self.defaultAfter : defaults.double(forKey: Self.afterKey) }
        set { defaults.set(newValue, forKey: Self.afterKey) }
    }

    /// `available` is false when the device has no passcode, so nothing can be asked.
    func status() -> [String: Any] {
        let any = LAContext()
        let available = any.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
        let biometrics = LAContext()
        var biometry = "none"
        // Not just what the hardware can do: a face that was never enrolled never asks.
        if biometrics.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) {
            switch biometrics.biometryType {
            case .faceID: biometry = "faceID"
            case .touchID: biometry = "touchID"
            default: break
            }
        }
        return ["enabled": enabled, "available": available, "biometry": biometry, "after": after]
    }

    /// Changing it asks first, both ways. A lock that anyone holding the open app could
    /// turn off would not last the first time it mattered.
    func set(enabled wanted: Bool) async {
        guard wanted != enabled, !machine.authenticating else { return }
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            // Nothing to ask with, so it cannot go on. It can go off: this is a phone
            // whose passcode was removed, and the setting is all that is left of the lock.
            if !wanted, Self.noPasscode(error) { enabled = false }
            return
        }
        willAsk(context)
        let passed = await answer(context, reason: "Change the lock")
        if passed { enabled = wanted }
        finish(passed: passed)
    }

    // ---- Asking --------------------------------------------------------------------

    /// From an arrival, or the Unlock button.
    private func unlock() {
        guard !machine.authenticating else { return }
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            // Without a passcode there is no one to ask, and asking anyway would shut
            // the owner out of their own data for good. Anything else stays covered,
            // and the button tries again with a fresh context.
            finish(passed: Self.noPasscode(error))
            return
        }
        willAsk(context)
        Task {
            finish(passed: await answer(context, reason: "Unlock \(AppName.display)"))
        }
    }

    /// Before any task starts, so a second call in the same turn finds it already asking.
    private func willAsk(_ context: LAContext) {
        machine.willAuthenticate()
        prompt = context
    }

    private func answer(_ context: LAContext, reason: String) async -> Bool {
        defer { prompt = nil }
        // Any error is a no: cancelled, failed, or ended by the app leaving. What each
        // one needs next is the same, the cover and its button.
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) == true
    }

    private func finish(passed: Bool) {
        let again = machine.didAuthenticate(passed: passed, now: Self.now, enabled: enabled, after: after)
        render()
        if again { unlock() }
    }

    private static func noPasscode(_ error: NSError?) -> Bool {
        error?.domain == LAError.errorDomain && error?.code == LAError.Code.passcodeNotSet.rawValue
    }

    /// Keeps counting while the phone sleeps, and setting the clock back does not move
    /// it. The uptime clock does stop, so a night asleep would read as seconds away.
    /// It restarts with the phone, but so does the app, and a launch always locks.
    private static var now: TimeInterval {
        TimeInterval(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)) / 1_000_000_000
    }

    // ---- The scenes ----------------------------------------------------------------

    @objc private func sceneWillConnect(_ note: Notification) {
        guard let scene = note.object as? UIWindowScene else { return }
        covers[ObjectIdentifier(scene)] = CoverWindow(scene: scene) { [weak self] in self?.unlock() }
        render()
    }

    @objc private func sceneDidDisconnect(_ note: Notification) {
        guard let scene = note.object as? UIScene else { return }
        covers.removeValue(forKey: ObjectIdentifier(scene))?.dismiss()
        away.remove(ObjectIdentifier(scene))
    }

    @objc private func sceneWillDeactivate(_ note: Notification) {
        guard let scene = note.object as? UIWindowScene else { return }
        away.insert(ObjectIdentifier(scene))
        if !Self.others(of: scene, match: { $0 == .foregroundActive }) { machine.willDeactivate(now: Self.now) }
        render()
        CATransaction.flush() // on screen before anything can take a picture of it
    }

    @objc private func sceneDidEnterBackground(_ note: Notification) {
        guard let scene = note.object as? UIWindowScene else { return }
        away.insert(ObjectIdentifier(scene))
        if !Self.others(of: scene, match: { $0 != .background && $0 != .unattached }) {
            machine.didEnterBackground(now: Self.now)
            prompt?.invalidate() // its answer must not wait for a return that may be hours off
        }
        render()
        CATransaction.flush()
    }

    @objc private func sceneDidActivate(_ note: Notification) {
        guard let scene = note.object as? UIWindowScene else { return }
        away.remove(ObjectIdentifier(scene))
        let ask = machine.didActivate(now: Self.now, enabled: enabled, after: after)
        render()
        if ask { unlock() }
    }

    private static func others(of scene: UIScene, match: (UIScene.ActivationState) -> Bool) -> Bool {
        UIApplication.shared.connectedScenes.contains { $0 !== scene && match($0.activationState) }
    }

    private func render() {
        let theme = theme()
        for (id, cover) in covers {
            if machine.covered || away.contains(id) {
                cover.present(locked: machine.locked, theme: theme)
            } else {
                cover.dismiss()
            }
        }
    }
}

/// Over everything the app shows, alerts included. It only takes the keyboard while
/// locked, so a glance at Control Center leaves what was being typed alone.
private final class CoverWindow: UIWindow {
    private let controller: CoverController

    init(scene: UIWindowScene, unlock: @escaping () -> Void) {
        controller = CoverController(unlock: unlock)
        super.init(windowScene: scene)
        windowLevel = .alert + 1
        rootViewController = controller
        isHidden = true
        controller.loadViewIfNeeded()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("Built in code") }

    func present(locked: Bool, theme: CoverTheme) {
        overrideUserInterfaceStyle = theme.style
        controller.paint(locked: locked, theme: theme)
        isHidden = false
        layoutIfNeeded()
        if locked, !isKeyWindow {
            windowScene?.keyWindow?.endEditing(true)
            makeKey() // or a hardware keyboard and VoiceOver would still reach the page
            UIAccessibility.post(notification: .screenChanged, argument: controller.unlockButton)
        }
    }

    func dismiss() {
        guard !isHidden else { return }
        let wasKey = isKeyWindow
        isHidden = true
        if wasKey { windowScene?.windows.first { $0 !== self && !$0.isHidden && $0.windowLevel == .normal }?.makeKey() }
    }
}

/// The name on the canvas, and with the lock on, the one way in.
private final class CoverController: UIViewController {
    private let name = UILabel()
    private(set) lazy var unlockButton = UIButton(configuration: .filled(), primaryAction: UIAction { [unlock] _ in unlock() })
    private let unlock: () -> Void

    init(unlock: @escaping () -> Void) {
        self.unlock = unlock
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("Built in code") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityViewIsModal = true

        name.text = AppName.display
        name.accessibilityIdentifier = "lock-cover" // the UI tests' way to see it, as the page shows the same name
        name.font = .preferredFont(forTextStyle: .headline)
        name.adjustsFontForContentSizeCategory = true
        name.numberOfLines = 0
        name.textAlignment = .center

        let stack = UIStackView(arrangedSubviews: [name, unlockButton])
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -32),
        ])
    }

    func paint(locked: Bool, theme: CoverTheme) {
        view.backgroundColor = theme.canvas
        name.textColor = theme.ink
        var config = UIButton.Configuration.filled()
        config.title = "Unlock"
        config.cornerStyle = .capsule
        config.baseBackgroundColor = theme.accent
        config.baseForegroundColor = theme.canvas
        unlockButton.configuration = config
        unlockButton.isHidden = !locked
    }
}

import UIKit

/// A tap the hand can feel, at the few moments the page asks for one. UIKit's feedback
/// generators and nothing else, because they are what follows the phone's own settings:
/// with System Haptics off, or with no Taptic Engine, they play nothing. Core Haptics
/// and the vibrate sound do not ask.
@MainActor
enum Haptic: String {
    case light, success, warning

    func play() {
        switch self {
        case .light: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .success: UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .warning: UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
    }
}

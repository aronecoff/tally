import UIKit

/// The brand canvas colors, matching the web app's --bg in each theme.
enum PlainsumTheme: String {
    case dark, light

    static let key = "plainsum.theme"
    /// Last theme the page reported, so a cold launch paints the right canvas
    /// before the page has loaded.
    static var saved: PlainsumTheme {
        PlainsumTheme(rawValue: UserDefaults.standard.string(forKey: key) ?? "") ?? .dark
    }

    var canvas: UIColor {
        self == .dark
            ? UIColor(red: 0.035, green: 0.035, blue: 0.043, alpha: 1) // canvas #09090B (the web --bg)
            : UIColor(red: 0.957, green: 0.937, blue: 0.894, alpha: 1) // Paper #F4EFE4
    }
    /// Type colour: Paper on the dark canvas, Deep Ink #0C0414 on Paper.
    var ink: UIColor {
        self == .dark
            ? PlainsumTheme.light.canvas
            : UIColor(red: 0.047, green: 0.016, blue: 0.078, alpha: 1)
    }
    var sage: UIColor {
        self == .dark
            ? UIColor(red: 0.561, green: 0.627, blue: 0.514, alpha: 1) // #8FA083
            : UIColor(red: 0.361, green: 0.416, blue: 0.322, alpha: 1) // #5C6A52
    }
    var style: UIUserInterfaceStyle { self == .dark ? .dark : .light }
}

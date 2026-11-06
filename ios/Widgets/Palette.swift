import SwiftUI
import UIKit

/// The web app's tokens (src/styles/tokens.css), for the system's light and dark. A
/// test holds the two together (src/styles/widgetPalette.test.ts).
enum Palette {
    private static func color(dark: UInt32, light: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1
            )
        })
    }

    static let canvas = color(dark: 0x09090B, light: 0xF4EFE4)
    static let text1 = color(dark: 0xF4EFE4, light: 0x0C0414)
    static let text2 = color(dark: 0xB3AEA4, light: 0x4A4640)
    static let text3 = color(dark: 0x8E8981, light: 0x66615A)
    static let ok = color(dark: 0x8FA083, light: 0x57644E)
    static let near = color(dark: 0xC9A86B, light: 0x765A18)
    static let nearMark = color(dark: 0xC9A86B, light: 0x937334)
    static let over = color(dark: 0xC98A7E, light: 0x924638)
    static let overMark = color(dark: 0xC98A7E, light: 0xB26153)
    static let track = text1.opacity(0.1)
    static let fill = text1.opacity(0.44)
}

/// The app's two typefaces. Avenir Next ships with iOS, and the display serif ships
/// in the extension.
enum Typeface {
    static func display(_ size: CGFloat) -> Font { .custom("InstrumentSerif-Regular", fixedSize: size) }
    static func ui(_ size: CGFloat) -> Font { .custom("AvenirNext-Regular", fixedSize: size) }
    static func demi(_ size: CGFloat) -> Font { .custom("AvenirNext-DemiBold", fixedSize: size) }
}

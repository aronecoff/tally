import AppIntents
import WebKit

/// "Add expense" for Siri, Shortcuts and Spotlight. It opens the add sheet with the
/// amount and note filled in, and writes nothing: a row only exists once someone taps
/// Add, through the same form as any other. It has no brand in it, because the system
/// reads these words at build time and `.applicationName` follows the app's own name.
struct AddExpenseIntent: AppIntent {
    static let title: LocalizedStringResource = "Add expense"
    static let description = IntentDescription("Opens the add sheet with these filled in. Nothing is saved until you tap Add.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    /// Tally runs on iOS 17, which only knows this one. `supportedModes` replaces it.
    static let openAppWhenRun = true
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground }

    @Parameter(title: "Amount", requestValueDialog: "How much was it?")
    var amount: Double

    @Parameter(title: "Note")
    var note: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Add an expense of \(\.$amount) for \(\.$note)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        AddExpenseInbox.shared.hand(amount: amount, note: note)
        return .result()
    }
}

struct ExpenseShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddExpenseIntent(),
            phrases: [
                "Add an expense in \(.applicationName)",
                "Add expense in \(.applicationName)",
                "Log an expense in \(.applicationName)",
            ],
            shortTitle: "Add expense",
            systemImageName: "plus.circle"
        )
    }
}

/// One ask, held until the page takes it (src/lib/addIntent.ts). A launch can get here
/// before the web view exists, so it waits, and the page asks as it starts. A page
/// already up is nudged. The nudge carries nothing: the figures only ever cross the
/// bridge, which checks who is calling. It lives in memory, so an ask the app never
/// reached is gone with the process, and there is nothing for a backup or Erase to find.
@MainActor
final class AddExpenseInbox {
    static let shared = AddExpenseInbox()

    /// The page that last asked. Until one has, its first question will find the ask.
    private weak var page: WKWebView?
    private var waiting: [String: Any]?

    func hand(amount: Double, note: String?) {
        var ask: [String: Any] = ["amount": amount]
        if let note { ask["note"] = note }
        waiting = ask
        page?.evaluateJavaScript("window.dispatchEvent(new Event('app:add-expense'))", completionHandler: nil)
    }

    /// The waiting ask, once. Empty when there is none.
    func take(from web: WKWebView?) -> [String: Any] {
        page = web
        defer { waiting = nil }
        return waiting ?? [:]
    }
}

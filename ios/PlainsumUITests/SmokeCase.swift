import XCTest
import notify

/// What the smoke tests share. They drive the real Debug app through the page's
/// accessibility tree, on a simulator, because two things here only exist on one: a face
/// that can be matched on demand, and a group container the test can read.
///
/// Every test starts from a first run, however the last one ended, by the same Erase a
/// person would use. All the figures are the sample ledger's, so all are invented.
class SmokeCase: XCTestCase {
    let app = XCUIApplication()
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    /// From the same xcconfig line as the app, so a rename does not reach these tests.
    let appName = Bundle(for: SmokeCase.self).object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? ""

    /// A slow machine has taken about 30 seconds to first paint on a fresh install.
    let boot: TimeInterval = 45
    let step: TimeInterval = 15

    var welcome: XCUIElement { app.staticTexts["Welcome to \(appName)"] }
    var settings: XCUIElement { app.buttons["Settings"] }
    var settingsSheet: XCUIElement { app.otherElements["Settings, web dialog"] }
    var unlock: XCUIElement { app.buttons["Unlock"] }
    /// The cover, up for as long as the scene is away, with or without the button.
    var cover: XCUIElement { app.staticTexts["lock-cover"] }

    /// Home's hero with a budget set: `$791.72 left`, or `over` past the budget.
    var hero: XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", #"\$[0-9,.]+ (left|over)"#)).firstMatch
    }

    override func setUpWithError() throws {
        #if !targetEnvironment(simulator)
        throw XCTSkip("These need a simulator.")
        #else
        continueAfterFailure = false
        FaceID.enroll()
        startFromFirstRun()
        #endif
    }

    // ---- Launching ---------------------------------------------------------------------

    /// A cold launch: the app and its web content process start from nothing.
    func launch(offline: Bool = false) {
        app.terminate()
        app.launchEnvironment = offline ? ["PLAINSUM_NO_NETWORK": "1"] : [:]
        app.launch()
    }

    private func startFromFirstRun() {
        launch()
        // A test that failed with the lock on left it on.
        if unlock.waitForExistence(timeout: 3) { passFaceID() }
        // An open sheet takes the page behind it out of the accessibility tree.
        until("the app starts", timeout: boot) { welcome.exists || settings.exists }
        // And the first-run sheet opens a moment after the page does.
        if !welcome.waitForExistence(timeout: 4) { eraseAll() }
    }

    /// A trip to the Home Screen, long enough for what the page writes on its way out.
    func leaveAndReturn() {
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: step), "The app did not leave")
        Thread.sleep(forTimeInterval: 2)
        app.activate()
    }

    // ---- The page ----------------------------------------------------------------------

    func openSettings() {
        settings.tap()
        XCTAssertTrue(settingsSheet.waitForExistence(timeout: step), "Settings did not open")
    }

    /// The sheet scrolls in the page, where XCUITest will not scroll for itself.
    @discardableResult
    func reveal(_ element: XCUIElement) -> XCUIElement {
        XCTAssertTrue(element.waitForExistence(timeout: step), "\(element) is not there")
        for _ in 0..<12 where !element.isHittable { app.swipeUp() }
        XCTAssertTrue(element.isHittable, "\(element) could not be reached")
        return element
    }

    func closeSheet() {
        let close = app.buttons["Close"].firstMatch
        close.tap()
        until("the sheet closes") { !close.exists }
    }

    func loadSampleData() {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Load sample data'")).firstMatch.tap()
        XCTAssertTrue(hero.waitForExistence(timeout: step), "Home did not show the sample budget")
    }

    /// Two taps, then the page reloads at the first run.
    func eraseAll() {
        openSettings()
        reveal(app.buttons["Erase all data"]).tap()
        let again = app.buttons["Tap again to erase"]
        XCTAssertTrue(again.waitForExistence(timeout: step), "Erase did not ask again")
        again.tap()
        XCTAssertTrue(welcome.waitForExistence(timeout: boot), "Erase did not end at the first run")
    }

    // ---- Face ID -----------------------------------------------------------------------

    /// The system's Face ID sheet belongs to SpringBoard, not to the app.
    private var faceIDSheet: XCUIElement {
        springboard.staticTexts["Face ID"]
    }

    /// So the face never arrives before the camera is looking.
    func waitForFaceIDPrompt() {
        until("the Face ID prompt shows") { faceIDSheet.exists }
    }

    /// Done once the cover has gone. The system's sheet outlives its own label by a second
    /// or two, and until it has gone the app is inactive and a tap goes nowhere.
    func passFaceID() {
        waitForFaceIDPrompt()
        until("a matched face takes the cover away") {
            FaceID.match()
            return !cover.exists
        }
    }

    /// A face that does not match, then the way out of the sheet that leaves behind.
    /// Done once the app has the screen back, with its cover or without.
    func failFaceID() {
        waitForFaceIDPrompt()
        FaceID.noMatch()
        // The sheet lists each of its buttons twice.
        let cancel = springboard.alerts.buttons["Cancel"].firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: step), "Face ID did not say the face failed")
        cancel.tap()
        until("the app has the screen back") { !cancel.exists && (!cover.exists || unlock.exists) }
    }

    // ---- Waiting -----------------------------------------------------------------------

    func until(_ what: String, timeout: TimeInterval? = nil, _ done: () -> Bool) {
        let end = Date().addingTimeInterval(timeout ?? step)
        while Date() < end {
            if done() { return }
            Thread.sleep(forTimeInterval: 0.25)
        }
        XCTFail("Timed out waiting until \(what)")
    }
}

/// The simulator's Face ID, by the notifications its Features menu sends. These reach the
/// simulator because the test runs inside it.
enum FaceID {
    private static let enrolled = "com.apple.BiometricKit.enrollmentChanged"

    static func enroll() {
        var token: Int32 = 0
        notify_register_check(enrolled, &token)
        notify_set_state(token, 1)
        notify_cancel(token)
        notify_post(enrolled)
    }

    static func match() { notify_post("com.apple.BiometricKit_Sim.pearl.match") }
    static func noMatch() { notify_post("com.apple.BiometricKit_Sim.pearl.nomatch") }
}

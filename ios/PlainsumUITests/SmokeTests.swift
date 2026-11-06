import XCTest

final class SmokeTests: SmokeCase {
    /// The app needs nothing from anywhere: not to start, not for a screen, not to keep
    /// what it held. Airplane mode itself is a check for a real phone: a simulator shares
    /// the Mac's connection, so the web view is cut off by the build's offline switch.
    func testColdLaunchWithNoNetwork() throws {
        launch(offline: true)
        XCTAssertTrue(welcome.waitForExistence(timeout: boot), "The first run did not show with no network")
        loadSampleData()
        let figure = hero.label

        launch(offline: true)
        XCTAssertTrue(hero.waitForExistence(timeout: boot), "Home did not come back with no network")
        XCTAssertEqual(hero.label, figure, "A cold launch changed what Home shows")
        XCTAssertFalse(welcome.exists, "A cold launch went back to the first run")
        XCTAssertFalse(app.staticTexts["\(appName) could not start."].exists)

        // Each screen is its own code, and all of it comes from inside the app.
        for screen in ["Budget", "Insights", "Accounts", "Activity"] {
            app.buttons[screen].tap()
            XCTAssertTrue(app.otherElements["\(screen), region"].waitForExistence(timeout: step), "\(screen) did not open")
        }
    }

    /// The keyboard takes the bottom of the screen, and a web view makes room for it in
    /// ways a browser does not, so this is a check for a real keyboard. What is typed
    /// stays on screen, and so does the button that saves it, clear of the bar above the
    /// keys. The sheet is the one Tally uses.
    func testWhatIsTypedStaysOnScreen() throws {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Track by hand'")).firstMatch.tap()
        // A row far enough down that the keyboard would land on it, as a person would tap.
        let fields = app.textFields
        XCTAssertTrue(fields.firstMatch.waitForExistence(timeout: step), "The budgets did not open")
        let low = fields.element(boundBy: fields.count - 2)
        // The tick above the keys is called Done too.
        let done = app.webViews.buttons["Done"]
        low.tap()
        assertOnScreen(low, then: done)
        app.typeText("40")
        // The web view moves as it takes a key, and the row must not go with it.
        Thread.sleep(forTimeInterval: 1)
        assertOnScreen(low, then: done)
        XCTAssertEqual(low.value as? String, "40")
        done.tap()

        let add = app.buttons["Add transaction"]
        XCTAssertTrue(add.waitForExistence(timeout: step), "Done did not close the budgets")
        add.tap()
        let amount = app.textFields["Amount"]
        XCTAssertTrue(amount.waitForExistence(timeout: step), "The sheet did not open")
        let save = app.webViews.buttons["Add"]
        assertOnScreen(amount, then: save)
        app.typeText("12.50")
        Thread.sleep(forTimeInterval: 1)
        assertOnScreen(amount, then: save)
        XCTAssertEqual(amount.value as? String, "12.50")
    }

    /// Done once the keyboard has settled, however long the sheet takes to come up.
    private func assertOnScreen(_ field: XCUIElement, then button: XCUIElement) {
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: step), "No keyboard. In the simulator, turn off Connect Hardware Keyboard.")
        // The bar with the arrows and the tick sits above the keys, and is not in their frame.
        let visible = { keyboard.frame.minY - 80 }
        until("the field settles on screen") {
            field.frame.minY > 60 && field.frame.maxY < button.frame.minY && button.frame.maxY <= visible()
        }
        XCTAssertTrue(field.isHittable, "The field being typed in is off the screen")
        XCTAssertTrue(button.isHittable, "\(button) is under the keyboard")
    }

    /// What the widget reads is what Home shows, through the widget's own decoder and
    /// its own rules for what to say.
    func testWidgetSnapshotFollowsHome() throws {
        let started = Date()
        loadSampleData()
        let figure = hero.label

        let snapshot = try published { $0.hasBudget }
        XCTAssertGreaterThan(snapshot.readAt, started.addingTimeInterval(-60), "The snapshot is an old one")
        XCTAssertEqual("\(snapshot.whole)\(snapshot.cents) \(snapshot.unit)", figure, "The widget and Home disagree")
        guard case let .figure(face) = WidgetFace.at(Date(), snapshot: snapshot, app: appName) else {
            return XCTFail("A snapshot from now should show a figure")
        }
        XCTAssertFalse(face.stale)
        XCTAssertTrue(app.staticTexts[face.headline].exists, "Home does not say \(face.headline)")

        eraseAll()
        let empty = try published { !$0.hasBudget }
        XCTAssertEqual(WidgetFace.at(Date(), snapshot: empty, app: appName), .prompt("Set a budget in \(appName)"))
    }

    /// A copy the app saved by itself brings back rows that have since gone. Nothing is
    /// replaced until the second tap. It waits for the copy that lands a while after a
    /// change (`QUIET_MS` in src/lib/autoBackup.ts). The copy made on leaving is left to
    /// that file's tests, because here it is a race with the system freezing the page.
    func testBackupAndRestore() throws {
        loadSampleData()
        let figure = hero.label
        Thread.sleep(forTimeInterval: 22)

        openSettings()
        reveal(app.buttons["Remove sample data"]).tap()
        XCTAssertTrue(app.buttons["Load sample data"].waitForExistence(timeout: step), "The sample stayed")
        closeSheet()
        until("Home shows no budget") { !hero.exists }

        openSettings()
        reveal(app.buttons["Backups"]).tap()
        let saved = app.buttons.matching(NSPredicate(format: "label MATCHES %@", #"[A-Z][a-z]{2} [0-9]+, [0-9]{4} .*"#)).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: step), "No backup was saved")
        saved.tap()

        let holds = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'This backup from' AND label CONTAINS ' transactions'")).firstMatch
        XCTAssertTrue(holds.waitForExistence(timeout: step), "The preview did not say what the backup holds")
        app.buttons["Restore"].tap()
        let again = app.buttons["Tap again to replace"]
        XCTAssertTrue(again.waitForExistence(timeout: step), "Restore did not ask again")
        again.tap()

        XCTAssertTrue(hero.waitForExistence(timeout: boot), "The restore did not bring the budget back")
        XCTAssertEqual(hero.label, figure, "The restore changed what Home shows")
        XCTAssertFalse(welcome.exists, "A restore went back to the first run")
    }

    /// With the lock on, nothing is reachable until a face matches. The privacy cover in
    /// the app switcher is the one part a test cannot see, so it is a check for a phone.
    func testLockAsksForAFace() throws {
        app.buttons["Close"].firstMatch.tap()
        openSettings()
        let lock = reveal(app.switches["Lock with Face ID"])

        // Changing it asks first, and a face that fails leaves it as it was.
        lock.tap()
        failFaceID()
        XCTAssertEqual(lock.value as? String, "0", "A failed face turned the lock on")
        lock.tap()
        passFaceID()
        until("the lock turns on") { lock.value as? String == "1" }

        launch()
        XCTAssertTrue(cover.waitForExistence(timeout: boot), "A cold launch did not cover the app")

        // A failed face leaves the cover, and a tap where Settings sits lands on the
        // cover. The button is the way back to the prompt.
        failFaceID()
        XCTAssertTrue(unlock.exists, "A failed face took the cover away")
        settings.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        unlock.tap()
        passFaceID()
        XCTAssertFalse(settingsSheet.exists, "A tap reached the page through the cover")

        // Right away means a trip to the Home Screen asks again.
        openSettings()
        reveal(app.otherElements["Right away"]).tap()
        closeSheet()
        leaveAndReturn()
        XCTAssertTrue(unlock.waitForExistence(timeout: step), "Coming back did not lock the app")
        passFaceID()

        // Turning it off asks too, and then a launch goes straight in.
        openSettings()
        reveal(lock).tap()
        passFaceID()
        until("the lock turns off") { lock.value as? String == "0" }
        launch()
        XCTAssertTrue(settings.waitForExistence(timeout: boot), "The app did not start")
        XCTAssertFalse(cover.exists, "The lock was still on")
    }

    // ---- The group container -----------------------------------------------------------

    /// The newest snapshot once it meets `wanted`. The page publishes a moment after a
    /// change, so this waits a little longer than that.
    private func published(_ wanted: (WidgetSnapshot) -> Bool) throws -> WidgetSnapshot {
        let file = try XCTUnwrap(groupFolder(), "The app has no group container").appendingPathComponent(WidgetSnapshot.fileName)
        var latest: WidgetSnapshot?
        until("the snapshot is published") {
            latest = WidgetSnapshot.read(from: file)
            return latest.map(wanted) ?? false
        }
        return try XCTUnwrap(latest)
    }

    /// Finds the group by the label the system leaves in each container. The runner has no
    /// entitlements to ask with, and on a simulator it can simply look.
    private func groupFolder() -> URL? {
        let id = WidgetSnapshot.groupID(bundleID: "com.aronecoff.plainsum")
        // <device>/data/Containers/Data/Application/<runner>
        let containers = URL(fileURLWithPath: NSHomeDirectory()).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let groups = containers.appendingPathComponent("Shared/AppGroup", isDirectory: true)
        let folders = (try? FileManager.default.contentsOfDirectory(at: groups, includingPropertiesForKeys: nil)) ?? []
        return folders.first { folder in
            let label = folder.appendingPathComponent(".com.apple.mobile_container_manager.metadata.plist")
            return (NSDictionary(contentsOf: label)?["MCMMetadataIdentifier"] as? String) == id
        }
    }
}

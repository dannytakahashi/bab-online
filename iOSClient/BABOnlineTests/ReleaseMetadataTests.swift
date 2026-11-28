import XCTest

/// App Store metadata of the built app (README "Releasing"): the version comes
/// from the project's MARKETING_VERSION / CURRENT_PROJECT_VERSION (never a
/// literal in Info.plist), export compliance is answered in the plist, and the
/// privacy manifest is bundled at the app root.
final class ReleaseMetadataTests: XCTestCase {
    /// The lowest build this release may carry (1.2.0 (3) was uploaded, never submitted;
    /// 1.2.0 (4) was submitted and pulled from review; build 5 was uploaded and never
    /// submitted; build 6 added the new app icon and was released 2026-11-13, closing the
    /// 1.2.0 train, so build 7 is 1.2.1: removing lobby bots, game-end stats, the Stats
    /// sheet with Records and the four-suit empty lobby; build 7 went to TestFlight, so
    /// build 8 adds the card art, the HI-joker icon and the Stats scope control and went to
    /// review; build 9 keeps a live connection after a long background and shows Records'
    /// games played per period, and 1.2.1 was released; build 10 is 1.2.2: web parity, i.e.
    /// profiles with photo upload, the admin panel, lobby, tournament and table parity with
    /// opponent card backs, table sounds and error reports; build 10 went to TestFlight, so
    /// build 11 adds the New Game label on phones and went to review, then was pulled from it
    /// (owner 2026-11-16) for build 12, which replaced it as 1.2.2:
    /// family lobbies of up to 8 and spectator voice, the casualSpectators cap; build 13
    /// is still 1.2.2 and replaced build 12 in review (owner 2026-11-17): the card-back fans on
    /// 390 pt phones, the refreshed boot splash and the sign-in / register in the web's style,
    /// and 1.2.2 was released 2026-11-17, closing the 1.2.2 train, so build 14 is 1.2.3: teams
    /// labelled by player names, voice on the loudspeaker and the voice panel tip; build 14
    /// went to TestFlight, so build 15 (still 1.2.3) adds the bid clock, the voice panel's long
    /// press opening the panel only and the paced loudspeaker safety net; build 15 went to
    /// TestFlight, so build 16 (still 1.2.3) moves table sounds off the main thread: with voice
    /// on, every sound froze the table on the owner's iPhone Air; build 16 went to TestFlight, so
    /// build 17 (still 1.2.3) brings the voice defaults: the mic starts muted, spectators may
    /// always talk, no voice when you are the only human, and the lobby header shows Ready n/4;
    /// the TestFlight "17" was build 16 renumbered by Organizer, so build 18 is the build 17
    /// source renumbered (the first upload of the voice defaults), and build 19 (still 1.2.3)
    /// brings /help at the table, the game log's fault rows and the toast follow-ups; build 19
    /// went to TestFlight, so build 20 (still 1.2.3) keeps the play-turn lightbulb off my seat row;
    /// build 20 went to TestFlight, so build 21 (still 1.2.3) brings the tutorial and the
    /// session unmute; build 21 went to TestFlight, so build 22 (still 1.2.3) brings the HSI reveal
    /// and colour of the web's #345 and the live rainbow row; build 22 went to TestFlight, so build
    /// 23 (still 1.2.3) brings the four-colour deck; build 23 went to TestFlight, so build 24
    /// (still 1.2.3) brings the Records superlatives; build 24 went to review, so build 25
    /// (still 1.2.3) brings the online list's leave refresh; build 25 went to review, so build 26
    /// (still 1.2.3) brings the tutorial welcome shown once; build 26 went to review, so build 27
    /// (still 1.2.3) brings the iPhone Duo's vertical bar items for /help and the tutorial; build
    /// 27 went to review, so build 28 (still 1.2.3) brings the welcome tip's fixes and the bar's
    /// tutorial switch shown while off; build 28 went to review, so build 29 (still 1.2.3) brings
    /// the tutorial's corner button on iPhone and iPad and its stats question; build 29 went to
    /// TestFlight, so build 30 (still 1.2.3) brings the Duo's draw without the docked log; build 30 went
    /// to review, and build 31 (still 1.2.3) brings the over-the-shoulder spectator view; 1.2.3 (30)
    /// was released, so build 32 is 1.2.4; build 33 (still 1.2.4) shows a spectator the eye by the
    /// watched hand only while someone else watches it too; build 34 (still 1.2.4) lets the sound
    /// slider reach 0 and words the help-stats rule as on a win only; build 35 (still 1.2.4) lights
    /// the spectator badge while a spectator talks and puts the Duo's mic in its vertical bar; build 36
    /// (still 1.2.4) gives chat and bid bubbles one VoiceOver element with the bubble's frame; build 37
    /// (still 1.2.4) plays a fanfare for a won game and a sad trombone for a lost one; build 38
    /// (still 1.2.4) draws the /help room notice in gold; 1.2.4 (38) went into App Store review, so build 39
    /// is 1.2.5 and adds the avatar badges; 1.2.5 (39) was released 2026-11-24, so build 40 is 1.2.6 and adds
    /// tournament voice in the tournament lobby, Min ducking during a call and distinct chat name colours;
    /// 1.2.6 (40) went into App Store review, so build 41 is 1.2.7 and adds the round pairings, "Partners
    /// so far", the draw for first deal at a tournament table (the cap `tournamentPairings`) and the
    /// full-screen update screen (s2c updateRequired); build 42 (still 1.2.7) plays the cut's intro over
    /// the list too; 1.2.7 (42) was released, so build 43 is 1.2.8 and brings the simpler tournament
    /// lobby, the native New Game menu and the turn vibration; builds 43 and 44 went only to TestFlight,
    /// build 45 (still 1.2.8) adds the review nits and goes to review, and build 46 (still 1.2.8)
    /// replaces it in review: the host's Leave and End Tournament icons, Tournament in New Game; build 47
    /// (still 1.2.8, cut from 46's commit) adds only the "The host ended the tournament" toast; build 48
    /// (still 1.2.8, cut from 47's commit) adds only the gold trophy back; build 49 (still 1.2.8, cut
    /// from 48's commit) adds the lobby bar like the game's and the trophy in the bottom pill, white;
    /// build 50 (still 1.2.8, cut from 49's commit) adds Players search and the restore-answer wait;
    /// build 51 (still 1.2.8, cut from 50's) adds the online list's pictures and the lobby's back chevron;
    /// build 52 (still 1.2.8, cut from 51's) adds the scorecard; build 53 (still 1.2.8, cut from 52's)
    /// adds one voice call per player after a reconnect).
    static let minimumBuild = 53

    private func info(_ key: String) -> Any? { Bundle.main.object(forInfoDictionaryKey: key) }

    func testVersionComesFromBuildSettings() throws {
        let version = try XCTUnwrap(info("CFBundleShortVersionString") as? String)
        let build = try XCTUnwrap(info("CFBundleVersion") as? String)
        XCTAssertNotNil(version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression), version)
        XCTAssertNotNil(build.range(of: #"^\d+$"#, options: .regularExpression), build)
        XCTAssertNotEqual(version, "1.0", "Info.plist must use $(MARKETING_VERSION)")
    }

    /// server/socket/upgradeGate.js answers builds below MIN_IOS_BUILD (41: 1.0.0 (1) to
    /// 1.2.6 (40)) with an update message only; 1.2.7 (41) to (42) and 1.2.8 (43) to (53) are current, pinned
    /// server-side by upgradeGate.test.js. The build number only grows:
    /// builds 3 to 6 went to App Store Connect and 1.2.0 (6) was released, so build 7 is 1.2.1.
    func testBuildIsNeverGatedByTheServer() throws {
        let build = try XCTUnwrap(Int(try XCTUnwrap(info("CFBundleVersion") as? String)))
        XCTAssertGreaterThanOrEqual(build, Self.minimumBuild, "1.2.0 (6), 1.2.1 (9) and 1.2.2 (13) were released; 1.2.8 ships as build 53 or later and builds never go back")
        XCTAssertEqual(info("CFBundleShortVersionString") as? String, "1.2.8", "1.2.7 (42) was released, so build 43 is 1.2.8")
    }

    /// README "Releasing (App Store)", which the owner follows to archive and upload, names
    /// the build being shipped and the floor this file checks.
    func testReadmeReleaseHistoryNamesThisBuild() throws {
        let version = try XCTUnwrap(info("CFBundleShortVersionString") as? String)
        let build = try XCTUnwrap(info("CFBundleVersion") as? String)
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        // The README is read from the checkout through #filePath: there on a simulator, not on a device.
        let url = root.appendingPathComponent("README.md")
        guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("README.md is not reachable from this test host") }
        let readme = try String(contentsOf: url, encoding: .utf8)
        let line = try XCTUnwrap(readme.components(separatedBy: "\n").first { $0.contains("History: 1.0.0 (1)") }, "README version history")
        XCTAssertTrue(line.contains("\(version) (\(build)"), "README history lacks \(version) (\(build)): \(line)")
        XCTAssertTrue(line.contains("build number drops below \(Self.minimumBuild)"), "README's documented floor is not \(Self.minimumBuild)")
    }

    func testExportComplianceAndUsageStrings() {
        XCTAssertEqual(info("ITSAppUsesNonExemptEncryption") as? Bool, false)
        XCTAssertFalse((info("NSMicrophoneUsageDescription") as? String ?? "").isEmpty)
        // WebRTC.framework links AVCaptureDevice: App Store Connect requires the camera string.
        XCTAssertFalse((info("NSCameraUsageDescription") as? String ?? "").isEmpty)
    }

    func testPrivacyManifestIsBundled() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
        XCTAssertEqual(url.deletingLastPathComponent().standardizedFileURL, Bundle.main.bundleURL.standardizedFileURL)
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any])
        XCTAssertEqual(plist["NSPrivacyTracking"] as? Bool, false)
        XCTAssertEqual((plist["NSPrivacyTrackingDomains"] as? [String])?.count, 0)
        let collected = try XCTUnwrap(plist["NSPrivacyCollectedDataTypes"] as? [[String: Any]])
        XCTAssertEqual(Set(collected.compactMap { $0["NSPrivacyCollectedDataType"] as? String }), [
            "NSPrivacyCollectedDataTypeUserID",
            "NSPrivacyCollectedDataTypeOtherUserContent",
            "NSPrivacyCollectedDataTypeGameplayContent",
            // clientError reports (ErrorReporter): an uncaught exception, decode and socket errors
            "NSPrivacyCollectedDataTypeCrashData",
            "NSPrivacyCollectedDataTypeOtherDiagnosticData",
            // the profile picture a player uploads (1.2.2: PhotosPicker, ProfilePicture)
            "NSPrivacyCollectedDataTypePhotosorVideos",
        ])
        for entry in collected { XCTAssertEqual(entry["NSPrivacyCollectedDataTypeTracking"] as? Bool, false) }
        // release code keeps settings in UserDefaults (the Stats scope, the sound switch and volume):
        // declared with CA92.1 (read and written by this app only)
        let apis = try XCTUnwrap(plist["NSPrivacyAccessedAPITypes"] as? [[String: Any]])
        let defaults = apis.first { $0["NSPrivacyAccessedAPIType"] as? String == "NSPrivacyAccessedAPICategoryUserDefaults" }
        XCTAssertEqual(defaults?["NSPrivacyAccessedAPITypeReasons"] as? [String], ["CA92.1"])
    }
}

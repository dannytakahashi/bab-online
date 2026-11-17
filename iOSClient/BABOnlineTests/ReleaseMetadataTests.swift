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
    /// build 11 adds the New Game label on phones and went to review; build 12 is 1.2.3:
    /// family lobbies of up to 8 and spectator voice, the casualSpectators cap).
    static let minimumBuild = 12

    private func info(_ key: String) -> Any? { Bundle.main.object(forInfoDictionaryKey: key) }

    func testVersionComesFromBuildSettings() throws {
        let version = try XCTUnwrap(info("CFBundleShortVersionString") as? String)
        let build = try XCTUnwrap(info("CFBundleVersion") as? String)
        XCTAssertNotNil(version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression), version)
        XCTAssertNotNil(build.range(of: #"^\d+$"#, options: .regularExpression), build)
        XCTAssertNotEqual(version, "1.0", "Info.plist must use $(MARKETING_VERSION)")
    }

    /// server/socket/upgradeGate.js answers builds below MIN_IOS_BUILD (3: 1.0.0 (1) and
    /// 1.1.0 (2)) with an update message only; 1.2.0 (3) to (6) and 1.2.1 (7) to (9), 1.2.2 (10) and (11) and 1.2.3 (12) are current, pinned
    /// server-side by upgradeGate.test.js. The build number only grows:
    /// builds 3 to 6 went to App Store Connect and 1.2.0 (6) was released, so build 7 is 1.2.1.
    func testBuildIsNeverGatedByTheServer() throws {
        let build = try XCTUnwrap(Int(try XCTUnwrap(info("CFBundleVersion") as? String)))
        XCTAssertGreaterThanOrEqual(build, Self.minimumBuild, "1.2.0 (6) and 1.2.1 (9) were released; 1.2.2 (11) went to review; 1.2.3 ships as build 12 or later and builds never go back")
        XCTAssertEqual(info("CFBundleShortVersionString") as? String, "1.2.3", "1.2.2 (11) went to review (its train is closed): the next upload is 1.2.3")
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

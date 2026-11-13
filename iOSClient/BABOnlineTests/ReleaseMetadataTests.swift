import XCTest

/// App Store metadata of the built app (README "Releasing"): the version comes
/// from the project's MARKETING_VERSION / CURRENT_PROJECT_VERSION (never a
/// literal in Info.plist), export compliance is answered in the plist, and the
/// privacy manifest is bundled at the app root.
final class ReleaseMetadataTests: XCTestCase {
    /// The lowest build this release may carry (1.2.0 (3) was uploaded, never submitted;
    /// 1.2.0 (4) was submitted and pulled from review; build 5 was uploaded and never
    /// submitted; build 6 added the new app icon and was pulled from review for build 7,
    /// which adds removing lobby bots, game-end stats and the Stats sheet with Records).
    static let minimumBuild = 7

    private func info(_ key: String) -> Any? { Bundle.main.object(forInfoDictionaryKey: key) }

    func testVersionComesFromBuildSettings() throws {
        let version = try XCTUnwrap(info("CFBundleShortVersionString") as? String)
        let build = try XCTUnwrap(info("CFBundleVersion") as? String)
        XCTAssertNotNil(version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression), version)
        XCTAssertNotNil(build.range(of: #"^\d+$"#, options: .regularExpression), build)
        XCTAssertNotEqual(version, "1.0", "Info.plist must use $(MARKETING_VERSION)")
    }

    /// server/socket/upgradeGate.js answers builds below MIN_IOS_BUILD (2) with an
    /// update message only; every build from 1.1.0 (2) on is current (1.2.0 (3),
    /// pinned server-side by upgradeGate.test.js, 1.2.0 (4) to (7)). The build number only grows:
    /// builds 3 to 6 went to App Store Connect, so 1.2.0 is now submitted as build 7.
    func testBuildIsNeverGatedByTheServer() throws {
        let build = try XCTUnwrap(Int(try XCTUnwrap(info("CFBundleVersion") as? String)))
        XCTAssertGreaterThanOrEqual(build, Self.minimumBuild, "1.2.0 (6) was uploaded; 1.2.0 ships as build 7 and builds never go back")
        XCTAssertEqual(info("CFBundleShortVersionString") as? String, "1.2.0", "build 7 is still 1.2.0")
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
        ])
        for entry in collected { XCTAssertEqual(entry["NSPrivacyCollectedDataTypeTracking"] as? Bool, false) }
        XCTAssertNotNil(plist["NSPrivacyAccessedAPITypes"] as? [Any])
    }
}

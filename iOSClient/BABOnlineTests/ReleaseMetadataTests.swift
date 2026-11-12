import XCTest

/// App Store metadata of the built app (README "Releasing"): the version comes
/// from the project's MARKETING_VERSION / CURRENT_PROJECT_VERSION (never a
/// literal in Info.plist), export compliance is answered in the plist, and the
/// privacy manifest is bundled at the app root.
final class ReleaseMetadataTests: XCTestCase {
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
    /// pinned server-side by upgradeGate.test.js, and 1.2.0 (4)). The build number only grows:
    /// build 3 went to App Store Connect, so 1.2.0 is submitted as build 4.
    func testBuildIsNeverGatedByTheServer() throws {
        let build = try XCTUnwrap(Int(try XCTUnwrap(info("CFBundleVersion") as? String)))
        XCTAssertGreaterThanOrEqual(build, 4, "1.2.0 (3) was uploaded; 1.2.0 ships as build 4 and builds never go back")
        XCTAssertEqual(info("CFBundleShortVersionString") as? String, "1.2.0", "build 4 is still 1.2.0")
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

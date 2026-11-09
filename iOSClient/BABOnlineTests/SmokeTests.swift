import XCTest
@testable import BAB_Online

/// The test target builds, is hosted in the app and reaches app types.
final class SmokeTests: XCTestCase {
    func testTestableImportReachesAppTypes() {
        let card = Card(suit: .spades, rank: .ace)
        XCTAssertEqual(card.id, "A_spades")
    }

    func testHostedWithoutSocket() {
        XCTAssertNotNil(ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"])
        XCTAssertFalse(SocketService.shared.isConnected, "setupSocket must not connect under XCTest")
    }

    func testContractFixtureFolderIsBundled() throws {
        let bundle = Bundle(for: SmokeTests.self)
        let url = try XCTUnwrap(bundle.url(forResource: "index", withExtension: "json", subdirectory: "v2"))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(obj["snapshotVersion"] as? Int, 2)
    }
}

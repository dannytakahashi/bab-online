import XCTest
@testable import BAB_Online

/// The generated TableSnapshot decodes every server-produced snapshot.
final class TableSnapshotDecodingTests: XCTestCase {
    func testEveryV2FixtureDecodesStrictly() throws {
        let names = try FixtureLoader.v2Names()
        XCTAssertEqual(names.count, 14)
        for name in names {
            let raw = try FixtureLoader.v2Snapshot(name)
            do {
                let snap = try TableSnapshot.decode(raw, strict: true)
                XCTAssertEqual(snap.v, 2, name)
                XCTAssertEqual(snap.bids.byPosition.count, 4, name)
                XCTAssertEqual(snap.tricksByPosition.count, 4, name)
            } catch {
                XCTFail("\(name): \(error)")
            }
        }
    }

    func testFixtureStagesAndRoles() throws {
        let index = try XCTUnwrap(try FixtureLoader.json(url: XCTUnwrap(FixtureLoader.bundle.url(forResource: "index", withExtension: "json", subdirectory: "v2"))) as? [String: Any])
        for entry in try XCTUnwrap(index["fixtures"] as? [[String: Any]]) {
            let name = try XCTUnwrap(entry["name"] as? String)
            let snap = try TableSnapshot.decode(try FixtureLoader.v2Snapshot(name), strict: true)
            XCTAssertEqual(snap.stage.rawValue, entry["stage"] as? String, name)
            XCTAssertEqual(snap.viewer.role.rawValue, entry["viewerRole"] as? String, name)
        }
    }

    func testUnknownEnumValuesFallBackUnlessStrict() throws {
        var raw = try FixtureLoader.v2Snapshot("presence-mixed")
        raw["stage"] = "SOME_NEW_STAGE"
        var seats = try XCTUnwrap(raw["seats"] as? [[String: Any]])
        seats[0]["presence"] = "hibernating"
        raw["seats"] = seats
        let snap = try TableSnapshot.decode(raw)
        XCTAssertEqual(snap.stage, .unknown("SOME_NEW_STAGE"))
        XCTAssertEqual(snap.seats[0].presence, .unknown("hibernating"))
        XCTAssertThrowsError(try TableSnapshot.decode(raw, strict: true))
    }

    func testEncodeDecodeRoundTrip() throws {
        for name in try FixtureLoader.v2Names() {
            let snap = try TableSnapshot.decode(try FixtureLoader.v2Snapshot(name), strict: true)
            let data = try JSONEncoder().encode(snap)
            XCTAssertEqual(try TableSnapshot.decode(data: data, strict: true), snap, name)
        }
    }

    func testRejectsOtherVersions() throws {
        var raw = try FixtureLoader.v2Snapshot("bidding-mid")
        raw["v"] = 3
        XCTAssertThrowsError(try TableSnapshot.decode(raw)) { XCTAssertEqual($0 as? SnapshotDecodeError, .unsupportedVersion(3)) }
        XCTAssertThrowsError(try TableSnapshot.decode("nope")) { XCTAssertEqual($0 as? SnapshotDecodeError, .notAnObject) }
    }

    func testContractSeqListsTheSequencedEvents() {
        XCTAssertTrue(ContractSeq.events.contains("cardPlayed"))
        XCTAssertTrue(ContractSeq.events.contains("chatMessage"))
        XCTAssertTrue(ContractSeq.events.contains("voicePeerLeft"))
        XCTAssertFalse(ContractSeq.events.contains("youDrew"))
        XCTAssertEqual(ContractSeq.events.count, 26)
    }
}

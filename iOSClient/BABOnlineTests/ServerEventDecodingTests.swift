import XCTest
@testable import BAB_Online

/// Every recorded server → client event decodes into the typed wire layer.
final class ServerEventDecodingTests: XCTestCase {
    /// Events the table store does not consume (voice signalling, the 'error' toast).
    static let notStoreEvents: Set<String> = ["voicePeerJoined", "voicePeerList", "error"]

    func testEveryRecordedEventDecodesStrictly() throws {
        var counts: [String: Int] = [:]
        for name in FixtureLoader.eventLogNames {
            let rec = try FixtureLoader.eventLog(name)
            let logs = try XCTUnwrap(rec["logs"] as? [String: [[String: Any]]])
            for (label, log) in logs {
                for entry in log where entry["dir"] as? String == "s2c" {
                    let event = try XCTUnwrap(entry["event"] as? String)
                    let payload: [Any] = entry["data"].map { $0 is NSNull ? [] : [$0] } ?? []
                    if Self.notStoreEvents.contains(event) {
                        if event == "error" {
                            XCTAssertNoThrow(try Wire.decode(WirePayload.ServerError.self, payload.first, strict: true))
                        }
                        continue
                    }
                    switch ServerEvent.decode(name: event, payload: payload, strict: true) {
                    case .success(let ev):
                        counts[event, default: 0] += 1
                        let rawSeq = (payload.first as? [String: Any])?["seq"] as? Int
                        XCTAssertEqual(ev.seq, rawSeq, "\(name)/\(label) #\(entry["i"] ?? "?") \(event)")
                    case .failure(let err):
                        XCTFail("\(name)/\(label) #\(entry["i"] ?? "?") \(event): \(err)")
                    }
                }
            }
        }
        for e in ["gameStart", "cardPlayed", "bidReceived", "rejoinSuccess", "spectatorJoined", "actionRejected", "restorePlayerState", "playerResigned"] {
            XCTAssertGreaterThan(counts[e] ?? 0, 0, e)
        }
    }

    func testEmbeddedSnapshotsDecodeStrictly() throws {
        var n = 0
        for name in FixtureLoader.eventLogNames {
            let rec = try FixtureLoader.eventLog(name)
            for cp in try XCTUnwrap(rec["checkpoints"] as? [[String: Any]]) {
                XCTAssertNoThrow(try TableSnapshot.decode(try XCTUnwrap(cp["snapshot"]), strict: true))
                n += 1
            }
            for (_, f) in try XCTUnwrap(rec["final"] as? [String: [String: Any]]) {
                XCTAssertNoThrow(try TableSnapshot.decode(try XCTUnwrap(f["snapshot"]), strict: true))
            }
        }
        XCTAssertGreaterThan(n, 100)
    }

    /// 21.DW: a legacy rejoin built by JSONSerialization (sparse NSNull
    /// playedCards, seat 3 leading, numeric pics) decodes; only the hints are read.
    func testLegacyRejoinEnvelopeWithNullHoles() throws {
        var snap = try FixtureLoader.v2Snapshot("trick-mid-lead3")
        snap["partial"] = ["customPics"]
        let json = """
        {"gameId":"g","position":1,"playedCards":[null,null,{"suit":"hearts","rank":"A"},{"suit":"hearts","rank":"2"}],
         "leadPosition":3,"isLazy":false,"tournamentId":null,
         "players":[{"position":1,"username":"a","pic":7,"socketId":"s1"},{"position":2,"username":"b","pic":"12","socketId":"s2"},
                    {"position":3,"username":"c","pic":"data:image/png;base64,AAAA","socketId":"s3"},{"position":4,"username":"d","pic":null,"socketId":"bot:x"}]}
        """
        var dict = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        dict["snapshot"] = snap
        let decoded = ServerEvent.decode(name: "rejoinSuccess", payload: [dict], strict: true)
        guard case .success(let ev) = decoded, case .rejoinSuccess(let env) = ev.event else { return XCTFail("\(decoded)") }
        XCTAssertNotNil(env.snapshot)
        XCTAssertTrue(env.hasTournamentId)
        XCTAssertNil(env.tournamentId)
        XCTAssertEqual(env.hints.pics, [1: .avatar(7), 2: .avatar(12), 3: .custom("data:image/png;base64,AAAA")], "a null pic is no hint")
        XCTAssertEqual(env.hints.sockets, [1: "s1", 2: "s2", 3: "s3", 4: "bot:x"])
    }

    func testNSNumberBoolIsNotAnInt() throws {
        let bad: [String: Any] = ["winner": NSNumber(value: true)]
        guard case .failure = ServerEvent.decode(name: "trickComplete", payload: [bad]) else { return XCTFail("a bool winner must not decode") }
        let good: [String: Any] = ["winner": NSNumber(value: 3), "seq": NSNumber(value: 9)]
        guard case .success(let ev) = ServerEvent.decode(name: "trickComplete", payload: [good]) else { return XCTFail() }
        XCTAssertEqual(ev.seq, 9)
        // a bool seq is no seq
        guard case .success(let ev2) = ServerEvent.decode(name: "createUI", payload: [["seq": NSNumber(value: true)]]) else { return XCTFail() }
        XCTAssertNil(ev2.seq)
    }

    func testBidWireNormalises() throws {
        XCTAssertEqual(try Wire.decode(BidWire.self, 4).value, "4")
        XCTAssertEqual(try Wire.decode(BidWire.self, "2b").value, "2B")
        let br = try Wire.decode(WirePayload.BidReceived.self, ["bid": 3, "position": 2, "bidArray": [NSNull(), 3]] as [String: Any])
        XCTAssertEqual(br.bidArray?.map { $0?.value }, [nil, "3"])
    }

    func testUnknownEventAndMissingPayload() {
        guard case .failure(.unknownEvent("nope")) = ServerEvent.decode(name: "nope", payload: []) else { return XCTFail() }
        guard case .failure(.missingPayload("cardPlayed")) = ServerEvent.decode(name: "cardPlayed", payload: []) else { return XCTFail() }
    }
}

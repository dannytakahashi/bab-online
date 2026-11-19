import SwiftUI
import XCTest
@testable import BAB_Online

/// Red fault rows (the server's hand-end fault lines, server rules.handFaults): a gameLogEntry
/// or a snapshot log item that carries `fault` is a red row, live and on every replay, once;
/// and the snapshot's viewer.assist makes the /help count exact after a rejoin.
final class FaultRowsTests: XCTestCase {
    private func faults(_ s: TableState) -> [String] { s.log.entries.filter(\.isFault).map(\.message) }

    // MARK: - Wire

    func testTheFaultDecodesAndAWrongShapeLeavesAPlainRow() throws {
        let ev = try ServerEvent.decode(name: "gameLogEntry", payload: [[
            "message": "Fault: 🤖 Mike (bid 2, took 0)", "type": "system", "seq": 9,
            "fault": ["position": 3, "bid": 2, "took": 0],
        ] as [String: Any]], strict: true).get()
        XCTAssertEqual(ev.seq, 9, "a stored room line: sequenced")
        guard case .gameLogEntry(let p) = ev.event else { return XCTFail("\(ev.event)") }
        XCTAssertEqual(p.fault, .init(position: 3, bid: 2, took: 0))
        let odd = try ServerEvent.decode(name: "gameLogEntry", payload: [[
            "message": "Fault: x (bid 1, took 0)", "type": "system", "seq": 10, "fault": "not an object",
        ] as [String: Any]], strict: true).get()
        guard case .gameLogEntry(let q) = odd.event else { return XCTFail("\(odd.event)") }
        XCTAssertNil(q.fault, "a fault this build cannot read is absent, never a dropped line")
        XCTAssertEqual(q.message, "Fault: x (bid 1, took 0)")
        XCTAssertEqual(odd.seq, 10)
    }

    // MARK: - Reducer

    func testALiveFaultLineIsARedRow() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("gameLogEntry", ["message": "Hand over.", "type": "system", "seq": 3]))
        TableReducer.reduce(&s, T.ev("gameLogEntry", ["message": "Fault: me (bid 2, took 1)", "type": "system", "seq": 4,
                                                      "fault": ["position": 1, "bid": 2, "took": 1]]))
        XCTAssertEqual(faults(s), ["Fault: me (bid 2, took 1)"])
        XCTAssertFalse(s.log.entries.first { $0.message == "Hand over." }!.isFault, "no fault: the plain dim row")
        XCTAssertEqual(s.log.entries.last?.type, .system)
        XCTAssertEqual(s.log.unread, 0, "a system line is no unread chat")
    }

    func testTheSnapshotLogReplaysTheFaultsInPlaceOnce() throws {
        let snap = try T.snapshot("trick-mid-lead3") { raw in
            var log = raw["log"] as? [[String: Any]] ?? []
            log.insert(["message": "Fault: ivy (bid 3, took 1)", "type": "system", "position": NSNull(), "at": 1_767_268_800_000,
                        "fault": ["position": 1, "bid": 3, "took": 1]], at: 1)
            log.append(["message": "Fault: hal (bid 4, took 2)", "type": "system", "position": NSNull(), "at": 1_767_268_810_000,
                        "fault": ["position": 3, "bid": 4, "took": 2]])
            raw["log"] = log
        }
        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: "ivy", playerId: "ui")))
        TableReducer.reduce(&s, .snapshot(snap, .rejoin, hints: nil))
        XCTAssertEqual(faults(s), ["Fault: ivy (bid 3, took 1)", "Fault: hal (bid 4, took 2)"])
        XCTAssertTrue(s.log.entries[1].isFault, "in place, where the server stored it")
        XCTAssertEqual(s.log.entries.count, snap.log.count)
        // the same snapshot again (a reconnect): the same rows, not twice
        TableReducer.reduce(&s, .snapshot(snap, .requested("again"), hints: nil))
        XCTAssertEqual(faults(s), ["Fault: ivy (bid 3, took 1)", "Fault: hal (bid 4, took 2)"])
        // a snapshot that leaves the log out keeps this game's rows
        let partial = try T.snapshot("trick-mid-lead3") { raw in raw["log"] = [Any](); raw["partial"] = ["log"] }
        TableReducer.reduce(&s, .snapshot(partial, .requested("p"), hints: nil))
        XCTAssertEqual(faults(s).count, 2)
    }

    /// The recorded games (the server's real fault lines): at every checkpoint the replayed
    /// log's red rows are the server snapshot's fault items, in order, none missing or twice,
    /// and a red row is exactly a line the server marked.
    func testRecordedGamesMatchTheServersFaultRows() throws {
        var compared = 0, seen = 0
        for game in try RecordedGame.all() {
            for viewer in game.viewers {
                let log = game.logs[viewer.label] ?? []
                var replay = ReducerReplay(viewer: viewer)
                var next = 0
                for check in game.checks(for: viewer.label) {
                    while next < check.afterIndex { try replay.apply(log[next]); next += 1 }
                    let server = (check.snapshot["log"] as? [[String: Any]] ?? []).filter { $0["fault"] != nil }.compactMap { $0["message"] as? String }
                    let mine = faults(replay.state)
                    let partial = (check.snapshot["partial"] as? [String])?.contains("log") ?? false
                    if !partial { XCTAssertEqual(mine, server, "\(game.name)/\(viewer.label) after #\(check.afterIndex)") }
                    let marked = replay.state.log.entries.filter { $0.type == .system && $0.message.hasPrefix("Fault: ") }
                    XCTAssertTrue(marked.allSatisfy(\.isFault), "\(game.name)/\(viewer.label): a server fault line drawn plain")
                    seen = max(seen, mine.count)
                    compared += 1
                }
            }
        }
        XCTAssertGreaterThan(compared, 100)
        XCTAssertGreaterThan(seen, 2, "the recordings carry real fault lines")
    }

    func testSeatOneRejoinReplaysThenAppendsLive() throws {
        let game = try RecordedGame("events-bots-s14")
        let viewer = game.viewer("seat1-rejoin")
        var replay = ReducerReplay(viewer: viewer)
        let log = try XCTUnwrap(game.logs[viewer.label])
        try replay.apply(log[0])  // the rejoin's snapshot
        XCTAssertEqual(faults(replay.state), ["Fault: ios_ann (bid 4, took 3)", "Fault: 🤖 Mike (bid 2, took 0)", "Fault: 🤖 Mike (bid 1, took 0)"])
        for e in log.dropFirst() { try replay.apply(e) }
        let all = faults(replay.state)
        XCTAssertEqual(all.prefix(4), ["Fault: ios_ann (bid 4, took 3)", "Fault: 🤖 Mike (bid 2, took 0)", "Fault: 🤖 Mike (bid 1, took 0)",
                                        "Fault: 🤖 Sharon (bid 1, took 0)"])
        XCTAssertEqual(all.suffix(2), ["Fault: ios_ann (bid 4, took 3)", "Fault: 🤖 Mike (bid 4, took 3)"])
        XCTAssertEqual(all.count, 9, "3 replayed + 6 live, none twice")
    }

    // MARK: - The row

    func testTheRowIsRedOthersStayDim() {
        var fault = ChatMessage(username: "System", message: "Fault: a (bid 1, took 0)", type: .system)
        fault.isFault = true
        XCTAssertEqual(GameLogEntryView.systemColor(fault), Theme.error)
        XCTAssertEqual(Theme.error, Theme.Palette.Danger.text.color, "danger.text, the web's red")
        XCTAssertEqual(GameLogEntryView.systemColor(ChatMessage(username: "System", message: "x", type: .system)), Theme.textDim)
        var mine = ChatMessage(username: "System", message: "Help: Bid 2 (only you see this)", type: .system)
        mine.isPrivate = true
        XCTAssertEqual(GameLogEntryView.systemColor(mine), Theme.gold.opacity(0.75))
    }

    // MARK: - /help uses from the snapshot

    func testTheSnapshotsViewerAssistMakesTheCountExact() throws {
        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: "ivy", playerId: "ui")))
        let two = try T.snapshot("trick-mid-lead3") { raw in
            var v = raw["viewer"] as! [String: Any]
            v["assist"] = ["uses": 2, "freeUses": 3, "assisted": false]
            raw["viewer"] = v
        }
        TableReducer.reduce(&s, .snapshot(two, .rejoin, hints: nil))
        XCTAssertEqual(s.table.assistUses, AssistUses(uses: 2, freeUses: 3, assisted: false, told: true))
        XCTAssertEqual(AssistRules.helpDescription(s.table.assistUses), "Ask a bot for advice (2 of 3 free used)")
        // a same-game snapshot without it (an older server) keeps what we had
        let none = try T.snapshot("trick-mid-lead3") { raw in
            var v = raw["viewer"] as! [String: Any]
            v.removeValue(forKey: "assist")
            raw["viewer"] = v
        }
        TableReducer.reduce(&s, .snapshot(none, .requested("r"), hints: nil))
        XCTAssertEqual(s.table.assistUses?.uses, 2)
        let crossed = try T.snapshot("trick-mid-lead3") { raw in
            var v = raw["viewer"] as! [String: Any]
            v["assist"] = ["uses": 4, "freeUses": 3, "assisted": true]
            raw["viewer"] = v
        }
        TableReducer.reduce(&s, .snapshot(crossed, .requested("c"), hints: nil))
        XCTAssertEqual(AssistRules.helpDescription(s.table.assistUses), "Ask a bot for advice (this game is bot-assisted for you)")
        // a spectator's snapshot carries none: unknown
        var w = TableState()
        TableReducer.reduce(&w, .local(.identity(username: "zed", playerId: "w")))
        TableReducer.reduce(&w, .snapshot(try T.snapshot("spectator-mid-hand"), .rejoin, hints: nil))
        XCTAssertNil(w.table.assistUses)
    }
}

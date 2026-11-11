import Foundation
import XCTest
@testable import BAB_Online

/// One recorded fixture (server/testUtils/eventRecorder.js), typed for the tests.
struct RecordedGame {
    struct Viewer { let label: String; let sid: String; let role: String; let position: Int?; let username: String? }
    struct Entry { let i: Int; let dir: String; let event: String; let t: Int; let data: Any? }
    struct Checkpoint { let viewer: String; let afterIndex: Int; let snapshot: [String: Any] }
    struct Final { let afterIndex: Int; let snapshot: [String: Any]; let gameEnd: [String: Any] }

    let name: String
    let viewers: [Viewer]
    let logs: [String: [Entry]]
    let checkpoints: [Checkpoint]
    let final: [String: Final]

    init(_ name: String) throws {
        let raw = try FixtureLoader.eventLog(name)
        self.name = name
        viewers = try XCTUnwrap(raw["viewers"] as? [[String: Any]]).map {
            Viewer(label: $0["label"] as! String, sid: $0["sid"] as! String, role: $0["role"] as! String,
                   position: $0["position"] as? Int, username: $0["username"] as? String)
        }
        var logs: [String: [Entry]] = [:]
        for (label, list) in try XCTUnwrap(raw["logs"] as? [String: [[String: Any]]]) {
            logs[label] = list.map { Entry(i: $0["i"] as! Int, dir: $0["dir"] as! String, event: $0["event"] as! String,
                                           t: $0["t"] as? Int ?? 0, data: ($0["data"] is NSNull) ? nil : $0["data"]) }
        }
        self.logs = logs
        checkpoints = try XCTUnwrap(raw["checkpoints"] as? [[String: Any]]).map {
            Checkpoint(viewer: $0["viewer"] as! String, afterIndex: $0["afterIndex"] as! Int, snapshot: $0["snapshot"] as! [String: Any])
        }
        var final: [String: Final] = [:]
        for (label, f) in try XCTUnwrap(raw["final"] as? [String: [String: Any]]) {
            final[label] = Final(afterIndex: f["afterIndex"] as! Int, snapshot: f["snapshot"] as! [String: Any], gameEnd: f["gameEnd"] as! [String: Any])
        }
        self.final = final
    }

    static func all() throws -> [RecordedGame] { try FixtureLoader.eventLogNames.map { try RecordedGame($0) } }

    func viewer(_ label: String) -> Viewer { viewers.first { $0.label == label }! }

    /// Every (afterIndex, snapshot) to check for a viewer, the final one included.
    func checks(for label: String) -> [(afterIndex: Int, snapshot: [String: Any], isFinal: Bool)] {
        var out = checkpoints.filter { $0.viewer == label }.map { (afterIndex: $0.afterIndex, snapshot: $0.snapshot, isFinal: false) }
        if let f = final[label] { out.append((afterIndex: f.afterIndex, snapshot: f.snapshot, isFinal: true)) }
        return out.sorted { $0.afterIndex < $1.afterIndex }
    }
}

/// Feeds a recorded viewer log into the pure reducer (no store, no handlers).
struct ReducerReplay {
    var state = TableState()
    var effects: [TableEffect] = []
    private var reqId: UInt32 = 0
    let me: RecordedGame.Viewer

    init(viewer: RecordedGame.Viewer) {
        me = viewer
        TableReducer.reduce(&state, .local(.identity(username: viewer.username, playerId: viewer.sid)))
    }

    mutating func apply(_ e: RecordedGame.Entry) throws {
        if e.dir == "c2s" {
            guard let d = e.data as? [String: Any] else { return }
            switch e.event {
            case "playCard":
                guard let cd = d["card"] as? [String: Any], let card = Card.from(cd) else { return }
                reqId += 1
                effects += TableReducer.reduce(&state, .local(.submitPlay(card, reqId: reqId)))
            case "playerBid":
                let bid = (d["bid"] as? String) ?? (d["bid"] as? Int).map(String.init) ?? "0"
                reqId += 1
                effects += TableReducer.reduce(&state, .local(.submitBid(bid, reqId: reqId)))
            default:
                break
            }
            return
        }
        let payload: [Any] = e.data.map { [$0] } ?? []
        switch e.event {
        case "voicePeerJoined", "voicePeerList":
            return
        case "spectatorsUpdated":
            // no handler in the app yet (as in the App Store build): unsequenced, so skipping it moves no seq
            return
        case "tournamentGameAssignment":
            let d = e.data as? [String: Any]
            if let gid = d?["gameId"] as? String {
                effects += TableReducer.reduce(&state, .local(.enterGameContext(gameId: gid, tournamentId: d?["tournamentId"] as? String)))
            }
            return
        case "error":
            let err = try Wire.decode(WirePayload.ServerError.self, e.data)
            if let h = err.handler, ["playCard", "playerBid", "requestSnapshot"].contains(h) {
                effects += TableReducer.reduce(&state, .local(.transportError(handler: h)))
            }
            return
        default:
            let mine = ((e.data as? [String: Any])?["username"] as? String) == me.username
            switch ServerEvent.decode(name: e.event, payload: payload, strict: true, chatMine: mine) {
            case .success(let ev): effects += TableReducer.reduce(&state, .server(ev))
            case .failure(let err): throw err
            }
        }
    }
}

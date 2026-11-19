import Foundation

/// One decoded server → client event the table store consumes.
enum ServerEvent: Equatable {
    // pre-game / draw
    case allPlayersReady(WirePayload.AllPlayersReady)
    case startDraw
    case youDrew(WirePayload.YouDrew)
    case playerDrew(WirePayload.PlayerDrew)
    case positionUpdate(WirePayload.PositionUpdate)
    case teamsAnnounced(WirePayload.TeamsAnnounced)
    case createUI
    // deal / bidding / play
    case gameStart(WirePayload.GameStart)
    case updateTurn(WirePayload.UpdateTurn)
    case bidReceived(WirePayload.BidReceived)
    case doneBidding(WirePayload.DoneBidding)
    case rainbow(WirePayload.PositionOnly)
    case destroyHands
    case cardPlayed(WirePayload.CardPlayed)
    case trickComplete(WirePayload.TrickComplete)
    case handComplete(WirePayload.HandComplete)
    case gameEnd(WirePayload.GameEnd, data: GameEndData?)
    case abortGame
    case leftGame
    // presence / seats
    case playerDisconnected(WirePayload.Presence)
    case playerReconnected(WirePayload.Presence)
    case resignationAvailable(WirePayload.ResignationAvailable)
    case playerResigned(WirePayload.PlayerResigned)
    case playerLazyMode(WirePayload.LazyMode)
    case playerActiveMode(WirePayload.ActiveMode)
    // log / chat / spectators / voice
    case gameLogEntry(WirePayload.GameLogEntry)
    case chatMessage(WirePayload.Chat, blocked: Bool, mine: Bool)
    case spectatorNotice(WirePayload.SpectatorNotice)
    /// spectatorsUpdated: UNSEQUENCED (decoded with seq nil whatever the payload says), so it
    /// goes around the seq gate and never opens or fills a gap (V1_REMOVALS "iOS spectator badge")
    case spectators(WirePayload.SpectatorsUpdated)
    /// bidClock: UNSEQUENCED too (decoded with seq nil): a human seat's bid clock started or
    /// stopped (contract/README.md "Bid clock"); never opens or fills a gap
    case bidClock(WirePayload.BidClock)
    /// seatLeft: UNSEQUENCED too (decoded with seq nil): a seat's owner left for good (the
    /// voice rule, VoiceCompany); never opens or fills a gap
    case seatLeft(WirePayload.SeatLeft)
    case seqOnly
    // snapshot carriers
    case rejoinSuccess(WirePayload.RejoinEnvelope)
    case rejoinFailed(WirePayload.RejoinFailed)
    case restorePlayerState(WirePayload.RejoinEnvelope)
    case spectatorState(WirePayload.RejoinEnvelope)
    case actionRejected(WirePayload.ActionRejected)
    case stateSnapshot(WirePayload.StateSnapshot)

    /// Restores (and a refused action's rollback): what they show is state, not news (no sounds).
    var isSnapshotCarrier: Bool {
        switch self {
        case .rejoinSuccess, .rejoinFailed, .restorePlayerState, .spectatorState, .actionRejected, .stateSnapshot: return true
        default: return false
        }
    }
}

struct SequencedEvent: Equatable {
    let name: String
    let seq: Int?
    let event: ServerEvent
}

enum WireError: Error, Equatable {
    case unknownEvent(String)
    case missingPayload(String)
    /// `message`: DecodeTrace.describe (kind + coding path, never a value), logged in release too.
    case decode(event: String, message: String)
    /// A snapshot carrier whose snapshot this build cannot show. Not a delta: asking again
    /// gets the same snapshot, so TableReducer.snapshotFailed retries a bounded number of times.
    case snapshot(event: String, requestId: String?, problem: SnapshotProblem)
}

/// Why a snapshot cannot be shown (a newer server's table, in every case).
enum SnapshotProblem: Equatable {
    case undecodable(String)   // DecodeTrace.describe of the error
    case version(Int?)         // v is not 2 (the web rejects it too)
    case unknownStage(String)  // a stage this build does not know

    var summary: String {
        switch self {
        case .undecodable(let d): return d
        case .version(let v): return "snapshot v \(v.map(String.init) ?? "missing")"
        case .unknownStage(let raw): return "unknown stage \(raw)"
        }
    }
}

/// A decode error as its kind + coding path (keys and array indices), none of the payload's
/// values, so release builds can log it with no PII.
enum DecodeTrace {
    static func describe(_ error: Error) -> String {
        guard let e = error as? DecodingError else { return String(describing: type(of: error)) }
        switch e {
        case .keyNotFound(let key, let c): return "keyNotFound \(path(c.codingPath + [key]))"
        case .typeMismatch(let t, let c): return "typeMismatch \(t) at \(path(c.codingPath))"
        case .valueNotFound(let t, let c): return "valueNotFound \(t) at \(path(c.codingPath))"
        case .dataCorrupted(let c): return "dataCorrupted at \(path(c.codingPath))"
        @unknown default: return "DecodingError"
        }
    }

    /// "snapshot.seats[0].position"; "(root)" for the payload itself.
    static func path(_ keys: [CodingKey]) -> String {
        guard !keys.isEmpty else { return "(root)" }
        return keys.enumerated().map { i, k in
            if let n = k.intValue { return "[\(n)]" }
            return i == 0 ? k.stringValue : ".\(k.stringValue)"
        }.joined()
    }

    /// The error is inside the payload's `snapshot` (not the carrier's own fields).
    static func isInSnapshot(_ error: Error) -> Bool {
        guard let e = error as? DecodingError else { return false }
        switch e {
        case .keyNotFound(let key, let c): return (c.codingPath + [key]).first?.stringValue == "snapshot"
        case .typeMismatch(_, let c), .valueNotFound(_, let c), .dataCorrupted(let c): return c.codingPath.first?.stringValue == "snapshot"
        @unknown default: return false
        }
    }
}

extension ServerEvent {
    /// Decode a raw Socket.IO event. Never throws: a failure is a `WireError`
    /// (the store logs it, in release too, and resyncs: GameState.apply(serverEvent:)).
    /// `chatBlocked` / `chatMine`: chatMessage context from SafetyState / the identity.
    static func decode(name: String, payload: [Any], strict: Bool = false,
                       chatBlocked: Bool = false, chatMine: Bool = false) -> Result<SequencedEvent, WireError> {
        let first = payload.first
        func d<T: Decodable>(_ t: T.Type) throws -> T {
            guard let first, !(first is NSNull) else { throw WireError.missingPayload(name) }
            return try Wire.decode(t, first, strict: strict)
        }
        var seq: Int? = ((first as? [String: Any])?["seq"] as? NSNumber).flatMap { CFGetTypeID($0) == CFBooleanGetTypeID() ? nil : $0.intValue }
        let carriesSnapshot = snapshotCarriers.contains(name)
        func snapshotFailure(_ problem: SnapshotProblem) -> Result<SequencedEvent, WireError> {
            .failure(.snapshot(event: name, requestId: (first as? [String: Any])?["requestId"] as? String, problem: problem))
        }
        // the version first: a v3 snapshot may decode, or fail anywhere, and is not ours either way
        if carriesSnapshot, let raw = (first as? [String: Any])?["snapshot"] as? [String: Any] {
            let v = (raw["v"] as? NSNumber).flatMap { CFGetTypeID($0) == CFBooleanGetTypeID() ? nil : $0.intValue }
            if v != 2 { return snapshotFailure(.version(v)) }
        }
        do {
            let event: ServerEvent
            switch name {
            case "allPlayersReady": event = .allPlayersReady(try d(WirePayload.AllPlayersReady.self))
            case "startDraw": event = .startDraw
            case "youDrew": event = .youDrew(try d(WirePayload.YouDrew.self))
            case "playerDrew": event = .playerDrew(try d(WirePayload.PlayerDrew.self))
            case "positionUpdate": event = .positionUpdate(try d(WirePayload.PositionUpdate.self))
            case "teamsAnnounced": event = .teamsAnnounced(try d(WirePayload.TeamsAnnounced.self))
            case "createUI": event = .createUI
            case "gameStart": event = .gameStart(try d(WirePayload.GameStart.self))
            case "updateTurn": event = .updateTurn(try d(WirePayload.UpdateTurn.self))
            case "bidReceived": event = .bidReceived(try d(WirePayload.BidReceived.self))
            case "doneBidding": event = .doneBidding(try d(WirePayload.DoneBidding.self))
            case "rainbow": event = .rainbow(try d(WirePayload.PositionOnly.self))
            case "destroyHands": event = .destroyHands
            case "cardPlayed": event = .cardPlayed(try d(WirePayload.CardPlayed.self))
            case "trickComplete": event = .trickComplete(try d(WirePayload.TrickComplete.self))
            case "handComplete": event = .handComplete(try d(WirePayload.HandComplete.self))
            case "gameEnd":
                let wire = try d(WirePayload.GameEnd.self)
                event = .gameEnd(wire, data: (first as? [String: Any]).flatMap(GameEndData.from))
            case "abortGame": event = .abortGame
            case "leftGame": event = .leftGame
            case "playerDisconnected": event = .playerDisconnected(try d(WirePayload.Presence.self))
            case "playerReconnected": event = .playerReconnected(try d(WirePayload.Presence.self))
            case "resignationAvailable": event = .resignationAvailable(try d(WirePayload.ResignationAvailable.self))
            case "playerResigned": event = .playerResigned(try d(WirePayload.PlayerResigned.self))
            case "playerLazyMode": event = .playerLazyMode(try d(WirePayload.LazyMode.self))
            case "playerActiveMode": event = .playerActiveMode(try d(WirePayload.ActiveMode.self))
            case "gameLogEntry": event = .gameLogEntry(try d(WirePayload.GameLogEntry.self))
            case "chatMessage": event = .chatMessage(try d(WirePayload.Chat.self), blocked: chatBlocked, mine: chatMine)
            case "voicePeerLeft": event = .seqOnly
            case "spectatorsUpdated":
                event = .spectators(try d(WirePayload.SpectatorsUpdated.self))
                seq = nil
            case "bidClock":
                event = .bidClock(try d(WirePayload.BidClock.self))
                seq = nil
            case "seatLeft":
                event = .seatLeft(try d(WirePayload.SeatLeft.self))
                seq = nil
            case "spectatorJoined":
                // The joiner's own full state, or the notice about someone else
                let env = try d(WirePayload.RejoinEnvelope.self)
                if env.snapshot != nil || env.hasFullState {
                    event = .spectatorState(env)
                } else {
                    event = .spectatorNotice(try d(WirePayload.SpectatorNotice.self))
                }
            case "rejoinSuccess": event = .rejoinSuccess(try d(WirePayload.RejoinEnvelope.self))
            case "rejoinFailed": event = .rejoinFailed((try? d(WirePayload.RejoinFailed.self)) ?? .init(reason: nil))
            case "restorePlayerState": event = .restorePlayerState(try d(WirePayload.RejoinEnvelope.self))
            case "actionRejected": event = .actionRejected(try d(WirePayload.ActionRejected.self))
            case "stateSnapshot": event = .stateSnapshot(try d(WirePayload.StateSnapshot.self))
            default: return .failure(.unknownEvent(name))
            }
            // production decodes an unknown stage as .unknown: a newer server's table, never applied
            if case .unknown(let raw)? = event.carriedSnapshot?.stage { return snapshotFailure(.unknownStage(raw)) }
            return .success(SequencedEvent(name: name, seq: seq, event: event))
        } catch let e as WireError {
            return .failure(e)
        } catch {
            if carriesSnapshot && DecodeTrace.isInSnapshot(error) { return snapshotFailure(.undecodable(DecodeTrace.describe(error))) }
            return .failure(.decode(event: name, message: DecodeTrace.describe(error)))
        }
    }

    /// The events that carry a snapshot v2 (contract/CLAUDE.md "Snapshot v2").
    static let snapshotCarriers: Set<String> = ["stateSnapshot", "rejoinSuccess", "restorePlayerState", "spectatorJoined", "actionRejected"]

    var carriedSnapshot: TableSnapshot? {
        switch self {
        case .rejoinSuccess(let e), .restorePlayerState(let e), .spectatorState(let e): return e.snapshot
        case .actionRejected(let p): return p.snapshot
        case .stateSnapshot(let p): return p.snapshot
        default: return nil
        }
    }
}

import Foundation

/// One decoded server → client event the table store consumes.
enum ServerEvent: Equatable {
    // pre-game / draw
    case allPlayersReady(WirePayload.AllPlayersReady)
    case startDraw
    case youDrew(WirePayload.YouDrew)
    case playerDrew(WirePayload.PlayerDrew)
    case playerAssigned
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
    case resignationAvailable(WirePayload.Presence)
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
    case seqOnly
    // snapshot carriers
    case rejoinSuccess(WirePayload.RejoinEnvelope)
    case rejoinFailed(WirePayload.RejoinFailed)
    case restorePlayerState(WirePayload.RejoinEnvelope)
    case spectatorState(WirePayload.RejoinEnvelope)
    case actionRejected(WirePayload.ActionRejected)
    case stateSnapshot(WirePayload.StateSnapshot)
    case roomFull
}

struct SequencedEvent: Equatable {
    let name: String
    let seq: Int?
    let event: ServerEvent
}

enum WireError: Error, Equatable {
    case unknownEvent(String)
    case missingPayload(String)
    case decode(event: String, message: String)
}

extension ServerEvent {
    /// Decode a raw Socket.IO event. Never throws: a failure is a `WireError`
    /// (the store logs it in DEBUG and resyncs with requestSnapshot).
    /// `chatBlocked` / `chatMine`: chatMessage context from SafetyState / the identity.
    static func decode(name: String, payload: [Any], strict: Bool = false,
                       chatBlocked: Bool = false, chatMine: Bool = false) -> Result<SequencedEvent, WireError> {
        let first = payload.first
        func d<T: Decodable>(_ t: T.Type) throws -> T {
            guard let first, !(first is NSNull) else { throw WireError.missingPayload(name) }
            return try Wire.decode(t, first, strict: strict)
        }
        var seq: Int? = ((first as? [String: Any])?["seq"] as? NSNumber).flatMap { CFGetTypeID($0) == CFBooleanGetTypeID() ? nil : $0.intValue }
        do {
            let event: ServerEvent
            switch name {
            case "allPlayersReady": event = .allPlayersReady(try d(WirePayload.AllPlayersReady.self))
            case "startDraw": event = .startDraw
            case "youDrew": event = .youDrew(try d(WirePayload.YouDrew.self))
            case "playerDrew": event = .playerDrew(try d(WirePayload.PlayerDrew.self))
            case "playerAssigned": event = .playerAssigned
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
            case "resignationAvailable": event = .resignationAvailable(try d(WirePayload.Presence.self))
            case "playerResigned": event = .playerResigned(try d(WirePayload.PlayerResigned.self))
            case "playerLazyMode": event = .playerLazyMode(try d(WirePayload.LazyMode.self))
            case "playerActiveMode": event = .playerActiveMode(try d(WirePayload.ActiveMode.self))
            case "gameLogEntry": event = .gameLogEntry(try d(WirePayload.GameLogEntry.self))
            case "chatMessage": event = .chatMessage(try d(WirePayload.Chat.self), blocked: chatBlocked, mine: chatMine)
            case "voicePeerLeft": event = .seqOnly
            case "spectatorsUpdated":
                event = .spectators(try d(WirePayload.SpectatorsUpdated.self))
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
            case "roomFull": event = .roomFull
            default: return .failure(.unknownEvent(name))
            }
            return .success(SequencedEvent(name: name, seq: seq, event: event))
        } catch let e as WireError {
            return .failure(e)
        } catch {
            return .failure(.decode(event: name, message: String(describing: error)))
        }
    }
}

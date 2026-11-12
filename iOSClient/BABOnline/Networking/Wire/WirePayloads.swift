import Foundation

/// Hand-written Decodables of the delta events the table reducer reads
/// (shapes from contract/src/s2c.js). Every field is optional except the
/// discriminants a handler cannot do without, so an additive server field
/// never breaks decoding.
enum WirePayload {
    struct SeqOnly: Decodable, Equatable { var seq: Int? }

    struct AllPlayersReady: Decodable, Equatable { var gameId: String? }

    struct YouDrew: Decodable, Equatable { var card: Card?; var drawOrder: Int?; var position: Int? }

    struct PlayerDrew: Decodable, Equatable {
        var username: String?; var card: Card?; var drawOrder: Int; var cardIndex: Int?; var seq: Int?
    }

    struct PositionUpdate: Decodable, Equatable {
        struct Name: Decodable, Equatable { var username: String?; var socketId: String? }
        var positions: [Int]?
        var sockets: [String]?
        var usernames: [Name]?
        var pics: [PicWire]?
        var avatarUrls: [String: String]?
        var yourPosition: Int?
        var seq: Int?
    }

    struct TeamsAnnounced: Decodable, Equatable { var team1: [String]?; var team2: [String]?; var resumeInMs: Int?; var seq: Int? }

    struct PlayerInfo: Decodable, Equatable { var position: Int; var username: String?; var pic: PicWire? }

    struct GameStart: Decodable, Equatable {
        var gameId: String?
        /// Custom pictures by position (clientHello avatarUrl cap: the playerInfo slot is null then).
        var avatarUrls: [String: String]?
        var players: [String]?
        var hand: [Card]?
        var trump: Card?
        var score1: Int?
        var score2: Int?
        var dealer: Int?
        var position: Int?
        var currentHand: Int?
        var hsiValues: [String: Double]?
        var playerInfo: [PlayerInfo]?
        var seq: Int?
    }

    struct UpdateTurn: Decodable, Equatable { var currentTurn: Int?; var turn: Int?; var seq: Int? }

    struct BidReceived: Decodable, Equatable {
        var bid: BidWire
        var position: Int
        var bidArray: [BidWire?]?
        var seq: Int?
    }

    struct DoneBidding: Decodable, Equatable {
        var bids: [BidWire?]?
        var lead: Int?
        var teamBids: TableSnapshot.TeamPair?
        var mults: TableSnapshot.TeamPair?
        var seq: Int?
    }

    struct PositionOnly: Decodable, Equatable { var position: Int?; var seq: Int? }

    struct CardPlayed: Decodable, Equatable {
        var card: Card
        var position: Int
        var trump: Bool?
        var trumpBroken: Bool?
        var resumeInMs: Int?
        var seq: Int?
    }

    struct TrickComplete: Decodable, Equatable { var winner: Int; var resumeInMs: Int?; var seq: Int? }

    struct HandComplete: Decodable, Equatable {
        var score: TableSnapshot.TeamPair?
        var team1Tricks: Int?
        var team2Tricks: Int?
        var team1OldScore: Int?
        var team2OldScore: Int?
        var seq: Int?
    }

    struct GameEnd: Decodable, Equatable { var tournamentId: String?; var seq: Int? }

    struct Presence: Decodable, Equatable { var position: Int?; var username: String?; var seq: Int? }

    struct PlayerResigned: Decodable, Equatable {
        var position: Int?; var oldUsername: String?; var botUsername: String?; var botPic: PicWire?; var seq: Int?
    }

    struct LazyMode: Decodable, Equatable {
        var position: Int?; var botUsername: String?; var botPic: PicWire?; var originalUsername: String?; var seq: Int?
    }

    struct ActiveMode: Decodable, Equatable {
        var position: Int?; var username: String?; var pic: PicWire?; var avatarUrl: String?; var seq: Int?
    }

    struct GameLogEntry: Decodable, Equatable { var message: String?; var type: String?; var playerPosition: Int?; var seq: Int? }

    struct Chat: Decodable, Equatable {
        var username: String?; var message: String?; var position: Int?; var type: String?; var isSpectator: Bool?; var seq: Int?
    }

    /// spectatorsUpdated: the whole list each time, UNSEQUENCED (never carries seq).
    struct SpectatorsUpdated: Decodable, Equatable {
        var gameId: String?
        var spectators: [TableSnapshot.Spectator]?
        var count: Int?
    }

    struct SpectatorNotice: Decodable, Equatable { var username: String?; var spectatorCount: Int?; var seq: Int? }

    /// rejoinSuccess / restorePlayerState / the spectator full state: only the
    /// v2 snapshot plus what v1 alone carries (socket ids and pictures for
    /// voice and R5, isLazy, tournamentId). Everything else (playedCards with
    /// NSNull holes, legacy bids...) is never read.
    struct RejoinEnvelope: Decodable, Equatable {
        struct Player: Decodable, Equatable { var position: Int?; var socketId: String?; var username: String?; var pic: PicWire? }
        var gameId: String?
        var avatarUrls: [String: String]?
        var snapshot: TableSnapshot?
        var isLazy: Bool?
        var tournamentId: String?
        var hasTournamentId: Bool
        var players: [Player]?
        var hasFullState: Bool  // spectatorJoined: the full state (players + trump), not the notice

        enum CodingKeys: String, CodingKey { case gameId, snapshot, isLazy, tournamentId, players, trump, avatarUrls }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            gameId = try c.decodeIfPresent(String.self, forKey: .gameId)
            avatarUrls = try c.decodeIfPresent([String: String].self, forKey: .avatarUrls)
            snapshot = try c.decodeIfPresent(TableSnapshot.self, forKey: .snapshot)
            isLazy = try c.decodeIfPresent(Bool.self, forKey: .isLazy)
            hasTournamentId = c.contains(.tournamentId)
            tournamentId = try c.decodeIfPresent(String.self, forKey: .tournamentId)
            players = try c.decodeIfPresent([Player].self, forKey: .players)
            hasFullState = c.contains(.players) && c.contains(.trump)
        }

        var hints: LegacySeatHints {
            var h = LegacySeatHints()
            for p in players ?? [] {
                guard let pos = Position.valid(p.position) else { continue }
                if let pic = p.pic?.pic { h.pics[pos] = pic }
                if let sid = p.socketId, !sid.isEmpty { h.sockets[pos] = sid }
            }
            for (k, url) in avatarUrls ?? [:] { if let pos = Position.valid(Int(k)) { h.avatarUrls[pos] = url } }
            return h
        }
    }

    struct ActionRejected: Decodable, Equatable { var action: String?; var reason: String?; var snapshot: TableSnapshot? }

    /// stateSnapshot: `{snapshot, requestId?}` or `{snapshot: null, reason: 'not_in_game', requestId?}`.
    struct StateSnapshot: Decodable, Equatable { var snapshot: TableSnapshot?; var reason: String?; var requestId: String? }

    /// The app-level `error` ({type?, message, handler?}) and `serverError` ({code, message, handler}, V1_REMOVALS #1).
    struct ServerError: Decodable, Equatable { var type: String?; var code: String?; var message: String?; var handler: String? }

    struct RejoinFailed: Decodable, Equatable { var reason: String? }
}

/// What a v1 snapshot carrier knows that the v2 snapshot leaves out
/// (`partial: customPics`) or never has (socket ids, for voice).
struct LegacySeatHints: Equatable {
    var pics: [Int: Pic] = [:]
    var sockets: [Int: String] = [:]
    /// Custom pictures as URLs (the carrier's `avatarUrls`, clientHello avatarUrl cap).
    var avatarUrls: [Int: String] = [:]
    /// rejoinSuccess always carries tournamentId (null for casual games); nil here = the key was absent.
    var tournamentId: String?? = nil
}

/// Seat positions from the wire: 1...4, anything else is no position (21.7).
enum Position {
    static func valid(_ v: Int?) -> Int? {
        guard let v, (1...4).contains(v) else { return nil }
        return v
    }
}

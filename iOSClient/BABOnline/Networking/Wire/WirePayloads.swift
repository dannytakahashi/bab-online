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
        /// positions order, true for a bot seat (additive, contract/V1_REMOVALS #14). Read first;
        /// the bot: prefix of `sockets` is the fallback for a server that does not send it yet.
        var isBot: [Bool]?
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

    /// resignationAvailable: `idle: true` (additive, 2026-11-15; absent otherwise) marks the
    /// tournament table's idle-seat offer: the player is connected, just slow on their turn.
    struct ResignationAvailable: Decodable, Equatable { var position: Int?; var username: String?; var idle: Bool?; var seq: Int? }

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

    /// seatLeft (additive 2026-11-19): a seat's owner left the game for good, UNSEQUENCED.
    struct SeatLeft: Decodable, Equatable {
        var gameId: String?
        var position: Int?
        var username: String?
    }

    /// spectatorsUpdated: the whole list each time, UNSEQUENCED (never carries seq).
    struct SpectatorsUpdated: Decodable, Equatable {
        var gameId: String?
        var spectators: [TableSnapshot.Spectator]?
        var count: Int?
    }

    /// bidClock (contract/README.md "Bid clock"): UNSEQUENCED (decoded with seq nil). `running`
    /// carries the time left from emission (`inMs`, relative: measured from receipt) and the
    /// clock's full length; `stopped` says why (`reason`). Fields optional but the two the
    /// reducer cannot do without, so a newer server's shape never fails the decode.
    struct BidClock: Decodable, Equatable {
        /// Why a clock stopped; a reason this build does not know is `.unknown` (treated as `turn`).
        enum Reason: Equatable, Decodable {
            case bid, timeout, turn, controller
            case unknown(String)

            init(from decoder: Decoder) throws {
                let raw = try decoder.singleValueContainer().decode(String.self)
                switch raw {
                case "bid": self = .bid
                case "timeout": self = .timeout
                case "turn": self = .turn
                case "controller": self = .controller
                default: self = .unknown(raw)
                }
            }
        }

        var gameId: String?
        var position: Int
        var running: Bool
        var inMs: Int?
        var durationMs: Int?
        var reason: Reason?
    }

    /// assistHint (s2c, private, UNSEQUENCED: decoded with seq nil): my own /help answer, sent
    /// only because this build's clientHello carries the cap `assist` (contract/src/s2c.js
    /// assistHint; docs/claude/assist.md). Every field optional, so a newer server's shape never
    /// fails the decode; one this build cannot show (v not 1, an unknown kind, no headline) is
    /// dropped by AssistRules.
    struct AssistHint: Decodable, Equatable {
        /// `suggest`: {bid} or {card}.
        struct Suggest: Decodable, Equatable { var bid: String?; var card: Card? }
        var v: Int?
        var source: String?
        var kind: String?
        var turnKey: String?
        var headline: String?
        var reasons: [String]?
        var uses: Int?
        var freeUses: Int?
        var assisted: Bool?
        var counted: Bool?
        var details: [String]?
        var confidence: String?
        var suggest: Suggest?
        var note: String?

        enum CodingKeys: String, CodingKey {
            case v, source, kind, turnKey, headline, reasons, uses, freeUses, assisted, counted, details, confidence, suggest, note
        }

        init(v: Int? = 1, source: String? = "help", kind: String?, turnKey: String? = nil, headline: String?, reasons: [String]? = nil,
             uses: Int? = nil, freeUses: Int? = nil, assisted: Bool? = nil, counted: Bool? = nil, details: [String]? = nil,
             confidence: String? = nil, suggest: Suggest? = nil, note: String? = nil) {
            self.v = v; self.source = source; self.kind = kind; self.turnKey = turnKey; self.headline = headline
            self.reasons = reasons; self.uses = uses; self.freeUses = freeUses; self.assisted = assisted; self.counted = counted
            self.details = details; self.confidence = confidence; self.suggest = suggest; self.note = note
        }

        /// Lenient: a field of the wrong type is absent (a card this build cannot read is no card).
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            func opt<T: Decodable>(_ t: T.Type, _ k: CodingKeys) -> T? { (try? c.decodeIfPresent(t, forKey: k)) ?? nil }
            v = opt(Int.self, .v)
            source = opt(String.self, .source)
            kind = opt(String.self, .kind)
            turnKey = opt(String.self, .turnKey)
            headline = opt(String.self, .headline)
            reasons = opt([String].self, .reasons)
            uses = opt(Int.self, .uses)
            freeUses = opt(Int.self, .freeUses)
            assisted = opt(Bool.self, .assisted)
            counted = opt(Bool.self, .counted)
            details = opt([String].self, .details)
            confidence = opt(String.self, .confidence)
            suggest = opt(Suggest.self, .suggest)
            note = opt(String.self, .note)
        }
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

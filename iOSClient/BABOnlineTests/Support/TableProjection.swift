import Foundation
@testable import BAB_Online

/// The comparable part of a table: built from a server snapshot or from the
/// client's TableState, then diffed field by field.
///
/// Excluded (never derivable from deltas, or display-only): serverTime,
/// resume, log, graceDeadline/resignableAt, partial, customPic/avatarUrl,
/// offered, ownerUsername, spectatorCount (silent leaves), draw.deckRemaining,
/// draw.viewerDrawOrder, entrants, tournament, viewer.ownerView.
struct TableProjection: Equatable {
    var phase: String
    var role: String
    var position: Int?
    var canAct: Bool
    var hand: [String]               // multiset (sorted ids)
    var deal: [Int]?                 // handNo, handSize, dealer, bidder, dealSeq
    var trump: String?
    var trumpBroken: Bool
    var turn: Int?
    var byPosition: [String?]
    var order: [Int]
    var teamBids: [Int]?
    var mults: [Int]
    var trickNumber: Int?
    var trickLead: Int?
    var trickCards: [String]         // "pos:cardId" in play order
    var tricks: [Int]
    var tricksByPosition: [Int]
    var score: [Int]
    var rainbows: [Int]
    var hsi: [Int: Double]
    var seats: [String]              // "pos username pic controller presence isBot lazy cards"
    var seq: Int?

    static func phaseName(stage: TableSnapshot.Stage, hasDeal: Bool) -> String {
        switch stage {
        case .created: return "waiting"
        case .drawing, .drawResolving, .teamsAnnounced: return "draw"
        case .dealing: return hasDeal ? "handResolving" : "draw"
        case .bidding, .redeal: return "bidding"
        case .playing, .trickResolving: return "playing"
        case .handResolving: return "handResolving"
        case .ended, .aborted, .unknown: return "ended"
        }
    }

    init(snapshot s: TableSnapshot) {
        phase = Self.phaseName(stage: s.stage, hasDeal: s.deal != nil)
        role = s.viewer.role.rawValue
        position = s.viewer.position
        canAct = s.viewer.canAct
        hand = (s.hand ?? []).map(\.id).sorted()
        deal = s.deal.map { [$0.handNo, $0.handSize, $0.dealer, $0.bidder, $0.dealSeq ?? 0] }
        trump = s.trump?.id
        trumpBroken = s.trumpBroken
        turn = s.turn?.position
        byPosition = s.bids.byPosition.map { $0?.uppercased() }
        order = s.bids.order
        teamBids = s.bids.teamBids.map { [$0.team1, $0.team2] }
        mults = [s.bids.mults.team1, s.bids.mults.team2]
        let inTrick = s.stage == .playing || s.stage == .trickResolving
        trickNumber = inTrick ? s.trick.number : nil
        trickLead = s.trick.leadPosition
        trickCards = s.trick.cards.map { "\($0.position):\($0.card.id)" }
        tricks = [s.tricks.team1, s.tricks.team2]
        tricksByPosition = s.tricksByPosition
        score = [s.score.team1, s.score.team2]
        rainbows = [s.rainbows.team1, s.rainbows.team2]
        var h: [Int: Double] = [:]
        for (i, v) in (s.hsi ?? []).enumerated() { if let v { h[i + 1] = v } }
        hsi = h
        seats = s.seats.map { "\($0.position) \($0.username ?? "-") \($0.pic.map(String.init) ?? "-") \($0.controller.rawValue) \($0.presence.rawValue) \($0.isBot) \($0.lazy) \($0.cardsInHand)" }
        seq = s.seq
    }

    init(state t: TableState) {
        phase = t.table.phase.kind.rawValue
        role = t.table.viewer.role.rawValue
        position = t.table.viewer.position
        canAct = t.myTurn.isChoosing
        hand = t.table.hand.map(\.id).sorted()
        deal = t.table.deal.map { [$0.handNo, $0.handSize, $0.dealer, $0.bidder, $0.dealSeq] }
        trump = t.table.deal?.trump?.id
        trumpBroken = t.table.deal?.trumpBroken ?? false
        turn = t.table.phase.turn
        let bids = t.table.phase.bids
        byPosition = bids?.byPosition ?? [nil, nil, nil, nil]
        order = bids?.order ?? []
        teamBids = bids?.teamBids.map { [$0.team1, $0.team2] }
        mults = [bids?.mults.team1 ?? 1, bids?.mults.team2 ?? 1]
        trickNumber = t.table.phase.kind == .playing ? t.table.trickNo : nil
        let trick = t.table.phase.trick
        trickLead = trick.isEmpty ? nil : t.table.phase.lead
        trickCards = trick.map { "\($0.position):\($0.card.id)" }
        tricks = [t.scores.tricks.team1, t.scores.tricks.team2]
        tricksByPosition = t.scores.tricksByPosition
        score = [t.scores.score.team1, t.scores.score.team2]
        rainbows = [t.scores.rainbows.team1, t.scores.rainbows.team2]
        hsi = t.table.viewer.role == .spectator ? [:] : t.table.hsi
        seats = t.players.seats.keys.sorted().map { pos in
            let x = t.players.seats[pos]!
            return "\(pos) \(x.username ?? "-") \(x.pic.number.map(String.init) ?? "-") \(x.controller.rawValue) \(x.presence.rawValue) \(x.isBot) \(x.lazy) \(x.cardsInHand)"
        }
        seq = t.sync.lastSeq
    }

    /// "field: client != server" lines (empty when equal).
    func diff(_ server: TableProjection) -> [String] {
        let mirror = Mirror(reflecting: self)
        let other = Mirror(reflecting: server)
        var out: [String] = []
        for (a, b) in zip(mirror.children, other.children) {
            let x = String(describing: a.value), y = String(describing: b.value)
            if x != y, !(a.label == "hsi" && (self.hsi == server.hsi)) { out.append("\(a.label ?? "?"): client \(x) != server \(y)") }
        }
        return out
    }
}

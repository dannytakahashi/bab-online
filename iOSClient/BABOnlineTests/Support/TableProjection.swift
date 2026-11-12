import Foundation
@testable import BAB_Online

/// The comparable part of a table: built from a server snapshot or from the
/// client's TableState, then diffed field by field.
///
/// Excluded, with the reason a mismatch there is acceptable:
///   serverTime, resume, partial     transport metadata
///   graceDeadline / resignableAt    absolute server times, never sent as deltas
///   customPic / avatarUrl           left out of the recorded snapshots (customPics:false)
///   log                             the snapshot carries the server's game log
///                                   ("🤖 Mary bid 2."), live play appends the
///                                   client's own lines ("🤖 Mary bid 2", as the
///                                   App Store build does): a rejoined client
///                                   shows both formats, by design
///   draw.deckRemaining / viewerDrawOrder, entrants, tournament (other than
///   its id), viewer.ownerView       not kept by the client
/// Compared with an allowance: R3's seating lead (the DRAW_RESOLVING snapshot
/// shows the seats ~1 s before positionUpdate; the entrant then is already a
/// seat), spectatorCount only moves with a notice (a spectator's /leave is
/// silent; no recording has one), and a lazy / resigned seat's away vs
/// connected (its owner's socket dropping or coming back sends nothing; the
/// client shows no presence for a bot-controlled seat), and `watching` while a
/// spectatorsUpdated is in flight (`diff(_:watchingInFlight:)`).
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
    var tricksByPosition: [Int?]
    var score: [Int]
    var rainbows: [Int]
    var hsi: [Int: Double]
    var seats: [String]              // "pos username pic owner controller presence isBot lazy cards"
    var offered: Int?                // the resignation offer's seat
    var spectatorCount: Int
    var watching: String             // "count: name pic, ..." (spectatorsUpdated, snapshot watching)
    var draw: [String]               // "drawOrder username card", draw stages only
    var tournamentId: String?
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
        order = ["bidding", "playing", "handResolving"].contains(phase) ? s.bids.order : []  // no bid book before the deal
        teamBids = s.bids.teamBids.map { [$0.team1, $0.team2] }
        mults = [s.bids.mults.team1, s.bids.mults.team2]
        let inTrick = s.stage == .playing || s.stage == .trickResolving
        trickNumber = inTrick ? s.trick.number : nil
        trickLead = s.trick.leadPosition
        trickCards = s.trick.cards.map { "\($0.position):\($0.card.id)" }
        tricks = [s.tricks.team1, s.tricks.team2]
        tricksByPosition = s.tricksByPosition.map { Optional($0) }
        score = [s.score.team1, s.score.team2]
        rainbows = [s.rainbows.team1, s.rainbows.team2]
        var h: [Int: Double] = [:]
        for (i, v) in (s.hsi ?? []).enumerated() { if let v { h[i + 1] = v } }
        hsi = h
        seats = s.seats.map { "\($0.position) \($0.username ?? "-") \($0.pic.map(String.init) ?? "-") \($0.ownerUsername ?? "-") \($0.controller.rawValue) \(Self.presence($0.presence.rawValue, $0.controller.rawValue)) \($0.isBot) \($0.lazy) \($0.cardsInHand)" }
        offered = s.seats.first(where: \.offered)?.position
        spectatorCount = s.spectatorCount
        watching = Self.watching(WatchingList(s.watching))
        let drawStage = [.drawing, .drawResolving, .teamsAnnounced].contains(s.stage)
        draw = drawStage ? (s.draw?.drawn ?? []).sorted { $0.drawOrder < $1.drawOrder }.map { "\($0.drawOrder) \($0.username ?? "-") \($0.card.id)" } : []
        tournamentId = s.tournament?.tournamentId
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
            return "\(pos) \(x.username ?? "-") \(x.pic.number.map(String.init) ?? "-") \(x.ownerUsername ?? "-") \(x.controller.rawValue) \(Self.presence(x.presence.rawValue, x.controller.rawValue)) \(x.isBot) \(x.lazy) \(x.cardsInHand)"
        }
        offered = t.players.resignationOffer?.position
        spectatorCount = t.players.spectatorCount
        watching = Self.watching(t.players.watching)
        if let d = t.table.phase.draw, d.stage != .dealing {
            draw = d.results.sorted { $0.drawOrder < $1.drawOrder }.map { "\($0.drawOrder) \($0.username) \($0.card?.id ?? "-")" }
        } else {
            draw = []
        }
        tournamentId = t.table.tournamentId
        seq = t.sync.lastSeq
    }

    static func watching(_ w: WatchingList) -> String {
        "\(w.count): " + w.spectators.map { "\($0.username) \($0.pic.map(String.init) ?? "-")" }.joined(separator: ", ")
    }

    /// A lazy / resigned seat's owner presence (away / connected) is not on the wire.
    static func presence(_ p: String, _ controller: String) -> String {
        (controller == "lazyBot" || controller == "resignBot") && (p == "away" || p == "connected") ? "connected|away" : p
    }

    /// "field: client != server" lines (empty when equal).
    /// `watchingInFlight`: a spectatorsUpdated reaches this viewer within `RecordedGame.watchingLag`
    /// after the checkpoint (the server coalesces the list for 250 ms and fills in a joiner's
    /// picture after its lookup, while a snapshot shows the list at once): the client's list
    /// may lag the snapshot's until it lands.
    func diff(_ snapshot: TableProjection, watchingInFlight: Bool = false) -> [String] {
        var server = snapshot
        if watchingInFlight { server.watching = watching }
        // R3: seating shows in the snapshot before positionUpdate reaches the client
        if phase == "draw" && seats.isEmpty && !server.seats.isEmpty {
            server.seats = []
            if role == "entrant" && server.role == "seat" { server.role = role; server.position = position }
        }
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

import Foundation

/// Cut for a buck on iOS 1.2.7 (41) (owner 2026-11-25; the integrated spec's section 6, the web's
/// client/src/state/cutForABuck.js, same rules and words): the tournament's finale as one pure
/// state, from the server's events (cutForABuckStart / Round / Drew / Left / Reveal / Winner) or
/// from tournamentJoined.cut (a rejoin, a return from the score screen). No views, no timers:
/// CutForABuckView draws it, TournamentSocketHandler feeds it (TournamentState.cut).
///
/// Times are absolute (the receiver's clock): the server sends relative ones (startsInMs,
/// closesInMs, nextInMs, cut.inMs), so `endsAt` is now + that at receipt.
///
/// Every word names people: "you" for me, usernames for everyone else, never a team or a number.
/// Owner 2026-11-25 (after the web PR): "cut for a buck" is lowercase mid-sentence ("bea won cut
/// for a buck"), capitalised only where it starts a line or a heading; the winner screen has no
/// "just for bragging rights" line.
enum CutForABuck {
    /// The clientHello cap ($defs.clientCapCutForABuck): the server runs the cut when a connected
    /// member has it, says phase 'cut' to this socket (else 'round_active'), sends it
    /// tournamentJoined.cut and the complete phase's cutForABuck, and admits it to the tournament
    /// voice room in the complete phase (the final lobby has voice).
    static let cap = "cutForABuck"
    static let phase = "cut"
}

enum CutStage: String, Equatable {
    case gather, drawing, reveal, winner
}

/// One revealed draw (`$defs.cutDraw`).
struct CutDraw: Equatable {
    let username: String
    let slot: Int
    let card: Card

    static func from(_ any: Any?) -> CutDraw? {
        guard let d = any as? [String: Any], let username = d["username"] as? String,
              let card = (d["card"] as? [String: Any]).flatMap(Card.from) else { return nil }
        return CutDraw(username: username, slot: d["slot"] as? Int ?? 0, card: card)
    }
}

/// A round's reveal: every card, who is out, a redraw (everyone tied).
struct CutReveal: Equatable {
    let round: Int
    let draws: [CutDraw]
    let eliminated: [String]
    let redraw: Bool
}

/// The cut's result (`$defs.cutResult`): tournamentComplete.cutForABuck,
/// cutForABuckWinner, tournamentJoined.cutForABuck in the complete phase.
struct CutResult: Equatable {
    let winner: String
    let participants: [String]
    let rounds: Int

    static func from(_ any: Any?) -> CutResult? {
        guard let d = any as? [String: Any], let winner = d["winner"] as? String, !winner.isEmpty else { return nil }
        return CutResult(winner: winner, participants: CutState.names(d["participants"]), rounds: d["rounds"] as? Int ?? 1)
    }
}

/// The cut as it stands.
struct CutState: Equatable {
    static let deckSize = 54

    struct Out: Equatable {
        var round: Int
        var left = false
    }

    /// A draw this round (never a card: they are secret until the reveal).
    struct Drawn: Equatable {
        var slot: Int
        var auto: Bool
        /// Mine, shown at once before the server's cutForABuckDrew confirms it.
        var local = false
    }

    /// The last change, for the view's animations and sounds.
    enum Change: Equatable {
        case restore, start
        case round(Int, reshuffled: Bool)
        case drew(String, slot: Int, auto: Bool)
        case left(String, freedSlot: Int?)
        case reveal(Int)
        case winner(String?)
    }

    var stage: CutStage = .gather
    var endsAt: Date?
    var round = 0
    var candidates: [String] = []
    var participants: [String] = []
    var alive: [String] = []
    var out: [String: Out] = [:]
    /// Cards revealed since the last reshuffle, oldest first (the eliminated players' too).
    var table: [String: [Card]] = [:]
    var drawn: [String: Drawn] = [:]
    /// The round's deck at its open (slots 0..<deckCount).
    var deckCount = CutState.deckSize
    /// The full deck(s): the fan's widest spread.
    var deckSize = CutState.deckSize
    var lastReveal: CutReveal?
    var reshuffled = false
    var winner: String?
    var rounds: Int?
    var last: Change = .start
    /// Bumped by every applied event.
    var seq = 0

    static func names(_ any: Any?) -> [String] { (any as? [Any] ?? []).compactMap { $0 as? String } }
    static func fullDecks(_ n: Int) -> Int { deckSize * max(1, Int((Double(n) / Double(deckSize)).rounded(.up))) }
    private static func at(_ now: Date, _ ms: Any?) -> Date? {
        guard let ms = ms as? Int else { return nil }
        return now.addingTimeInterval(Double(max(0, ms)) / 1000)
    }

    static func reveal(from d: [String: Any]) -> CutReveal? {
        guard let round = d["round"] as? Int else { return nil }
        return CutReveal(round: round, draws: (d["draws"] as? [Any] ?? []).compactMap(CutDraw.from),
                         eliminated: names(d["eliminated"]), redraw: d["redraw"] as? Bool ?? false)
    }

    /// The state from tournamentJoined.cut (`$defs.cutState`; nil or absent: no cut).
    static func fromWire(_ any: Any?, now: Date = Date()) -> CutState? {
        guard let wire = any as? [String: Any] else { return nil }
        var s = CutState()
        s.stage = (wire["stage"] as? String).flatMap(CutStage.init(rawValue:)) ?? .gather
        s.endsAt = at(now, wire["inMs"])
        s.round = wire["round"] as? Int ?? 0
        s.candidates = names(wire["candidates"])
        s.participants = names(wire["participants"])
        s.alive = names(wire["alive"])
        for o in wire["out"] as? [Any] ?? [] {
            guard let o = o as? [String: Any], let u = o["username"] as? String else { continue }
            s.out[u] = Out(round: o["round"] as? Int ?? 0, left: o["left"] as? Bool ?? false)
        }
        for t in wire["table"] as? [Any] ?? [] {
            guard let t = t as? [String: Any], let u = t["username"] as? String, let cards = t["cards"] as? [Any] else { continue }
            s.table[u] = cards.compactMap { ($0 as? [String: Any]).flatMap(Card.from) }
        }
        if s.stage == .drawing {
            for d in wire["drawn"] as? [Any] ?? [] {
                guard let d = d as? [String: Any], let u = d["username"] as? String else { continue }
                s.drawn[u] = Drawn(slot: d["slot"] as? Int ?? 0, auto: false)
            }
        }
        let people = s.participants.isEmpty ? s.candidates.count : s.participants.count
        s.deckSize = fullDecks(people)
        s.deckCount = wire["deckCount"] as? Int ?? s.deckSize
        s.lastReveal = (wire["lastReveal"] as? [String: Any]).flatMap(reveal(from:))
        if let w = wire["winner"] as? String, !w.isEmpty { s.winner = w }
        if s.winner != nil { s.stage = .winner }
        s.last = .restore
        return s
    }

    enum Event: String, CaseIterable {
        case start, round, drew, left, reveal, winner

        /// The wire event's name (SocketEvents.Server.cutForABuck*).
        var wireName: String {
            switch self {
            case .start: return SocketEvents.Server.cutForABuckStart
            case .round: return SocketEvents.Server.cutForABuckRound
            case .drew: return SocketEvents.Server.cutForABuckDrew
            case .left: return SocketEvents.Server.cutForABuckLeft
            case .reveal: return SocketEvents.Server.cutForABuckReveal
            case .winner: return SocketEvents.Server.cutForABuckWinner
            }
        }

        static func of(wireName: String) -> Event? { allCases.first { $0.wireName == wireName } }
    }

    /// One server event: the next state (nil stays nil for anything but a start, a round or a
    /// winner: an event without its start, as for an app that joined late, builds what it can).
    static func reduce(_ state: CutState?, _ type: Event, _ d: [String: Any], now: Date = Date()) -> CutState? {
        if type == .start {
            var s = CutState()
            s.candidates = names(d["candidates"])
            s.deckSize = d["deckCount"] as? Int ?? fullDecks(s.candidates.count)
            s.deckCount = s.deckSize
            s.endsAt = at(now, d["startsInMs"])
            s.last = .start
            s.seq = (state?.seq ?? 0) + 1
            return s
        }
        guard var s = state ?? ((type == .round || type == .winner) ? CutState() : nil) else { return nil }
        s.seq += 1
        switch type {
        case .start:
            return s
        case .round:
            s.stage = .drawing
            s.round = d["round"] as? Int ?? s.round + 1
            if d["participants"] is [Any] { s.participants = names(d["participants"]) }
            s.deckSize = max(s.deckSize, fullDecks(s.participants.count))
            s.alive = names(d["alive"])
            s.deckCount = d["deckCount"] as? Int ?? s.deckCount
            s.reshuffled = d["reshuffled"] as? Bool ?? false
            if s.reshuffled { s.table = [:] }
            s.drawn = [:]
            s.endsAt = at(now, d["closesInMs"])
            s.last = .round(s.round, reshuffled: s.reshuffled)
            return s
        case .drew:
            guard d["round"] as? Int == s.round, let u = d["username"] as? String else { return state }
            let slot = d["slot"] as? Int ?? 0, auto = d["auto"] as? Bool ?? false
            s.drawn[u] = Drawn(slot: slot, auto: auto)
            s.last = .drew(u, slot: slot, auto: auto)
            return s
        case .left:
            guard let u = d["username"] as? String else { return state }
            s.alive = names(d["alive"])
            let r = d["round"] as? Int ?? 0
            s.out[u] = Out(round: r > 0 ? r : s.round, left: true)
            s.drawn[u] = nil
            s.last = .left(u, freedSlot: d["freedSlot"] as? Int)
            return s
        case .reveal:
            guard let reveal = reveal(from: d) else { return state }
            for x in reveal.draws { s.table[x.username, default: []].append(x.card) }
            for u in reveal.eliminated { s.out[u] = Out(round: reveal.round) }
            s.alive = names(d["alive"])
            s.drawn = [:]
            s.deckCount = max(0, s.deckCount - reveal.draws.count)
            s.lastReveal = reveal
            s.stage = s.alive.count == 1 ? .winner : .reveal
            s.endsAt = at(now, d["nextInMs"])
            s.last = .reveal(reveal.round)
            return s
        case .winner:
            s.stage = .winner
            if let w = d["winner"] as? String, !w.isEmpty { s.winner = w }
            if d["participants"] is [Any] { s.participants = names(d["participants"]) }
            s.rounds = d["rounds"] as? Int ?? s.round
            // the round cap's random pick: everyone else is out now
            for u in s.alive where u != s.winner && s.out[u] == nil { s.out[u] = Out(round: s.round) }
            if let w = s.winner { s.alive = [w] }
            s.drawn = [:]
            s.last = .winner(s.winner)
            return s
        }
    }

    // MARK: - Questions

    /// A player still in.
    func isAlive(_ me: String?) -> Bool { me.map(alive.contains) ?? false }

    /// In the cut at all (a participant, or a candidate during the gather).
    func isInCut(_ me: String?) -> Bool {
        guard let me else { return false }
        return stage == .gather ? candidates.contains(me) || participants.contains(me) : participants.contains(me)
    }

    /// The players the ring shows: the participants, or the candidates during the gather.
    var ringPlayers: [String] { participants.isEmpty ? candidates : participants }

    /// The ones still to draw this round.
    var waitingFor: [String] { stage == .drawing ? alive.filter { drawn[$0] == nil } : [] }

    /// Cards still face down in the deck.
    var deckLeft: Int { stage == .drawing ? max(0, deckCount - drawn.count) : deckCount }

    /// The free slots of the round's deck, in order (every slot outside the drawing stage).
    var freeSlots: [Int] {
        let taken = Set(drawn.values.map(\.slot))
        let n = stage == .drawing ? deckCount : deckLeft
        return (0..<max(0, n)).filter { stage != .drawing || !taken.contains($0) }
    }

    /// Whole seconds until `endsAt` (nil: no clock).
    func secondsLeft(now: Date = Date()) -> Int? {
        endsAt.map { max(0, Int(($0.timeIntervalSince(now)).rounded(.up))) }
    }

    /// I may draw: a player still in, the round open, no draw of mine yet.
    func canDraw(me: String?, spectator: Bool) -> Bool {
        !spectator && stage == .drawing && isAlive(me) && me.map { drawn[$0] == nil } ?? false
    }

    /// The server drew for me this round (away: 2 timeouts in a row, so it draws for me at each
    /// open before I can). A tap still sends one draw a round (slot nil): the server drops it as a
    /// repeat but stops drawing for me at the open, so the next round waits for me again (the
    /// web's canSayBack).
    func canSayBack(me: String?, spectator: Bool) -> Bool {
        !spectator && stage == .drawing && isAlive(me) && me.flatMap { drawn[$0]?.auto } == true
    }
}

// MARK: - Words

/// Every string the cut shows (the web's state/cutForABuck.js words, with the owner's two
/// tweaks: lowercase "cut for a buck" mid-sentence, no "just for bragging rights").
enum CutCopy {
    static let title = "Cut for a buck"
    static let introTitle = "Cut for a buck!"
    static let rules = "Lowest card is out. Suits don't count; aces are high and jokers higher."
    static let reshuffle = "Not enough cards left. Shuffling them back in."
    /// My draw was the server's (I was away, disconnected or the window closed).
    static let drewForYou = "We drew a card for you"
    static let watching = "Watching cut for a buck"
    static let outWatching = "You're out. Watching the rest"
    static let tapToDraw = "Tap the deck to draw"
    static let turning = "Turning the cards over"
    static let drawACard = "Draw a card"
    static let mainRoomCard = "Cut for a buck!"
    static let lobbyOpenNote = "This lobby stays open for about 10 minutes"

    private static let rankName: [Rank: String] = [.jack: "jack", .queen: "queen", .king: "king", .ace: "ace", .hi: "HI joker", .lo: "LO joker"]
    private static let rankPluralName: [Rank: String] = [.jack: "jacks", .queen: "queens", .king: "kings", .ace: "aces",
                                                        .hi: "HI jokers", .lo: "LO jokers"]
    private static let suitSymbol: [Suit: String] = [.spades: "\u{2660}", .hearts: "\u{2665}", .diamonds: "\u{2666}", .clubs: "\u{2663}"]

    /// "a 9", "an 8", "an ace", "a HI joker"
    static func rankWithArticle(_ rank: Rank) -> String {
        let word = rankName[rank] ?? rank.rawValue
        let an = word.hasPrefix("8") || word.hasPrefix("ace")
        return "\(an ? "an" : "a") \(word)"
    }

    /// "3s", "aces", "LO jokers"
    static func rankPlural(_ rank: Rank?) -> String {
        guard let rank else { return "" }
        return rankPluralName[rank] ?? "\(rank.rawValue)s"
    }

    /// "3 of clubs", "HI joker" (VoiceOver)
    static func cardSpoken(_ card: Card) -> String {
        if card.suit == .joker { return "\(card.rank.rawValue) joker" }
        return "\(rankName[card.rank] ?? card.rank.rawValue) of \(card.suit.rawValue)"
    }

    /// "9♥", "HI joker" (the list)
    static func cardShort(_ card: Card) -> String {
        if card.suit == .joker { return "\(card.rank.rawValue) joker" }
        return "\(card.rank.rawValue)\(suitSymbol[card.suit] ?? "")"
    }

    /// "al", "al and cy", "al, bo and cy"
    static func joinNames(_ names: [String]) -> String {
        guard names.count > 1 else { return names.first ?? "" }
        return "\(names.dropLast().joined(separator: ", ")) and \(names[names.count - 1])"
    }

    static func nameOf(_ u: String, me: String?) -> String { u == me ? "you" : u }

    /// "Round 2 · 9 of 12 left" (empty during the gather).
    static func roundLine(_ s: CutState?) -> String {
        guard let s, s.round > 0 else { return "" }
        return "Round \(s.round) \u{00B7} \(s.alive.count) of \(s.participants.count) left"
    }

    /// "37 cards left" / "1 card left"
    static func deckLine(_ s: CutState?) -> String {
        let left = s?.deckLeft ?? 0
        return "\(left) card\(left == 1 ? "" : "s") left"
    }

    /// The verdict of a reveal for me, mine first: "Everyone tied on 7s. Redraw!", "You're safe
    /// with a 9" / "You're out with a 3", "bo and al are out with 3s" / "bo is out with a 3".
    static func verdictLines(_ reveal: CutReveal?, me: String?) -> [String] {
        guard let reveal else { return [] }
        if reveal.redraw { return ["Everyone tied on \(rankPlural(reveal.draws.first?.card.rank)). Redraw!"] }
        var lines: [String] = []
        let outCard = reveal.draws.first { reveal.eliminated.contains($0.username) }?.card
        if let mine = reveal.draws.first(where: { $0.username == me }) {
            lines.append(reveal.eliminated.contains(mine.username)
                ? "You're out with \(rankWithArticle(mine.card.rank))" : "You're safe with \(rankWithArticle(mine.card.rank))")
        }
        let others = reveal.eliminated.filter { $0 != me }
        if !others.isEmpty, let outCard {
            lines.append(others.count == 1 ? "\(others[0]) is out with \(rankWithArticle(outCard.rank))"
                         : "\(joinNames(others)) are out with \(rankPlural(outCard.rank))")
        }
        return lines
    }

    /// One announcement per reveal (draws are never announced one by one).
    static func revealAnnouncement(_ reveal: CutReveal?, me: String?) -> String {
        guard let reveal else { return "" }
        let cards = reveal.draws.map { "\(nameOf($0.username, me: me)) \(cardSpoken($0.card))" }.joined(separator: ", ")
        return "Round \(reveal.round): \(cards). \(verdictLines(reveal, me: me).joined(separator: ". "))."
    }

    /// "dan wins cut for a buck!" / "You win cut for a buck!"
    static func winnerLine(_ winner: String, me: String?) -> String {
        winner == me ? "You win cut for a buck!" : "\(winner) wins cut for a buck!"
    }

    /// The final lobby: "dan won cut for a buck" / "You won cut for a buck".
    static func cutWonLine(_ cut: CutResult?, me: String?) -> String {
        guard let cut else { return "" }
        return cut.winner == me ? "You won cut for a buck" : "\(cut.winner) won cut for a buck"
    }

    /// "kim wins the tournament!" / "kim and bo share the win!" / "You win the tournament!"
    static func tournamentWinnerLine(_ winners: [String], me: String?) -> String {
        switch winners.count {
        case 0: return "Tournament complete"
        case 1: return winners[0] == me ? "You win the tournament!" : "\(winners[0]) wins the tournament!"
        default:
            let names = winners.filter { $0 == me }.map { _ in "You" } + winners.filter { $0 != me }
            return "\(joinNames(names)) share the win!"
        }
    }

    struct Status: Equatable {
        var main: String
        var sub: String
    }

    /// The status lines over the stage.
    static func status(_ s: CutState?, me: String?, spectator: Bool, now: Date = Date()) -> Status {
        guard let s else { return Status(main: "", sub: "") }
        let secs = s.secondsLeft(now: now)
        switch s.stage {
        case .gather:
            return Status(main: "Cut for a buck starts in \(secs ?? 0)", sub: rules)
        case .drawing:
            let waiting = s.waitingFor
            let waitLine = waiting.isEmpty ? "" : "Waiting for \(joinNames(waiting))"
            if spectator { return Status(main: watching, sub: waitLine) }
            if s.isAlive(me), let me, s.drawn[me] == nil {
                return Status(main: tapToDraw, sub: secs.map { "Auto-draw in \($0)" } ?? "")
            }
            if !s.isInCut(me) || !s.isAlive(me) {
                return Status(main: s.isInCut(me) ? outWatching : watching, sub: waitLine)
            }
            let mine = me.flatMap { s.drawn[$0] }
            return Status(main: waiting.isEmpty ? turning : "Waiting for \(joinNames(waiting.map { nameOf($0, me: me) }))",
                          sub: mine?.auto == true ? drewForYou : s.reshuffled ? reshuffle : rules)
        case .reveal:
            let lines = verdictLines(s.lastReveal, me: me)
            return Status(main: lines.first ?? "", sub: lines.dropFirst().joined(separator: ". "))
        case .winner:
            return Status(main: s.winner.map { winnerLine($0, me: me) } ?? "", sub: "")
        }
    }

    /// The last table's score screen while the cut is on (spec section 3.3): the strip's line and
    /// the Return button's label (nil: the button keeps "Return to Tournament").
    static func scoreStrip(_ s: CutState?, me: String?, spectator: Bool, now: Date = Date()) -> (text: String, button: String?)? {
        guard let s else { return nil }
        let join = spectator ? "Watch cut for a buck" : "Join cut for a buck"
        switch s.stage {
        case .gather: return ("Cut for a buck starts in \(s.secondsLeft(now: now) ?? 0)", join)
        case .winner where s.winner != nil: return (winnerLine(s.winner!, me: me), nil)
        default:
            return (spectator ? "Cut for a buck has started." : "Cut for a buck has started. We'll draw for you until you join.", join)
        }
    }
}

/// One player's look in the ring and the list.
struct CutSeatLook: Equatable {
    enum Look: String { case idle, waiting, drawn, auto, out, left, winner }

    var look: Look
    var caption: String
    var label: String
    var cards: [Card]
    var disconnected: Bool

    /// `verdictPending`: the reveal's cards are still turning over, so a player it put out still
    /// looks in (no dimming, no "Out" caption) until the verdict shows.
    static func of(_ s: CutState?, _ username: String, me: String?, connected: Bool = true, talking: Bool = false,
                   verdictPending: Bool = false) -> CutSeatLook {
        var look = Look.idle
        var caption = ""
        let out = s?.out[username]
        let pendingOut = verdictPending && out.map { !$0.left && $0.round == s?.lastReveal?.round } == true
        if s?.winner == username, !verdictPending {
            look = .winner
            caption = "Winner"
        } else if let out, out.left {
            look = .left
            caption = "Left"
        } else if let out, !pendingOut {
            look = .out
            caption = "Out \u{00B7} round \(out.round)"
        } else if let s, s.stage == .drawing, s.alive.contains(username) {
            let d = s.drawn[username]
            look = d == nil ? .waiting : d!.auto ? .auto : .drawn
            caption = d?.auto == true ? "auto" : ""
        }
        if !connected && look != .left && look != .out { caption = "reconnecting\u{2026}" }
        let cards = s?.table[username] ?? []
        var parts = [username == me ? "you" : username]
        switch look {
        case .out: parts.append("out in round \(out?.round ?? 0)")
        case .left: parts.append("left")
        case .winner: parts.append("the winner")
        case .waiting: parts.append("still to draw")
        case .drawn: parts.append("drawn")
        case .auto: parts.append("drawn for")
        case .idle: break
        }
        if let newest = cards.last { parts.append(CutCopy.cardSpoken(newest)) }
        if !connected { parts.append("reconnecting") }
        if talking { parts.append("talking") }
        return CutSeatLook(look: look, caption: caption, label: parts.joined(separator: ", "), cards: cards, disconnected: !connected)
    }

    /// The lowest rank among `cards` (the losing cards' danger outline).
    static func lowestRank(_ cards: [Card]) -> Int? {
        cards.compactMap { CardConstants.rankValues[$0.rank] }.min()
    }
}

/// The ring's order: `players` rotated so `me` comes first (6 o'clock), then clockwise. A
/// spectator (me not playing) keeps the order as is.
enum CutOrder {
    static func ring(_ players: [String], me: String?) -> [String] {
        guard let me, let i = players.firstIndex(of: me), i > 0 else { return players }
        return Array(players[i...] + players[..<i])
    }
}

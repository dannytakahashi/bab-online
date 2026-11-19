import Foundation

// /help on iOS (the build after 1.2.3 (17); help plan section 4.5 "iOS b15 (H4)"; server side
// docs/claude/assist.md). The words and rules of the private s2c `assistHint`, a port of the
// web's client/src/state/assistHint.js, kept apart from the views (AssistCardView) and the
// reducer (TableReducer+Assist) so they can be tested without a table.
//
//  - The clientHello cap `assist` (ServerConfig `ClientHello.caps`) makes the server answer this
//    socket's /help with `assistHint` instead of private plain-text game-log lines.
//  - A bid or card hint is live while it is still my turn as it was answered: `isLive` checks
//    the parts of its turnKey the client knows (stage, seat on turn, bids so far, cards played
//    this hand; `${dealSeq}|${stage}|${currentTurn}|${bidCount}|${cardIndex}`, server
//    GameState.turnKey). dealSeq is not compared: the client's count is its own.
//  - The /help uses of this game come from the latest hint and start at 0 when a game starts
//    (createUI); after a relaunch or a rejoin into another game they are unknown until the next
//    hint. The chat command list describes /help from them (`helpDescription`).
//  - A game with a native bot seat (owner 2026-11-19, "Unlimited, keep notice"; server
//    assistState.isFreeHelpGame: a seat whose controller is `bot`, never a lazy or resign bot)
//    has no /help limit: players see no count and never "free", "unlimited" or "bot-assisted"
//    there (the footer, the chat list, VoiceOver). Known from the hint's `unlimited`, the
//    snapshot's viewer.assist.unlimited, or, before the server has said, the table's own seats
//    (`isFreeHelpGame`: positionUpdate's nativeBot / the snapshot's controller `bot`; never
//    positionUpdate's isBot alone, which a draw-phase leaver's resign bot has too). Once the
//    server has said (a hint, a snapshot's viewer.assist), its word wins, as on the web.
//
// Names only in every text (never team numbers, "your team", "opponents"); the hint's own
// texts come from the server, which lints them.

/// A /help answer this build can show (WirePayload.AssistHint, checked and trimmed).
struct AssistHint: Equatable {
    enum Kind: String, Equatable { case bid, card, status }

    var kind: Kind
    var turnKey: String?
    /// The suggestion ("Bid 4", "Lead A♣") or, for a status reply, the whole reply.
    var headline: String
    /// At most 2 (a status reply has none).
    var reasons: [String] = []
    /// At most 4 ("Why?").
    var details: [String] = []
    var confidence: String?
    /// The suggested bid, uppercased ("4", "B"): a bid hint only.
    var bid: String?
    /// The suggested card: a card hint only.
    var card: Card?
    /// The warning on the last free use, or "This game now counts as bot-assisted for you."
    var note: String?
    var uses = 0
    var freeUses = AssistRules.defaultFreeUses
    var assisted = false
    var counted = false
    /// A game with a native bot seat (the wire's `unlimited`; `AssistRules.inFreeHelpGame`
    /// normalizes such a hint): no count, no note, never bot-assisted.
    var unlimited = false

    /// nil for a hint this build cannot show (v not 1, a kind it does not know, no headline).
    init?(_ w: WirePayload.AssistHint) {
        guard w.v == 1, let raw = w.kind, let kind = Kind(rawValue: raw), let headline = w.headline,
              !headline.isEmpty else { return nil }
        self.kind = kind
        self.turnKey = w.turnKey
        self.headline = headline
        let clean = { (xs: [String]?, n: Int) in Array((xs ?? []).filter { !$0.isEmpty }.prefix(n)) }
        if kind != .status {
            reasons = clean(w.reasons, 2)
            details = clean(w.details, 4)
            confidence = w.confidence
        }
        if kind == .bid, let b = w.suggest?.bid, !b.isEmpty { bid = b.uppercased() }
        if kind == .card { card = w.suggest?.card }
        note = (w.note?.isEmpty ?? true) ? nil : w.note
        uses = max(0, w.uses ?? 0)
        freeUses = max(0, w.freeUses ?? AssistRules.defaultFreeUses)
        assisted = w.assisted == true
        counted = w.counted == true
        unlimited = w.unlimited == true
    }

    init(kind: Kind, headline: String, turnKey: String? = nil) {
        self.kind = kind
        self.headline = headline
        self.turnKey = turnKey
    }
}

/// This game's /help uses as the latest hint said (`TableSlice.assistUses`; nil: unknown).
struct AssistUses: Equatable {
    var uses = 0
    var freeUses = AssistRules.defaultFreeUses
    var assisted = false
    /// The wire's `unlimited` (the hint's, the snapshot's viewer.assist): a game with a native bot seat.
    var unlimited = false
    /// The server sent these (a hint, a snapshot's viewer.assist), so its `unlimited` is the
    /// server's verdict; false for createUI's zero count, where the table's seats decide.
    var told = false
}

enum AssistRules {
    /// What the lightbulb and the chat send (the server's command).
    static let command = "/help"
    /// Free counted /help uses per game when no hint has said (server ASSIST_FREE_HELP).
    static let defaultFreeUses = 3
    /// After a /help the lightbulb waits this long at most for the answer before it shows again
    /// (the web's ASSIST_ASK_WAIT_MS).
    static let askWait: TimeInterval = 10

    /// The confidence chip's words (server copy.js CONFIDENCE_LABEL, the web's).
    static let confidenceLabels: [String: String] = [
        "only": "Only legal card",
        "certain": "Sure thing",
        "clear": "Clear choice",
        "close": "Close call",
        "any": "Any card works",
        "quick": "Quick suggestion",
    ]
    static func confidenceLabel(_ h: AssistHint) -> String? {
        h.kind == .status ? nil : h.confidence.flatMap { confidenceLabels[$0] }
    }

    /// The footer's first part (copy.js FOOTER, without its second sentence).
    static let footerBot = "What our strongest bot would play"
    /// A Quick suggestion's footer (copy.js QUICK_NOTE).
    static let footerQuick = "Quick suggestion: rules only, the server is busy."
    /// The private row for a bid or card answer that came after its turn had passed.
    static let lateLine = "Help: that turn had passed before the answer came (only you see this)"
    /// The lightbulb's VoiceOver label (the web "?" button's).
    static let askLabel = "Ask a bot for advice"
    /// The lightbulb while the socket is down (the web's NOTICE.RECONNECTING).
    static let reconnecting = "Reconnecting. Try again in a moment."
    /// The card's close button.
    static let dismissLabel = "Dismiss suggestion"
    /// The details toggle.
    static let whyLabel = "Why?"

    /// The /help line in the chat command list, from this game's uses:
    ///   "Ask a bot for advice (1 of 3 free used)"
    ///   "Ask a bot for advice (the next one makes this game bot-assisted)"
    ///   "Ask a bot for advice (this game is bot-assisted for you)"
    ///   "Ask a bot for advice (after 3 free, this game counts as bot-assisted)" (unknown: a
    ///   relaunch, a rejoin; the warning stays, since the uses so far may be spent)
    ///   "Ask a bot for advice" in a game with a native bot seat (`free`, or the uses' `unlimited`)
    static func helpDescription(_ u: AssistUses?, free: Bool = false) -> String {
        if free || u?.unlimited == true { return askLabel }
        guard let u else { return "\(askLabel) (after \(defaultFreeUses) free, this game counts as bot-assisted)" }
        if u.assisted || u.uses > u.freeUses { return "\(askLabel) (this game is bot-assisted for you)" }
        if u.uses >= u.freeUses { return "\(askLabel) (the next one makes this game bot-assisted)" }
        return "\(askLabel) (\(u.uses) of \(u.freeUses) free used)"
    }

    /// A game with a native bot seat (server assistState.isFreeHelpGame). Once the server has
    /// said (`assistUses.told`: the latest hint's or snapshot's `unlimited`) its word wins, as on
    /// the web (assistHint.js helpIsUnlimited); before that, a seat whose controller is a native
    /// bot (lobby Add Bot, a tournament filler, a solo game; positionUpdate's nativeBot or the
    /// snapshot's controller; never `.lazyBot` / `.resignBot`, a human's seat, even though a
    /// draw-phase leaver's resign bot has positionUpdate's isBot). Native bots never leave.
    static func isFreeHelpGame(_ s: TableState) -> Bool {
        if let u = s.table.assistUses, u.told { return u.unlimited }
        return s.players.seats.values.contains { $0.controller == .bot }
    }

    /// `h` as this table shows it: the hint's own `unlimited` decides (the server's verdict wins
    /// over the table's seats, as on the web); such a hint has no note (the server sends none
    /// there: no 3rd-use warning, no crossing) and is never assisted.
    static func inFreeHelpGame(_ h: AssistHint) -> AssistHint {
        guard h.unlimited else { return h }
        var h = h
        h.unlimited = true
        h.note = nil
        h.assisted = false
        return h
    }

    /// The card's footer (nil for a status reply):
    ///   "What our strongest bot would play · Help 2 of 3 free"
    ///   "What our strongest bot would play · Help 4: this game counts as bot-assisted for you"
    ///   "Not counted" (a forced move: nothing to guess)
    ///   "What our strongest bot would play · Asked again this turn: not counted"
    ///   "Quick suggestion: rules only, the server is busy. · Help 1 of 3 free"
    /// In a game with a native bot seat (`unlimited`) no count: just "What our strongest bot
    /// would play" (a forced move and a re-ask too), or the Quick note alone.
    static func footer(_ h: AssistHint) -> String? {
        guard h.kind != .status else { return nil }
        if h.unlimited { return h.confidence == "quick" ? footerQuick : footerBot }
        if h.confidence == "only" { return "Not counted" }
        let lead = h.confidence == "quick" ? footerQuick : footerBot
        let tail: String
        if !h.counted { tail = "Asked again this turn: not counted" }
        else if h.uses <= h.freeUses { tail = "Help \(h.uses) of \(h.freeUses) free" }
        else { tail = "Help \(h.uses): this game counts as bot-assisted for you" }
        return "\(lead) \u{00B7} \(tail)"
    }

    /// The dim private log row (never sent): "Help: Play 9♦ (only you see this)".
    static func logLine(_ h: AssistHint) -> String { "Help: \(h.headline) (only you see this)" }

    /// What VoiceOver hears: the headline and the main reason (the last one: the first is the
    /// contract line when there are two, as the server's plain-text line chooses), and the note.
    static func announcement(_ h: AssistHint) -> String {
        func end(_ s: String) -> String { [".", "!", "?"].contains(where: s.hasSuffix) ? s : s + "." }
        var parts = [h.kind == .status ? end(h.headline) : "Suggestion: \(end(h.headline))"]
        if h.kind != .status, let main = h.reasons.last { parts.append(end(main)) }
        if let note = h.note { parts.append(end(note)) }
        return parts.joined(separator: " ")
    }

    // MARK: - Is it still my turn's?

    struct TurnKey: Equatable {
        var stage: String
        var currentTurn: Int?
        var bidCount: Int?
        var cardIndex: Int?
    }

    static func parseTurnKey(_ key: String?) -> TurnKey? {
        guard let key else { return nil }
        let p = key.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard p.count == 5 else { return nil }
        return TurnKey(stage: p[1], currentTurn: Int(p[2]), bidCount: Int(p[3]), cardIndex: Int(p[4]))
    }

    /// Cards played so far this hand as the server counts them (turnKey's cardIndex).
    static func cardIndex(_ s: TableState) -> Int? {
        guard s.table.phase.kind == .playing, s.table.trickNo >= 1 else { return nil }
        return (s.table.trickNo - 1) * 4 + s.table.phase.trick.count
    }

    /// Is `h` still showable? A status reply always is (the next turn change clears it); a bid
    /// or card only on my own turn at my seat with nothing of mine on its way, matching its turnKey.
    static func isLive(_ h: AssistHint, _ s: TableState) -> Bool {
        if h.kind == .status { return true }
        guard s.table.viewer.role == .seat, let me = s.table.viewer.position, s.pending == nil,
              s.table.phase.turn == me else { return false }
        let k = parseTurnKey(h.turnKey)
        if let t = k?.currentTurn, t != me { return false }
        switch h.kind {
        case .bid:
            guard case .bidding(let b) = s.table.phase, b.bids.bid(at: me) == nil else { return false }
            if let k {
                let count = b.bids.byPosition.compactMap { $0 }.count
                if k.stage != "BIDDING" || k.bidCount != count { return false }
            }
            return true
        case .card:
            guard case .playing(let p) = s.table.phase, !p.trick.contains(where: { $0.position == me }) else { return false }
            if let k {
                if k.stage != "PLAYING" { return false }
                if let at = cardIndex(s), let i = k.cardIndex, i != at { return false }
            }
            return true
        case .status:
            return true
        }
    }

    /// A bid or card answer still this turn's by its turnKey (a status reply, or one without a
    /// turnKey, ends at a turn change).
    static func stillLive(_ h: AssistHint, _ s: TableState) -> Bool {
        h.kind != .status && parseTurnKey(h.turnKey) != nil && isLive(h, s)
    }

    /// My own bid or play turn at my seat, with nothing of mine on its way (where the lightbulb
    /// shows, while no answer is up and none asked for is on its way).
    static func canAsk(_ s: TableState) -> Bool {
        guard s.table.viewer.role == .seat, s.table.viewer.position != nil, !s.table.hand.isEmpty,
              s.table.snapshotTrouble == .none else { return false }
        switch s.myTurn {
        case .choosing(.bid): return s.table.phase.isBidding
        case .choosing(.play): return s.table.phase.kind == .playing
        default: return false
        }
    }

    /// The lightbulb shows now.
    static func showsAsk(_ s: TableState) -> Bool {
        canAsk(s) && s.table.assist == nil && !s.table.assistAsking
    }
}

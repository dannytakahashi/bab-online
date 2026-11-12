import Foundation

/// Delta events (after the seq gate). Log lines are today's exact strings.
extension TableReducer {
    static func apply(_ s: inout TableState, _ ev: SequencedEvent, _ fx: inout [TableEffect]) {
        switch ev.event {
        // MARK: draw
        case .allPlayersReady(let p):
            if let gid = p.gameId { local(&s, .enterGameContext(gameId: gid, tournamentId: nil), &fx) }
        case .startDraw:
            if s.table.phase.kind == .ended { s = .fresh(keeping: s.table.me) }
            s.table.phase = .draw(DrawState(stage: .drawing))  // drawResults start empty (stale-results fix)
        case .youDrew(let p):
            mutateDraw(&s) { d in
                d.hasDrawn = true
                if let c = p.card { d.drawnCard = c }
            }
        case .playerDrew(let p):
            mutateDraw(&s) { d in
                let r = DrawResult(username: p.username ?? "", position: p.drawOrder, cardIndex: p.cardIndex ?? 0, card: p.card)
                if let i = d.results.firstIndex(where: { $0.drawOrder == p.drawOrder }) { d.results[i] = r } else { d.results.append(r) }
            }
        case .playerAssigned:
            break  // deprecated (positionUpdate carries it)
        case .positionUpdate(let p):
            positionUpdate(&s, p)
        case .teamsAnnounced(let p):
            mutateDraw(&s) { d in
                d.stage = .teamsAnnounced
                d.teams = TeamsAnnounced(team1: p.team1 ?? [], team2: p.team2 ?? [])
            }
        case .createUI:
            mutateDraw(&s) { $0.stage = .dealing }

        // MARK: deal / bidding
        case .gameStart(let p):
            gameStart(&s, p, &fx)
        case .updateTurn(let p):
            guard let turn = Position.valid(p.currentTurn ?? p.turn) else { break }
            switch s.table.phase {
            case .bidding(var b): b.turn = turn; s.table.phase = .bidding(b)
            case .playing(var pl): pl.turn = turn; s.table.phase = .playing(pl)
            default: break
            }
        case .bidReceived(let p):
            bidReceived(&s, p, &fx)
        case .doneBidding(let p):
            guard var bids = s.table.phase.bids else { break }
            if let arr = p.bids, arr.count == 4 { bids.byPosition = arr.map { $0?.value } }
            if let tb = p.teamBids { bids.teamBids = TeamPair(team1: tb.team1, team2: tb.team2) }
            if let m = p.mults { bids.mults = TeamPair(team1: m.team1, team2: m.team2) } else { bids.recomputeMults() }
            s.table.phase = .playing(PlayingState(trick: [], lead: nil, turn: Position.valid(p.lead), bids: bids))
            s.table.deal?.trumpBroken = false
            logBiddingComplete(&s, bids)
        case .rainbow(let p):
            guard let pos = Position.valid(p.position) else { break }
            s.scores.rainbows[team: Positions.getTeamNumber(pos)] += 1
            fx.append(.animate(.rainbow(position: pos, dealSeq: s.table.deal?.dealSeq ?? 0)))
        case .destroyHands:
            s.table.hand = []
            s.pending = nil
            let bidder = s.table.deal?.bidder ?? 1
            s.table.phase = .bidding(BiddingState(turn: nil, bids: .fresh(bidder: bidder)))
            fx.append(.animate(.handsDestroyed(dealSeq: s.table.deal?.dealSeq ?? 0)))

        // MARK: play
        case .cardPlayed(let p):
            cardPlayed(&s, p, &fx)
        case .trickComplete(let p):
            trickComplete(&s, p, &fx)
        case .handComplete(let p):
            handComplete(&s, p)
        case .gameEnd(let p, let data):
            s.pending = nil
            s.table.tournamentId = p.tournamentId
            s.table.phase = .ended(data ?? GameEndData(winningTeam: 0, team1Score: s.scores.score.team1, team2Score: s.scores.score.team2,
                                                     team1Players: [], team2Players: [], handHistory: []))
        case .abortGame, .leftGame:
            local(&s, .reset, &fx)

        // MARK: presence
        case .playerDisconnected(let p):
            guard let pos = Position.valid(p.position) else { break }  // 21.7: a null position is ignored (seq still advanced)
            // R3: an idempotent setter. replayPresenceTo re-sends it privately for
            // every absent seat on a rejoin / lazy rejoin / /active, resignable
            // ones included (then one resignationAvailable): never downgrade a
            // resignable or away seat to grace
            mutateSeat(&s, pos) { seat in
                if seat.presence == .connected || seat.presence == .none { seat.presence = .grace }
            }
        case .playerReconnected(let p):
            guard let pos = Position.valid(p.position) else { break }
            mutateSeat(&s, pos) { $0.presence = .connected }
            if s.players.resignationOffer?.position == pos { s.players.resignationOffer = nil }
        case .resignationAvailable(let p):
            guard let pos = Position.valid(p.position) else { break }
            mutateSeat(&s, pos) { $0.presence = .resignable }
            s.players.resignationOffer = ResignationOffer(position: pos, username: p.username ?? s.players.name(pos))
        case .playerResigned(let p):
            guard let pos = Position.valid(p.position) else { break }
            mutateSeat(&s, pos) { seat in
                seat.controller = .resignBot
                seat.presence = .away
                seat.isBot = true
                seat.lazy = false
                seat.ownerUsername = p.oldUsername ?? seat.ownerUsername
                if let name = p.botUsername { seat.username = name }
                seat.pic = p.botPic?.pic ?? seat.pic
            }
            s.players.resignationOffer = nil
        case .playerLazyMode(let p):
            guard let pos = Position.valid(p.position) else { break }
            mutateSeat(&s, pos) { seat in
                seat.controller = .lazyBot
                seat.isBot = true
                seat.lazy = true
                seat.ownerUsername = p.originalUsername ?? seat.ownerUsername ?? seat.username
                seat.username = p.botUsername ?? "Bot"
                seat.pic = p.botPic?.pic ?? .none
            }
            if pos == s.table.viewer.position && s.table.viewer.role == .seat {
                s.table.viewer.role = .lazyWatcher
                s.table.viewer.ownerView = "seat"
                s.pending = nil
            }
        case .playerActiveMode(let p):
            guard let pos = Position.valid(p.position) else { break }
            mutateSeat(&s, pos) { seat in
                seat.controller = .human
                seat.presence = .connected
                seat.isBot = false
                seat.lazy = false
                seat.username = p.username ?? seat.ownerUsername
                seat.ownerUsername = p.username ?? seat.ownerUsername
                seat.pic = p.pic?.pic ?? .none
                seat.avatarUrl = p.avatarUrl
            }
            // the seat is human and connected again: an offer to replace it is moot
            if s.players.resignationOffer?.position == pos { s.players.resignationOffer = nil }
            if pos == s.table.viewer.position && s.table.viewer.role == .lazyWatcher {
                s.table.viewer.role = .seat
                s.table.viewer.ownerView = "seat"
            }

        // MARK: log / chat / spectators
        case .gameLogEntry(let p):
            let type = ChatMessage.MessageType(rawValue: p.type ?? "system") ?? .system
            s.log.entries.append(ChatMessage(username: "System", message: p.message ?? "", type: type))
        case .chatMessage(let p, let blocked, let mine):
            guard !blocked else { break }
            // 21.8: `isSpectator` routes (the server drops `type` with V1_REMOVALS #12); `type` only for an older server
            let isSpectator = p.isSpectator ?? (p.type == "spectator")
            let message = p.message ?? ""
            let pos = Position.valid(p.position)
            s.log.entries.append(ChatMessage(username: p.username ?? "", message: message, type: isSpectator ? .spectator : .player, position: pos))
            if !mine { s.log.unread += 1 }
            if isSpectator {
                // a pure spectator's line, and a watching owner's (sent without a position): by the badge
                fx.append(.animate(.spectatorChatBubble(username: p.username ?? "", message: message)))
            } else if let pos {
                fx.append(.animate(.chatBubble(position: pos, message: message)))
            }
        case .spectators(let p):
            // the whole list each time; another game's list (a late one after leaving) is dropped
            guard let gid = p.gameId, gid == s.table.gameId else { break }
            s.players.watching = WatchingList(spectators: p.spectators ?? [], count: p.count ?? p.spectators?.count ?? 0)
        case .spectatorNotice(let p):
            if let n = p.spectatorCount { s.players.spectatorCount = n }
            addLog(&s, "\(p.username ?? "Someone") joined as spectator")
        case .seqOnly, .roomFull, .rejoinFailed:
            break

        // MARK: snapshot carriers (decoded by the handler into .snapshot; a carrier without one asks)
        case .rejoinSuccess(let env), .restorePlayerState(let env), .spectatorState(let env):
            let source: SnapshotSource
            switch ev.event {
            case .rejoinSuccess: source = .rejoin
            case .restorePlayerState: source = .restore
            default: source = .spectate
            }
            if let snap = env.snapshot {
                applySnapshot(&s, snap, source, envelopeHints(env), &fx)
            } else {
                requestResync(&s, &fx)
            }
        case .actionRejected(let p):
            let matches = s.pending.map { $0.submission.action.rawValue == p.action } ?? false
            if let snap = p.snapshot {
                applySnapshot(&s, snap, .rejected, nil, &fx)
            } else if matches {
                s.pending = nil
            }
            if matches { fx.append(.haptic(.error)) }
        case .stateSnapshot(let p):
            if let snap = p.snapshot {
                applySnapshot(&s, snap, .requested(p.requestId ?? ""), nil, &fx)
            } else {
                local(&s, .snapshotUnavailable(requestId: p.requestId), &fx)
            }
        }
    }

    static func envelopeHints(_ env: WirePayload.RejoinEnvelope) -> LegacySeatHints {
        var h = env.hints
        if env.hasTournamentId { h.tournamentId = .some(env.tournamentId) }
        return h
    }

    /// Debounced by the coordinator (at most one in flight).
    static func requestResync(_ s: inout TableState, _ fx: inout [TableEffect]) {
        guard s.sync.resyncId == nil else { return }
        let id = "gap-\(s.sync.nextRequestNo)"
        s.sync.nextRequestNo += 1
        s.sync.resyncId = id
        fx.append(.requestSnapshot(requestId: id, log: false))
    }

    // MARK: - helpers

    static func mutateDraw(_ s: inout TableState, _ f: (inout DrawState) -> Void) {
        guard case .draw(var d) = s.table.phase else { return }
        f(&d)
        s.table.phase = .draw(d)
    }

    static func mutateSeat(_ s: inout TableState, _ pos: Int, _ f: (inout SeatState) -> Void) {
        var seat = s.players.seats[pos] ?? SeatState(position: pos)
        f(&seat)
        s.players.seats[pos] = seat
    }

    static func addLog(_ s: inout TableState, _ message: String) {
        s.log.entries.append(ChatMessage(username: "System", message: message, type: .system))
    }

    static func positionUpdate(_ s: inout TableState, _ p: WirePayload.PositionUpdate) {
        let positions = p.positions ?? []
        for (i, pos) in positions.enumerated() {
            guard let pos = Position.valid(pos) else { continue }
            let sid = i < (p.sockets?.count ?? 0) ? p.sockets![i] : nil
            let name = i < (p.usernames?.count ?? 0) ? p.usernames![i].username : nil
            let pic = i < (p.pics?.count ?? 0) ? p.pics![i].pic : Pic.none
            let isBot = sid?.hasPrefix("bot:") ?? false
            var seat = s.players.seats[pos] ?? SeatState(position: pos)
            seat.username = name ?? seat.username
            seat.pic = pic
            seat.avatarUrl = p.avatarUrls?[String(pos)]
            seat.isBot = isBot
            seat.controller = isBot ? .bot : .human
            seat.presence = isBot ? .none : (seat.presence == .none ? .connected : seat.presence)
            seat.ownerUsername = isBot ? nil : name
            seat.lazy = false
            s.players.seats[pos] = seat
            if let sid { s.players.socketBySeat[pos] = sid }
            // My seat: matched by socket id or username (as the old setPlayerData did)
            if let sid, sid == s.table.me.playerId { s.table.viewer.position = pos; s.table.viewer.role = .seat }
            else if let name, let me = s.table.me.username, name == me, s.table.viewer.position == nil || s.table.viewer.role != .seat {
                s.table.viewer.position = pos
                s.table.viewer.role = .seat
            }
        }
        if let mine = Position.valid(p.yourPosition) { s.table.viewer.position = mine; s.table.viewer.role = .seat }
        if s.table.viewer.role == .seat { s.table.viewer.ownerView = "seat" }
        mutateDraw(&s) { $0.stage = .resolving }
    }

    static func gameStart(_ s: inout TableState, _ p: WirePayload.GameStart, _ fx: inout [TableEffect]) {
        if s.table.phase.kind == .ended || s.table.phase.kind == .none { s.table.phase = .waiting }
        if let gid = p.gameId { s.table.gameId = gid }
        let previous = s.table.deal
        let dealSeq = (previous?.dealSeq ?? 0) + 1
        let size = p.currentHand ?? previous?.handSize ?? 0
        let dealer = Position.valid(p.dealer) ?? previous?.dealer ?? 1
        let bidder = dealer % 4 + 1
        s.table.deal = DealState(handNo: HandSequence.handNo(forSize: size), handSize: size, dealer: dealer, bidder: bidder,
                                 dealSeq: dealSeq, trump: p.trump, trumpBroken: false)
        if let pos = Position.valid(p.position) {
            s.table.viewer.position = pos
            if s.table.viewer.role != .lazyWatcher { s.table.viewer.role = .seat; s.table.viewer.ownerView = "seat" }
        } else if s.table.viewer.role == .none || s.table.viewer.role == .entrant {
            s.table.viewer.role = .spectator  // the spectator variant carries no position
        }
        s.table.hand = s.table.viewer.holdsSeat ? (p.hand ?? []) : []
        var hsi: [Int: Double] = [:]
        for (k, v) in p.hsiValues ?? [:] { if let pos = Position.valid(Int(k)) { hsi[pos] = v } }
        s.table.hsi = hsi
        s.scores.tricks = TeamPair()
        s.scores.tricksByPosition = [0, 0, 0, 0]
        s.scores.rainbows = TeamPair()
        if let s1 = p.score1, let s2 = p.score2 { s.scores.score = TeamPair(team1: s1, team2: s2) }
        for info in p.playerInfo ?? [] {
            guard let pos = Position.valid(info.position) else { continue }
            mutateSeat(&s, pos) { seat in
                if let name = info.username { seat.username = name }
                if let pic = info.pic?.pic { seat.pic = pic }
                // avatarUrl cap: a custom picture's slot is null and its URL is in avatarUrls (only
                // when a rendition exists; else the slot carries the inline picture, docs/avatars.md I6)
                if let urls = p.avatarUrls {
                    seat.avatarUrl = urls[String(pos)]
                } else if case .avatar = seat.pic {
                    seat.avatarUrl = nil
                }
            }
        }
        for pos in 1...4 where s.players.seats[pos] != nil { s.players.seats[pos]!.cardsInHand = size }
        s.table.trickNo = 1
        s.pending = nil
        s.table.phase = .bidding(BiddingState(turn: nil, bids: .fresh(bidder: bidder)))  // 21.5: bids start empty every deal
        if let previous { fx.append(.animate(.handCleared(dealSeq: previous.dealSeq))) }
        if let trump = p.trump {
            addLog(&s, "Hand \(size) — Trump: \(trumpString(trump))")
        } else {
            addLog(&s, "Hand \(size) started")
        }
    }

    static func trumpString(_ trump: Card) -> String {
        switch trump.suit {
        case .spades: return "\(trump.rank.rawValue)\u{2660}"
        case .hearts: return "\(trump.rank.rawValue)\u{2665}"
        case .diamonds: return "\(trump.rank.rawValue)\u{2666}"
        case .clubs: return "\(trump.rank.rawValue)\u{2663}"
        case .joker: return trump.rank == .hi ? "High Joker" : "Low Joker"
        }
    }

    static func bidReceived(_ s: inout TableState, _ p: WirePayload.BidReceived, _ fx: inout [TableEffect]) {
        guard let pos = Position.valid(p.position), case .bidding(var b) = s.table.phase else { return }
        let bid = p.bid.value
        if let arr = p.bidArray {
            for i in 0..<4 { b.bids.byPosition[i] = i < arr.count ? arr[i]?.value : nil }
        }
        b.bids.byPosition[pos - 1] = bid  // bidArray is authoritative; the bid itself is always in it
        b.bids.recomputeMults()
        s.table.phase = .bidding(b)
        addLog(&s, "\(s.players.name(pos)) bid \(bid)")
        if pos == s.table.viewer.position, let pending = s.pending, case .bid = pending.submission {
            s.pending = nil
            fx.append(.cancelAck(reqId: pending.reqId))
        }
        let dealSeq = s.table.deal?.dealSeq ?? 0
        fx.append(.animate(.bidPlaced(position: pos, bid: bid, dealSeq: dealSeq)))
        if BidRules.isBore(bid) { fx.append(.animate(.bore(position: pos, bid: bid, dealSeq: dealSeq))) }
    }

    static func logBiddingComplete(_ s: inout TableState, _ bids: BidBook) {
        let players = s.players
        let name = { (pos: Int) in players.name(pos) }
        let b = { (pos: Int) in bids.bid(at: pos) ?? "-" }
        if s.table.viewer.role == .spectator {
            addLog(&s, "Bidding complete — \(name(1))/\(name(3)): \(b(1))/\(b(3)), \(name(2))/\(name(4)): \(b(2))/\(b(4))")
        } else if let me = s.table.viewer.position {
            let opp = me % 2 == 1 ? [2, 4] : [1, 3]
            addLog(&s, "Bidding complete — Your team: \(b(me))/\(b(Positions.team(me))), Opponents: \(b(opp[0]))/\(b(opp[1]))")
        }
    }

    static func cardPlayed(_ s: inout TableState, _ p: WirePayload.CardPlayed, _ fx: inout [TableEffect]) {
        guard let pos = Position.valid(p.position), case .playing(var pl) = s.table.phase else { return }
        if pl.trick.count >= 4 { return }  // a trick never takes a 5th card
        if pl.trick.isEmpty { pl.lead = pos }
        let played = PlayedCard(card: p.card, position: pos)
        pl.trick.append(played)
        if let tb = p.trumpBroken ?? p.trump { s.table.deal?.trumpBroken = tb }
        if pl.trick.count == 4 { pl.turn = nil }  // TRICK_RESOLVING: no updateTurn until trickComplete
        s.table.phase = .playing(pl)
        mutateSeat(&s, pos) { $0.cardsInHand = max(0, $0.cardsInHand - 1) }
        let mine = pos == s.table.viewer.position && s.table.viewer.holdsSeat
        if mine, let i = s.table.hand.firstIndex(of: p.card) { s.table.hand.remove(at: i) }  // also a lazy bot's play for me
        if mine, let pending = s.pending, case .play(let c) = pending.submission {
            s.pending = nil
            if c == p.card {
                fx.append(.cancelAck(reqId: pending.reqId))
            } else {
                fx.append(.cancelAck(reqId: pending.reqId))
                let id = "mismatch-\(s.sync.nextRequestNo)"
                s.sync.nextRequestNo += 1
                fx.append(.requestSnapshot(requestId: id, log: false))
            }
        }
        let key = currentKey(s)
        fx.append(.animate(.cardPlayed(played, key, byMe: mine && s.table.viewer.role == .seat)))
        if TrickRules.isOverTrump(trick: pl.trick, trump: s.table.deal?.trump) { fx.append(.animate(.overTrump(key))) }
    }

    static func trickComplete(_ s: inout TableState, _ p: WirePayload.TrickComplete, _ fx: inout [TableEffect]) {
        guard let winner = Position.valid(p.winner), case .playing(let pl) = s.table.phase else { return }
        s.scores.tricks[team: Positions.getTeamNumber(winner)] += 1
        if let n = s.scores.tricksByPosition[winner - 1] { s.scores.tricksByPosition[winner - 1] = n + 1 }
        let key = currentKey(s)
        s.table.trickNo += 1
        if s.table.trickNo > (s.table.deal?.handSize ?? 0) {
            s.table.phase = .handResolving(HandResolvingState(bids: pl.bids, outcome: nil))
        } else {
            s.table.phase = .playing(PlayingState(trick: [], lead: nil, turn: nil, bids: pl.bids))
        }
        let rel = s.scores.tricks.relative(to: s.table.viewer.viewPosition)
        addLog(&s, "\(s.players.name(winner)) won the trick (\(rel.mine)-\(rel.theirs))")
        fx.append(.animate(.trickCollected(winner: winner, key)))
    }

    static func handComplete(_ s: inout TableState, _ p: WirePayload.HandComplete) {
        let bids = s.table.phase.bids ?? .fresh(bidder: s.table.deal?.bidder ?? 1)
        let t1 = p.score?.team1 ?? s.scores.score.team1
        let t2 = p.score?.team2 ?? s.scores.score.team2
        let old1 = p.team1OldScore ?? 0
        let old2 = p.team2OldScore ?? 0
        let t1Tricks = p.team1Tricks ?? 0
        let t2Tricks = p.team2Tricks ?? 0
        s.scores.score = TeamPair(team1: t1, team2: t2)
        s.table.phase = .handResolving(HandResolvingState(bids: bids,
            outcome: HandOutcome(team1Tricks: t1Tricks, team2Tricks: t2Tricks, team1OldScore: old1, team2OldScore: old2)))
        guard p.score != nil else { return }

        let players = s.players
        let name = { (pos: Int) in players.name(pos) }
        let b = { (pos: Int) in bids.bid(at: pos) ?? "-" }
        let change = { (d: Int) in d >= 0 ? "+\(d)" : "\(d)" }
        func annotation(mult: Int, rainbows: Int) -> String {
            var parts: [String] = []
            if mult > 1 { parts.append("\(mult)x") }
            if rainbows > 0 { parts.append("rainbow +\(rainbows * 10)") }
            return parts.isEmpty ? "" : " (\(parts.joined(separator: ", ")))"
        }
        let a1 = annotation(mult: bids.mults.team1, rainbows: s.scores.rainbows.team1)
        let a2 = annotation(mult: bids.mults.team2, rainbows: s.scores.rainbows.team2)
        addLog(&s, "--- HAND COMPLETE ---")
        addLog(&s, "\(name(1))/\(name(3)): Bid \(b(1))/\(b(3)), Won \(t1Tricks), \(change(t1 - old1)) → \(t1)\(a1)")
        addLog(&s, "\(name(2))/\(name(4)): Bid \(b(2))/\(b(4)), Won \(t2Tricks), \(change(t2 - old2)) → \(t2)\(a2)")
    }
}

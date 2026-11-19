import Foundation

/// Snapshot v2 application (contract/README.md R5): the only restore path.
extension TableReducer {
    static func applySnapshot(_ s: inout TableState, _ snap: TableSnapshot, _ source: SnapshotSource,
                              _ hints: LegacySeatHints?, _ fx: inout [TableEffect]) {
        switch snap.stage {
        case .ended, .aborted, .unknown:
            // Never on the wire for a live game (ENDED/ABORTED answer not_in_game), or a newer stage: keep the table
            #if DEBUG
            print("[Table] snapshot with stage \(snap.stage.rawValue) ignored")
            #endif
            // (ServerEvent.decode already turns a carrier's unknown stage into WireError.snapshot)
            if case .unknown = snap.stage { snapshotFailed(&s, &fx) }
            return
        default:
            break
        }
        let buffered = s.sync.buffered
        let resyncId = s.sync.resyncId
        var next = state(from: snap, hints: hints, previous: s, source: source)
        // keep the resync bookkeeping, then replay what arrived above S
        next.sync = SyncState(lastSeq: snap.seq, buffered: [], resyncId: nil, nextRequestNo: s.sync.nextRequestNo)
        _ = resyncId  // any snapshot covers the gap (R3: always apply), whichever request it answers
        // Leave's check: any snapshot while it is on settles the seats (LeaveOutcome `verified`)
        if s.players.leaveCheck != .idle { next.players.leaveCheck = .verified }
        // the bid clock: a snapshot is state, so it may start the tune (the documented exception
        // to "a snapshot plays nothing"); one without the clock ends it; another game's ends
        // whatever may still ring
        let sameGame = s.table.gameId == next.table.gameId
        if !sameGame && s.table.bidTuneLive { fx.append(.bidClock(.stop(.hard))) }
        let hadClock = sameGame && s.table.bidClock != nil
        // /help: the same game keeps its answer (shown again if still live), a held one, the
        // uses and an ask on its way; another game's are gone
        if sameGame {
            next.table.assist = s.table.assist
            next.table.parkedAssist = s.table.parkedAssist
            next.table.assistUses = next.table.assistUses ?? s.table.assistUses
            next.table.assistAsking = s.table.assistAsking
        }
        s = next
        s.table.myTurn = s.myTurn
        settleAssist(&s, abandon: false, &fx)
        fx.append(.animate(.sceneReset))
        if s.table.bidClock != nil { fx.append(.bidClock(.sync)) } else if hadClock { fx.append(.bidClock(.stop(.fade))) }
        catchUp(&fx) { fx in
            for ev in buffered.sorted(by: { ($0.seq ?? 0) < ($1.seq ?? 0) }) where (ev.seq ?? Int.max) > snap.seq {
                gate(&s, ev, &fx)
            }
        }
    }

    /// The whole table from a snapshot, keeping only what `partial` says was
    /// left out (log, custom pictures) and what v2 never carries (socket ids).
    static func state(from snap: TableSnapshot, hints: LegacySeatHints?, previous: TableState?, source: SnapshotSource) -> TableState {
        let prev = previous ?? TableState()
        let sameGame = prev.table.gameId == snap.gameId
        var s = TableState.fresh(keeping: prev.table.me)
        s.table.gameId = snap.gameId

        // tournament: the snapshot, else the v1 carrier's key, else what we had for this game
        if let t = snap.tournament { s.table.tournamentId = t.tournamentId }
        else if let hinted = hints?.tournamentId { s.table.tournamentId = hinted }
        else if sameGame { s.table.tournamentId = prev.table.tournamentId }

        s.table.viewer = ViewerState(role: role(snap.viewer.role), position: Position.valid(snap.viewer.position),
                                     ownerView: snap.viewer.ownerView?.rawValue)
        // /help: my own seat's uses this game (snapshot viewer.assist, additive 2026-11-19; a
        // seat or a lazy watcher only), so the chat list's "(n of 3 free used)" is exact after a
        // relaunch or rejoin. Absent (a spectator, an older server): unknown, or what this game had.
        // Its additive `unlimited`: a game with a native bot seat (AssistRules.isFreeHelpGame).
        if let a = snap.viewer.assist {
            s.table.assistUses = AssistUses(uses: max(0, a.uses), freeUses: max(0, a.freeUses), assisted: a.assisted,
                                            unlimited: a.unlimited == true, told: true)
        }
        s.table.hand = snap.hand ?? []
        s.table.deal = snap.deal.map {
            DealState(handNo: $0.handNo, handSize: $0.handSize, dealer: $0.dealer, bidder: $0.bidder, dealSeq: $0.dealSeq ?? 0,
                      trump: snap.trump, trumpBroken: snap.trumpBroken)
        }
        var hsi: [Int: Double] = [:]
        for (i, v) in (snap.hsi ?? []).enumerated() where i < 4 { if let v { hsi[i + 1] = v } }
        s.table.hsi = hsi
        s.table.trickNo = snap.trick.number ?? (snap.tricks.team1 + snap.tricks.team2 + 1)

        s.scores = ScoreSlice(tricks: pair(snap.tricks), tricksByPosition: seatTricks(snap),
                              score: pair(snap.score), rainbows: pair(snap.rainbows))

        // seats: [] until all four exist; keep ours meanwhile
        if snap.seats.isEmpty {
            if sameGame { s.players.seats = prev.players.seats }
        } else {
            for seat in snap.seats {
                guard let pos = Position.valid(seat.position) else { continue }
                s.players.seats[pos] = seatState(seat, snap: snap, prev: sameGame ? prev.players.seats : [:], hints: hints)
            }
        }
        s.players.socketBySeat = sameGame ? prev.players.socketBySeat : [:]
        for (pos, sid) in hints?.sockets ?? [:] { s.players.socketBySeat[pos] = sid }
        s.players.spectatorCount = snap.spectatorCount
        s.players.watching = WatchingList(snap.watching)
        // the voice rule before seating (VoiceCompany): the draw's human entrants not left
        if s.players.seats.count < 4, let entrants = snap.entrants {
            s.players.entrantHumans = entrants.compactMap { e in
                guard !e.isBot, e.presence != .left, let name = e.username, !name.isEmpty else { return nil }
                return name
            }
        }
        if let offered = snap.seats.first(where: { $0.offered }) {
            s.players.resignationOffer = ResignationOffer(position: offered.position, username: offered.ownerUsername ?? offered.username ?? "")
        } else if sameGame, let idle = prev.players.resignationOffer, idle.idle, snap.turn?.position == idle.position,
                  let seat = s.players.seats[idle.position], seat.controller == .human,
                  seat.presence == .connected || seat.presence == .none {
            // a standing idle-seat offer outlives a snapshot of the same game while its seat is
            // still a connected human on turn (the snapshot does not carry it, and the server
            // replays it only to a re-attached socket or at its next 90 s asking; the web keeps
            // its dialog too). A stale Replace is refused by the server (idleOfferStands).
            s.players.resignationOffer = idle
        }

        // log: kept when left out of this snapshot (same game), else the snapshot's
        if snap.partial.contains(.log) && sameGame {
            s.log = prev.log
        } else {
            s.log.entries = snap.log.map { entry in
                var row = ChatMessage(username: "System", message: entry.message, type: ChatMessage.MessageType(rawValue: entry.type.rawValue) ?? .system,
                                      position: Position.valid(entry.position), timestamp: ChatMessage.serverDate(entry.at) ?? Date())
                // the stored fault line replays red, in place, once (the server's, never recomputed here)
                row.isFault = entry.fault != nil
                return row
            }
        }

        let bids = BidBook(byPosition: padded(snap.bids.byPosition.map { $0?.uppercased() }, to: 4),
                           order: snap.bids.order.count == 4 ? snap.bids.order : [1, 2, 3, 4],
                           teamBids: snap.bids.teamBids.map(pair), mults: pair(snap.bids.mults))
        let cards = snap.trick.cards.map { PlayedCard(card: $0.card, position: $0.position) }
        switch snap.stage {
        case .created:
            s.table.phase = .waiting
        case .drawing, .drawResolving, .teamsAnnounced:
            var d = DrawState(stage: snap.stage == .drawing ? .drawing : snap.stage == .drawResolving ? .resolving : .teamsAnnounced)
            d.results = (snap.draw?.drawn ?? []).map { DrawResult(username: $0.username ?? "", position: $0.drawOrder, cardIndex: 0, card: $0.card) }
            if let mine = snap.draw?.viewerDrawOrder {
                d.hasDrawn = true
                d.drawnCard = snap.draw?.drawn.first(where: { $0.drawOrder == mine })?.card
            }
            if snap.stage == .teamsAnnounced {
                let name = { (pos: Int) in s.players.seats[pos]?.username ?? snap.draw?.drawn.first(where: { $0.position == pos })?.username ?? "" }
                d.teams = TeamsAnnounced(team1: [name(1), name(3)], team2: [name(2), name(4)])
            }
            s.table.phase = .draw(d)
        case .dealing:
            // the first deal still shows the draw screen; between hands the table stays up
            s.table.phase = snap.deal == nil ? .draw(DrawState(stage: .dealing)) : .handResolving(HandResolvingState(bids: bids, outcome: nil))
        case .bidding, .redeal:
            s.table.phase = .bidding(BiddingState(turn: snap.turn?.position, bids: bids))
        case .playing:
            s.table.phase = .playing(PlayingState(trick: cards, lead: snap.trick.leadPosition ?? cards.first?.position,
                                                  turn: snap.turn?.position, bids: bids))
        case .trickResolving:
            s.table.phase = .playing(PlayingState(trick: cards, lead: snap.trick.leadPosition ?? cards.first?.position, turn: nil, bids: bids))
        case .handResolving:
            s.table.phase = .handResolving(HandResolvingState(bids: bids, outcome: nil))
        case .ended, .aborted, .unknown:
            s.table.phase = prev.table.phase
        }

        // the running bid clock (present only while it runs; inMs from the snapshot's serverTime,
        // i.e. from receipt); an invalid one is dropped, never the snapshot
        if let c = snap.bidClock, let pos = Position.valid(c.position), c.inMs >= 0, c.durationMs >= 1, s.table.phase.isBidding {
            s.table.bidClock = BidClockState(position: pos, inMs: c.inMs, durationMs: c.durationMs)
        }
        s.table.bidTuneLive = s.table.bidClock != nil || (sameGame && prev.table.bidTuneLive)

        // A play still in flight survives a gap resync that shows it not yet taken
        if let p = prev.pending, case .requested(let id) = source, id.hasPrefix("gap-"), snap.viewer.canAct {
            if case .play(let c) = p.submission, s.table.hand.contains(c) { s.pending = p }
            if case .bid = p.submission { s.pending = p }
        }
        s.table.myTurn = s.myTurn
        return s
    }

    static func role(_ r: TableSnapshot.Role) -> ViewerRole {
        switch r {
        case .seat: return .seat
        case .lazyWatcher: return .lazyWatcher
        case .spectator: return .spectator
        case .entrant: return .entrant
        case .none, .unknown: return .none
        }
    }

    static func pair(_ p: TableSnapshot.TeamPair) -> TeamPair { TeamPair(team1: p.team1, team2: p.team2) }

    static func padded<T>(_ a: [T?], to n: Int) -> [T?] { Array((a + Array(repeating: nil, count: max(0, n - a.count))).prefix(n)) }

    /// Each seat's tricks for a snapshot, per team (the web's GameState._seatTricksFor): the
    /// snapshot's tricksByPosition when that team's two seats add up to its count (the server's
    /// own count), else the winners in trickHistory when every one of that team's tricks has a
    /// winner on that team, else nil for both seats (the pips then show the team's tricks).
    static func seatTricks(_ snap: TableSnapshot) -> [Int?] {
        let byPos = snap.tricksByPosition.count == 4 && snap.tricksByPosition.allSatisfy { $0 >= 0 } ? snap.tricksByPosition : nil
        var out: [Int?] = [nil, nil, nil, nil]
        for (team, seats) in [(1, [1, 3]), (2, [2, 4])] {
            let count = team == 1 ? snap.tricks.team1 : snap.tricks.team2
            if let b = byPos, b[seats[0] - 1] + b[seats[1] - 1] == count {
                for p in seats { out[p - 1] = b[p - 1] }
                continue
            }
            let won = snap.trickHistory.filter { Positions.getTeamNumber($0.winner) == team }
            let known = won.count == count && won.allSatisfy { seats.contains($0.winner) }
            for p in seats { out[p - 1] = known ? won.filter { $0.winner == p }.count : nil }
        }
        return out
    }

    static func seatState(_ seat: TableSnapshot.Seat, snap: TableSnapshot, prev: [Int: SeatState], hints: LegacySeatHints?) -> SeatState {
        var pic: Pic = seat.pic.map { .avatar($0) } ?? .none
        if seat.hasCustomPic {
            if let custom = seat.customPic {
                pic = .custom(custom)
            } else if let held = prev.values.first(where: { $0.username == seat.username && { if case .custom = $0.pic { return true } else { return false } }($0) }) {
                pic = held.pic  // R5 customPics: keep the picture held for that username
            } else if let hinted = hints?.pics[seat.position] {
                pic = hinted
            }
        }
        let controller: SeatController
        switch seat.controller {
        case .human: controller = .human
        case .lazyBot: controller = .lazyBot
        case .resignBot: controller = .resignBot
        case .bot: controller = .bot
        case .unknown: controller = .unknown
        }
        let presence: SeatPresence
        switch seat.presence {
        case .connected: presence = .connected
        case .grace: presence = .grace
        case .resignable: presence = .resignable
        case .away: presence = .away
        case .gone: presence = .gone
        case .none, .unknown: presence = .none
        }
        // the URL: the snapshot's, else the carrier's avatarUrls, else the one held for that username
        var avatarUrl = seat.avatarUrl ?? hints?.avatarUrls[seat.position]
        if avatarUrl == nil, seat.hasCustomPic {
            avatarUrl = prev.values.first(where: { $0.username == seat.username && $0.avatarUrl != nil })?.avatarUrl
        }
        return SeatState(position: seat.position, username: seat.username, pic: pic, avatarUrl: avatarUrl,
                         ownerUsername: seat.ownerUsername, controller: controller, presence: presence,
                         isBot: seat.isBot, lazy: seat.lazy, cardsInHand: seat.cardsInHand)
    }
}

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
            if case .unknown = snap.stage { requestResync(&s, &fx) }
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
        s = next
        s.table.myTurn = s.myTurn
        fx.append(.animate(.sceneReset))
        for ev in buffered.sorted(by: { ($0.seq ?? 0) < ($1.seq ?? 0) }) where (ev.seq ?? Int.max) > snap.seq {
            gate(&s, ev, &fx)
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
        s.table.hand = snap.hand ?? []
        s.table.deal = snap.deal.map {
            DealState(handNo: $0.handNo, handSize: $0.handSize, dealer: $0.dealer, bidder: $0.bidder, dealSeq: $0.dealSeq ?? 0,
                      trump: snap.trump, trumpBroken: snap.trumpBroken)
        }
        var hsi: [Int: Double] = [:]
        for (i, v) in (snap.hsi ?? []).enumerated() where i < 4 { if let v { hsi[i + 1] = v } }
        s.table.hsi = hsi
        s.table.trickNo = snap.trick.number ?? (snap.tricks.team1 + snap.tricks.team2 + 1)

        s.scores = ScoreSlice(tricks: pair(snap.tricks), tricksByPosition: padded(snap.tricksByPosition),
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
        if let offered = snap.seats.first(where: { $0.offered }) {
            s.players.resignationOffer = ResignationOffer(position: offered.position, username: offered.ownerUsername ?? offered.username ?? "")
        }

        // log: kept when left out of this snapshot (same game), else the snapshot's
        if snap.partial.contains(.log) && sameGame {
            s.log = prev.log
        } else {
            s.log.entries = snap.log.map { entry in
                ChatMessage(username: "System", message: entry.message, type: ChatMessage.MessageType(rawValue: entry.type.rawValue) ?? .system,
                            position: Position.valid(entry.position))
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
    static func padded(_ a: [Int]) -> [Int] { Array((a + [0, 0, 0, 0]).prefix(4)) }

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

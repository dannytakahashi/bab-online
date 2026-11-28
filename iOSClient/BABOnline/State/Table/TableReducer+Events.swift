import Foundation

/// Delta events (after the seq gate). Log lines are today's exact strings.
extension TableReducer {
    static func apply(_ s: inout TableState, _ ev: SequencedEvent, _ fx: inout [TableEffect]) {
        switch ev.event {
        // MARK: draw
        case .allPlayersReady(let p):
            if let gid = p.gameId { local(&s, .enterGameContext(gameId: gid, tournamentId: nil), &fx) }
            if GameMode.from(p.mode) == .gyb { setMode(&s, .gyb) }
        case .startDraw(let p):
            if s.table.phase.kind == .ended {
                let mode = s.table.mode
                s = .fresh(keeping: s.table.me)
                s.table.mode = mode
            }
            // drawResults start empty (stale-results fix); a tournament table's planned teams
            s.table.phase = .draw(DrawState(stage: .drawing, plannedTeams: PlannedTeams.valid(p.teams)))
        case .youDrew(let p):
            mutateDraw(&s) { d in
                d.hasDrawn = true
                if let c = p.card { d.drawnCard = c }
            }
        case .playerDrew(let p):
            var turnedUp = false
            mutateDraw(&s) { d in
                let r = DrawResult(username: p.username ?? "", position: p.drawOrder, cardIndex: p.cardIndex ?? 0, card: p.card)
                if let i = d.results.firstIndex(where: { $0.drawOrder == p.drawOrder }) {
                    d.results[i] = r
                } else {
                    d.results.append(r)
                    turnedUp = true
                }
            }
            // a new card in the draw for deal (DrawPhaseView flips it): its card sound, spaced by
            // TableSoundCues when draws come together; never for a re-sent draw order, a snapshot
            // (the draw is its state) or buffered catch-up (catchUp drops it)
            if turnedUp { fx.append(.sound(.draw)) }
        case .positionUpdate(let p):
            positionUpdate(&s, p)
        case .teamsAnnounced(let p):
            mutateDraw(&s) { d in
                d.stage = .teamsAnnounced
                d.teams = TeamsAnnounced(team1: p.team1 ?? [], team2: p.team2 ?? [])
            }
        case .createUI:
            mutateDraw(&s) { $0.stage = .dealing }
            // a new game: no /help used yet (the command list's count)
            s.table.assistUses = AssistUses()

        // MARK: deal / bidding
        case .gameStart(let p):
            gameStart(&s, p, &fx)
        case .updateTurn(let p):
            guard let turn = Position.valid(p.currentTurn ?? p.turn) else { break }
            if let clock = s.table.bidClock, clock.position != turn { stopBidClock(&s, .fade, &fx) }
            switch s.table.phase {
            case .bidding(var b): b.turn = turn; s.table.phase = .bidding(b)
            case .playing(var pl): pl.turn = turn; s.table.phase = .playing(pl)
            default: break
            }
            // a turn change ends a /help answer, unless still live by its turnKey (a repeat of
            // this turn); one held while the table lagged behind shows now if it is live
            s.table.assistAsking = false
            settleAssist(&s, abandon: true, &fx)
            // a watched seat's advice ends at its turn's change too (unless still this turn's)
            if let w = s.table.watchedAssist, !AssistRules.isLiveWatched(w, s) { s.table.watchedAssist = nil }
            // a lightbulb is its seat's open turn's (SeatBadges.swift)
            clearHelpBadges(&s, keeping: turn)
        case .bidReceived(let p):
            bidReceived(&s, p, &fx)
        case .doneBidding(let p):
            stopBidClock(&s, .fade, &fx)
            clearAssist(&s)
            s.table.watchedAssist = nil
            clearHelpBadges(&s)
            guard var bids = s.table.phase.bids else { break }
            if let arr = p.bids, arr.count == 4 || arr.count == s.table.seats {
                bids.byPosition = BidBook.padded(arr.map { $0?.value })
            }
            if let tb = p.teamBids { bids.teamBids = TeamPair(team1: tb.team1, team2: tb.team2) }
            if let m = p.mults { bids.mults = TeamPair(team1: m.team1, team2: m.team2) } else { bids.recomputeMults() }
            s.table.phase = .playing(PlayingState(trick: [], lead: nil, turn: Position.valid(p.lead), bids: bids))
            s.table.deal?.trumpBroken = false
            if s.table.isGyb { s.table.gyb.forbidden = p.gyb?.forbidden ?? s.table.gybForbidden }
            logBiddingComplete(&s, bids)
        case .rainbow(let p):
            guard let pos = Position.valid(p.position) else { break }
            s.scores.rainbows[team: Positions.getTeamNumber(pos)] += 1
            fx.append(.animate(.rainbow(position: pos, dealSeq: s.table.deal?.dealSeq ?? 0)))
            // the server stores this line (type rainbow) but never sends it live: the web adds it
            // on this event, the same row a rejoin's snapshot log replays
            s.log.entries.append(ChatMessage(username: "System", message: rainbowLine(s.players.name(pos)), type: .system, position: pos))
        case .destroyHands:
            stopBidClock(&s, .fade, &fx)
            clearAssist(&s)
            s.table.watchedAssist = nil
            clearHelpBadges(&s)
            s.table.hand = []
            // every hand is gone, not only mine (the card backs; the redeal's gameStart refills them)
            for pos in s.players.seats.keys { s.players.seats[pos]?.cardsInHand = 0 }
            s.pending = nil
            let bidder = s.table.deal?.bidder ?? 1
            s.table.phase = .bidding(BiddingState(turn: nil, bids: .fresh(bidder: bidder, seats: s.table.seats)))
            fx.append(.animate(.handsDestroyed(dealSeq: s.table.deal?.dealSeq ?? 0)))

        // MARK: play
        case .cardPlayed(let p):
            cardPlayed(&s, p, &fx)
        case .trickComplete(let p):
            trickComplete(&s, p, &fx)
        case .handComplete(let p):
            handComplete(&s, p, &fx)
        case .gameEnd(let p, let data):
            stopBidClock(&s, .hard, &fx)
            dropAssist(&s)
            // the over-the-shoulder view ends with the game: the end screen is the plain
            // spectator's (the server forgets the watch with the game; nothing is sent)
            endWatch(&s)
            clearHelpBadges(&s)
            fx.append(.sound(TableReducer.gameEndSound(s, data)))
            s.pending = nil
            s.table.tournamentId = p.tournamentId
            if let rows = data?.scorecard { s.table.scorecard = rows }
            if let end = data?.gyb {
                setMode(&s, .gyb)
                s.table.gyb.scores = end.scores
                s.table.gyb.made = end.made
                s.table.gyb.hands = end.hands
            }
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
            // the seat really dropped: its idle offer is moot (grace, then its own offer, follow)
            if let o = s.players.resignationOffer, o.idle, o.position == pos { s.players.resignationOffer = nil }
        case .playerReconnected(let p):
            guard let pos = Position.valid(p.position) else { break }
            mutateSeat(&s, pos) { $0.presence = .connected }
            if s.players.resignationOffer?.position == pos { s.players.resignationOffer = nil }
        case .resignationAvailable(let p):
            guard let pos = Position.valid(p.position) else { break }
            // an idle-seat offer (a tournament table): the player is connected, so the seat's
            // presence stays (no "disconnected" row); a seat already away keeps the usual offer
            let away = [.grace, .resignable, .away].contains(s.players.seats[pos]?.presence ?? .none)
            let idle = p.idle == true && !away
            if !idle { mutateSeat(&s, pos) { $0.presence = .resignable } }
            var round = 0
            if idle, let old = s.players.resignationOffer, old.idle, old.position == pos { round = old.round + 1 }
            s.players.resignationOffer = ResignationOffer(position: pos, username: p.username ?? s.players.name(pos), idle: idle, round: round)
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
            clearHelpBadge(&s, at: pos)
            // a resigned owner may later leave unannounced: while my Leave is up, check again
            if s.players.leaveCheck != .idle { checkLeave(&s, &fx) }
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
            // a bot plays the seat now: its lightbulb goes (the cap stays: the owner's tutorial is on)
            clearHelpBadge(&s, at: pos)
            if pos == s.table.viewer.position && s.table.viewer.role == .seat {
                s.table.viewer.role = .lazyWatcher
                s.table.viewer.ownerView = "seat"
                s.pending = nil
                // a bot plays my seat now: my /help answer is moot (and a rule tip with it)
                clearAssist(&s)
                clearTip(&s)
                s.table.assistAsking = false
            } else if s.players.leaveCheck != .idle {
                // another owner's /lazy or /leave while my Leave is up (whatever it opened
                // with, settled included): check again (a /leave shows here only as this
                // event; its `gone` only in a snapshot)
                checkLeave(&s, &fx)
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
            clearHelpBadge(&s, at: pos)
            // the seat is human and connected again: an offer to replace it is moot
            if s.players.resignationOffer?.position == pos { s.players.resignationOffer = nil }
            if pos == s.table.viewer.position && s.table.viewer.role == .lazyWatcher {
                s.table.viewer.role = .seat
                s.table.viewer.ownerView = "seat"
            }

        // MARK: log / chat / spectators
        case .gameLogEntry(let p):
            let type = ChatMessage.MessageType(rawValue: p.type ?? "system") ?? .system
            var row = ChatMessage(username: "System", message: p.message ?? "", type: type)
            row.isFault = p.fault != nil
            row.isHelp = p.help != nil
            row.isTutorial = p.tutorial != nil
            s.log.entries.append(row)
            // the avatar badges (SeatBadges.swift): the notice's lightbulb, the tutorial's cap (the
            // live tag only: a snapshot's stored tag styles its row and toggles nothing)
            if let pos = Position.valid(p.help?.position) { helpNotice(&s, position: pos, &fx) }
            if let t = p.tutorial, let pos = Position.valid(t.position), let on = t.on { tutorialTag(&s, position: pos, on: on, &fx) }
            // the paused rule (the over-the-shoulder view): the room's pause and resume lines
            if type == .system, let m = p.message { watchLogLine(&s, m, &fx) }
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
        case .bidClock(let p):
            bidClockEvent(&s, p, &fx)
        case .seatLeft(let p):
            seatLeft(&s, p)
        case .assistHint(let p):
            assistHint(&s, p, &fx)
        case .assistState(let p):
            assistState(&s, p, &fx)
        case .watchHandRefused(let p):
            watchRefused(&s, p, &fx)
        case .spectatorNotice(let p):
            if let n = p.spectatorCount { s.players.spectatorCount = n }
            addLog(&s, "\(p.username ?? "Someone") joined as spectator")
        case .seqOnly, .rejoinFailed:
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
                applySnapshot(&s, snap, .rejected, p.gyb.map { LegacySeatHints(gyb: $0) }, &fx)
            } else if matches {
                s.pending = nil
            }
            if matches { fx.append(.haptic(.error)) }
            // why, in the web's words (the server-error toast over the table; never blocks)
            fx.append(.notice(RejectReason.message(p.reason)))
        case .stateSnapshot(let p):
            if let snap = p.snapshot {
                applySnapshot(&s, snap, p.reason == "watchHand" ? .watchReply : .requested(p.requestId ?? ""),
                              p.gyb.map { LegacySeatHints(gyb: $0) }, &fx)
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

    /// Debounced by the coordinator (at most one in flight). Never once the table is
    /// unreadable: every later gap would ask for the same snapshot again.
    static func requestResync(_ s: inout TableState, _ fx: inout [TableEffect]) {
        guard s.sync.resyncId == nil, s.table.snapshotTrouble != .unreadable else { return }
        let id = "gap-\(s.sync.nextRequestNo)"
        s.sync.nextRequestNo += 1
        s.sync.resyncId = id
        fx.append(.requestSnapshot(requestId: id, log: false))
    }

    /// A snapshot this build cannot show (any carrier, any request). A resync waiting for it
    /// ends here (it kept `resyncId` set, so nothing asked again and the table froze); it is
    /// asked for again SnapshotRetryPolicy.maxRetries times with backoff, then the table is
    /// `unreadable` (UnreadableTableView: update the app, or leave) until a snapshot applies.
    static func snapshotFailed(_ s: inout TableState, _ fx: inout [TableEffect]) {
        guard s.table.snapshotTrouble != .unreadable else { return }
        s.sync.snapshotFailures += 1
        let attempt = s.sync.snapshotFailures
        if attempt <= SnapshotRetryPolicy.maxRetries {
            let id = "snap-\(s.sync.nextRequestNo)"
            s.sync.nextRequestNo += 1
            s.sync.resyncId = id
            s.table.snapshotTrouble = .retrying(attempt: attempt)
            fx.append(.retrySnapshot(requestId: id, attempt: attempt))
        } else {
            s.sync.resyncId = nil
            s.sync.buffered = []
            s.table.snapshotTrouble = .unreadable
            // nothing can confirm or roll back a submission now
            if let p = s.pending {
                s.pending = nil
                fx.append(.cancelAck(reqId: p.reqId))
            }
        }
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

    /// "ann has a rainbow!" (the server's stored line, gameHandlers.js; the web's live one).
    static func rainbowLine(_ name: String) -> String { "\(name) has a rainbow!" }

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
            // positionUpdate.isBot (V1_REMOVALS #14) wins; the bot: socket prefix is the fallback, so a
            // later server can drop sockets without this build losing its bots
            let isBot = (i < (p.isBot?.count ?? 0) ? p.isBot![i] : nil) ?? (sid?.hasPrefix("bot:") ?? false)
            // nativeBot (additive 2026-11-19) tells a native bot from a draw-phase leaver's resign
            // bot (isBot is true for both): only a native bot is `.bot` (AssistRules.isFreeHelpGame).
            // From an older server (no nativeBot) every bot seat is `.bot`, as before.
            let native = (i < (p.nativeBot?.count ?? 0) ? p.nativeBot![i] : nil) ?? isBot
            var seat = s.players.seats[pos] ?? SeatState(position: pos)
            // another user in the seat: the badges were the last owner's (SeatBadges.swift)
            if let name, let owner = seat.ownerUsername ?? seat.username, owner != name {
                seat.askedHelp = false
                seat.tutorial = false
            }
            seat.username = name ?? seat.username
            seat.pic = pic
            seat.avatarUrl = p.avatarUrls?[String(pos)]
            seat.isBot = isBot
            seat.controller = !isBot ? .human : native ? .bot : .resignBot
            seat.presence = isBot ? .none : (seat.presence == .none ? .connected : seat.presence)
            // owners (additive 2026-11-26): the seat's owner, so a draw-phase leaver's resign bot
            // seat is named by the leaver (PlayersSlice.ownerName / teamName), as a snapshot's
            // ownerUsername says; nil (a native bot, an older server): as before
            let owner = p.owners?.name(at: i)
            seat.ownerUsername = owner ?? (isBot ? nil : name)
            seat.lazy = false
            s.players.seats[pos] = seat
            if let sid { s.players.socketBySeat[pos] = sid }
            // My seat: matched by socket id or username (as the old setPlayerData did). A pure
            // spectator never claims a seat by username (the web keeps isSpectator there too): it
            // is my account's seat on another device (a second device spectating during the
            // draw), and claiming it would make this socket a seat (the chime, a live bid panel
            // sending playerBid) and lose the own-seat watch. Only this socket's id seats it.
            if let sid, sid == s.table.me.playerId { s.table.viewer.position = pos; s.table.viewer.role = .seat }
            else if let name, let me = s.table.me.username, name == me, s.table.viewer.role != .spectator,
                    s.table.viewer.position == nil || s.table.viewer.role != .seat {
                s.table.viewer.position = pos
                s.table.viewer.role = .seat
            }
        }
        if let mine = Position.valid(p.yourPosition) { s.table.viewer.position = mine; s.table.viewer.role = .seat }
        if s.table.viewer.role == .seat { s.table.viewer.ownerView = "seat" }
        if s.players.seats.count >= s.table.seats { s.players.entrantHumans = nil }  // the seats say who is here
        mutateDraw(&s) { $0.stage = .resolving }
    }

    static func gameStart(_ s: inout TableState, _ p: WirePayload.GameStart, _ fx: inout [TableEffect]) {
        stopBidClock(&s, .fade, &fx)
        clearAssist(&s)
        clearHelpBadges(&s)
        s.table.watchedAssist = nil
        if s.table.phase.kind == .ended || s.table.phase.kind == .none { s.table.phase = .waiting }
        // the scorecard: another game's deal starts a new card; a deal with scorecardRows says
        // the server keeps one
        if let gid = p.gameId, let mine = s.table.gameId, gid != mine { s.table.scorecard = nil }
        if p.scorecardRows?.value != nil, s.table.scorecard == nil { s.table.scorecard = [] }
        if let gid = p.gameId { s.table.gameId = gid }
        let previous = s.table.deal
        let dealSeq = (previous?.dealSeq ?? 0) + 1
        let size = p.currentHand ?? previous?.handSize ?? 0
        let dealer = Position.valid(p.dealer) ?? previous?.dealer ?? 1
        // Get Your Bid (gameStart.gyb): three seats, each its own score
        if let g = p.gyb {
            setMode(&s, .gyb)
            s.table.gyb.scores = g.scores
        }
        s.table.gyb.forbidden = nil
        s.table.gyb.last = nil
        let bidder = Positions.rotate(dealer, seats: s.table.seats)
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
        // a watcher's deal: the watched seat's new hand and HSI (gameStart.shoulder)
        dealWatch(&s, p)
        // "HSI --" until the cards are down (the web's clearPlayerHsi, then a 1 s director.delay)
        s.table.hsiHeld = true
        fx.append(.revealHSI(dealSeq: dealSeq))
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
        s.table.phase = .bidding(BiddingState(turn: nil, bids: .fresh(bidder: bidder, seats: s.table.seats)))  // 21.5: bids start empty every deal
        if let previous { fx.append(.animate(.handCleared(dealSeq: previous.dealSeq))) }
        fx.append(.animate(.dealt(dealSeq: dealSeq)))
        fx.append(.sound(.deal))
        if let trump = p.trump {
            addLog(&s, "Hand \(size) — Trump: \(trumpString(trump))")
        } else {
            addLog(&s, "Hand \(size) started")
        }
        // a spectator's first deal (after the draw) sends the watch; a deal without the wanted hand asks again
        afterDealWatch(&s, p, &fx)
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
        if s.table.bidClock?.position == pos { stopBidClock(&s, .fade, &fx) }
        let bid = p.bid.value
        if let arr = p.bidArray {
            for i in 0..<4 { b.bids.byPosition[i] = i < arr.count ? arr[i]?.value : nil }
        }
        b.bids.byPosition[pos - 1] = bid  // bidArray is authoritative; the bid itself is always in it
        b.bids.recomputeMults()
        s.table.phase = .bidding(b)
        // my own bid: the /help card is done
        if pos == s.table.viewer.position && s.table.viewer.holdsSeat { clearAssist(&s); clearTip(&s) }
        // the watched seat's bid: its mirrored advice and tip are done
        if pos == s.table.viewer.watchedSeat { clearWatchedHints(&s) }
        clearHelpBadge(&s, at: pos)
        addLog(&s, "\(s.players.name(pos)) bid \(bid)")
        if pos == s.table.viewer.position, let pending = s.pending, case .bid = pending.submission {
            s.pending = nil
            fx.append(.cancelAck(reqId: pending.reqId))
        }
        let dealSeq = s.table.deal?.dealSeq ?? 0
        fx.append(.animate(.bidPlaced(position: pos, bid: bid, dealSeq: dealSeq)))
        if BidRules.isBore(bid) { fx.append(.animate(.bore(position: pos, bid: bid, dealSeq: dealSeq))) }
    }

    /// "Bidding complete — ann/cat: 1/0, bob/dan: B/0": each team by its players' names with
    /// their bids in the same order (owner 2026-11-17: never "Your team" / "Opponents"; the
    /// web logs no such line). A seat's own team first ("me/partner", then "opp1/opp2", opp1
    /// the next seat clockwise, as the score bar); a spectator's seats 1/3 then 2/4.
    static func logBiddingComplete(_ s: inout TableState, _ bids: BidBook) {
        let players = s.players
        let me: Int
        if s.table.viewer.role == .spectator { me = 1 } else if let p = s.table.viewer.position { me = p } else { return }
        if s.table.isGyb {
            // each player by name, mine first ("Bidding complete — ann: 3, bob: 2, cat: 4")
            let line = GybRules.order(viewer: me).map { "\(players.ownerName($0)): \(bids.bid(at: $0) ?? "-")" }.joined(separator: ", ")
            addLog(&s, "Bidding complete — \(line)")
            return
        }
        let r = Positions.getRelativePositions(myPos: me)
        let side = { (a: Int, b: Int) in
            "\(players.teamName(a))/\(players.teamName(b)): \(bids.bid(at: a) ?? "-")/\(bids.bid(at: b) ?? "-")"
        }
        addLog(&s, "Bidding complete — \(side(me, r.partner)), \(side(r.opp1, r.opp2))")
    }

    static func cardPlayed(_ s: inout TableState, _ p: WirePayload.CardPlayed, _ fx: inout [TableEffect]) {
        guard let pos = Position.valid(p.position), case .playing(var pl) = s.table.phase else { return }
        let seats = s.table.seats
        if pl.trick.count >= seats { return }  // a trick never takes a 5th card (a 4th at three seats)
        if pl.trick.isEmpty { pl.lead = pos }
        let played = PlayedCard(card: p.card, position: pos)
        pl.trick.append(played)
        if let tb = p.trumpBroken ?? p.trump { s.table.deal?.trumpBroken = tb }
        if pl.trick.count == seats { pl.turn = nil }  // TRICK_RESOLVING: no updateTurn until trickComplete
        s.table.phase = .playing(pl)
        mutateSeat(&s, pos) { $0.cardsInHand = max(0, $0.cardsInHand - 1) }
        clearHelpBadge(&s, at: pos)
        let mine = pos == s.table.viewer.position && s.table.viewer.holdsSeat
        // my own card: the /help card is done
        if mine { clearAssist(&s); clearTip(&s) }
        if mine, let i = s.table.hand.firstIndex(of: p.card) { s.table.hand.remove(at: i) }  // also a lazy bot's play for me
        // the watched seat's card (the over-the-shoulder view): out of the hand shown, its hints done
        if pos == s.table.viewer.watchedSeat {
            clearWatchedHints(&s)
            if s.table.viewer.watchesHand, let i = s.table.hand.firstIndex(of: p.card) { s.table.hand.remove(at: i) }
        }
        var confirmsMine = false
        if mine, let pending = s.pending, case .play(let c) = pending.submission {
            s.pending = nil
            confirmsMine = c == p.card
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
        // my submitted card made its sound when it went down (submitPlay); the over-trump
        // accent follows the card's sound (TableSoundCues), with the effect it goes with
        if !confirmsMine { fx.append(.sound(.card)) }
        if TrickRules.isOverTrump(trick: pl.trick, trump: s.table.deal?.trump, seats: seats) {
            fx.append(.animate(.overTrump(key)))
            fx.append(.sound(.overTrump))
        }
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
        if s.table.isGyb {
            // each player's own count, mine first ("ann won the trick (ann 2, bob 1, cat 0)")
            let order = GybRules.order(viewer: s.table.viewer.role == .spectator && s.table.viewer.watchedSeat == nil ? 1 : s.table.viewer.viewPosition)
            let tally = order.map { "\(s.players.ownerName($0)) \(s.scores.tricksByPosition[$0 - 1] ?? 0)" }.joined(separator: ", ")
            addLog(&s, "\(s.players.ownerName(winner)) won the trick (\(tally))")
            fx.append(.animate(.trickCollected(winner: winner, key)))
            // my own trick (no partner at three seats)
            fx.append(.sound(s.table.viewer.holdsSeat && s.table.viewer.position == winner ? .trickOurs : .trick))
            return
        }
        let rel = s.scores.tricks.relative(to: s.table.viewer.viewPosition)
        addLog(&s, "\(s.players.name(winner)) won the trick (\(rel.mine)-\(rel.theirs))")
        fx.append(.animate(.trickCollected(winner: winner, key)))
        // my team's sweep for a seat (a lazy owner's too); a pure spectator has no team
        let ours = s.table.viewer.holdsSeat && s.table.viewer.position.map { Positions.getTeamNumber($0) == Positions.getTeamNumber(winner) } == true
        fx.append(.sound(ours ? .trickOurs : .trick))
    }

    static func handComplete(_ s: inout TableState, _ p: WirePayload.HandComplete, _ fx: inout [TableEffect]) {
        let bids = s.table.phase.bids ?? .fresh(bidder: s.table.deal?.bidder ?? 1)
        let t1 = p.score?.team1 ?? s.scores.score.team1
        let t2 = p.score?.team2 ?? s.scores.score.team2
        let old1 = p.team1OldScore ?? 0
        let old2 = p.team2OldScore ?? 0
        let t1Tricks = p.team1Tricks ?? 0
        let t2Tricks = p.team2Tricks ?? 0
        clearAssist(&s)
        s.table.watchedAssist = nil
        clearHelpBadges(&s)
        s.scores.score = TeamPair(team1: t1, team2: t2)
        if let row = p.scorecardRow?.value, row.isValid { s.table.scorecard = Scorecard.merge(s.table.scorecard ?? [], row) }
        s.table.phase = .handResolving(HandResolvingState(bids: bids,
            outcome: HandOutcome(team1Tricks: t1Tricks, team2Tricks: t2Tricks, team1OldScore: old1, team2OldScore: old2)))
        if let hand = p.gyb {
            gybHandComplete(&s, hand, &fx)
            return
        }
        guard p.score != nil else { return }
        // made / set for my team (server calculateScore: tricks >= the team's bid total); a pure
        // spectator has no team: the neutral, quieter hand end (as the web)
        if s.table.viewer.holdsSeat, let me = s.table.viewer.position {
            let team = Positions.getTeamNumber(me)
            let total = BidTotals.totals(bids, handSize: s.table.deal?.handSize)[team: team]
            let won = (team == 1 ? p.team1Tricks : p.team2Tricks) ?? s.scores.tricks[team: team]
            fx.append(.sound(won >= total ? .made : .set))
        } else {
            fx.append(.sound(.handEnd))
        }

        let players = s.players
        // teams by their players: a lazy or resigned seat's owner (PlayersSlice.teamName)
        let name = { (pos: Int) in players.teamName(pos) }
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
        // each team by name, mine first as "me/partner" then "opp1/opp2" (opp1 the next seat
        // clockwise; a spectator's seats 1/3 then 2/4), as logBiddingComplete and the web
        let me = s.table.viewer.role == .spectator ? 1 : (Position.valid(s.table.viewer.position) ?? 1)
        let r = Positions.getRelativePositions(myPos: me)
        let line = { (a: Int, b2: Int) -> String in
            let team1 = Positions.getTeamNumber(a) == 1
            let (won, now, was, note) = team1 ? (t1Tricks, t1, old1, a1) : (t2Tricks, t2, old2, a2)
            return "\(name(a))/\(name(b2)): Bid \(b(a))/\(b(b2)), Won \(won), \(change(now - was)) → \(now)\(note)"
        }
        addLog(&s, "--- HAND COMPLETE ---")
        addLog(&s, line(me, r.partner))
        addLog(&s, line(r.opp1, r.opp2))
    }
}

// MARK: - Bid clock (contract/README.md "Bid clock"; docs/ios-table-store.md "Bid clock")

extension TableReducer {
    /// The timeout's notice to the bidder (`TableEffect.notice`, the web's toast words).
    static let bidTimeoutNotice = "Time ran out: you bid 0"

    /// seatLeft (unsequenced, additive 2026-11-19): that seat's owner left the game for good
    /// (/leave from the seat or from watching its bot): presence gone, so the voice rule no
    /// longer counts them (VoiceCompany). The bot keeps the seat; nothing on screen changes (the
    /// playerLazyMode before it already drew the bot). Another game's, another owner's or an
    /// unknown seat's is ignored.
    static func seatLeft(_ s: inout TableState, _ p: WirePayload.SeatLeft) {
        if let gid = p.gameId, let mine = s.table.gameId, gid != mine { return }
        guard let pos = Position.valid(p.position), var seat = s.players.seats[pos] else { return }
        if let name = p.username, let owner = seat.ownerUsername, owner != name { return }
        seat.presence = .gone
        s.players.seats[pos] = seat
    }

    /// bidClock (unsequenced): `running` sets the clock and starts or restates the tune;
    /// `stopped` clears it (the timeout lets the tune's end cue ring). Another game's event, an
    /// invalid position or a running one with no usable times is dropped.
    static func bidClockEvent(_ s: inout TableState, _ p: WirePayload.BidClock, _ fx: inout [TableEffect]) {
        guard let gid = p.gameId, gid == s.table.gameId, let pos = Position.valid(p.position) else { return }
        if p.running {
            // only while bidding: a running clock never outlives its deal (the pre-wait keeps a
            // gap's replay from clearing a fresh one: critic C8; a lagging table gets it from its
            // resync's snapshot)
            guard let inMs = p.inMs, inMs >= 0, let dur = p.durationMs, dur >= 1, s.table.phase.isBidding else { return }
            s.table.bidClock = BidClockState(position: pos, inMs: inMs, durationMs: dur)
            s.table.bidTuneLive = true
            fx.append(.bidClock(.sync))
            return
        }
        let timeout = p.reason == .timeout
        if s.table.bidClock?.position == pos { stopBidClock(&s, timeout ? .ring : .fade, &fx) }
        // the bidder learns why the panel closed (the others read the log's "ran out of time")
        if timeout, s.table.viewer.role == .seat, s.table.viewer.position == pos { fx.append(.infoNotice(bidTimeoutNotice)) }
    }

    /// The clock is over. `.fade` / `.ring` only for a clock that runs (a ringing tail is the
    /// tune's business: BidClockTune keeps it); `.hard` also when only a tail may still ring.
    static func stopBidClock(_ s: inout TableState, _ kind: BidTuneStop, _ fx: inout [TableEffect]) {
        if kind == .hard {
            let live = s.table.bidClock != nil || s.table.bidTuneLive
            s.table.bidClock = nil
            s.table.bidTuneLive = false
            if live { fx.append(.bidClock(.stop(.hard))) }
            return
        }
        guard s.table.bidClock != nil else { return }
        s.table.bidClock = nil
        fx.append(.bidClock(.stop(kind)))
    }
}

extension TableReducer {
    /// The game end's sound (owner 2026-11-22), by my team's final score against the other's: the
    /// fanfare above it, the sad trombone below it, the soft arpeggio for a tie or no team (a pure
    /// spectator; a lazy owner watching keeps its seat's team, as for made / set). The scores are
    /// the payload's (GameEndData), else the table's last.
    static func gameEndSound(_ s: TableState, _ data: GameEndData?) -> SoundKind {
        guard s.table.viewer.holdsSeat, let me = s.table.viewer.position else { return .gameEnd }
        if s.table.isGyb, let end = data?.gyb {
            // the fanfare for the sole winner, the trombone for everyone else, a shared win the arpeggio
            switch GybRules.outcome(end, me: me) {
            case .victory: return .gameWon
            case .defeat: return .gameLost
            case .tie, .neutral: return .gameEnd
            }
        }
        let t1 = data?.team1Score ?? s.scores.score.team1
        let t2 = data?.team2Score ?? s.scores.score.team2
        let (mine, theirs) = Positions.getTeamNumber(me) == 1 ? (t1, t2) : (t2, t1)
        if mine == theirs { return .gameEnd }
        return mine > theirs ? .gameWon : .gameLost
    }
}

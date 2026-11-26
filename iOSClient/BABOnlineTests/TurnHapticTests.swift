import XCTest
@testable import BAB_Online

/// The haptic on my turn (player request, owner 2026-11-26): the reducer's `.haptic(.myTurn)` on
/// the live edge into my choice, TurnHaptic's once per turn, the setting and the app state.
@MainActor
final class TurnHapticTests: XCTestCase {
    private func turnCues(_ fx: [TableEffect]) -> [TurnCue] {
        fx.compactMap { if case .haptic(.myTurn(let c)) = $0 { return c } else { return nil } }
    }

    /// Me at seat 1 with three bots, dealt one card (my bid turn opens with the updateTurn).
    private func seated(_ s: inout TableState, me: String = "me", seat sockets: [String] = ["sid-me", "bot:l", "sid-p", "bot:r"]) {
        TableReducer.reduce(&s, .local(.identity(username: me, playerId: "sid-me")))
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        TableReducer.reduce(&s, T.ev("positionUpdate", [
            "positions": [1, 2, 3, 4], "sockets": sockets,
            "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]], "pics": [1, 2, 3, 4], "seq": 1,
        ]))
        TableReducer.reduce(&s, T.ev("gameStart", [
            "gameId": "g1", "hand": [T.card("spades", "A")], "trump": T.card("diamonds", "5"), "score1": 0, "score2": 0,
            "dealer": 4, "position": 1, "currentHand": 1, "seq": 2,
        ]))
    }

    // MARK: - Reducer

    func testMyBidAndPlayTurnsEachOpenOnce() {
        var s = TableState()
        seated(&s)
        let bid = TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 3]))
        XCTAssertEqual(turnCues(bid), [TurnCue(gameId: "g1", dealSeq: s.table.deal?.dealSeq ?? -1, action: .bid, trick: 0)])
        // a later event while my choice stays open is not a new turn
        XCTAssertEqual(turnCues(TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 4]))), [])
        TableReducer.reduce(&s, .local(.submitBid("1", reqId: 1)))
        TableReducer.reduce(&s, T.ev("bidReceived", ["position": 1, "bid": "1", "seq": 5]))
        XCTAssertEqual(turnCues(TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 2, "seq": 6]))), [])
        var seq = 7
        for (pos, rank) in [(2, "2"), (3, "3")] {
            XCTAssertEqual(turnCues(TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("spades", rank), "position": pos, "seq": seq]))), [])
            seq += 1
        }
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("spades", "4"), "position": 4, "seq": seq])); seq += 1
        let play = TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": seq]))
        XCTAssertEqual(turnCues(play).map(\.action), [.play])
        XCTAssertEqual(turnCues(play).first?.trick, s.table.trickNo)
        XCTAssertTrue(play.contains(.sound(.turn)), "the same edge as the turn sound")
    }

    /// A snapshot (rejoin, restore, resync) that lands on my open turn is not news.
    func testASnapshotOfAnOpenTurnIsSilent() throws {
        let snap = try T.snapshot("trick-mid-lead3")
        var s = TableState()
        let fx = TableReducer.reduce(&s, .snapshot(snap, .rejoin, hints: nil))
        XCTAssertEqual(s.myTurn, .choosing(.play))
        XCTAssertEqual(turnCues(fx), [])
        // the same again as a requested resync: still nothing
        let again = TableReducer.reduce(&s, .snapshot(try T.snapshot("trick-mid-lead3") { $0["seq"] = snap.seq + 1 }, .requested("r1"), hints: nil))
        XCTAssertEqual(turnCues(again), [])
    }

    /// Buffered events replayed above a snapshot (catch-up) never tap.
    func testCatchUpDropsTheTurnHaptic() {
        var s = TableState()
        var fx: [TableEffect] = []
        let cue = TurnCue(gameId: "g1", dealSeq: 1, action: .bid, trick: 0)
        TableReducer.catchUp(&s, &fx) { _, inner in inner.append(.haptic(.myTurn(cue))); inner.append(.haptic(.error)) }
        XCTAssertEqual(fx, [.haptic(.error)])
    }

    func testALazySeatGetsNoHaptic() {
        var s = TableState()
        seated(&s)
        TableReducer.reduce(&s, T.ev("playerLazyMode", ["position": 1, "botUsername": "Bot", "originalUsername": "me", "seq": 3]))
        XCTAssertEqual(s.table.viewer.role, .lazyWatcher)
        XCTAssertEqual(turnCues(TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 4]))), [])
    }

    func testASpectatorGetsNoHaptic() throws {
        var s = TableState()
        TableReducer.reduce(&s, .snapshot(try T.snapshot("spectator-mid-hand"), .spectate, hints: nil))
        XCTAssertEqual(s.table.viewer.role, .spectator)
        var seq = (s.sync.lastSeq ?? 0) + 1
        for pos in 1...4 {
            XCTAssertEqual(turnCues(TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": pos, "seq": seq]))), [], "seat \(pos)")
            seq += 1
        }
    }

    /// Every recorded game (Get Your Bid's included), every viewer: a haptic only on a live
    /// event that opened my choice, never on a snapshot carrier, once per turn, and exactly as
    /// often as the turn sound.
    func testRecordedGamesTapOncePerTurnOpened() throws {
        var total = 0
        var gyb = 0
        for game in try RecordedGame.all() + [RecordedGame("events-gyb-s19")] {
            for viewer in game.viewers {
                let h = ReplayHarness(viewer: viewer)
                var seen = Set<TurnCue>()
                var sounds = 0, taps = 0
                for e in game.logs[viewer.label]! where !GetYourBidTests.offTable.contains(e.event) {
                    let before = h.effects.count
                    try h.apply(e)
                    let fx = Array(h.effects[before...])
                    let cues = turnCues(fx)
                    let ctx = "\(game.name) \(viewer.label) #\(e.i) \(e.event)"
                    if ["rejoinSuccess", "restorePlayerState", "spectatorState", "stateSnapshot", "actionRejected"].contains(e.event) {
                        XCTAssertEqual(cues, [], ctx)
                    }
                    for c in cues {
                        XCTAssertTrue(h.store.myTurn.isChoosing, ctx)
                        XCTAssertEqual(h.store.state.table.viewer.role, .seat, ctx)
                        XCTAssertTrue(seen.insert(c).inserted, "a second tap for one turn: \(ctx)")
                    }
                    taps += cues.count
                    sounds += fx.filter { $0 == .sound(.turn) }.count
                }
                XCTAssertEqual(taps, sounds, "\(game.name) \(viewer.label)")
                total += taps
                if game.name.contains("gyb") { gyb += taps }
            }
        }
        XCTAssertGreaterThan(total, 20, "the recordings open many of my turns")
        XCTAssertGreaterThan(gyb, 0, "Get Your Bid turns count")
    }

    // MARK: - TurnHaptic

    @MainActor
    private final class Rig {
        let clock = ManualClock()
        var enabled = true
        var active = true
        var open: Set<TurnCue> = []
        var played: [TurnCue] = []
        lazy var haptic = TurnHaptic(clock: clock, isEnabled: { [unowned self] in self.enabled },
                                     isAppActive: { [unowned self] in self.active },
                                     isStillOpen: { [unowned self] in self.open.contains($0) },
                                     play: { [unowned self] in self.played.append($0) })
    }

    private let bid = TurnCue(gameId: "g1", dealSeq: 1, action: .bid, trick: 0)
    private let play1 = TurnCue(gameId: "g1", dealSeq: 1, action: .play, trick: 1)
    private let play2 = TurnCue(gameId: "g1", dealSeq: 1, action: .play, trick: 2)

    func testOneTapPerTurnAfterTheShortDelay() {
        let r = Rig()
        r.open = [bid, play1, play2]
        r.haptic.turnOpened(bid)
        r.clock.advance(TurnHaptic.delay - 0.01)
        XCTAssertEqual(r.played, [], "after the trick collect's own haptic")
        r.clock.advance(0.01)
        XCTAssertEqual(r.played, [bid])
        // the same turn again (a re-render, a repeated edge): nothing more
        r.haptic.turnOpened(bid)
        r.clock.advance(1)
        XCTAssertEqual(r.played, [bid])
        r.haptic.turnOpened(play1)
        r.clock.advance(1)
        r.haptic.turnOpened(play2)
        r.clock.advance(1)
        XCTAssertEqual(r.played, [bid, play1, play2])
    }

    func testNoTapWithTheSettingOff() {
        let r = Rig()
        r.open = [bid]
        r.enabled = false
        r.haptic.turnOpened(bid)
        r.clock.advance(1)
        XCTAssertEqual(r.played, [])
    }

    /// A turn that opened in the background (or under Control Center) never taps, not at the
    /// foreground either.
    func testNoTapUnlessTheAppIsActive() {
        let r = Rig()
        r.open = [bid]
        r.active = false
        r.haptic.turnOpened(bid)
        r.clock.advance(1)
        r.active = true
        r.clock.advance(5)
        XCTAssertEqual(r.played, [])
    }

    func testNoTapForATurnAlreadyGone() {
        let r = Rig()
        r.open = [bid]
        r.haptic.turnOpened(bid)
        r.open = []  // bid within the delay
        r.clock.advance(1)
        XCTAssertEqual(r.played, [])
    }

    // MARK: - Settings

    func testTheSettingDefaultsOnAndPersists() throws {
        let suite = "TurnHapticTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertTrue(HapticSettings(defaults: defaults).vibratesOnTurn, "default on")
        HapticSettings(defaults: defaults).vibratesOnTurn = false
        XCTAssertEqual(defaults.object(forKey: HapticSettings.turnKey) as? Bool, false)
        XCTAssertFalse(HapticSettings(defaults: defaults).vibratesOnTurn)
    }

    /// The switch is offered on a phone only: an iPad has no haptic engine (review of PR #430).
    func testTheSwitchIsOfferedOnAPhoneOnly() {
        XCTAssertTrue(HapticSettings.isOffered(on: .phone))
        XCTAssertFalse(HapticSettings.isOffered(on: .pad))
        XCTAssertFalse(HapticSettings.isOffered(on: .mac))
    }

    // MARK: - Through ActionCoordinator

    func testTheCoordinatorTapsOnceForMyTurnAndNotForASnapshot() throws {
        let store = GameState()
        let hapticClock = ManualClock()
        var played: [HapticKind] = []
        var vibrate = true
        let actions = ActionCoordinator(store: store, emitter: FakeEmitter(), clock: ManualClock(), sounds: NoSounds(),
                                        soundClock: ManualClock(), hapticClock: hapticClock,
                                        haptics: { played.append($0) }, vibratesOnTurn: { vibrate }, isAppActive: { true })
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        store.apply(T.ev("positionUpdate", [
            "positions": [1, 2, 3, 4], "sockets": ["sid-me", "bot:l", "sid-p", "bot:r"],
            "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]], "pics": [1, 2, 3, 4], "seq": 1,
        ]))
        store.apply(T.ev("gameStart", ["gameId": "g1", "hand": [T.card("spades", "A")], "trump": T.card("diamonds", "5"),
                                       "score1": 0, "score2": 0, "dealer": 4, "position": 1, "currentHand": 1, "seq": 2]))
        store.apply(T.ev("updateTurn", ["currentTurn": 1, "seq": 3]))
        hapticClock.advance(1)
        XCTAssertEqual(played.count, 1)
        if case .myTurn(let c) = played.first { XCTAssertEqual(c.action, .bid) } else { XCTFail("\(played)") }
        // the setting off: the next turn is silent
        vibrate = false
        XCTAssertTrue(actions.bid("1"))
        store.apply(T.ev("bidReceived", ["position": 1, "bid": "1", "seq": 4]))
        store.apply(T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 1, "seq": 5]))
        store.apply(T.ev("updateTurn", ["currentTurn": 1, "seq": 6]))
        hapticClock.advance(1)
        XCTAssertEqual(played.filter { if case .myTurn = $0 { return true } else { return false } }.count, 1)
        withExtendedLifetime(actions) {}
    }
}

/// A sound player that plays nothing (the coordinator tests above listen for haptics only).
@MainActor
private final class NoSounds: SoundPlaying {
    func play(_ kind: SoundKind) {}
}

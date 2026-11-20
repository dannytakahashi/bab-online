import XCTest
@testable import BAB_Online

/// The web's PR #345 on iOS: my HSI reads "HSI --" from a live deal until HSIScale.revealDelay
/// later (a redeal drops the stale reveal; a snapshot or a catch-up shows it at once), the value
/// reads red (weak) through yellow to green (strong) on the web's hue scale, and a rainbow adds
/// the server's "<name> has a rainbow!" row live.
@MainActor
final class HSIRevealTests: XCTestCase {
    // MARK: - Colour

    private func hex(_ c: ThemeColor) -> UInt32 {
        func b(_ v: Double) -> UInt32 { UInt32((v * 255).rounded()) }
        return b(c.red) << 16 | b(c.green) << 8 | b(c.blue)
    }

    /// The web's formula: hue = 120 * clamp((hsi - 70) / 125, 0, 1).
    func testTheHueIsTheWebs() {
        XCTAssertEqual(HSIScale.hue(70), 0)
        XCTAssertEqual(HSIScale.hue(0), 0, "clamped: full red under 70")
        XCTAssertEqual(HSIScale.hue(132.5), 60, "yellow at the midpoint")
        XCTAssertEqual(HSIScale.hue(195), 120)
        XCTAssertEqual(HSIScale.hue(400), 120, "clamped: full green over 195")
        XCTAssertEqual(HSIScale.hue(100), 120 * 30 / 125, accuracy: 1e-9)
        XCTAssertEqual(HSIScale.hue(.nan), 0)
    }

    /// hsl(hue, 75%, 55%) as a browser paints it: red #e23636, yellow #e2e236, green #36e236.
    func testTheWebColourAtTheEndsAndTheMidpoint() {
        XCTAssertEqual(hex(HSIScale.webColor(70)), 0xe23636)
        XCTAssertEqual(hex(HSIScale.webColor(132.5)), 0xe2e236)
        XCTAssertEqual(hex(HSIScale.webColor(195)), 0x36e236)
        // the CSS hsl() conversion itself, at hues the scale passes through
        XCTAssertEqual(hex(HSIScale.hsl(30, 0.75, 0.55)), 0xe28c36)
        XCTAssertEqual(hex(HSIScale.hsl(90, 0.75, 0.55)), 0x8ce236)
        XCTAssertEqual(hex(HSIScale.hsl(0, 0, 0.5)), 0x808080)
    }

    /// The badge's colour is the web's wherever that reads 4.5:1 on the pill and the panel: the
    /// midpoint, the green end and everything from ~91 up.
    func testTheBadgeColourIsTheWebsFromTheMiddleUp() {
        XCTAssertEqual(hex(HSIScale.color(132.5)), 0xe2e236)
        XCTAssertEqual(hex(HSIScale.color(195)), 0x36e236)
        for hsi in stride(from: 91.0, through: 300, by: 0.5) {
            XCTAssertEqual(hex(HSIScale.color(hsi)), hex(HSIScale.webColor(hsi)), "\(hsi)")
        }
    }

    /// The web's red end is 3.3:1 on the HSI box; here it is lifted (same hue, lighter) to the
    /// 4.5:1 every text pair keeps, and no lighter than that needs.
    func testTheRedEndIsLiftedJustEnoughForAA() {
        let web = HSIScale.webColor(70), lifted = HSIScale.color(70)
        XCTAssertLessThan(HSIScale.backings.map { HSIScale.contrast(web, $0) }.min()!, 4.5, "the web's red is under AA here")
        XCTAssertNotEqual(hex(lifted), hex(web))
        XCTAssertGreaterThan(lifted.red, lifted.green, "still red")
        XCTAssertEqual(lifted.green, lifted.blue, accuracy: 1e-9, "hue 0")
        XCTAssertGreaterThan(lifted.green, web.green, "lighter")
        let darker = HSIScale.hsl(0, HSIScale.saturation, 0.66 - 0.005)
        XCTAssertLessThan(HSIScale.backings.map { HSIScale.contrast(darker, $0) }.min()!, 4.5, "one step darker would not pass")
        XCTAssertEqual(hex(HSIScale.color(0)), hex(lifted), "clamped")
    }

    func testEveryValueIsLegibleOnThePillAndThePanel() {
        XCTAssertEqual(HSIScale.backings.count, 4)
        for hsi in stride(from: 0.0, through: 400, by: 0.25) {
            let c = HSIScale.color(hsi)
            for (i, bg) in HSIScale.backings.enumerated() {
                XCTAssertGreaterThanOrEqual(HSIScale.contrast(c, bg), 4.5, "\(hsi) on backing \(i)")
            }
        }
    }

    /// The pill's backing is the one Theme.contrastPairs checks for the HSI box (surface.s2 @ 0.86
    /// over felt.light), and the math agrees with ThemeTests' (text.secondary there is >= 4.5).
    func testTheBackingsAreThePillsAndThePanels() {
        let pill = HSIScale.over(Theme.Palette.Surface.s2.opacity(0.86), Theme.Palette.Felt.light)
        XCTAssertTrue(HSIScale.backings.contains(pill))
        XCTAssertTrue(Theme.contrastPairs.contains { $0.fg == "text.secondary" && $0.bg == ["surface.s2@0.86", "felt.light"] })
        XCTAssertGreaterThanOrEqual(HSIScale.contrast(Theme.Palette.Text.secondary, pill), 4.5)
        XCTAssertEqual(HSIScale.contrast(ThemeColor(0xffffff), ThemeColor(0x000000)), 21, accuracy: 0.01)
    }

    func testThePendingBadge() {
        XCTAssertEqual(HSIBadge.text(.pending), "HSI --")
        XCTAssertEqual(HSIBadge.spoken(.pending), "Hand strength index pending")
        XCTAssertEqual(HSIBadge.text(.value(119.16666)), "HSI 119.2")
        XCTAssertEqual(HSIBadge.spoken(.value(119.16666)), "Hand strength index 119.2")
        XCTAssertEqual(HSIBadge.color(.pending), Theme.Palette.Text.secondary, "the web's text-secondary with no --hsi-color")
        XCTAssertEqual(HSIBadge.color(.value(195)), HSIScale.color(195))
        // as wide as a three-digit value (monospaced), so nothing moves when it comes
        XCTAssertEqual(HSIBadge.pendingWidthTemplate.count, HSIBadge.text(119.2).count)
    }

    // MARK: - Reveal (reducer)

    private func gameStart(seq: Int, hsi: [String: Double] = ["1": 150.5, "2": 90, "3": 120, "4": 80], gameId: String = "g1") -> TableEvent {
        T.ev("gameStart", ["gameId": gameId, "hand": [T.card("spades", "A")], "trump": T.card("clubs", "5"), "score1": 0, "score2": 0,
                           "dealer": 4, "position": 1, "currentHand": 1, "hsiValues": hsi, "seq": seq])
    }

    private func reveals(_ fx: [TableEffect]) -> [Int] {
        fx.compactMap { if case .revealHSI(let seq) = $0 { return seq } else { return nil } }
    }

    func testALiveDealHoldsItsHSIUntilItsReveal() {
        var s = T.dealtState()
        let fx = TableReducer.reduce(&s, gameStart(seq: 3))
        let deal = s.table.deal!.dealSeq
        XCTAssertTrue(s.table.hsiHeld)
        XCTAssertEqual(s.table.hsi[1], 150.5, "the value is kept, only not shown")
        XCTAssertEqual(reveals(fx), [deal])
        TableReducer.reduce(&s, .local(.hsiRevealed(dealSeq: deal)))
        XCTAssertFalse(s.table.hsiHeld)
    }

    /// An all-zero redeal: the first deal's reveal (still on its way) changes nothing.
    func testARedealDropsTheStaleReveal() {
        var s = T.dealtState()
        TableReducer.reduce(&s, gameStart(seq: 3))
        let first = s.table.deal!.dealSeq
        TableReducer.reduce(&s, T.ev("destroyHands", ["seq": 4]))
        let fx = TableReducer.reduce(&s, gameStart(seq: 5, hsi: ["1": 70]))
        let second = s.table.deal!.dealSeq
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(reveals(fx), [second])
        TableReducer.reduce(&s, .local(.hsiRevealed(dealSeq: first)))
        XCTAssertTrue(s.table.hsiHeld, "the first deal's reveal is stale")
        TableReducer.reduce(&s, .local(.hsiRevealed(dealSeq: second)))
        XCTAssertFalse(s.table.hsiHeld)
        XCTAssertEqual(s.table.hsi[1], 70)
    }

    /// A reload or relaunch (the snapshot) shows it at once, mid-hold included.
    func testASnapshotShowsItAtOnce() throws {
        for name in ["bidding-mid", "trick-mid-lead3"] {
            var s = T.dealtState()
            XCTAssertTrue(s.table.hsiHeld)
            let fx = TableReducer.reduce(&s, .snapshot(try T.snapshot(name), .rejoin, hints: nil))
            XCTAssertFalse(s.table.hsiHeld, name)
            XCTAssertTrue(reveals(fx).isEmpty, name)
        }
    }

    /// A deal replayed by a catch-up (after a snapshot, or a lapsed resync's flush) shows it at
    /// once too: no fly-in, so no wait.
    func testACatchUpDealShowsItAtOnce() throws {
        let snap = try T.snapshot("trick-mid-lead3")
        var s = TableState()
        TableReducer.reduce(&s, .snapshot(snap, .rejoin, hints: nil))
        TableReducer.reduce(&s, gameStart(seq: snap.seq + 2, gameId: snap.gameId))
        XCTAssertEqual(s.sync.buffered.count, 1)
        let resync = try T.snapshot("trick-mid-lead3") { $0["seq"] = snap.seq + 1 }
        let fx = TableReducer.reduce(&s, .snapshot(resync, .requested(s.sync.resyncId ?? ""), hints: nil))
        XCTAssertEqual(s.table.hand.count, 1, "the buffered deal applied")
        XCTAssertFalse(s.table.hsiHeld)
        XCTAssertTrue(reveals(fx).isEmpty)

        var f = T.dealtState()
        TableReducer.reduce(&f, gameStart(seq: 4))
        XCTAssertEqual(f.sync.buffered.count, 1)
        XCTAssertTrue(f.table.hsiHeld, "still the live deal's hold")
        let flushed = TableReducer.reduce(&f, .local(.snapshotUnavailable(requestId: f.sync.resyncId)))
        XCTAssertEqual(f.table.hsi[1], 150.5)
        XCTAssertFalse(f.table.hsiHeld)
        XCTAssertTrue(reveals(flushed).isEmpty)
    }

    // MARK: - Reveal (store and coordinator)

    private func seated() -> (GameState, ActionCoordinator, ManualClock) {
        let store = GameState()
        let clock = ManualClock()
        let actions = ActionCoordinator(store: store, emitter: FakeEmitter(), clock: ManualClock(), sounds: RecordingSounds(),
                                        soundClock: ManualClock(), tunePlayer: FakeTunePlayer(SoundClock()), askClock: ManualClock(),
                                        hsiClock: clock)
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        store.apply(T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["sid-me", "bot:l", "sid-p", "bot:r"],
                                            "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]],
                                            "pics": [1, 2, 3, 4], "seq": 1]))
        return (store, actions, clock)
    }

    /// "HSI --" for revealDelay (1 s, the web's) after the deal, then the value.
    func testTheCoordinatorRevealsItOneSecondAfterTheDeal() {
        let (store, actions, clock) = seated()
        XCTAssertNil(store.myHSIReading, "no deal yet")
        store.apply(gameStart(seq: 2))
        XCTAssertEqual(HSIScale.revealDelay, 1.0)
        XCTAssertEqual(store.myHSIReading, .pending)
        XCTAssertEqual(store.myHSI, 150.5)
        clock.advance(HSIScale.revealDelay - 0.01)
        XCTAssertEqual(store.myHSIReading, .pending)
        clock.advance(0.01)
        XCTAssertEqual(store.myHSIReading, .value(150.5))
        XCTAssertEqual(clock.pending, 0)
        _ = actions
    }

    /// A redeal half way through the wait: the new deal waits its own full second.
    func testARedealRestartsTheWait() {
        let (store, actions, clock) = seated()
        store.apply(gameStart(seq: 2))
        clock.advance(0.5)
        store.apply(T.ev("destroyHands", ["seq": 3]))
        store.apply(gameStart(seq: 4, hsi: ["1": 88.25]))
        XCTAssertEqual(clock.pending, 1, "the first deal's reveal is cancelled")
        clock.advance(0.6)
        XCTAssertEqual(store.myHSIReading, .pending, "1.1 s after the first deal, 0.6 s after the redeal")
        clock.advance(0.4)
        XCTAssertEqual(store.myHSIReading, .value(88.25))
        _ = actions
    }

    func testNoReadingForASpectatorOrWithoutAValue() throws {
        let spectator = GameState()
        spectator.apply(.snapshot(try T.snapshot("spectator-mid-hand"), .rejoin, hints: nil))
        XCTAssertNil(spectator.myHSIReading)
        let noValues = GameState()
        noValues.apply(.snapshot(try T.snapshot("bidding-mid") { $0["hsi"] = NSNull() }, .rejoin, hints: nil))
        XCTAssertNil(noValues.myHSIReading)
        let rejoined = GameState()
        rejoined.apply(.snapshot(try T.snapshot("bidding-mid"), .rejoin, hints: nil))
        XCTAssertEqual(rejoined.myHSIReading, rejoined.myHSI.map { .value($0) })
        XCTAssertNotNil(rejoined.myHSIReading)
    }

    // MARK: - Rainbow row

    /// The server stores "<name> has a rainbow!" (type rainbow, the seat) and never sends it;
    /// the web adds it on the rainbow event, as this does: the row a rejoin's log replays.
    func testARainbowAddsItsLogRow() {
        var s = T.dealtState()
        let before = s.log.entries.count
        TableReducer.reduce(&s, T.ev("rainbow", ["position": 3, "seq": 3]))
        XCTAssertEqual(s.log.entries.count, before + 1)
        let row = s.log.entries.last!
        XCTAssertEqual(row.message, "P has a rainbow!")
        XCTAssertEqual(row.type, .system)
        XCTAssertEqual(row.position, 3)
        XCTAssertEqual(s.scores.rainbows, TeamPair(team1: 1, team2: 0))
        XCTAssertEqual(TableReducer.rainbowLine("ann"), "ann has a rainbow!")
    }
}

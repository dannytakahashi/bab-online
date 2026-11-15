import AVFoundation
import XCTest
@testable import BAB_Online

/// Table sounds (owner 2026-11-15): the reducer emits `.sound` for live delta events only,
/// SoundPlayer decides whether it plays (mute, volume, app active, throttle) and keeps the
/// audio session ambient unless voice chat owns it.
@MainActor
final class SoundEffectsTests: XCTestCase {
    private func sounds(_ fx: [TableEffect]) -> [SoundKind] {
        fx.compactMap { if case .sound(let k) = $0 { return k } else { return nil } }
    }

    // MARK: - Reducer: live events

    func testDealCardsTrickAndHandEnd() {
        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: "me", playerId: "sid-me")))
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        TableReducer.reduce(&s, T.ev("positionUpdate", [
            "positions": [1, 2, 3, 4], "sockets": ["sid-me", "bot:l", "sid-p", "bot:r"],
            "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]], "pics": [1, 2, 3, 4], "seq": 1,
        ]))
        let deal = TableReducer.reduce(&s, T.ev("gameStart", [
            "gameId": "g1", "hand": [T.card("spades", "A")], "trump": T.card("diamonds", "5"), "score1": 0, "score2": 0,
            "dealer": 4, "position": 1, "currentHand": 1, "seq": 2,
        ]))
        XCTAssertEqual(sounds(deal), [.deal])
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 2, "seq": 3]))), [])
        var seq = 4
        for (pos, rank) in [(2, "2"), (3, "3"), (4, "4")] {
            XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("spades", rank), "position": pos, "seq": seq]))), [.card])
            seq += 1
        }
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": seq]))), [.turn]); seq += 1
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("spades", "A"), "position": 1, "seq": seq]))), [.card]); seq += 1
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("trickComplete", ["winner": 1, "seq": seq]))), [.trickOurs]); seq += 1
        // bid 1, won 1: made
        let made = TableReducer.reduce(&s, T.ev("handComplete", ["score": ["team1": 10, "team2": 0], "team1Tricks": 1, "team2Tricks": 0,
                                                                  "team1OldScore": 0, "team2OldScore": 0, "seq": seq]))
        XCTAssertEqual(sounds(made), [.made]); seq += 1
        let end = TableReducer.reduce(&s, T.ev("gameEnd", ["score": ["team1": 10, "team2": 0], "tournamentId": NSNull(), "seq": seq]))
        XCTAssertEqual(sounds(end), [.gameEnd])
    }

    func testTrickOursFollowsMyTeamsParity() {
        for (winner, expected) in [(1, SoundKind.trickOurs), (3, .trickOurs), (2, .trick), (4, .trick)] {
            var s = T.dealtState(hand: [T.card("spades", "A"), T.card("hearts", "2")], size: 2)
            TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 1, "seq": 3]))
            var seq = 4
            for (pos, card) in [(1, T.card("spades", "A")), (2, T.card("spades", "2")), (3, T.card("spades", "3")), (4, T.card("spades", "4"))] {
                TableReducer.reduce(&s, T.ev("cardPlayed", ["card": card, "position": pos, "seq": seq])); seq += 1
            }
            XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("trickComplete", ["winner": winner, "seq": seq]))), [expected], "winner \(winner)")
        }
    }

    func testSetWhenMyTeamFallsShortAndBoresCountTheHand() {
        // bid 2 of a 2-card hand, won 1: set
        var s = T.dealtState(hand: [T.card("spades", "A"), T.card("hearts", "2")], size: 2)
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["2", "0", "0", "0"], "lead": 1, "seq": 3]))
        let set = TableReducer.reduce(&s, T.ev("handComplete", ["score": ["team1": -20, "team2": 1], "team1Tricks": 1, "team2Tricks": 1,
                                                                 "team1OldScore": 0, "team2OldScore": 0, "seq": 4]))
        XCTAssertEqual(sounds(set), [.set])
        // a bore by my partner: the whole hand, 1 of 2 won is a set even with a rainbow on the score
        var b = T.dealtState(hand: [T.card("spades", "A"), T.card("hearts", "2")], size: 2)
        TableReducer.reduce(&b, T.ev("doneBidding", ["bids": ["0", "0", "B", "0"], "lead": 1, "seq": 3]))
        XCTAssertEqual(sounds(TableReducer.reduce(&b, T.ev("handComplete", ["score": ["team1": 0, "team2": 1], "team1Tricks": 1, "team2Tricks": 1,
                                                                             "team1OldScore": 0, "team2OldScore": 0, "seq": 4]))), [.set])
        // the other team set, mine bid 0 and made it
        var o = T.dealtState(hand: [T.card("spades", "A"), T.card("hearts", "2")], size: 2)
        TableReducer.reduce(&o, T.ev("doneBidding", ["bids": ["0", "2", "0", "0"], "lead": 1, "seq": 3]))
        XCTAssertEqual(sounds(TableReducer.reduce(&o, T.ev("handComplete", ["score": ["team1": 1, "team2": -20], "team1Tricks": 1, "team2Tricks": 1,
                                                                             "team1OldScore": 0, "team2OldScore": 0, "seq": 4]))), [.made])
    }

    func testOverTrumpReplacesTheCardSound() {
        var s = T.dealtState(hand: [T.card("spades", "3"), T.card("hearts", "K")], size: 2, dealer: 4, trump: T.card("spades", "7"))
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 2, "seq": 3]))
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("hearts", "Q"), "position": 2, "seq": 4]))), [.card])
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("spades", "2"), "position": 3, "seq": 5]))), [.card])
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("joker", "LO"), "position": 4, "seq": 6]))), [.overTrump])
        // the same event again: dropped by the seq gate, silent
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("joker", "LO"), "position": 4, "seq": 6]))), [])
    }

    // MARK: - Reducer: the your-turn cue

    func testTurnCueOnlyOnTheEdgeIntoMyChoice() {
        var s = T.dealtState()
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 2, "seq": 3]))), [])
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 4]))), [.turn])
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 5]))), [], "still my turn: no second cue")
        // my bid goes out and lands; then the lead is mine: one cue for the play
        TableReducer.reduce(&s, .local(.submitBid("1", reqId: 1)))
        TableReducer.reduce(&s, T.ev("bidReceived", ["position": 1, "bid": "1", "bidArray": ["1"], "seq": 6]))
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 1, "seq": 7]))), [.turn])
    }

    func testNoTurnCueWhenARefusedOrUnansweredActionHandsTheTurnBack() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 3]))
        TableReducer.reduce(&s, .local(.submitBid("1", reqId: 7)))
        XCTAssertTrue(s.myTurn.isSubmitted)
        // refused without a snapshot: the choice is back, but that is not news
        let rejected = TableReducer.reduce(&s, T.ev("actionRejected", ["action": "bid", "reason": "invalid_bid"]))
        XCTAssertEqual(s.myTurn, .choosing(.bid))
        XCTAssertEqual(sounds(rejected), [])
        // an ack timeout's rollback (a local action) is silent too
        TableReducer.reduce(&s, .local(.submitBid("1", reqId: 8)))
        TableReducer.reduce(&s, .local(.ackTimeout(reqId: 8, attempt: 0)))
        XCTAssertEqual(sounds(TableReducer.reduce(&s, .local(.ackTimeout(reqId: 8, attempt: AckPolicy.maxResyncs)))), [])
        XCTAssertEqual(s.myTurn, .choosing(.bid))
    }

    func testSpectatorHearsTheTableButNoTurnOrTeamSounds() {
        var s = TableState()
        TableReducer.reduce(&s, .local(.identity(username: "watcher", playerId: "sid-w")))
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        TableReducer.reduce(&s, T.ev("positionUpdate", [
            "positions": [1, 2, 3, 4], "sockets": ["sid-a", "bot:l", "sid-p", "bot:r"],
            "usernames": [["username": "A"], ["username": "L"], ["username": "P"], ["username": "R"]], "pics": [1, 2, 3, 4], "seq": 1,
        ]))
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("gameStart", ["gameId": "g1", "trump": T.card("diamonds", "5"), "score1": 0, "score2": 0,
                                                                          "dealer": 4, "currentHand": 1, "seq": 2]))), [.deal])
        XCTAssertEqual(s.table.viewer.role, .spectator)
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 3]))), [])
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 1, "seq": 4]))
        var seq = 5
        for (pos, rank) in [(1, "A"), (2, "2"), (3, "3"), (4, "4")] {
            XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("spades", rank), "position": pos, "seq": seq]))), [.card])
            seq += 1
        }
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("trickComplete", ["winner": 1, "seq": seq]))), [.trick], "seat 1 is not my team"); seq += 1
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("handComplete", ["score": ["team1": 10, "team2": 0], "team1Tricks": 1, "team2Tricks": 0,
                                                                             "team1OldScore": 0, "team2OldScore": 0, "seq": seq]))), [], "no team, no made / set")
        seq += 1
        XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("gameEnd", ["score": ["team1": 10, "team2": 0], "tournamentId": NSNull(), "seq": seq]))), [.gameEnd])
    }

    // MARK: - Reducer: never for snapshots or catch-up

    func testSnapshotsAreSilentEvenOnMyTurn() throws {
        var sawMyTurn = false
        for name in try FixtureLoader.v2Names() {
            let raw = try FixtureLoader.v2Snapshot(name)
            let snap = try TableSnapshot.decode(raw, strict: true)
            for source in [SnapshotSource.rejoin, .restore, .spectate, .rejected, .requested("r")] {
                var s = TableState()
                XCTAssertEqual(sounds(TableReducer.reduce(&s, .snapshot(snap, source, hints: nil))), [], "\(name) \(source)")
                if s.myTurn.isChoosing { sawMyTurn = true }
            }
            var s = TableState()
            XCTAssertEqual(sounds(TableReducer.reduce(&s, T.ev("stateSnapshot", ["snapshot": raw, "requestId": "gap-1"]))), [], name)
            var r = TableState()
            XCTAssertEqual(sounds(TableReducer.reduce(&r, T.ev("rejoinSuccess", ["snapshot": raw]))), [], name)
        }
        XCTAssertTrue(sawMyTurn, "some fixture restores onto my turn (else this test proves nothing about the cue)")
    }

    func testBufferedCatchUpIsSilent() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "0", "0", "0"], "lead": 2, "seq": 3]))
        // seq 4 is lost: 5 and 6 wait for a resync
        var fx = TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("spades", "2"), "position": 2, "seq": 5]))
        fx += TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 6]))
        XCTAssertEqual(sounds(fx), [])
        XCTAssertEqual(s.sync.buffered.count, 2)
        // no snapshot can come: the buffer is applied, without a sound
        let flushed = TableReducer.reduce(&s, .local(.snapshotUnavailable(requestId: s.sync.resyncId)))
        XCTAssertTrue(s.sync.buffered.isEmpty)
        XCTAssertEqual(s.myTurn, .choosing(.play), "the buffered events did apply")
        XCTAssertTrue(flushed.animations.contains { if case .cardPlayed = $0 { return true } else { return false } })
        XCTAssertEqual(sounds(flushed), [])
    }

    func testBufferedEventsReplayedAfterASnapshotAreSilent() throws {
        let raw = try FixtureLoader.v2Snapshot("trick-mid-lead3")
        let snap = try TableSnapshot.decode(raw, strict: true)
        var s = TableState()
        TableReducer.reduce(&s, .snapshot(snap, .rejoin, hints: nil))
        XCTAssertEqual(s.myTurn, .choosing(.play))
        // seq lost before my play and the next one: both wait for the resync's snapshot
        let gapSeq = snap.seq + 2
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("clubs", "Q"), "position": 1, "seq": gapSeq]))
        TableReducer.reduce(&s, T.ev("cardPlayed", ["card": T.card("clubs", "2"), "position": 2, "seq": gapSeq + 1]))
        XCTAssertEqual(s.sync.buffered.count, 2)
        // the resync's snapshot covers the lost seq; the two above it replay
        let resync = try T.snapshot("trick-mid-lead3") { $0["seq"] = snap.seq + 1 }
        let fx = TableReducer.reduce(&s, .snapshot(resync, .requested(s.sync.resyncId ?? ""), hints: nil))
        XCTAssertEqual(s.table.phase.trick.count, 4, "replayed above the snapshot")
        XCTAssertEqual(fx.animations.filter { if case .cardPlayed = $0 { return true } else { return false } }.count, 2)
        XCTAssertEqual(sounds(fx), [])
    }

    // MARK: - Recorded games through the app's handlers

    func testRecordedGamesSoundOnlyForLiveEvents() throws {
        for game in try RecordedGame.all() {
            for viewer in game.viewers {
                let h = ReplayHarness(viewer: viewer)
                var counts: [SoundKind: Int] = [:]
                var live = (cards: 0, tricks: 0, ours: 0, deals: 0, hands: 0, ends: 0)
                for e in game.logs[viewer.label]! {
                    let before = h.effects.count
                    try h.apply(e)
                    let heard = sounds(Array(h.effects[before...]))
                    for k in heard { counts[k, default: 0] += 1 }
                    let ctx = "\(game.name) \(viewer.label) #\(e.i) \(e.event)"
                    if ["rejoinSuccess", "restorePlayerState", "spectatorState", "stateSnapshot", "actionRejected"].contains(e.event) {
                        XCTAssertEqual(heard, [], ctx)
                    }
                    if heard.contains(.turn) { XCTAssertTrue(h.store.myTurn.isChoosing, ctx) }
                    guard e.dir == "s2c" else { continue }
                    let d = e.data as? [String: Any]
                    switch e.event {
                    case "cardPlayed": if heard.contains(.card) || heard.contains(.overTrump) { live.cards += 1 }
                    case "trickComplete":
                        if !heard.isEmpty { live.tricks += 1 }
                        if heard == [.trickOurs], let me = h.store.position, let w = d?["winner"] as? Int {
                            XCTAssertEqual(me % 2, w % 2, ctx)
                            live.ours += 1
                        }
                    case "gameStart": if heard == [.deal] { live.deals += 1 }
                    case "handComplete": if !heard.isEmpty { live.hands += 1 }
                    case "gameEnd": if heard == [.gameEnd] { live.ends += 1 }
                    default: XCTAssertFalse(heard.contains { $0 != .turn }, ctx)
                    }
                }
                let label = "\(game.name) \(viewer.label)"
                XCTAssertEqual((counts[.card] ?? 0) + (counts[.overTrump] ?? 0), live.cards, label)
                XCTAssertEqual((counts[.trick] ?? 0) + (counts[.trickOurs] ?? 0), live.tricks, label)
                XCTAssertEqual(counts[.trickOurs] ?? 0, live.ours, label)
                XCTAssertEqual(counts[.deal] ?? 0, live.deals, label)
                XCTAssertEqual((counts[.made] ?? 0) + (counts[.set] ?? 0), live.hands, label)
                if viewer.role == "spectator" {
                    XCTAssertNil(counts[.turn], label)
                    XCTAssertNil(counts[.trickOurs], label)
                    XCTAssertEqual((counts[.made] ?? 0) + (counts[.set] ?? 0), 0, label)
                }
                // a whole live game at a seat is heard (presence-s21's seats stop after the deal)
                if game.name == "events-humans-s13" && viewer.label == "seat1" {
                    XCTAssertEqual(live.cards, 364)
                    XCTAssertEqual(live.tricks, 91)
                    XCTAssertGreaterThan(counts[.turn] ?? 0, 0)
                    XCTAssertGreaterThan(live.ours, 0)
                    XCTAssertEqual(live.ends, 1)
                }
            }
        }
    }

    // MARK: - ActionCoordinator runs them

    func testActionCoordinatorPlaysTheReducersSounds() {
        let store = GameState()
        let recorder = RecordingSounds()
        let actions = ActionCoordinator(store: store, emitter: FakeEmitter(), clock: ManualClock(), sounds: recorder)
        store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        store.apply(T.ev("positionUpdate", [
            "positions": [1, 2, 3, 4], "sockets": ["sid-me", "bot:l", "sid-p", "bot:r"],
            "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]], "pics": [1, 2, 3, 4], "seq": 1,
        ]))
        store.apply(T.ev("gameStart", ["gameId": "g1", "hand": [T.card("spades", "A")], "trump": T.card("diamonds", "5"),
                                       "score1": 0, "score2": 0, "dealer": 4, "position": 1, "currentHand": 1, "seq": 2]))
        store.apply(T.ev("updateTurn", ["currentTurn": 1, "seq": 3]))
        XCTAssertEqual(recorder.played, [.deal, .turn])
        withExtendedLifetime(actions) {}
    }

    // MARK: - SoundPlayer

    private var suite = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suite = "SoundEffectsTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private func player(active: Bool = true, voice: Bool = false, clock: SoundClock = SoundClock(),
                        session: FakeSession? = nil, output: RecordingOutput? = nil) -> SoundPlayer {
        SoundPlayer(output: output ?? RecordingOutput(), session: session ?? FakeSession(), defaults: defaults,
                    isAppActive: { active }, isVoiceActive: { voice }, now: { clock.t })
    }

    func testOnByDefaultAtAQuietVolume() {
        let out = RecordingOutput()
        let p = player(output: out)
        XCTAssertTrue(p.isEnabled)
        XCTAssertEqual(p.volume, 0.35, accuracy: 0.0001)
        p.play(.deal)
        XCTAssertEqual(out.played.map(\.file), ["deal"])
        XCTAssertEqual(out.played.first?.volume ?? 0, 0.35, accuracy: 0.0001)
    }

    func testMuteAndVolumeArePersistedAndRespected() {
        let out = RecordingOutput()
        let p = player(output: out)
        p.isEnabled = false
        p.volume = 0.6
        XCTAssertNil(p.playIfAllowed(.turn))
        XCTAssertEqual(out.played.count, 0)
        XCTAssertEqual(defaults.object(forKey: SoundPlayer.enabledKey) as? Bool, false)

        let out2 = RecordingOutput()
        let again = player(output: out2)
        XCTAssertFalse(again.isEnabled, "remembered on the device")
        XCTAssertEqual(again.volume, 0.6, accuracy: 0.0001)
        again.play(.turn)
        XCTAssertEqual(out2.played.count, 0)
        again.isEnabled = true
        again.play(.turn)
        XCTAssertEqual(out2.played.map(\.file), ["turn"])
        XCTAssertEqual(out2.played.first?.volume ?? 0, 0.6, accuracy: 0.0001)
        again.volume = 4
        XCTAssertEqual(again.volume, 1, "clamped")
        XCTAssertEqual((defaults.object(forKey: SoundPlayer.volumeKey) as? NSNumber)?.floatValue, 1)
    }

    func testSilentWhileTheAppIsNotActive() {
        let out = RecordingOutput()
        let session = FakeSession()
        let p = player(active: false, session: session, output: out)
        p.play(.card)
        p.play(.gameEnd)
        XCTAssertEqual(out.played.count, 0)
        XCTAssertEqual(session.ambientCalls, 0, "the session is not touched for a sound that does not play")
    }

    func testSameSoundThrottledAndCardTakesRotate() {
        let clock = SoundClock()
        let out = RecordingOutput()
        let p = player(clock: clock, output: out)
        p.play(.card)
        clock.t = 0.05
        p.play(.card)              // within 80 ms: dropped
        p.play(.trick)             // another sound: plays
        clock.t = 0.09
        p.play(.card)
        clock.t = 0.2
        p.play(.card)
        clock.t = 0.3
        p.play(.card)
        XCTAssertEqual(out.played.map(\.file), ["card-1", "trick", "card-2", "card-3", "card-1"])
    }

    func testEveryFileIsInTheBundle() {
        for file in Set(SoundKind.allCases.flatMap(\.files)) {
            XCTAssertNotNil(Bundle.main.url(forResource: file, withExtension: "m4a"), "\(file).m4a (Resources/Sounds)")
        }
    }

    // MARK: - Audio session policy

    func testPolicy() {
        XCTAssertEqual(SoundSessionPolicy.action(voiceActive: true, category: .playAndRecord), .leave)
        XCTAssertEqual(SoundSessionPolicy.action(voiceActive: true, category: .ambient), .leave)
        XCTAssertEqual(SoundSessionPolicy.action(voiceActive: false, category: .soloAmbient), .setAmbient)
        XCTAssertEqual(SoundSessionPolicy.action(voiceActive: false, category: .playAndRecord), .setAmbient)
        XCTAssertEqual(SoundSessionPolicy.action(voiceActive: false, category: .ambient), .leave)
    }

    func testAmbientWithoutVoiceAndUntouchedDuringVoice() {
        let session = FakeSession(category: .soloAmbient)
        let out = RecordingOutput()
        var voice = false
        let clock = SoundClock()
        let p = SoundPlayer(output: out, session: session, defaults: defaults,
                            isAppActive: { true }, isVoiceActive: { voice }, now: { clock.t })
        p.play(.deal)
        XCTAssertEqual(session.ambientCalls, 1)
        XCTAssertEqual(session.category, .ambient)
        clock.t = 1
        p.play(.deal)
        XCTAssertEqual(session.ambientCalls, 1, "already ambient")

        // voice starts: it owns the session (playAndRecord); sounds play through it untouched
        voice = true
        session.category = .playAndRecord
        clock.t = 2
        p.play(.turn)
        XCTAssertEqual(session.ambientCalls, 1)
        XCTAssertEqual(session.category, .playAndRecord)
        XCTAssertEqual(out.played.map(\.file), ["deal", "deal", "turn"])

        // voice stops and leaves playAndRecord behind: the next sound puts ambient back
        voice = false
        clock.t = 3
        p.play(.trick)
        XCTAssertEqual(session.ambientCalls, 2)
        XCTAssertEqual(session.category, .ambient)
    }

    func testAMutedPlayerNeverTouchesTheSession() {
        let session = FakeSession(category: .soloAmbient)
        let p = player(session: session)
        p.isEnabled = false
        for k in SoundKind.allCases { p.play(k) }
        XCTAssertEqual(session.ambientCalls, 0)
    }

    func testAFailedCategoryChangeStillPlays() {
        let session = FakeSession(category: .soloAmbient)
        session.fails = true
        let out = RecordingOutput()
        let p = player(session: session, output: out)
        p.play(.made)
        XCTAssertEqual(out.played.map(\.file), ["made"])
    }
}

// MARK: - Fakes

@MainActor
final class RecordingSounds: SoundPlaying {
    var played: [SoundKind] = []
    func play(_ kind: SoundKind) { played.append(kind) }
}

@MainActor
final class RecordingOutput: SoundOutput {
    var played: [(file: String, volume: Float)] = []
    func play(file: String, volume: Float) { played.append((file, volume)) }
}

@MainActor
final class FakeSession: SoundSession {
    var category: AVAudioSession.Category
    var ambientCalls = 0
    var fails = false
    init(category: AVAudioSession.Category = .soloAmbient) { self.category = category }
    func useAmbient() throws {
        ambientCalls += 1
        if fails { throw NSError(domain: "FakeSession", code: 1) }
        category = .ambient
    }
}

final class SoundClock { var t: TimeInterval = 0 }

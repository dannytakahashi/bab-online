import XCTest
@testable import BAB_Online

/// The tournament lobby's one action slot and its "…" menu (owner 2026-11-26): every phase x
/// host / member / spectator x ready x canBegin.
final class TournamentLobbySlotTests: XCTestCase {
    private func p(_ name: String, ready: Bool, host: Bool = false, connected: Bool = true) -> TournamentPlayer {
        TournamentPlayer(id: "sid-\(name)", username: name, pic: nil, isReady: ready, isCreator: host, connected: connected)
    }

    private func slot(_ phase: String, me: String = "ivy", host: String = "kim", ready: Bool,
                      others: [TournamentPlayer], spectator: Bool = false, deadline: Bool = false) -> TournamentLobbySlot? {
        let mine = p(me, ready: ready, host: me == host)
        let players = spectator ? others : [mine] + others
        return TournamentLobbySlot.of(phase: phase, isCreator: me == host, isSpectator: spectator, isReady: ready,
                                      deadlinePassed: deadline, players: players, me: me, host: host)
    }

    private let allReadyOthers = [TournamentPlayer(id: "a", username: "kim", pic: nil, isReady: true, isCreator: false, connected: true),
                                  TournamentPlayer(id: "b", username: "hal", pic: nil, isReady: true, isCreator: false, connected: true)]

    // MARK: - Member

    func testAMemberReadiesThenWaitsForTheHost() {
        let others = [p("kim", ready: true, host: true), p("hal", ready: false)]
        XCTAssertEqual(slot("lobby", ready: false, others: others), TournamentLobbySlot(primary: .ready))
        XCTAssertEqual(slot("lobby", ready: true, others: others),
                       TournamentLobbySlot(primary: .unready, caption: "Waiting for 1 player to ready up"))
        XCTAssertEqual(slot("lobby", ready: true, others: [p("kim", ready: true, host: true), p("hal", ready: true)]),
                       TournamentLobbySlot(primary: .unready, caption: "Waiting for kim to begin"),
                       "named, never 'the host', when the name is known")
        // a member never gets Begin, even when everyone is ready
        XCTAssertEqual(slot("between_rounds", ready: true, others: [p("kim", ready: true, host: true)])?.primary, .unready)
    }

    func testADisconnectedMemberIsNotWaitedFor() {
        let others = [p("kim", ready: true, host: true), p("ned", ready: false, connected: false), p("hal", ready: false)]
        XCTAssertEqual(slot("between_rounds", ready: true, others: others)?.caption, "Waiting for 1 player to ready up")
    }

    // MARK: - Host

    func testTheHostReadiesThenBegins() {
        let waiting = [p("kim", ready: true), p("hal", ready: false)]
        XCTAssertEqual(slot("lobby", host: "ivy", ready: false, others: waiting), TournamentLobbySlot(primary: .ready))
        // readied, others not: the slot still lets the host take it back, and says what Begin waits for
        XCTAssertEqual(slot("lobby", host: "ivy", ready: true, others: waiting),
                       TournamentLobbySlot(primary: .unready, caption: "Waiting for 1 player to ready up, then you can begin"))
        // everyone ready: Begin, with the host's Unready under it
        XCTAssertEqual(slot("lobby", host: "ivy", ready: true, others: allReadyOthers),
                       TournamentLobbySlot(primary: .begin("Begin Tournament"), toggle: .unready))
        XCTAssertEqual(slot("between_rounds", host: "ivy", ready: true, others: allReadyOthers),
                       TournamentLobbySlot(primary: .begin("Begin Next Round"), toggle: .unready))
    }

    /// In the lobby phase the host must be ready too (the server's allConnectedReady), so a host
    /// who is not ready reads Ready even with everyone else ready.
    func testTheHostMustBeReadyToBeginInTheLobby() {
        XCTAssertEqual(slot("lobby", host: "ivy", ready: false, others: allReadyOthers), TournamentLobbySlot(primary: .ready))
    }

    /// Between rounds past the ready deadline the host may start with the ready players, ready or
    /// not (pressing Begin puts the host in the round): Begin, and no Ready toggle under it, since
    /// the host's flag gates nothing there (review of PR #430: a grey "Ready" under "Start with
    /// ready players" read as "you are ready").
    func testPastTheDeadlineTheHostStartsWithTheReadyPlayers() {
        let some = [p("kim", ready: true), p("hal", ready: false)]
        XCTAssertEqual(slot("between_rounds", host: "ivy", ready: false, others: some, deadline: true),
                       TournamentLobbySlot(primary: .begin("Start with ready players"),
                                           caption: "Players who aren't ready sit this round out."))
        XCTAssertNil(slot("between_rounds", host: "ivy", ready: true, others: some, deadline: true)?.toggle)
        XCTAssertEqual(slot("between_rounds", host: "ivy", ready: true, others: allReadyOthers, deadline: true),
                       TournamentLobbySlot(primary: .begin("Begin Next Round")))
        // the deadline means nothing in the lobby phase
        XCTAssertEqual(slot("lobby", host: "ivy", ready: true, others: some, deadline: true)?.primary, .unready)
    }

    func testTheSlotFollowsTheBeginRuleExactly() {
        // the slot shows Begin exactly where TournamentBegin.canBegin allows it, for every mix
        for phase in ["lobby", "between_rounds"] {
            for deadline in [false, true] {
                for meReady in [false, true] {
                    for mask in 0..<8 {
                        let others = [p("kim", ready: mask & 1 != 0), p("hal", ready: mask & 2 != 0),
                                      p("ned", ready: false, connected: mask & 4 == 0)]
                        let players = [p("ivy", ready: meReady, host: true)] + others
                        let can = TournamentBegin.canBegin(phase: phase, deadlinePassed: deadline, players: players)
                        let s = TournamentLobbySlot.of(phase: phase, isCreator: true, isSpectator: false, isReady: meReady,
                                                       deadlinePassed: deadline, players: players, me: "ivy", host: "ivy")
                        let ctx = "\(phase) deadline=\(deadline) ready=\(meReady) mask=\(mask)"
                        if can {
                            XCTAssertEqual(s?.primary, .begin(TournamentBegin.label(phase: phase, deadlinePassed: deadline, players: players)), ctx)
                            let flagMatters = !(phase == "between_rounds" && deadline)
                            XCTAssertEqual(s?.toggle, flagMatters ? (meReady ? .unready : .ready) : nil, ctx)
                        } else {
                            XCTAssertEqual(s?.primary, meReady ? .unready : .ready, ctx)
                            XCTAssertNil(s?.toggle, ctx)
                        }
                    }
                }
            }
        }
    }

    /// A host hand-off mid-screen: the same state read with the new host gets Begin.
    func testAHostHandOffChangesTheSlotInPlace() {
        let players = [p("ivy", ready: true), p("kim", ready: true), p("hal", ready: true)]
        let before = TournamentLobbySlot.of(phase: "lobby", isCreator: false, isSpectator: false, isReady: true,
                                            deadlinePassed: false, players: players, me: "ivy", host: "kim")
        let after = TournamentLobbySlot.of(phase: "lobby", isCreator: true, isSpectator: false, isReady: true,
                                           deadlinePassed: false, players: players, me: "ivy", host: "ivy")
        XCTAssertEqual(before?.primary, .unready)
        XCTAssertEqual(after?.primary, .begin("Begin Tournament"))
    }

    /// The host's tap flips the local flag at once; the server's row follows with
    /// tournamentReadyUpdate. The slot reads my row with the local flag (review of PR #430), so
    /// Unready under Begin takes Begin away at once and a quick second tap cannot ready again.
    func testMyOwnRowFollowsTheLocalFlagBeforeTheServerAnswers() {
        let serverSaysReady = [p("ivy", ready: true, host: true)] + allReadyOthers
        let afterUnready = TournamentLobbySlot.of(phase: "lobby", isCreator: true, isSpectator: false, isReady: false,
                                                  deadlinePassed: false, players: serverSaysReady, me: "ivy", host: "ivy")
        XCTAssertEqual(afterUnready, TournamentLobbySlot(primary: .ready), "no Begin, no toggle reading Ready")
        let serverSaysNotReady = [p("ivy", ready: false, host: true)] + allReadyOthers
        let afterReady = TournamentLobbySlot.of(phase: "lobby", isCreator: true, isSpectator: false, isReady: true,
                                                deadlinePassed: false, players: serverSaysNotReady, me: "ivy", host: "ivy")
        XCTAssertEqual(afterReady, TournamentLobbySlot(primary: .begin("Begin Tournament"), toggle: .unready))
        // a member's count of who it waits for never includes me either way
        let member = TournamentLobbySlot.of(phase: "lobby", isCreator: false, isSpectator: false, isReady: true,
                                            deadlinePassed: false, players: [p("ivy", ready: false)] + [p("kim", ready: true, host: true)],
                                            me: "ivy", host: "kim")
        XCTAssertEqual(member?.caption, "Waiting for kim to begin")
    }

    func testTheToggleReadsAsAButton() {
        XCTAssertEqual(TournamentLobbySlot.Copy.markReady, "Mark me ready")
        XCTAssertEqual(TournamentLobbySlot.Copy.markNotReady, "Mark me not ready")
    }

    // MARK: - No slot

    func testNoSlotInARoundTheCutTheResultsOrForASpectator() {
        for phase in ["round_active", CutForABuck.phase, "complete", "", "weird"] {
            XCTAssertNil(slot(phase, host: "ivy", ready: true, others: allReadyOthers), phase)
            XCTAssertNil(slot(phase, ready: false, others: allReadyOthers), phase)
        }
        for phase in ["lobby", "between_rounds"] {
            XCTAssertNil(slot(phase, me: "lou", ready: false, others: allReadyOthers, spectator: true), phase)
        }
    }

    // MARK: - The "…" menu

    func testTheMenusItems() {
        typealias M = TournamentLobbyMenu
        for phase in ["lobby", "between_rounds", "round_active"] {
            XCTAssertEqual(M.items(phase: phase, isCreator: true, isSpectator: false), [.leave, .cancel], phase)
            XCTAssertEqual(M.items(phase: phase, isCreator: false, isSpectator: false), [.leave], phase)
            XCTAssertEqual(M.items(phase: phase, isCreator: false, isSpectator: true), [.stopWatching], phase)
        }
        // the cut: no Cancel (as before: it would end the cut early)
        XCTAssertEqual(M.items(phase: CutForABuck.phase, isCreator: true, isSpectator: false), [.leave])
        // the results: no controls at all (the back control reads Main Room)
        XCTAssertEqual(M.items(phase: "complete", isCreator: true, isSpectator: false), [])
        XCTAssertEqual(M.items(phase: "complete", isCreator: false, isSpectator: false), [])
    }

    func testTheConfirmationsSayWhatHappens() {
        typealias M = TournamentLobbyMenu
        func msg(_ item: M.Item, _ phase: String, host: Bool = false, others: Int = 2) -> String {
            M.confirmMessage(item, phase: phase, isCreator: host, othersConnected: others)
        }
        XCTAssertEqual(M.confirmButton(.cancel), "Cancel Tournament")
        XCTAssertEqual(M.confirmButton(.leave), "Leave Tournament")
        XCTAssertEqual(M.confirmButton(.stopWatching), "Stop Watching")
        XCTAssertTrue(msg(.cancel, "lobby", host: true).contains("everyone"))
        XCTAssertTrue(msg(.cancel, "round_active", host: true).contains("games still in play"))
        XCTAssertEqual(msg(.leave, "lobby"), "You can join again while it's waiting to start.")
        XCTAssertEqual(msg(.leave, "lobby", host: true),
                       "You can join again while it's waiting to start. Another player becomes the host.")
        XCTAssertFalse(msg(.leave, "lobby").contains("host"))
        for item in [M.Item.cancel, .leave, .stopWatching] {
            for words in [M.title(item), msg(item, "lobby", host: true)] {
                XCTAssertFalse(words.contains("Team"), words)
            }
        }
    }

    /// Once it has begun a member who leaves is no longer a member (review of PR #430): no score
    /// for the rounds to come (scoreMissedRound covers members only), no way back (joinTournament
    /// refuses after the lobby phase), never a winner (getWinners takes members only). Never the
    /// old "a missed round scores that round's lowest".
    func testLeavingOnceItHasBegunIsForGood() {
        typealias M = TournamentLobbyMenu
        for phase in ["between_rounds", "round_active"] {
            for host in [false, true] {
                let words = M.confirmMessage(.leave, phase: phase, isCreator: host, othersConnected: 2)
                XCTAssertTrue(words.hasPrefix("You can't come back to this tournament, and you won't be among the winners."), words)
                XCTAssertFalse(words.contains("lowest"), words)
                XCTAssertFalse(words.contains("join again"), words)
                XCTAssertEqual(words.contains("Another player becomes the host."), host, words)
            }
        }
    }

    /// The cut: leaving takes me out of it (cutForABuck.memberLeft); no "rounds still to come".
    func testLeavingDuringTheCut() {
        let words = TournamentLobbyMenu.confirmMessage(.leave, phase: CutForABuck.phase, isCreator: false, othersConnected: 3)
        XCTAssertEqual(words, "You'll be out of cut for a buck.", "lowercase mid-sentence (the owner's rule)")
        XCTAssertFalse(words.contains("round"))
    }

    /// A host alone in the lobby: leaving deletes the tournament (GameManager.leaveTournament:
    /// deleteTournamentIfAbandoned before transferCreator), so no rejoin and no new host.
    func testAHostAloneClosesTheTournamentByLeaving() {
        typealias M = TournamentLobbyMenu
        let alone = M.confirmMessage(.leave, phase: "lobby", isCreator: true, othersConnected: 0)
        XCTAssertEqual(alone, "The tournament closes, since nobody else has joined.")
        XCTAssertFalse(alone.contains("join again"))
        XCTAssertFalse(alone.contains("host"))
        // with someone else there the role passes on
        XCTAssertTrue(M.confirmMessage(.leave, phase: "lobby", isCreator: true, othersConnected: 1).contains("Another player becomes the host."))
        // anyone alone in the lobby (a lone member is handed the role): the same
        XCTAssertEqual(M.confirmMessage(.leave, phase: "lobby", isCreator: false, othersConnected: 0), alone)
        // once begun, a host alone has no one to hand the role to
        XCTAssertFalse(M.confirmMessage(.leave, phase: "between_rounds", isCreator: true, othersConnected: 0).contains("host"))
    }

    /// The dropped-choice rule: a confirm opened before a host hand-off, the cut or the results
    /// does nothing once the menu no longer offers that choice.
    func testAConfirmForAChoiceNoLongerOfferedIsDropped() {
        typealias M = TournamentLobbyMenu
        XCTAssertTrue(M.stillOffers(.cancel, phase: "lobby", isCreator: true, isSpectator: false))
        XCTAssertFalse(M.stillOffers(.cancel, phase: "lobby", isCreator: false, isSpectator: false), "the host role passed on")
        XCTAssertFalse(M.stillOffers(.cancel, phase: CutForABuck.phase, isCreator: true, isSpectator: false), "the cut began")
        XCTAssertFalse(M.stillOffers(.leave, phase: "complete", isCreator: false, isSpectator: false), "the results")
        XCTAssertFalse(M.stillOffers(.stopWatching, phase: "between_rounds", isCreator: false, isSpectator: false))
        XCTAssertTrue(M.stillOffers(.leave, phase: "round_active", isCreator: false, isSpectator: false))
    }
}

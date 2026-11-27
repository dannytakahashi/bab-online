import XCTest
@testable import BAB_Online

/// The tournament lobby's one action slot and its Leave / End Tournament / Stop Watching
/// (owner 2026-11-26): every phase x host / member / spectator x ready x canBegin; the entry point
/// each role gets and the confirmation's words.
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
            XCTAssertEqual(M.items(phase: phase, isCreator: true, isSpectator: false), [.leave, .end], phase)
            XCTAssertEqual(M.items(phase: phase, isCreator: false, isSpectator: false), [.leave], phase)
            XCTAssertEqual(M.items(phase: phase, isCreator: false, isSpectator: true), [.stopWatching], phase)
        }
        // the cut: no End (as before: it would end the cut early)
        XCTAssertEqual(M.items(phase: CutForABuck.phase, isCreator: true, isSpectator: false), [.leave])
        // the results: no controls at all (the back control reads Main Room)
        XCTAssertEqual(M.items(phase: "complete", isCreator: true, isSpectator: false), [])
        XCTAssertEqual(M.items(phase: "complete", isCreator: false, isSpectator: false), [])
    }

    func testTheConfirmationsSayWhatHappens() {
        typealias M = TournamentLobbyMenu
        func msg(_ item: M.Item, _ phase: String, host: Bool = false, others: Int = 2) -> String {
            M.confirmMessage(item, phase: phase, isCreator: host, othersConnected: others, othersPresent: others)
        }
        XCTAssertEqual(M.confirmButton(.end), "End Tournament")
        XCTAssertEqual(M.confirmButton(.leave), "Leave Tournament")
        XCTAssertEqual(M.confirmButton(.stopWatching), "Stop Watching")
        XCTAssertEqual(M.confirmTitle(.end), "End tournament?")
        XCTAssertEqual(M.confirmTitle(.leave), "Leave tournament?")
        XCTAssertEqual(M.confirmTitle(.stopWatching), "Stop watching?")
        // the keep choice is a button of its own, never a bare "Cancel" beside "End Tournament"
        XCTAssertEqual(M.keepButton(.end), "Keep Tournament", "never a bare Cancel")
        XCTAssertEqual(M.keepButton(.leave), "Stay")
        XCTAssertEqual(M.keepButton(.stopWatching), "Keep Watching")
        XCTAssertEqual(msg(.stopWatching, "round_active"), "You go back to the main room.")
        XCTAssertTrue(msg(.end, "lobby", host: true).contains("everyone"))
        XCTAssertTrue(msg(.end, "round_active", host: true).contains("games still in play"))
        XCTAssertEqual(msg(.leave, "lobby"), "You can join again while it's waiting to start.")
        XCTAssertEqual(msg(.leave, "lobby", host: true),
                       "You can join again while it's waiting to start. Another player becomes the host.")
        XCTAssertFalse(msg(.leave, "lobby").contains("host"))
        for item in [M.Item.end, .leave, .stopWatching] {
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
                let words = M.confirmMessage(.leave, phase: phase, isCreator: host, othersConnected: 2, othersPresent: 2)
                XCTAssertTrue(words.hasPrefix("You can't come back to this tournament, and you won't be among the winners."), words)
                XCTAssertFalse(words.contains("lowest"), words)
                XCTAssertFalse(words.contains("join again"), words)
                XCTAssertEqual(words.contains("Another player becomes the host."), host, words)
            }
        }
    }

    /// The cut: leaving takes me out of it (cutForABuck.memberLeft); no "rounds still to come".
    func testLeavingDuringTheCut() {
        let words = TournamentLobbyMenu.confirmMessage(.leave, phase: CutForABuck.phase, isCreator: false, othersConnected: 3,
                                                         othersPresent: 3)
        XCTAssertEqual(words, "You'll be out of cut for a buck.", "lowercase mid-sentence (the owner's rule)")
        XCTAssertFalse(words.contains("round"))
    }

    /// A host alone in the lobby: leaving deletes the tournament (GameManager.leaveTournament:
    /// deleteTournamentIfAbandoned before transferCreator), so no rejoin and no new host.
    func testAHostAloneClosesTheTournamentByLeaving() {
        typealias M = TournamentLobbyMenu
        func leave(_ phase: String, host: Bool = true, connected: Int, present: Int) -> String {
            M.confirmMessage(.leave, phase: phase, isCreator: host, othersConnected: connected, othersPresent: present)
        }
        let alone = leave("lobby", connected: 0, present: 0)
        XCTAssertEqual(alone, "The tournament ends, since nobody else has joined.")
        XCTAssertFalse(alone.contains("join again"))
        XCTAssertFalse(alone.contains("host"))
        // with someone else there the role passes on
        XCTAssertTrue(leave("lobby", connected: 1, present: 1).contains("Another player becomes the host."))
        // anyone alone in the lobby (a lone member is handed the role): the same
        XCTAssertEqual(leave("lobby", host: false, connected: 0, present: 0), alone)
    }

    /// A lobby restored after a deploy: its members come back disconnected and hold it open
    /// (restoreHolds), so leaving does not close it and one of them takes the role (transferCreator
    /// falls back to a disconnected member); they joined before the deploy, so never "nobody else
    /// has joined" (review of PR #430).
    func testLeavingARestoredLobbyWithOnlyDisconnectedMembersDoesNotCloseIt() {
        typealias M = TournamentLobbyMenu
        XCTAssertEqual(M.confirmMessage(.leave, phase: "lobby", isCreator: true, othersConnected: 0, othersPresent: 3),
                       "You can join again while it's waiting to start. Another player becomes the host.")
        XCTAssertEqual(M.confirmMessage(.leave, phase: "lobby", isCreator: false, othersConnected: 0, othersPresent: 2),
                       "You can join again while it's waiting to start.")
    }

    /// Between rounds the last connected member's leave deletes the tournament
    /// (deleteTournamentIfAbandoned: nobody connected and no round game running), whether the
    /// others left or only dropped (review of PR #430); with someone connected it goes on.
    func testTheLastConnectedMemberBetweenRoundsClosesTheTournament() {
        typealias M = TournamentLobbyMenu
        for (host, present) in [(true, 0), (true, 3), (false, 0), (false, 2)] {
            let words = M.confirmMessage(.leave, phase: "between_rounds", isCreator: host, othersConnected: 0, othersPresent: present)
            XCTAssertEqual(words, "The tournament ends, since nobody else is connected.")
            XCTAssertFalse(words.contains("host"), "nobody takes the role of a closed tournament")
        }
        XCTAssertEqual(M.confirmMessage(.leave, phase: "between_rounds", isCreator: false, othersConnected: 1, othersPresent: 1),
                       "You can't come back to this tournament, and you won't be among the winners.")
        // in a round the running tables keep it alive (hasRunningGames): no "ends"
        XCTAssertFalse(M.confirmMessage(.leave, phase: "round_active", isCreator: true, othersConnected: 0, othersPresent: 3)
            .contains("ends"))
    }

    /// The dropped-choice rule: a confirm opened before a host hand-off, the cut or the results
    /// does nothing once the menu no longer offers that choice.
    func testAConfirmForAChoiceNoLongerOfferedIsDropped() {
        typealias M = TournamentLobbyMenu
        XCTAssertTrue(M.stillOffers(.end, phase: "lobby", isCreator: true, isSpectator: false))
        XCTAssertFalse(M.stillOffers(.end, phase: "lobby", isCreator: false, isSpectator: false), "the host role passed on")
        XCTAssertFalse(M.stillOffers(.end, phase: CutForABuck.phase, isCreator: true, isSpectator: false), "the cut began")
        XCTAssertFalse(M.stillOffers(.leave, phase: "complete", isCreator: false, isSpectator: false), "the results")
        XCTAssertFalse(M.stillOffers(.stopWatching, phase: "between_rounds", isCreator: false, isSpectator: false))
        XCTAssertTrue(M.stillOffers(.leave, phase: "round_active", isCreator: false, isSpectator: false))
    }

    /// One verb for the tournament going away (End's "ends"), in every message.
    func testTheMessagesSayEndsNeverCloses() {
        typealias M = TournamentLobbyMenu
        for item in [M.Item.end, .leave, .stopWatching] {
            for phase in ["lobby", "between_rounds", "round_active", CutForABuck.phase] {
                for host in [false, true] {
                    for (c, p) in [(0, 0), (0, 2), (2, 2)] {
                        let words = M.confirmMessage(item, phase: phase, isCreator: host, othersConnected: c, othersPresent: p)
                        XCTAssertFalse(words.contains("close"), words)
                    }
                }
            }
        }
    }

    /// One action = one button (owner 2026-11-26: "it shouldn't be a menu within a menu within a
    /// menu", then "tournament host should get two separate icons"): the host outside the cut gets
    /// Leave and End Tournament, a button each; everyone else one.
    func testEachRoleGetsOneButtonPerAction() {
        typealias M = TournamentLobbyMenu
        for phase in ["lobby", "between_rounds", "round_active"] {
            XCTAssertEqual(M.entry(phase: phase, isCreator: true, isSpectator: false), .buttons([.leave, .end]), phase)
            XCTAssertEqual(M.entry(phase: phase, isCreator: false, isSpectator: false), .button(.leave), phase)
            XCTAssertEqual(M.entry(phase: phase, isCreator: false, isSpectator: true), .button(.stopWatching), phase)
        }
        // the host during the cut: Leave alone, one button as today
        XCTAssertEqual(M.entry(phase: CutForABuck.phase, isCreator: true, isSpectator: false), .button(.leave))
        XCTAssertEqual(M.entry(phase: CutForABuck.phase, isCreator: false, isSpectator: false), .button(.leave))
        XCTAssertEqual(M.entry(phase: "complete", isCreator: true, isSpectator: false), .none)
        XCTAssertEqual(M.entry(phase: "complete", isCreator: false, isSpectator: true), .none)
    }

    /// Leave keeps a member's Leave's place: first (the top) in the Duo's bar, last (the trailing
    /// corner) in a header row, with End Tournament before it.
    func testTheHostsButtonsKeepLeaveWhereAMembersIs() {
        typealias M = TournamentLobbyMenu
        let host = M.entry(phase: "lobby", isCreator: true, isSpectator: false)
        XCTAssertEqual(M.displayOrder(host, inBar: true), [.leave, .end])
        XCTAssertEqual(M.displayOrder(host, inBar: false), [.end, .leave])
        XCTAssertEqual(M.displayOrder(.button(.leave), inBar: false), [.leave])
        XCTAssertEqual(M.displayOrder(.button(.stopWatching), inBar: true), [.stopWatching])
        XCTAssertEqual(M.displayOrder(.none, inBar: true), [])
    }

    func testTheButtonsWordsAndIdentifiers() {
        typealias M = TournamentLobbyMenu
        XCTAssertEqual(M.identifier(.leave), "tournament.leave")
        XCTAssertEqual(M.identifier(.end), "tournament.end")
        XCTAssertEqual(M.identifier(.stopWatching), "tournament.stopWatching")
        // the fallback "…" menu (a header row with no room for two icons) and its rows
        XCTAssertEqual(M.fallbackIdentifier, "tournament.more")
        XCTAssertEqual(M.menuIdentifier(.end), "tournament.menu.end")
        XCTAssertEqual(M.menuIdentifier(.leave), "tournament.menu.leave")
        XCTAssertEqual(M.fallbackLabel, "More")
        XCTAssertEqual(M.fallbackHint, "Leave or end the tournament")
        XCTAssertEqual(M.confirmIdentifier, "tournament.confirm")
        XCTAssertEqual(M.keepIdentifier, "tournament.keep")
        // the menu's rows open a confirmation: a trailing ellipsis
        XCTAssertEqual(M.menuTitle(.leave), "Leave Tournament…")
        XCTAssertEqual(M.menuTitle(.end), "End Tournament…")
        // VoiceOver: the full titles and what each asks
        XCTAssertEqual(M.title(.leave), "Leave Tournament")
        XCTAssertEqual(M.title(.end), "End Tournament")
        XCTAssertEqual(M.title(.stopWatching), "Stop Watching")
        XCTAssertEqual(M.hint(.leave), "Asks before you leave the tournament")
        XCTAssertEqual(M.hint(.end), "Asks before ending the tournament for everyone")
        XCTAssertEqual(M.hint(.stopWatching), "Asks before you stop watching the tournament")
        // the visible words (the AX controls row, the bar, the Large Content Viewer) and the icons
        XCTAssertEqual(M.buttonTitle(.leave), "Leave")
        XCTAssertEqual(M.buttonTitle(.end), "End Tournament")
        XCTAssertEqual(M.buttonTitle(.stopWatching), "Stop Watching")
        XCTAssertEqual(M.icon(.leave), "rectangle.portrait.and.arrow.right")
        XCTAssertEqual(M.icon(.stopWatching), "eye.slash")
        XCTAssertEqual(M.icon(.end), "stop.circle")
        XCTAssertFalse(M.icon(.end).contains("xmark"), "End is a stop, never a close")
        // "End" everywhere the user reads it; the wire event stays cancelTournament
        for item in [M.Item.end, .leave, .stopWatching] {
            for words in [M.title(item), M.menuTitle(item), M.buttonTitle(item), M.hint(item), M.confirmTitle(item),
                          M.confirmButton(item), M.keepButton(item), M.fallbackHint,
                          M.confirmMessage(item, phase: "lobby", isCreator: true, othersConnected: 2, othersPresent: 2)] {
                XCTAssertFalse(words.lowercased().contains("cancel"), words)
            }
        }
        XCTAssertEqual(SocketEvents.Client.cancelTournament, "cancelTournament")
    }

    /// End Tournament waits for the session and the re-entry; Leave and Stop Watching never do.
    func testOnlyEndWaitsForTheSession() {
        typealias M = TournamentLobbyMenu
        XCTAssertFalse(M.isEnabled(.end, canSend: false))
        XCTAssertTrue(M.isEnabled(.end, canSend: true))
        for item in [M.Item.leave, .stopWatching] {
            XCTAssertTrue(M.isEnabled(item, canSend: false))
        }
    }

    /// The host's words at the accessibility sizes (review of PR #438): the controls row tries
    /// smaller and smaller caps before the icons alone, each below the accessibility sizes' first
    /// but the first; only End Tournament, which ends it for everyone, is drawn as destructive.
    func testTheHostsWordsShrinkBeforeTheyGoAndOnlyEndIsDestructive() {
        typealias M = TournamentLobbyMenu
        XCTAssertEqual(M.wordCaps.count, 3, "the view's ViewThatFits reads three caps")
        XCTAssertEqual(M.wordCaps, M.wordCaps.sorted().reversed(), "largest first: the largest that fits wins")
        XCTAssertEqual(M.wordCaps.first, .accessibility1)
        XCTAssertTrue(M.wordCaps.dropFirst().allSatisfy { !$0.isAccessibilitySize }, "then below the AX sizes")
        XCTAssertTrue(M.isDestructiveForEveryone(.end))
        XCTAssertFalse(M.isDestructiveForEveryone(.leave))
        XCTAssertFalse(M.isDestructiveForEveryone(.stopWatching))
    }

    /// The open alert while the lobby changes: its choice gone -> dropped; only the consequence
    /// changed -> the new words in place; otherwise nothing.
    func testAnOpenConfirmationFollowsTheLobby() {
        typealias M = TournamentLobbyMenu
        func ctx(_ phase: String = "lobby", host: Bool, spectator: Bool = false, connected: Int = 3, present: Int = 3,
                 tournament: Bool = true) -> M.Context {
            M.Context(hasTournament: tournament, phase: phase, isCreator: host, isSpectator: spectator,
                      othersConnected: connected, othersPresent: present)
        }
        let hostLeave = M.confirmMessage(.leave, phase: "lobby", isCreator: true, othersConnected: 3, othersPresent: 3)
        let memberLeave = M.confirmMessage(.leave, phase: "lobby", isCreator: false, othersConnected: 3, othersPresent: 3)
        let end = M.confirmMessage(.end, phase: "lobby", isCreator: true, othersConnected: 3, othersPresent: 3)
        XCTAssertEqual(M.change(open: .end, showing: end, in: ctx(host: true)), .none)
        // a host hand-off: End's alert goes, Leave's says the new consequence
        XCTAssertEqual(M.change(open: .end, showing: end, in: ctx(host: false)), .discard)
        XCTAssertEqual(M.change(open: .leave, showing: hostLeave, in: ctx(host: false)), .message(memberLeave))
        // I become the host
        XCTAssertEqual(M.change(open: .leave, showing: memberLeave, in: ctx(host: true)), .message(hostLeave))
        // the others leave: alone in the lobby
        XCTAssertEqual(M.change(open: .leave, showing: hostLeave, in: ctx(host: true, connected: 0, present: 0)),
                       .message("The tournament ends, since nobody else has joined."))
        // the cut starts: End goes, Leave stays with the cut's words
        XCTAssertEqual(M.change(open: .end, showing: end, in: ctx(CutForABuck.phase, host: true)), .discard)
        XCTAssertEqual(M.change(open: .leave, showing: hostLeave, in: ctx(CutForABuck.phase, host: true)),
                       .message("You'll be out of cut for a buck. Another player becomes the host."))
        // the results, or the tournament gone: every alert goes
        XCTAssertEqual(M.change(open: .leave, showing: memberLeave, in: ctx("complete", host: false)), .discard)
        XCTAssertEqual(M.change(open: .stopWatching, showing: "You go back to the main room.",
                                in: ctx("complete", host: false, spectator: true)), .discard)
        XCTAssertEqual(M.change(open: .leave, showing: memberLeave, in: ctx(host: false, tournament: false)), .discard)
        XCTAssertEqual(M.change(open: .stopWatching, showing: "You go back to the main room.",
                                in: ctx("round_active", host: false, spectator: true)), .none)
    }

    /// The view's context comes from TournamentState as the lobby reads it; no tournament is an
    /// empty id (reset), so an open alert goes when the tournament does, with or without a screen
    /// change (review of PR #437: the non-optional id was tested against nil, always "there").
    func testTheContextSeesTheTournamentGone() {
        typealias M = TournamentLobbyMenu
        let t = TournamentState()
        t.tournamentId = "t1"
        t.phase = "lobby"
        t.creatorUsername = "kim"
        t.players = ["kim", "ivy", "hal"].map {
            TournamentPlayer(id: "sid-\($0)", username: $0, pic: nil, isReady: false, isCreator: $0 == "kim",
                             connected: $0 != "hal")
        }
        var c = M.Context(tournament: t, me: "ivy", canSend: true)
        XCTAssertEqual(c, M.Context(hasTournament: true, phase: "lobby", isCreator: false, isSpectator: false,
                                    othersConnected: 1, othersPresent: 2, canSend: true))
        XCTAssertTrue(M.Context(tournament: t, me: "kim", canSend: false).isCreator)
        let memberLeave = M.confirmMessage(.leave, phase: "lobby", isCreator: false, othersConnected: 1, othersPresent: 2)
        XCTAssertEqual(M.change(open: .leave, showing: memberLeave, in: c), .none)
        t.reset()
        c = M.Context(tournament: t, me: "ivy", canSend: true)
        XCTAssertFalse(c.hasTournament, "reset leaves an empty id: no tournament")
        XCTAssertEqual(M.change(open: .leave, showing: memberLeave, in: c), .discard,
                       "never \"The tournament ends, since nobody else has joined.\" in place")
    }

    /// End's confirm waits for the session and the re-entry, as its button does; Leave and Stop
    /// Watching never wait (review of PR #437). The consequence does not depend on it.
    func testOnlyEndsConfirmWaitsForTheSession() {
        typealias M = TournamentLobbyMenu
        XCTAssertFalse(M.confirmEnabled(.end, canSend: false))
        XCTAssertTrue(M.confirmEnabled(.end, canSend: true))
        for item in [M.Item.leave, .stopWatching] {
            XCTAssertTrue(M.confirmEnabled(item, canSend: false))
            XCTAssertTrue(M.confirmEnabled(item, canSend: true))
        }
        let end = M.confirmMessage(.end, phase: "lobby", isCreator: true, othersConnected: 3, othersPresent: 3)
        let offline = M.Context(hasTournament: true, phase: "lobby", isCreator: true, isSpectator: false,
                                othersConnected: 3, othersPresent: 3, canSend: false)
        XCTAssertEqual(M.change(open: .end, showing: end, in: offline), .none, "the alert stays, its confirm waits")
    }
}

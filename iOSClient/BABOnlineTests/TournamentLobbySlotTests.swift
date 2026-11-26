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
    /// not (pressing Begin puts the host in the round): Begin with a small Ready under it.
    func testPastTheDeadlineTheHostStartsWithTheReadyPlayers() {
        let some = [p("kim", ready: true), p("hal", ready: false)]
        XCTAssertEqual(slot("between_rounds", host: "ivy", ready: false, others: some, deadline: true),
                       TournamentLobbySlot(primary: .begin("Start with ready players"), toggle: .ready,
                                           caption: "Players who aren't ready sit this round out."))
        XCTAssertEqual(slot("between_rounds", host: "ivy", ready: true, others: some, deadline: true)?.toggle, .unready)
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
                            XCTAssertEqual(s?.toggle, meReady ? .unready : .ready, ctx)
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
        XCTAssertEqual(M.confirmButton(.cancel), "Cancel Tournament")
        XCTAssertEqual(M.confirmButton(.leave), "Leave Tournament")
        XCTAssertEqual(M.confirmButton(.stopWatching), "Stop Watching")
        XCTAssertTrue(M.confirmMessage(.cancel, phase: "lobby", isCreator: true).contains("everyone"))
        XCTAssertTrue(M.confirmMessage(.cancel, phase: "round_active", isCreator: true).contains("games still in play"))
        XCTAssertTrue(M.confirmMessage(.leave, phase: "lobby", isCreator: false).contains("join again"))
        XCTAssertTrue(M.confirmMessage(.leave, phase: "between_rounds", isCreator: false).contains("lowest"))
        XCTAssertTrue(M.confirmMessage(.leave, phase: "lobby", isCreator: true).contains("Another player becomes the host"))
        XCTAssertFalse(M.confirmMessage(.leave, phase: "lobby", isCreator: false).contains("host"))
        for item in [M.Item.cancel, .leave, .stopWatching] {
            for words in [M.title(item), M.confirmMessage(item, phase: "lobby", isCreator: true)] {
                XCTAssertFalse(words.contains("Team"), words)
            }
        }
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

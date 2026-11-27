import XCTest
import UIKit
@testable import BAB_Online

/// The UIKit confirmation alert (LeaveAlertPresenter), generalised for the tournament lobby: the
/// in-game Leave's words are unchanged; any words, button identifiers, a message changed in place,
/// and a discard with no answer.
@MainActor
final class LeaveAlertPresenterTests: XCTestCase {
    /// The in-game "Exit game?" alert's words, exactly as before.
    func testTheInGameLeaveKeepsItsWords() {
        let w = LeaveAlertPresenter.Words.exitGame(message: "A bot takes your seat.")
        XCTAssertEqual(w.title, "Exit game?")
        XCTAssertEqual(LeaveAlertPresenter.title, "Exit game?")
        XCTAssertEqual(w.message, "A bot takes your seat.")
        XCTAssertEqual(w.confirm, "Exit Game")
        XCTAssertEqual(w.keep, "Cancel")
        XCTAssertNil(w.confirmIdentifier)
        XCTAssertNil(w.keepIdentifier)
    }

    private func presented(_ p: LeaveAlertPresenter) throws -> UIAlertController {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        var top = scenes.flatMap(\.windows).first { $0.isKeyWindow }?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return try XCTUnwrap(top as? UIAlertController, "the alert is on top")
    }

    private func settle(_ seconds: TimeInterval = 0.6) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    /// The tournament lobby's words and identifiers on the alert's own controller; a new message
    /// changes that controller's text (never a second alert); a discard closes it with no answer.
    func testAnyWordsThenAMessageInPlaceThenADiscard() throws {
        let p = LeaveAlertPresenter()
        var answers: [LeaveAlertPresenter.Answer] = []
        let words = LeaveAlertPresenter.Words(title: "End tournament?", message: "first", confirm: "End Tournament",
                                              keep: "Keep Tournament", confirmIdentifier: "tournament.confirm",
                                              keepIdentifier: "tournament.keep")
        guard p.present(words, answered: { answers.append($0) }) else {
            throw XCTSkip("the test host has no window to present on")
        }
        settle()
        XCTAssertTrue(p.isUp)
        let a = try presented(p)
        XCTAssertEqual(a.preferredStyle, .alert, "a centred alert, never a popover")
        XCTAssertEqual(a.title, "End tournament?")
        XCTAssertEqual(a.message, "first")
        XCTAssertEqual(a.actions.map(\.title), ["End Tournament", "Keep Tournament"])
        XCTAssertEqual(a.actions.map(\.style), [.destructive, .cancel])
        XCTAssertEqual(a.actions.map(\.accessibilityIdentifier), ["tournament.confirm", "tournament.keep"])
        // a second present while one is up does nothing
        XCTAssertFalse(p.present(words, answered: { answers.append($0) }))

        XCTAssertTrue(p.isPresented)
        XCTAssertEqual(p.confirmEnabled, true)
        // the destructive button waits in place (the lobby's End Tournament during a reconnect)
        p.setConfirmEnabled(false)
        XCTAssertEqual(a.actions.map(\.isEnabled), [false, true], "the keep button stays")
        XCTAssertTrue(try presented(p) === a)
        p.setConfirmEnabled(true)
        XCTAssertEqual(a.actions.map(\.isEnabled), [true, true])

        p.update(message: "second")
        XCTAssertEqual(p.message, "second")
        XCTAssertTrue(try presented(p) === a, "the same alert, its text changed in place")
        XCTAssertEqual(a.message, "second")

        p.discard()
        settle()
        XCTAssertFalse(p.isUp)
        XCTAssertNil(p.message)
        XCTAssertNil(a.presentingViewController, "gone")
        XCTAssertEqual(answers, [], "a discard answers nothing")
        p.update(message: "third")  // nothing open: nothing changes
        XCTAssertEqual(a.message, "second")
        p.setConfirmEnabled(false)  // nothing open: nothing changes
        XCTAssertNil(p.confirmEnabled)
        XCTAssertTrue(a.actions[0].isEnabled)
    }

    /// An alert something else dismissed (review of PR #437) reads as not presented the moment it
    /// is gone, and a discard frees the presenter for the next one: the tournament lobby's entry
    /// point never locks on a lost alert.
    func testAnAlertDismissedFromOutsideIsNotPresented() throws {
        let p = LeaveAlertPresenter()
        let words = LeaveAlertPresenter.Words(title: "Leave tournament?", message: "m", confirm: "Leave Tournament",
                                              keep: "Stay")
        guard p.present(words, answered: { _ in XCTFail("no answer for a lost alert") }) else {
            throw XCTSkip("the test host has no window to present on")
        }
        XCTAssertTrue(p.isPresented, "presented as soon as present returns")
        settle()
        try presented(p).presentingViewController?.dismiss(animated: false)
        settle()
        XCTAssertFalse(p.isPresented)
        p.discard()
        settle()
        XCTAssertFalse(p.isUp)
        XCTAssertTrue(p.present(words, answered: { _ in }), "the next alert opens")
        settle()
        XCTAssertTrue(p.isPresented)
        p.discard()
        settle()
    }

    /// The in-game form presents "Exit game?" with Exit Game / Cancel, as before.
    func testTheInGameFormPresentsAsBefore() throws {
        let p = LeaveAlertPresenter()
        guard p.present(message: "m", answered: { _ in }) else { throw XCTSkip("no window") }
        settle()
        let a = try presented(p)
        XCTAssertEqual(a.title, "Exit game?")
        XCTAssertEqual(a.actions.map(\.title), ["Exit Game", "Cancel"])
        XCTAssertEqual(a.actions.map(\.style), [.destructive, .cancel])
        var closed = false
        p.close { closed = true }
        settle()
        XCTAssertTrue(closed, "close reports UIKit's dismissal")
        XCTAssertFalse(p.isUp)
    }
}

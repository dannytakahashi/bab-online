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
        let words = LeaveAlertPresenter.Words(title: "Cancel tournament?", message: "first", confirm: "Cancel Tournament",
                                              keep: "Keep Tournament", confirmIdentifier: "tournament.confirm",
                                              keepIdentifier: "tournament.keep")
        guard p.present(words, answered: { answers.append($0) }) else {
            throw XCTSkip("the test host has no window to present on")
        }
        settle()
        XCTAssertTrue(p.isUp)
        let a = try presented(p)
        XCTAssertEqual(a.preferredStyle, .alert, "a centred alert, never a popover")
        XCTAssertEqual(a.title, "Cancel tournament?")
        XCTAssertEqual(a.message, "first")
        XCTAssertEqual(a.actions.map(\.title), ["Cancel Tournament", "Keep Tournament"])
        XCTAssertEqual(a.actions.map(\.style), [.destructive, .cancel])
        XCTAssertEqual(a.actions.map(\.accessibilityIdentifier), ["tournament.confirm", "tournament.keep"])
        // a second present while one is up does nothing
        XCTAssertFalse(p.present(words, answered: { answers.append($0) }))

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

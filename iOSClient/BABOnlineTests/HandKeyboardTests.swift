import XCTest
@testable import BAB_Online

/// Keyboard card play (State/Table/HandKeyboard.swift): the web's hand toolbar rules
/// (client/src/ui/handA11y.js) as a pure model. Platform-neutral; not wired on iOS.
final class HandKeyboardTests: XCTestCase {
    private func hand(_ ids: [String], dimmed: Set<String> = []) -> [HandKeyboard.Card] {
        ids.map { HandKeyboard.Card(id: $0, playable: !dimmed.contains($0)) }
    }

    private func focused(on id: String, in ids: [String], dimmed: Set<String> = []) -> HandKeyboard {
        var k = HandKeyboard()
        k.sync(hand(ids, dimmed: dimmed))
        k.focusCard(id)
        return k
    }

    func testOneStopTheFirstPlayableElseTheFirst() {
        var k = HandKeyboard()
        XCTAssertNil(k.stop)
        k.sync(hand(["2S", "3S", "4S"], dimmed: ["2S"]))
        XCTAssertEqual(k.stop, "3S", "the first playable card")
        k.sync(hand(["2S", "3S"], dimmed: ["2S", "3S"]))
        XCTAssertEqual(k.stop, "2S", "nothing playable: the first card")
        k.focusCard("3S")
        XCTAssertEqual(k.stop, "3S", "the focused card")
    }

    func testArrowsHomeAndEndMoveAndStopAtTheEnds() {
        var k = focused(on: "3S", in: ["2S", "3S", "4S", "5S"])
        XCTAssertEqual(k.press(.right), .moved)
        XCTAssertEqual(k.focusedId, "4S")
        XCTAssertEqual(k.press(.down), .moved)
        XCTAssertEqual(k.focusedId, "5S")
        XCTAssertEqual(k.press(.right), .moved, "the last card stays")
        XCTAssertEqual(k.focusedId, "5S")
        XCTAssertEqual(k.press(.home), .moved)
        XCTAssertEqual(k.focusedId, "2S")
        XCTAssertEqual(k.press(.left), .moved)
        XCTAssertEqual(k.focusedId, "2S", "the first card stays")
        XCTAssertEqual(k.press(.end), .moved)
        XCTAssertEqual(k.focusedId, "5S")
        XCTAssertEqual(k.press(.up), .moved)
        XCTAssertEqual(k.focusedId, "4S")
    }

    func testReturnAndSpaceActivateWhatAClickDoesAndADimmedCardRefuses() {
        var k = focused(on: "3S", in: ["2S", "3S", "4S"], dimmed: ["4S"])
        XCTAssertEqual(k.press(.enter), .activate("3S"))
        XCTAssertEqual(k.press(.space), .activate("3S"))
        _ = k.press(.right)
        XCTAssertEqual(k.focusedId, "4S", "a dimmed card stays focusable")
        XCTAssertEqual(k.press(.enter), .refuse("4S"))
    }

    func testOtherKeysAndModifiedKeysAreLeftAlone() {
        var k = focused(on: "3S", in: ["2S", "3S"])
        XCTAssertEqual(k.press(.other), .ignored, "the voice keys, a letter")
        XCTAssertEqual(k.press(.tab), .ignored, "Tab leaves the hand")
        XCTAssertEqual(k.press(.right, modifiers: true), .ignored, "a menu shortcut")
        XCTAssertEqual(k.focusedId, "3S")
        var none = HandKeyboard()
        none.sync(hand(["2S"]))
        XCTAssertEqual(none.press(.enter), .ignored, "no card focused")
    }

    func testFocusIsKeptByCardAcrossARenderAndPassesToTheNeighbour() {
        var k = focused(on: "4S", in: ["2S", "3S", "4S", "5S"])
        k.sync(hand(["5S", "4S", "3S", "2S"]))
        XCTAssertEqual(k.focusedId, "4S", "kept by card, not by index")
        // the focused card is played: the card now at its index
        k = focused(on: "3S", in: ["2S", "3S", "4S"])
        k.sync(hand(["2S", "4S"]))
        XCTAssertEqual(k.focusedId, "4S")
        // the last card of the row is played: the new last one
        k = focused(on: "4S", in: ["2S", "3S", "4S"])
        k.sync(hand(["2S", "3S"]))
        XCTAssertEqual(k.focusedId, "3S")
    }

    func testTheLastCardGivesFocusToTheAnnouncerAndARedrawBringsItBack() {
        var k = focused(on: "2S", in: ["2S"])
        k.sync([])
        XCTAssertEqual(k.focus, .announcer, "never nowhere")
        k.sync(hand(["7H", "8H"]))
        XCTAssertEqual(k.focus, .announcer, "the next deal does not pull focus into the hand")

        // a render that clears and redraws the same hand
        k = focused(on: "3S", in: ["2S", "3S"])
        k.sync([], redraw: true)
        XCTAssertEqual(k.focus, .announcer)
        k.sync(hand(["2S", "3S"]))
        XCTAssertEqual(k.focusedId, "3S", "back on the same card")
        // only the redraw right after the clear
        k = focused(on: "3S", in: ["2S", "3S"])
        k.sync([], redraw: true)
        k.sync([])
        k.sync(hand(["2S", "3S"]))
        XCTAssertEqual(k.focus, .announcer)
    }

    func testMyTurnTakesFocusOnlyFromNowhereAfterAKeyOrFromTheTable() {
        var k = HandKeyboard()
        k.sync(hand(["2S", "3S"], dimmed: ["2S"]))
        XCTAssertFalse(k.offerTurnFocus(from: .elsewhere), "never from chat, a field, a sheet")
        XCTAssertFalse(k.offerTurnFocus(from: .nowhere), "from nowhere only after a navigation key")
        _ = k.press(.tab)
        XCTAssertTrue(k.offerTurnFocus(from: .nowhere))
        XCTAssertEqual(k.focusedId, "3S", "the first playable card")

        var t = HandKeyboard()
        t.sync(hand(["2S", "3S"]))
        XCTAssertTrue(t.offerTurnFocus(from: .table), "the table's own controls")
        XCTAssertEqual(t.focusedId, "2S")
        XCTAssertFalse(t.offerTurnFocus(from: .table), "a playable card already focused stays")

        var d = focused(on: "2S", in: ["2S", "3S"], dimmed: ["2S"])
        XCTAssertTrue(d.offerTurnFocus(from: .table), "a dimmed focused card gives way")
        XCTAssertEqual(d.focusedId, "3S")

        var none = HandKeyboard()
        none.sync(hand(["2S"], dimmed: ["2S"]))
        XCTAssertFalse(none.offerTurnFocus(from: .table), "nothing playable")
    }

    func testTheRingShowsOnlyAfterANavigationKey() {
        var k = focused(on: "2S", in: ["2S", "3S"])
        XCTAssertFalse(k.showsRing, "focused by a click")
        _ = k.press(.other)
        XCTAssertFalse(k.showsRing, "a voice key is no navigation")
        _ = k.press(.right)
        XCTAssertTrue(k.showsRing)
        k.pointerDown()
        XCTAssertFalse(k.showsRing, "a mouse press hides it")
        k.focusLeft()
        _ = k.press(.right)
        XCTAssertFalse(k.showsRing, "nothing focused")
        XCTAssertEqual(HandKeyboard.navigationKeys, [.tab, .enter, .space, .left, .right, .up, .down, .home, .end])
    }
}

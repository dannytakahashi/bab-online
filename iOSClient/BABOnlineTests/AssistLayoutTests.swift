import XCTest
@testable import BAB_Online

/// Where the /help card goes (AssistLayout.frame, pane points, y down): above my hand or the
/// bid panel, and clear of my bid clock's pill, my seat's row (HSI, voice, my pips) and, in a
/// tabletop pose, the fold.
final class AssistLayoutTests: XCTestCase {
    // a 402 x 874 phone pane: the score bar ends at 150, the hand's lifted top at 760
    private let paneWidth: CGFloat = 402
    private let top: CGFloat = 150
    private let gap = AssistLayout.gap

    private func frame(_ keeps: AssistLayout.Keeps, handMidX: CGFloat = 201, handWidth: CGFloat = 360) -> CGRect {
        AssistLayout.frame(paneWidth: paneWidth, handMidX: handMidX, handWidth: handWidth, top: top, keeps: keeps)
    }

    func testTheBoxEndsJustAboveTheAnchor() {
        let f = frame(.init(anchor: 760))
        XCTAssertEqual(f.minY, top)
        XCTAssertEqual(f.maxY, 760 - gap)
        XCTAssertEqual(f.width, 360)
        XCTAssertEqual(f.midX, 201)
    }

    func testOnMyBidTurnTheCardStaysAboveTheCountdown() {
        // the band starts at 600; the pill hangs 21 pt above it at the panel's trailing corner
        let pill = CGRect(x: 300, y: 580, width: 50, height: 22)
        let f = frame(.init(anchor: 600, clock: pill))
        XCTAssertEqual(f.maxY, pill.minY - gap)
        XCTAssertFalse(f.intersects(pill))
        // no countdown: just above the band
        XCTAssertEqual(frame(.init(anchor: 600)).maxY, 600 - gap)
    }

    func testOnMyPlayTurnTheCardStaysAboveMySeatRow() {
        // the row (HSI and the voice button) just above my lifted hand, on the right
        let row = CGRect(x: 230, y: 700, width: 122, height: 44)
        let f = frame(.init(anchor: 760, seatRow: row))
        XCTAssertEqual(f.maxY, row.minY - gap)
        XCTAssertFalse(f.intersects(row))
    }

    func testASeatRowOutsideTheCardsSpanDoesNotLiftIt() {
        // a narrow hand's card (240 wide, centred at 120) ends left of a row at x 300
        let row = CGRect(x: 300, y: 700, width: 80, height: 44)
        let f = frame(.init(anchor: 760, seatRow: row), handMidX: 140, handWidth: 100)
        XCTAssertLessThan(f.maxX, row.minX)
        XCTAssertEqual(f.maxY, 760 - gap)
    }

    func testWithTooLittleRoomAboveTheRowTheCardKeepsTheHandsAnchor() {
        // the row reaches up to 20 pt under the score bar: lifting would leave no card
        let row = CGRect(x: 230, y: top + 20, width: 122, height: 590)
        let f = frame(.init(anchor: 760, seatRow: row))
        XCTAssertEqual(f.maxY, 760 - gap)
    }

    func testInATabletopPoseTheCardStaysBelowTheFold() {
        // a 20 pt fold across the pane at 430; the hand below it
        let fold = CGRect(x: 0, y: 430, width: paneWidth, height: 20)
        let f = frame(.init(anchor: 760, fold: fold))
        XCTAssertEqual(f.minY, fold.maxY + gap)
        XCTAssertEqual(f.maxY, 760 - gap)
        XCTAssertFalse(f.intersects(fold))
        // and below the fold with the bid panel and its countdown
        let pill = CGRect(x: 300, y: 600, width: 50, height: 22)
        let b = frame(.init(anchor: 621, clock: pill, fold: fold))
        XCTAssertEqual(b.minY, fold.maxY + gap)
        XCTAssertEqual(b.maxY, pill.minY - gap)
    }

    func testABookFoldOrOneBelowTheAnchorLeavesTheTop() {
        // a book pose's fold runs top to bottom: not a floor for the card
        let book = CGRect(x: 191, y: 0, width: 20, height: 874)
        XCTAssertEqual(frame(.init(anchor: 760, fold: book)).minY, top)
        // a fold under the hand (the hand above it): the card's box is above as before
        let low = CGRect(x: 0, y: 800, width: paneWidth, height: 20)
        XCTAssertEqual(frame(.init(anchor: 760, fold: low)).minY, top)
    }

    func testASeatRowAboveTheFoldDoesNotLiftTheCardBelowIt() {
        // tabletop: the row went above the fold beside the trick cards; the card is below
        let fold = CGRect(x: 0, y: 430, width: paneWidth, height: 20)
        let row = CGRect(x: 230, y: 360, width: 122, height: 44)
        let f = frame(.init(anchor: 760, seatRow: row, fold: fold))
        XCTAssertEqual(f.minY, fold.maxY + gap)
        XCTAssertEqual(f.maxY, 760 - gap)
    }

    func testTheProbeNamesWhatItKeeps() {
        let k = AssistLayout.Keeps(anchor: 1, clock: CGRect(x: 0, y: 0, width: 1, height: 1), seatRow: nil,
                                   fold: CGRect(x: 0, y: 0, width: 2, height: 1))
        XCTAssertEqual(Set(k.probe.keys), ["bidClock", "fold"])
    }
}

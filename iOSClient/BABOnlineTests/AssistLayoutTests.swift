import XCTest
@testable import BAB_Online

/// Where the /help card goes (AssistLayout.frame, pane points, y down): above my hand or the
/// bid panel, and clear of my bid clock's pill, my seat's row (HSI, voice, my pips) and, in a
/// tabletop pose, the fold. The lightbulb on my play turn (AssistLayout.askFrame, owner
/// 2026-11-19 on build 19: a short hand's lightbulb sat on HSI): clear of my seat's row and the
/// rest of the table at every hand size, size class and pose, and at today's spot wherever that
/// was clear.
@MainActor
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

    // MARK: - The lightbulb on my play turn

    typealias Mode = TableLayout.SeatRow.Mode

    /// iPhone 18 Pro (the owner's report, 402 x 874).
    static let pro18 = TableLayout(size: CGSize(width: 402, height: 874),
                                   chrome: PolishLayoutTests.chrome(TableLayoutTests.insets(62, 0, 34, 0), bottomBar: 0, topBar: 75.5))

    /// Every size class and pose my seat's row is checked at (SeatRowTests.configs: the phones,
    /// the iPads both ways and zoomed, the Duo closed / open / landscape / book / tabletop, Slide
    /// Over), and the 18 Pro.
    static var configs: [(String, TableLayout)] {
        SeatRowTests.configs.filter { !$0.1.isDegraded } + [("iPhone 18 Pro", pro18)]
    }

    /// What my seat's row draws (pane points), computed here from the layout: my pips' pill for
    /// `pips` > 0, HSI's badge at its widest (leading in its slot; its type is not zoomed), the voice button.
    static func row(_ L: TableLayout, pips: Int, hsi: Bool, voice: Bool) -> [String: CGRect] {
        var out: [String: CGRect] = [:]
        if pips > 0 { out["pips"] = L.window(TableLayout.rect(L.myPipsCenter(slots: pips), TableLayout.myPipsPill(pips))) }
        if hsi { out["hsi"] = L.window(L.seatRow.hsi).divided(atDistance: TableLayout.hsiSize.width, from: .minXEdge).slice }
        if voice { out["voice"] = L.window(L.seatRow.voice) }
        return out
    }

    /// (pips, hsi, voice, spectator badge): everything my seat's row can show, the owner's report
    /// (a bid of 2, HSI, no voice), voice without pips (a 0 bid), nothing.
    static let rowStates: [(Int, Bool, Bool, Bool)] = [(13, true, true, true), (2, true, false, false), (0, true, true, false), (0, false, false, false)]

    func testTheLightbulbClearsMySeatRowAtEveryHandSize() {
        var checked = 0, moved = 0
        for (tag, L) in Self.configs {
            for (pips, hsi, voice, spectators) in Self.rowStates {
                let badge = spectators ? L.window(L.spectatorBadge(spectating: false)) : nil
                for n in 1...13 {
                    let k = AssistLayout.askKeeps(L, handCount: n, pipSlots: pips, hsi: hsi, voice: voice, spectatorBadge: badge)
                    let f = AssistLayout.askFrame(k)
                    let button = AssistLayout.askButton(f)
                    let t = "\(tag) n=\(n) pips=\(pips) hsi=\(hsi) voice=\(voice) badge=\(spectators): \(f)"
                    XCTAssertEqual(AssistLayout.askProblems(f, k), [], t)
                    // the 44 pt tap square, on screen under the score bar
                    XCTAssertEqual(f.width, Theme.hitTarget, t)
                    XCTAssertEqual(f.height, Theme.hitTarget, t)
                    XCTAssertTrue(k.bounds.insetBy(dx: -0.01, dy: -0.01).contains(f), t)
                    XCTAssertGreaterThanOrEqual(f.minX, 0, t)
                    XCTAssertGreaterThanOrEqual(f.minY, 0, t)
                    XCTAssertLessThanOrEqual(f.maxX, L.paneSize.width + 0.01, t)
                    XCTAssertLessThanOrEqual(f.maxY, L.paneSize.height + 0.01, t)
                    // never on my seat's row (the drawn button off HSI and my pips, the tap square off the voice button)
                    for (name, r) in Self.row(L, pips: pips, hsi: hsi, voice: voice) {
                        XCTAssertFalse(TableLayout.overlaps(name == "voice" ? f : button, r), "\(t) over \(name) \(r)")
                    }
                    if let badge { XCTAssertFalse(TableLayout.overlaps(f, badge), "\(t) over the spectator badge \(badge)") }
                    // nor on my hand, the trick cards, the seats, the fans, the corner buttons, the fold
                    XCTAssertFalse(TableLayout.overlaps(button, AssistLayout.handBox(L, count: n)), t)
                    // (my own trick slot is empty on my turn)
                    for r in [Positions.RelativePosition.top, .left, .right] {
                        XCTAssertFalse(TableLayout.overlaps(button, L.window(L.trickRect(r))), "\(t) over trick \(r)")
                    }
                    for r in [Positions.RelativePosition.top, .left, .right] {
                        XCTAssertFalse(TableLayout.overlaps(button, L.window(L.seatFootprint(r))), "\(t) over seat \(r)")
                    }
                    for (r, fan) in L.fans(spectating: false) ?? [:] {
                        XCTAssertFalse(TableLayout.overlaps(button, L.window(fan)), "\(t) over fan \(r)")
                    }
                    for c in L.cornerRects { XCTAssertFalse(TableLayout.overlaps(button, L.window(c)), "\(t) over a corner button") }
                    if let fold = L.chrome.fold, !L.foldIgnored { XCTAssertFalse(TableLayout.overlaps(button, L.window(fold)), "\(t) over the fold") }
                    XCTAssertGreaterThanOrEqual(button.minY, L.window(CGRect(x: 0, y: L.topLimit, width: 1, height: 0)).minY - 0.01,
                                                "\(t) under the score bar")
                    // still my hand's: not below its home, near it, over the hand or just past its right end
                    let home = AssistLayout.askHome(hand: k.hand)
                    XCTAssertLessThanOrEqual(f.minY, home.minY + 0.01, t)
                    XCTAssertGreaterThanOrEqual(f.minY, home.minY - AssistLayout.askReach - 0.01, t)
                    XCTAssertGreaterThanOrEqual(f.midX, k.hand.minX - 0.01, t)
                    XCTAssertLessThanOrEqual(f.midX, k.hand.maxX + 0.01, t)
                    XCTAssertLessThanOrEqual(f.minX, home.minX + 0.01, "\(t): never right of today's spot")
                    if f != home { moved += 1 }
                    checked += 1
                }
            }
        }
        XCTAssertEqual(checked, Self.configs.count * Self.rowStates.count * 13)
        XCTAssertGreaterThan(moved, 0)
    }

    /// Where today's spot was clear (a full hand's right end past my seat's row, or the row not
    /// drawn there), the lightbulb stays put: the owner likes it there.
    func testWhereTodaysSpotIsClearTheLightbulbStaysPut() {
        let phones: [(String, TableLayout)] = [("iPhone 18 Pro", Self.pro18)]
            + SeatRowTests.configs.filter { ["iPhone 17e", "iPhone Pro Max", "iPhone SE size", "Duo closed (measured)", "Duo open",
                                             "Duo open landscape", "iPad 13 portrait", "iPad 13 landscape"].contains($0.0) }
        XCTAssertEqual(phones.count, 9)
        var kept = 0
        for (tag, L) in phones {
            for n in 1...13 {
                // HSI and a bid of 4, no voice (a game with bots)
                let k = AssistLayout.askKeeps(L, handCount: n, pipSlots: 4, hsi: true, voice: false)
                let home = AssistLayout.askHome(hand: k.hand)
                let f = AssistLayout.askFrame(k)
                if AssistLayout.askProblems(home, k).isEmpty {
                    XCTAssertEqual(f, home, "\(tag) n=\(n)")
                    kept += 1
                } else {
                    XCTAssertNotEqual(f, home, "\(tag) n=\(n)")
                }
                // with nothing in my seat's row drawn the home is clear at every size: it never moves
                let bare = AssistLayout.askKeeps(L, handCount: n, pipSlots: 0, hsi: false, voice: false)
                XCTAssertEqual(AssistLayout.askFrame(bare), AssistLayout.askHome(hand: bare.hand), "\(tag) n=\(n), an empty row")
            }
            // a full hand (11 to 13 cards) ends right of HSI and my pips: today's spot
            for n in 11...13 {
                let k = AssistLayout.askKeeps(L, handCount: n, pipSlots: 4, hsi: true, voice: false)
                XCTAssertEqual(AssistLayout.askFrame(k), AssistLayout.askHome(hand: k.hand), "\(tag) n=\(n): a full hand keeps today's spot")
            }
        }
        XCTAssertGreaterThan(kept, 9 * 4)
    }

    /// The owner's report: the 18 Pro, 2 cards left, HSI 111.6 and my pips (a bid of 2), no voice.
    /// The lightbulb moves left, over my hand at the same height, off HSI and my pips.
    func testTheOwnersTwoCardHandClearsHSI() {
        let L = Self.pro18
        let k = AssistLayout.askKeeps(L, handCount: 2, pipSlots: 2, hsi: true, voice: false)
        let home = AssistLayout.askHome(hand: k.hand)
        XCTAssertEqual(AssistLayout.askProblems(home, k), ["hsi", "pips"], "today's spot is on HSI")
        let f = AssistLayout.askFrame(k)
        let button = AssistLayout.askButton(f)
        let hsi = L.window(L.seatRow.hsi)
        XCTAssertFalse(button.intersects(hsi))
        XCTAssertFalse(f.intersects(hsi), "the tap square too")
        XCTAssertEqual(f.minY, home.minY, "the same height")
        XCTAssertLessThan(f.minX, home.minX, "moved left, toward the hand's middle")
        XCTAssertGreaterThan(button.minX, k.hand.minX, "over my hand")
        XCTAssertLessThanOrEqual(home.minX - f.minX, 40, "the nearest clear spot, not far")
        // one card: the same
        let one = AssistLayout.askKeeps(L, handCount: 1, pipSlots: 2, hsi: true, voice: false)
        XCTAssertTrue(AssistLayout.askProblems(AssistLayout.askFrame(one), one).isEmpty)
    }

    /// With the voice button up (a game with another human), a full hand's spot is on it at the
    /// phones' width: the lightbulb goes left of my seat's row at the same height, over my hand,
    /// and stays there while the row is in the way (the same spot as the owner's short hand).
    func testAFullHandsLightbulbClearsTheVoiceButton() {
        let L = Self.pro18
        let k = AssistLayout.askKeeps(L, handCount: 13, pipSlots: 4, hsi: true, voice: true)
        let home = AssistLayout.askHome(hand: k.hand)
        XCTAssertEqual(AssistLayout.askProblems(home, k), ["voice"])
        let f = AssistLayout.askFrame(k)
        let voice = L.window(L.seatRow.voice)
        XCTAssertFalse(f.intersects(voice))
        XCTAssertEqual(f.minY, home.minY, "the same height")
        let row = Self.row(L, pips: 4, hsi: true, voice: true).values.reduce(CGRect.null) { $0.union($1) }
        XCTAssertLessThanOrEqual(AssistLayout.askButton(f).maxX, row.minX - AssistLayout.askGap + 0.01, "left of my seat's row")
        XCTAssertGreaterThan(AssistLayout.askButton(f).minX, k.hand.minX, "over my hand")
        guard case .left(let x)? = AssistLayout.askLane(k) else { return XCTFail("the lane left of the row") }
        XCTAssertEqual(f.minX, x)
        for n in 1...12 {
            let kn = AssistLayout.askKeeps(L, handCount: n, pipSlots: 4, hsi: true, voice: true)
            XCTAssertEqual(AssistLayout.askFrame(kn), f, "n=\(n): the same spot all hand")
        }
    }

    /// Reviewer 2026-11-19: the lightbulb hopped right of HSI, then up between my pips and the
    /// voice slot, then left of my pips, on consecutive turns as the hand shrank (and on the Duo
    /// parked past my last card). Walking the hand down from 13 cards to 1 on every table and row
    /// state: it never moves right, its centre stays over my hand, at most one move is more than
    /// the hand's own step (a lift and a drop for the lane above the row: two), and it never
    /// changes height more than to lift over the row and drop back.
    func testTheLightbulbMovesSteadilyAsMyHandShrinks() {
        var walked = 0, hopped = 0
        for (tag, L) in Self.configs {
            for (pips, hsi, voice, spectators) in Self.rowStates {
                let badge = spectators ? L.window(L.spectatorBadge(spectating: false)) : nil
                var last: (f: CGRect, home: CGRect)?
                var big = 0, sideways = 0, heights: [CGFloat] = []
                for n in stride(from: 13, through: 1, by: -1) {
                    let k = AssistLayout.askKeeps(L, handCount: n, pipSlots: pips, hsi: hsi, voice: voice, spectatorBadge: badge)
                    let f = AssistLayout.askFrame(k), home = AssistLayout.askHome(hand: k.hand)
                    let t = "\(tag) pips=\(pips) hsi=\(hsi) voice=\(voice) badge=\(spectators) n=\(n): \(f)"
                    XCTAssertLessThanOrEqual(f.midX, k.hand.maxX + 0.01, "\(t): its centre over my hand")
                    XCTAssertLessThanOrEqual(AssistLayout.askButton(f).maxX, k.hand.maxX + 0.01, "\(t): never past my last card")
                    if let last {
                        let step = last.home.minX - home.minX, dx = f.minX - last.f.minX, dy = f.minY - last.f.minY
                        XCTAssertLessThanOrEqual(dx, 0.01, "\(t): moved right from \(last.f)")
                        if abs(dx) > step + 2 { sideways += 1 }
                        if abs(dx) > step + 2 || abs(dy) > 0.01 { big += 1 }
                    }
                    if heights.last.map({ abs($0 - f.minY) > 0.01 }) ?? true { heights.append(f.minY) }
                    last = (f, home)
                }
                let t = "\(tag) pips=\(pips) hsi=\(hsi) voice=\(voice) badge=\(spectators)"
                XCTAssertLessThanOrEqual(big, sideways > 0 ? 1 : 2, "\(t): \(big) hops (\(sideways) sideways)")
                // one height, or a move up or down, or up over the row and back down to today's
                XCTAssertTrue(heights.count <= 2 || (heights.count == 3 && abs(heights[0] - heights[2]) <= 0.01 && heights[1] < heights[0]),
                              "\(t): heights \(heights)")
                if big > 0 { hopped += 1 }
                walked += 1
            }
        }
        XCTAssertEqual(walked, Self.configs.count * Self.rowStates.count)
        XCTAssertGreaterThan(hopped, 0)
    }

    /// The owner's games with bots (HSI, a bid of 4, no voice) on the 18 Pro, 17e and the closed
    /// Duo: today's spot while my hand ends past my seat's row, then one move left of the row,
    /// where it stays to the last card.
    func testTheOwnersHandMovesOnceAndStays() {
        let phones = [("iPhone 18 Pro", Self.pro18)] + SeatRowTests.configs.filter { ["iPhone 17e", "Duo closed (measured)"].contains($0.0) }
        XCTAssertEqual(phones.count, 3)
        for (tag, L) in phones {
            var frames: [CGRect] = [], homes: [CGRect] = []
            for n in stride(from: 13, through: 1, by: -1) {
                let k = AssistLayout.askKeeps(L, handCount: n, pipSlots: 4, hsi: true, voice: false)
                frames.append(AssistLayout.askFrame(k))
                homes.append(AssistLayout.askHome(hand: k.hand))
            }
            guard let first = frames.indices.first(where: { frames[$0] != homes[$0] }) else { XCTFail("\(tag): never moved"); continue }
            XCTAssertGreaterThanOrEqual(13 - first, 2, "\(tag): the short hand moves (\(13 - first) cards)")
            XCTAssertLessThanOrEqual(13 - first, 8, "\(tag): a full hand keeps today's spot")
            XCTAssertEqual(Set(frames[first...].map { "\($0)" }).count, 1, "\(tag): one spot from \(13 - first) cards down: \(frames[first...])")
            XCTAssertEqual(frames[first].minY, homes[first].minY, "\(tag): the same height")
        }
    }

    /// The lanes round my seat's row on a made-up table: left of the row at the home's height
    /// while that is clear for every hand size the row blocks; else (something on that spot)
    /// straight up over the row at the hand's right end; else (both taken) the nearest clear spot.
    func testTheLaneIsLeftOfTheRowElseOverIt() {
        // hands 120...280 pt wide centred on x = 200, their lifted tops at y = 700
        let hands = stride(from: CGFloat(120), through: 280, by: 40).map { CGRect(x: 200 - $0 / 2, y: 700, width: $0, height: 150) }
        let hsi = CGRect(x: 230, y: 670, width: 74, height: 20)
        var k = AssistLayout.AskKeeps(hand: hands[0], drawn: ["hsi": hsi], bounds: CGRect(x: 0, y: 100, width: 400, height: 800), hands: hands)
        // every hand's home is on HSI
        XCTAssertTrue(hands.allSatisfy { AssistLayout.askProblems(AssistLayout.askHome(hand: $0), k.with(hand: $0)) == ["hsi"] })
        let left = hsi.minX - AssistLayout.askGap - AssistLayout.askSize - (AssistLayout.askHit - AssistLayout.askSize) / 2
        XCTAssertEqual(AssistLayout.askLane(k), .left(left))
        for h in hands {
            let f = AssistLayout.askFrame(k.with(hand: h))
            XCTAssertEqual(f, CGRect(x: left, y: AssistLayout.askHome(hand: h).minY, width: 44, height: 44))
        }
        // something on that spot: up over HSI, at each hand's right end
        k.table = [CGRect(x: 150, y: 660, width: 60, height: 40)]
        let above = hsi.minY - AssistLayout.askGap - AssistLayout.askSize - (AssistLayout.askHit - AssistLayout.askSize) / 2
        XCTAssertEqual(AssistLayout.askLane(k), .lift(above))
        for h in hands {
            let f = AssistLayout.askFrame(k.with(hand: h))
            XCTAssertEqual(f, CGRect(x: AssistLayout.askHome(hand: h).minX, y: above, width: 44, height: 44))
            XCTAssertEqual(AssistLayout.askProblems(f, k.with(hand: h)), [])
        }
        // and over HSI too: no lane, the nearest clear spot (still clear, still on my hand)
        k.table.append(CGRect(x: 200, y: 560, width: 150, height: 70))
        XCTAssertNil(AssistLayout.askLane(k))
        for h in hands {
            let kh = k.with(hand: h), f = AssistLayout.askFrame(kh)
            XCTAssertEqual(AssistLayout.askProblems(f, kh), [], "\(h)")
            XCTAssertLessThanOrEqual(f.midX, h.maxX + 0.01)
            XCTAssertGreaterThanOrEqual(f.midX, h.minX - 0.01)
        }
        // the row in nobody's way: no lane
        XCTAssertNil(AssistLayout.askLane(AssistLayout.AskKeeps(hand: hands[0], drawn: ["hsi": hsi.offsetBy(dx: 0, dy: -300)],
                                                                bounds: k.bounds, hands: hands)))
    }

    func testTheLightbulbsProblemsNameWhatItCovers() {
        let hand = CGRect(x: 100, y: 700, width: 200, height: 150)
        let home = AssistLayout.askHome(hand: hand)
        XCTAssertEqual(AssistLayout.askButton(home).maxX, hand.maxX, "the button's right edge at the hand's right end")
        XCTAssertEqual(AssistLayout.askButton(home).maxY, hand.minY - 2, "2 pt above the lifted cards")
        let bounds = CGRect(x: 0, y: 100, width: 400, height: 800)
        let k = AssistLayout.AskKeeps(hand: hand, drawn: ["hsi": home.insetBy(dx: 10, dy: 10)], taps: ["voice": home.offsetBy(dx: 20, dy: 0)],
                                      table: [], bounds: bounds)
        XCTAssertEqual(AssistLayout.askProblems(home, k), ["hsi", "voice"])
        let f = AssistLayout.askFrame(k)
        XCTAssertEqual(AssistLayout.askProblems(f, k), [])
        XCTAssertTrue(bounds.contains(f))
        // a tap square past the safe area is off screen
        let edge = AssistLayout.AskKeeps(hand: CGRect(x: 300, y: 700, width: 100, height: 150), bounds: bounds)
        XCTAssertEqual(AssistLayout.askProblems(CGRect(x: 380, y: 600, width: 44, height: 44), edge), ["offscreen"])
    }
}

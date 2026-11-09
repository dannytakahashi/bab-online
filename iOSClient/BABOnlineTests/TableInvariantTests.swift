import XCTest
@testable import BAB_Online

/// The coexistence facts TableLayout's exempt pairs rely on (item 25), over
/// every recorded event log, after every event, reducer only:
///   - the bid panel shows only with an empty trick and an empty history,
///   - bid bubbles show only with my provisional card at most, and an empty history.
final class TableInvariantTests: XCTestCase {
    func testBidPanelAndBubblesNeverMeetTricksOrHistory() throws {
        var bidTurns = 0, bubbleStates = 0, events = 0
        for game in try RecordedGame.all() {
            for viewer in game.viewers {
                var replay = ReducerReplay(viewer: viewer)
                var failures = 0
                for e in game.logs[viewer.label] ?? [] {
                    try replay.apply(e)
                    events += 1
                    let s = replay.state
                    let model = TableRenderModel(s)
                    let historyEmpty = model.history.team1 == 0 && model.history.team2 == 0
                    switch s.myTurn {
                    case .choosing(.bid), .submitted(.bid, _):
                        bidTurns += 1
                        if (!model.trick.isEmpty || !historyEmpty) && failures < 3 {
                            failures += 1
                            XCTFail("\(game.name)/\(viewer.label) #\(e.i) \(e.event): bid turn with trick \(model.trick.count) history \(model.history)")
                        }
                    default: break
                    }
                    if !model.bidBubbles.isEmpty {
                        bubbleStates += 1
                        let me = s.table.viewer.position
                        let onlyMine = model.trick.count <= 1 && model.trick.allSatisfy { $0.provisional && $0.position == me }
                        if (!onlyMine || !historyEmpty) && failures < 3 {
                            failures += 1
                            XCTFail("\(game.name)/\(viewer.label) #\(e.i) \(e.event): bid bubbles with trick \(model.trick) history \(model.history)")
                        }
                    }
                }
            }
        }
        XCTAssertGreaterThan(bidTurns, 50)
        XCTAssertGreaterThan(bubbleStates, 500)
        XCTAssertGreaterThan(events, 5000)
    }
}

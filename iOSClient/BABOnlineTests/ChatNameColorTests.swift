import XCTest
@testable import BAB_Online

/// Chat name colours (owner 2026-11-24: in a tournament lobby's chat the players' names were
/// similar shades of green): every chat (main room, game lobby, tournament lobby) gives each
/// name a hue at least 50 degrees from the names before it, the web's `generateDistinctColor`
/// (client/src/utils/colors.js), and the hash is the web's to the bit. Expected values are the
/// web module's output (node, 2026-11-24).
final class ChatNameColorTests: XCTestCase {

    func testTheHashIsTheWebs() {
        // web hashToHue: 32-bit, UTF-16 code units (iOS before 1.2.6 differed past six letters)
        let web: [(String, Double)] = [("iosplay1", 109), ("iosplay2", 110), ("zach", 213), ("kim", 154),
                                       ("Bartholomew", 43), ("test1", 194), ("test2", 193), ("test3", 192),
                                       ("alice", 287), ("bob", 42)]
        for (name, hue) in web { XCTAssertEqual(UsernameColor.hashToHue(name), hue, name) }
    }

    func testCloseNamesGetDistinctHuesAsOnTheWeb() {
        // iosplay1 / iosplay2 hash to 109 / 110: both green before 1.2.6
        XCTAssertEqual(UsernameColor.distinctHues(["iosplay1", "iosplay2", "zach", "kim"]),
                       ["iosplay1": 109, "iosplay2": 177, "zach": 280, "kim": 355])
        XCTAssertEqual(UsernameColor.distinctHues(["test1", "test2", "test3", "iosplay1", "iosplay2"]),
                       ["test1": 194, "test2": 260, "test3": 326, "iosplay1": 109, "iosplay2": 18])
    }

    func testEachNameKeepsItsHueAndSystemLinesTakeNone() {
        let lines = [
            ChatMessage(username: "iosplay1", message: "hi"),
            ChatMessage(username: "", message: "Round 1 begins", type: .system),
            ChatMessage(username: "iosplay2", message: "hey"),
            ChatMessage(username: "iosplay1", message: "gl"),
        ]
        let hues = UsernameColor.distinctHues(for: lines)
        XCTAssertEqual(hues, ["iosplay1": 109, "iosplay2": 177])
        XCTAssertGreaterThanOrEqual(UsernameColor.hueDistance(hues["iosplay1"]!, hues["iosplay2"]!), UsernameColor.minHueDistance)
        // a later line never recolours an earlier name
        let more = UsernameColor.distinctHues(for: lines + [ChatMessage(username: "kim", message: "o/")])
        XCTAssertEqual(more["iosplay1"], 109)
        XCTAssertEqual(more["iosplay2"], 177)
    }

    func testManyNamesStillGetAHue() {
        let names = (1...12).map { "player\($0)" }
        let hues = UsernameColor.distinctHues(names)
        XCTAssertEqual(hues.count, 12)
        XCTAssertTrue(hues.values.allSatisfy { (0..<360).contains($0) })
        // the first seven are pairwise 50 degrees apart where the circle allows it
        XCTAssertGreaterThanOrEqual(UsernameColor.hueDistance(hues["player1"]!, hues["player2"]!), 50)
    }
}

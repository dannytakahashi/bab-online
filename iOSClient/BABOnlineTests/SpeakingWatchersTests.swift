import XCTest
@testable import BAB_Online

/// The spectator badge's speaking outline (SpeakingWatchers, State/Table/SpeakingWatchers.swift):
/// which talking voice peers light the eye. A spectator yes; a seated player (their seat glows),
/// me (my mic's ring) and a human entrant before seating no; a peer with no username lights it
/// only when no seat's socket is its; a stop, or the watcher leaving the list, clears it.
final class SpeakingWatchersTests: XCTestCase {
    /// T.dealtState's table: seats me (sid-me), L (bot:l), P (sid-p), R (bot:r); then a list.
    private func table(watchers: [String], count: Int? = nil) -> TableState {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("spectatorsUpdated", [
            "gameId": "g1", "spectators": watchers.enumerated().map { ["username": $1, "pic": 10 + $0] }, "count": count ?? watchers.count,
        ]))
        return s
    }

    private func pick(_ s: TableState, _ talking: [String: String?], me: String? = "me") -> SpeakingWatchers {
        SpeakingWatchers.select(speaking: Set(talking.keys), username: { talking[$0] ?? nil }, players: s.players, me: me)
    }

    func testASpectatorTalkingLightsTheEye() {
        let s = table(watchers: ["bo", "cy"])
        let w = pick(s, ["sid-bo": "bo"])
        XCTAssertTrue(w.isLit)
        XCTAssertEqual(w.names, ["bo"])
        XCTAssertTrue(w.isTalking("bo"))
        XCTAssertFalse(w.isTalking("cy"))
        XCTAssertEqual(w.accessibilityValue, "bo is talking")
    }

    func testASeatedPlayerNeverLightsIt() {
        let s = table(watchers: ["bo"])
        // by username, by the seat's socket id with no username, and a lazy seat's owner
        XCTAssertFalse(pick(s, ["sid-p2": "P"]).isLit)
        XCTAssertFalse(pick(s, ["sid-p": nil]).isLit)
        XCTAssertFalse(pick(s, ["sid-p": ""]).isLit)
        var lazy = s
        TableReducer.reduce(&lazy, T.ev("playerLazyMode", ["position": 3, "botUsername": "🤖 Mary", "botPic": 9, "originalUsername": "P", "seq": 3]))
        XCTAssertFalse(pick(lazy, ["sid-p2": "P"]).isLit, "the lazy owner still talks from their seat")
        // a seated player who is ALSO listed as watching (another tab) is still the seat's
        XCTAssertFalse(pick(table(watchers: ["P"]), ["sid-x": "P"]).isLit)
        // with a spectator talking too, only the spectator counts
        XCTAssertEqual(pick(s, ["sid-p": "P", "sid-bo": "bo"]).names, ["bo"])
    }

    func testMyOwnTalkingIsMyMicsNeverTheEyes() {
        // a spectator viewer: I am in the list, my own level is "self"
        let s = table(watchers: ["zach", "yan"])
        XCTAssertFalse(pick(s, ["self": nil], me: "zach").isLit)
        XCTAssertFalse(pick(s, ["self": "zach"], me: "zach").isLit)
        XCTAssertFalse(pick(s, ["sid-zach2": "zach"], me: "zach").isLit, "my other tab is still me")
        XCTAssertEqual(pick(s, ["self": nil, "sid-yan": "yan"], me: "zach").names, ["yan"])
    }

    func testAPeerWithNoNameLightsItOnlyOffTheSeats() {
        let s = table(watchers: ["bo"])
        let w = pick(s, ["sid-q": nil])
        XCTAssertTrue(w.isLit, "a voice member at no seat is a spectator")
        XCTAssertEqual(w.names, [])
        XCTAssertEqual(w.unnamed, 1)
        XCTAssertEqual(w.accessibilityValue, "A spectator is talking")
        XCTAssertEqual(pick(s, ["sid-q": nil, "sid-bo": "bo"]).accessibilityValue, "bo and a spectator are talking")
        XCTAssertEqual(pick(s, ["sid-q": nil, "sid-r": ""]).accessibilityValue, "2 spectators are talking")
        XCTAssertFalse(pick(s, ["sid-me": nil]).isLit, "my seat's socket")
    }

    func testANamedPeerTheListDoesNotNameCountsOnlyWhileTheListIsCut() {
        let s = table(watchers: ["bo"])
        XCTAssertFalse(pick(s, ["sid-dee": "dee"]).isLit, "dee left (the list dropped her) or was never watching")
        // more watchers than names (the server lists at most 50): dee may be past the cut
        let cut = table(watchers: ["bo"], count: 60)
        XCTAssertEqual(pick(cut, ["sid-dee": "dee", "sid-bo": "bo"]).names, ["bo", "dee"])
        // still never a seat
        XCTAssertFalse(pick(cut, ["sid-p2": "P"]).isLit)
    }

    func testAnEntrantBeforeSeatingIsNotASpectator() {
        var s = table(watchers: ["bo"], count: 60)
        s.players.entrantHumans = ["gus"]
        XCTAssertFalse(pick(s, ["sid-gus": "gus"]).isLit)
    }

    func testTheWordsPastTwoAndTheListOrder() {
        let s = table(watchers: ["cy", "bo", "al"])
        XCTAssertEqual(pick(s, ["1": "bo", "2": "cy"]).accessibilityValue, "cy and bo are talking", "the list's order")
        XCTAssertEqual(pick(s, ["1": "bo", "2": "cy", "3": "al"]).accessibilityValue, "3 spectators are talking")
        XCTAssertEqual(pick(s, [:]).accessibilityValue, "")
        XCTAssertEqual(pick(s, [:]), .none)
    }

    func testAStopOrALeaveClearsIt() {
        var s = table(watchers: ["bo", "cy"])
        XCTAssertTrue(pick(s, ["sid-bo": "bo"]).isLit)
        // the stop: the peer is out of speakingPeers
        XCTAssertFalse(pick(s, [:]).isLit)
        // the leave: the list drops bo while his call (and its level) may last a moment longer
        TableReducer.reduce(&s, T.ev("spectatorsUpdated", ["gameId": "g1", "spectators": [["username": "cy", "pic": 3]], "count": 1]))
        XCTAssertFalse(pick(s, ["sid-bo": "bo"]).isLit)
        XCTAssertTrue(pick(s, ["sid-cy": "cy"]).isLit)
    }

    /// The outline is Theme.success, the speaking rings' green, over the lit felt and over the
    /// badge's own fill (surface.s2@0.86 on the felt): at least the 3:1 of a UI glyph (the app is
    /// dark only, `preferredColorScheme(.dark)`, so one appearance covers both).
    func testTheOutlineReadsOnTheFelt() throws {
        let success = Theme.Palette.success
        for felt in ["felt.light", "felt.base", "felt.deep"] {
            let bg = try XCTUnwrap(Theme.colorsByPath[felt])
            XCTAssertGreaterThanOrEqual(HSIScale.contrast(success, bg), 3, felt)
            // the badge's fill over that felt
            let s2 = Theme.Palette.Surface.s2, a = 0.86
            func mix(_ t: Double, _ b: Double) -> Double { t * a + b * (1 - a) }
            let r = mix(s2.red, bg.red), g = mix(s2.green, bg.green), b = mix(s2.blue, bg.blue)
            func byte(_ v: Double) -> UInt32 { UInt32((v * 255).rounded()) }
            let fill = ThemeColor(byte(r) << 16 | byte(g) << 8 | byte(b))
            XCTAssertGreaterThanOrEqual(HSIScale.contrast(success, fill), 3, "on the badge over \(felt)")
        }
    }
}

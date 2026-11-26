import XCTest
@testable import BAB_Online

/// Badges on iOS (1.2.7 (41); the web's client/src/ui/components/Badges.js): the cap, the
/// earned badges' decoding (lenient: an absent or unreadable field is none, a bad entry is
/// dropped), the profile replies and ProfileState, the toast's words, and its queue
/// (BadgeAwards: every award waits its turn, a repeat is never toasted, the spot's other
/// toasts hold it, VoiceOver hears it once), and the art in the asset catalog.
@MainActor
final class BadgesTests: XCTestCase {
    private func wire(_ id: String, _ name: String, _ description: String = "d.") -> [String: Any] {
        ["id": id, "name": name, "description": description, "at": "2026-11-20T18:30:00.000Z"]
    }

    // MARK: - Cap and decoding

    func testTheBadgesCapIsSent() {
        XCTAssertEqual(Badges.cap, "badges")
        XCTAssertTrue(ClientHello.caps.contains("badges"), "only a socket with the cap gets badges and badgesAwarded")
        XCTAssertTrue((ClientHello.payload()["caps"] as? [String])?.contains("badges") == true)
    }

    func testBadgeIdsAreTheWebsFileNames() {
        for ok in ["felted", "five-hundred", "go-big-or-go-home", "a1-2b", String(repeating: "a", count: 40)] {
            XCTAssertTrue(Badges.isId(ok), ok)
        }
        for bad in ["", "Felted", "-felted", "felted-", "fel--ted", "fel ted", "fel_ted", "../felted", "felté",
                    String(repeating: "a", count: 41)] {
            XCTAssertFalse(Badges.isId(bad), bad)
        }
    }

    func testCleanKeepsTheServersOrderAndDropsWhatCannotBeDrawn() {
        let list: [Any] = [
            wire("felted", "Felted", "Ended a game with a negative score."),
            ["id": "century", "name": "Century"],               // no description: ""
            wire("felted", "Felted again"),                     // a repeated id: the first kept
            ["id": "Bad Id", "name": "Dropped"],
            ["id": "no-name", "name": ""],
            ["id": "no-name-2"],
            ["name": "No id"],
            ["id": 7, "name": "Number id"],
            "nonsense", NSNull(), 3,
            wire("hammer-time", "Hammer Time"),
        ]
        XCTAssertEqual(Badges.clean(list), [
            EarnedBadge(id: "felted", name: "Felted", description: "Ended a game with a negative score."),
            EarnedBadge(id: "century", name: "Century", description: ""),
            EarnedBadge(id: "hammer-time", name: "Hammer Time", description: "d."),
        ])
        for none in [nil, NSNull(), "felted", 3, [:] as [String: Any], [] as [Any]] as [Any?] {
            XCTAssertEqual(Badges.clean(none), [], "\(String(describing: none))")
        }
    }

    func testTheToastsWordsAreTheWebs() {
        XCTAssertEqual(Badges.earnedText([]), "")
        XCTAssertEqual(Badges.earnedText([EarnedBadge(id: "felted", name: "Felted", description: "")]), "Badge earned: Felted")
        XCTAssertEqual(Badges.earnedText([EarnedBadge(id: "felted", name: "Felted", description: ""),
                                          EarnedBadge(id: "five-hundred", name: "500", description: "")]),
                       "Badges earned: Felted, 500")
        XCTAssertEqual(Badges.artName("felted"), "Badges/felted")
    }

    // MARK: - Profiles

    private func profileReply(_ name: String, badges: Any?) -> [String: Any] {
        var r: [String: Any] = ["success": true, "scope": "human",
                                "profile": ["username": name, "profilePic": 3, "stats": ["gamesPlayed": 2]] as [String: Any]]
        if let badges { r["badges"] = badges }
        return r
    }

    func testAProfileReplyCarriesItsBadges() throws {
        let p = try XCTUnwrap(PlayerProfile.from(response: profileReply("kim", badges: [wire("felted", "Felted"), ["id": "x y"]])))
        XCTAssertEqual(p.badges.map(\.id), ["felted"])
        // absent (a server without badges, or a socket without the cap) or unreadable: none, and the reply still decodes
        XCTAssertEqual(try XCTUnwrap(PlayerProfile.from(response: profileReply("kim", badges: nil))).badges, [])
        XCTAssertEqual(try XCTUnwrap(PlayerProfile.from(response: profileReply("kim", badges: "felted"))).badges, [])
        XCTAssertEqual(try XCTUnwrap(PlayerProfile.from(response: profileReply("kim", badges: nil))).stats.gamesPlayed, 2)
    }

    func testMyBadgesComeWithEverySuccessAndGoWithTheAccount() {
        let s = ProfileState()
        s.sendOwn = { _ in }
        XCTAssertNil(s.ownBadges, "nothing said yet: no section")
        s.requestOwn(username: "ivy", scope: .human)
        s.applyOwn(response: profileReply("ivy", badges: [wire("felted", "Felted")]))
        XCTAssertEqual(s.ownBadges?.map(\.id), ["felted"])
        // a failure keeps what was said
        s.requestOwn(username: "ivy", scope: .bots)
        s.applyOwn(response: ["success": false, "message": "Database error"])
        XCTAssertEqual(s.ownBadges?.map(\.id), ["felted"])
        // another scope's reply says the same list (badges are whatever the scope); one without the field: none
        s.requestOwn(username: "ivy", scope: .bots)
        var bots = profileReply("ivy", badges: nil)
        bots["scope"] = "bots"
        s.applyOwn(response: bots)
        XCTAssertEqual(s.ownBadges, [])
        // another account starts from nothing
        s.requestOwn(username: "kim", scope: .human)
        XCTAssertNil(s.ownBadges)
    }

    func testAnotherPlayersBadges() {
        let s = ProfileState()
        s.sendPlayer = { _, _ in }
        s.view("kim", scope: .human)
        XCTAssertNil(s.viewed?.badges)
        s.applyPlayer(response: profileReply("kim", badges: [wire("five-hundred", "500"), wire("chemistry", "Chemistry")]))
        XCTAssertEqual(s.viewed?.badges?.map(\.name), ["500", "Chemistry"])
        // the next sheet starts empty
        s.view("bo", scope: .human)
        XCTAssertNil(s.viewed?.badges)
        s.applyPlayer(response: profileReply("bo", badges: []))
        XCTAssertEqual(s.viewed?.badges, [])
    }

    // MARK: - The toast's queue

    private final class Clock {
        var timers: [(at: TimeInterval, run: () -> Void)] = []
        var now: TimeInterval = 0
        func schedule(_ delay: TimeInterval, _ run: @escaping () -> Void) { timers.append((now + delay, run)) }
        func advance(_ by: TimeInterval) {
            now += by
            let due = timers.filter { $0.at <= now }
            timers.removeAll { $0.at <= now }
            due.forEach { $0.run() }
        }
    }

    private func awards() -> (BadgeAwards, Clock, () -> [String]) {
        let a = BadgeAwards()
        let clock = Clock()
        var said: [String] = []
        a.schedule = { clock.schedule($0, $1) }
        a.announce = { said.append($0) }
        return (a, clock, { said })
    }

    private func badge(_ id: String, _ name: String) -> EarnedBadge { EarnedBadge(id: id, name: name, description: "") }

    func testAwardsWaitTheirTurnInOrder() {
        let (a, clock, said) = awards()
        XCTAssertTrue(a.receive(["gameId": "g1", "badges": [wire("felted", "Felted"), wire("hurt-people-mode", "Hurt People Mode")]]))
        XCTAssertTrue(a.receive(["gameId": "g1", "badges": [wire("century", "Century")]]))
        XCTAssertEqual(a.shown?.text, "Badges earned: Felted, Hurt People Mode")
        XCTAssertEqual(a.waiting.map(\.text), ["Badge earned: Century"], "the second waits, never replaces the first")
        XCTAssertEqual(said(), ["Badges earned: Felted, Hurt People Mode"])

        clock.advance(BadgeAwards.visibleSeconds - 0.1)
        XCTAssertEqual(a.shown?.text, "Badges earned: Felted, Hurt People Mode")
        clock.advance(0.2)
        XCTAssertEqual(a.shown?.text, "Badge earned: Century", "its time is up: the next")
        XCTAssertEqual(said().last, "Badge earned: Century")
        // a tap dismisses it at once
        a.dismiss()
        XCTAssertNil(a.shown)
        XCTAssertNil(a.current)
        clock.advance(60)
        XCTAssertEqual(said().count, 2)
    }

    func testATapShowsTheNextAndItsOwnTimeRuns() {
        let (a, clock, _) = awards()
        a.enqueue(gameId: "g", badges: [badge("felted", "Felted")])
        clock.advance(5)
        a.enqueue(gameId: "g", badges: [badge("century", "Century")])
        a.dismiss()
        XCTAssertEqual(a.shown?.text, "Badge earned: Century")
        clock.advance(BadgeAwards.visibleSeconds - 5 + 0.1)
        XCTAssertEqual(a.shown?.text, "Badge earned: Century", "the first toast's timer does not end the second")
        clock.advance(5)
        XCTAssertNil(a.shown)
    }

    func testABadgeIsToastedOnce() {
        let (a, _, said) = awards()
        XCTAssertTrue(a.receive(["gameId": "g1", "badges": [wire("felted", "Felted")]]))
        XCTAssertFalse(a.receive(["gameId": "g1", "badges": [wire("felted", "Felted")]]), "a replay")
        // a later award with one known and one new badge names the new one only
        XCTAssertTrue(a.receive(["gameId": "g2", "badges": [wire("felted", "Felted"), wire("century", "Century")]]))
        XCTAssertEqual(a.waiting.map(\.text), ["Badge earned: Century"])
        XCTAssertEqual(said().count, 1)
        // nothing worth drawing: no toast
        XCTAssertFalse(a.receive(["gameId": "g3", "badges": []]))
        XCTAssertFalse(a.receive(["gameId": "g3", "badges": [["id": "Bad", "name": "x"]]]))
        XCTAssertFalse(a.receive(["gameId": "g3"]))
        XCTAssertFalse(a.receive([:]))
    }

    func testAtMostFourPicturesAndEveryName() {
        let (a, _, _) = awards()
        let five = ["felted", "hurt-people-mode", "in-the-red", "choke-artist", "exact-tie"].map { badge($0, $0) }
        a.enqueue(gameId: "g", badges: five)
        XCTAssertEqual(a.shown?.art.map(\.id), Array(five.prefix(4)).map(\.id))
        XCTAssertEqual(a.shown?.text, "Badges earned: felted, hurt-people-mode, in-the-red, choke-artist, exact-tie")
    }

    func testTheOtherToastsHoldItAndItThenShowsInFull() {
        let (a, clock, said) = awards()
        a.cover(.notice, true)
        a.enqueue(gameId: "g", badges: [badge("felted", "Felted")])
        XCTAssertNil(a.shown, "an error toast is in the spot")
        XCTAssertNotNil(a.current)
        XCTAssertEqual(said(), [], "not announced while hidden")
        clock.advance(30)
        XCTAssertNotNil(a.current, "its time does not run while covered")
        a.cover(.notice, false)
        XCTAssertEqual(a.shown?.text, "Badge earned: Felted")
        XCTAssertEqual(said(), ["Badge earned: Felted"])
        // covered mid-way: hidden, then its full time again, announced once
        clock.advance(4)
        a.cover(.connection, true)
        a.cover(.connection, true)
        XCTAssertNil(a.shown)
        clock.advance(BadgeAwards.visibleSeconds)
        XCTAssertNotNil(a.current, "the timer from before the cover does nothing")
        a.cover(.connection, false)
        clock.advance(BadgeAwards.visibleSeconds - 1)
        XCTAssertNotNil(a.shown)
        clock.advance(1.1)
        XCTAssertNil(a.current)
        XCTAssertEqual(said().count, 1)
    }

    func testTwoCoversBothHaveToGo() {
        let (a, _, _) = awards()
        a.enqueue(gameId: "g", badges: [badge("felted", "Felted")])
        a.cover(.notice, true)
        a.cover(.connection, true)
        a.cover(.notice, false)
        XCTAssertNil(a.shown)
        a.cover(.connection, false)
        XCTAssertNotNil(a.shown)
    }

    func testSignOutForgetsTheQueue() {
        let (a, clock, _) = awards()
        a.enqueue(gameId: "g", badges: [badge("felted", "Felted")])
        a.enqueue(gameId: "g", badges: [badge("century", "Century")])
        a.reset()
        XCTAssertNil(a.current)
        XCTAssertEqual(a.waiting, [])
        clock.advance(60)
        XCTAssertNil(a.current)
        // the next account's badges toast afresh
        XCTAssertTrue(a.enqueue(gameId: "g", badges: [badge("felted", "Felted")]))
    }

    func testTheQueueIsBounded() {
        let (a, _, _) = awards()
        for i in 0..<(BadgeAwards.maxWaiting + 5) { a.enqueue(gameId: "g", badges: [badge("b\(i)", "B\(i)")]) }
        XCTAssertEqual(a.current?.text, "Badge earned: B0")
        XCTAssertEqual(a.waiting.count, BadgeAwards.maxWaiting)
        XCTAssertEqual(a.waiting.first?.text, "Badge earned: B1", "the oldest are kept")
    }

    // MARK: - The art

    /// Every badge of the web's art folder is in the app's catalog (Misc.xcassets/Badges, the
    /// same files: server/game/__tests__/badges.test.js), and an id with no art has none.
    func testEveryBadgeHasItsArtInTheCatalog() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let ids = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("client/assets/badges").path)
            .filter { $0.hasSuffix(".svg") }.map { String($0.dropLast(4)) }
        XCTAssertEqual(ids.count, 20)
        for id in ids {
            XCTAssertTrue(Badges.isId(id), id)
            XCTAssertTrue(BadgeArt.exists(id), id)
            let image = try XCTUnwrap(PlatformImage(named: Badges.artName(id)), id)
            XCTAssertEqual(image.size, CGSize(width: 96, height: 96), "\(id): the SVG's 96 x 96 view box")
        }
        XCTAssertFalse(BadgeArt.exists("brand-new-badge"))
        XCTAssertFalse(BadgeArt.exists("../felted"))
    }
}

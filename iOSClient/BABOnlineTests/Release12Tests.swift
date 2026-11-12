import XCTest
import SpriteKit
import SwiftUI
@preconcurrency import WebRTC
@testable import BAB_Online

/// iOS 1.2 (roadmap 29 track): spectator badge + bubble, resignation clearing,
/// serverError, clientHello, avatar URLs, voice TURN, and both wire forms the
/// app must read while the server's V1 removals land.
final class SpectatorStateTests: XCTestCase {
    private let fan: [String: Any] = ["username": "fan", "pic": 12]

    func testEventSetsTheWholeListAndGoesAroundTheSeqGate() {
        var s = T.dealtState()
        let last = s.sync.lastSeq
        TableReducer.reduce(&s, T.ev("spectatorsUpdated", ["gameId": "g1", "spectators": [fan, ["username": "zed", "pic": NSNull(), "avatarUrl": "/avatar/zed?v=0123456789abcdef"]], "count": 2]))
        XCTAssertEqual(s.players.watching.count, 2)
        XCTAssertEqual(s.players.watching.spectators.map(\.username), ["fan", "zed"])
        XCTAssertEqual(s.players.watching.spectators[1].pictureKey, "/avatar/zed?v=0123456789abcdef")
        XCTAssertEqual(s.players.watching.spectators[0].pictureKey, "12")
        XCTAssertEqual(s.sync.lastSeq, last, "unsequenced: the gate never moves")
        XCTAssertEqual(s.players.spectatorCount, 0, "spectatorCount stays the socket count of the notices")
        // the whole list each time: an empty one clears
        TableReducer.reduce(&s, T.ev("spectatorsUpdated", ["gameId": "g1", "spectators": [], "count": 0]))
        XCTAssertEqual(s.players.watching, WatchingList())
    }

    func testDecodedWithoutSeqEvenIfOneWereSent() {
        guard case .success(let ev) = ServerEvent.decode(name: "spectatorsUpdated", payload: [["gameId": "g1", "spectators": [], "count": 0, "seq": 99]]) else { return XCTFail() }
        XCTAssertNil(ev.seq)
        var s = T.dealtState()
        TableReducer.reduce(&s, .server(ev))
        XCTAssertEqual(s.sync.lastSeq, 2)
        XCTAssertTrue(s.sync.buffered.isEmpty)
    }

    func testAppliedAtOnceWhileAGapIsBuffered() {
        var s = T.dealtState()
        let fx = TableReducer.reduce(&s, T.ev("updateTurn", ["currentTurn": 1, "seq": 5]))  // a gap (expected 3)
        XCTAssertTrue(fx.contains { if case .gap = $0 { return true }; return false })
        TableReducer.reduce(&s, T.ev("spectatorsUpdated", ["gameId": "g1", "spectators": [fan], "count": 1]))
        XCTAssertEqual(s.players.watching.count, 1, "not buffered behind the gap")
        XCTAssertEqual(s.sync.buffered.count, 1)
    }

    func testAnotherGamesListIsDropped() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("spectatorsUpdated", ["gameId": "other", "spectators": [fan], "count": 1]))
        XCTAssertEqual(s.players.watching.count, 0)
    }

    func testSnapshotSetsItAndANewGameClearsIt() throws {
        let snap = try T.snapshot("between-tricks") { raw in
            raw["watching"] = ["spectators": [["username": "fan", "pic": 3]], "count": 7]
        }
        var s = TableState()
        TableReducer.reduce(&s, .snapshot(snap, .rejoin, hints: nil))
        XCTAssertEqual(s.players.watching.count, 7)
        XCTAssertEqual(s.players.watching.spectators.first?.username, "fan")
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "next-game", tournamentId: nil)))
        XCTAssertEqual(s.players.watching, WatchingList())
        TableReducer.reduce(&s, .snapshot(snap, .rejoin, hints: nil))
        TableReducer.reduce(&s, .local(.reset))
        XCTAssertEqual(s.players.watching, WatchingList())
    }

    func testAccessibilityLabel() {
        XCTAssertEqual(WatchingList(spectators: [], count: 1).accessibilityLabel, "1 person watching")
        XCTAssertEqual(WatchingList(spectators: [], count: 2).accessibilityLabel, "2 people watching")
    }

    @MainActor
    func testTheHandlerRoutesIt() {
        XCTAssertTrue(GameSocketHandler.events.contains(SocketEvents.Server.spectatorsUpdated))
        let h = ReplayHarness()
        h.store.apply(.local(.enterGameContext(gameId: "g9", tournamentId: nil)))
        h.handler.handle(event: "spectatorsUpdated", payload: [["gameId": "g9", "spectators": [["username": "a", "pic": 1]], "count": 1]])
        XCTAssertEqual(h.store.watching.count, 1)
    }
}

final class ChatRoutingTests: XCTestCase {
    private func bubbles(_ data: [String: Any]) -> [TableAnimation] {
        var s = T.dealtState()
        var d = data
        d["seq"] = 3
        return TableReducer.reduce(&s, T.ev("chatMessage", d)).animations
    }

    func testIsSpectatorRoutesToTheBadgeBubble() {
        // the server after V1_REMOVALS #12: no `type`
        XCTAssertEqual(bubbles(["username": "fan", "message": "hi", "position": NSNull(), "isSpectator": true]),
                       [.spectatorChatBubble(username: "fan", message: "hi")])
        // a watching owner's line with a position still goes by the badge
        XCTAssertEqual(bubbles(["username": "own", "message": "hey", "position": 2, "isSpectator": true]),
                       [.spectatorChatBubble(username: "own", message: "hey")])
    }

    func testPlayersKeepTheirSeat() {
        XCTAssertEqual(bubbles(["username": "P", "message": "gg", "position": 3, "isSpectator": false]),
                       [.chatBubble(position: 3, message: "gg")])
        // today's server: both keys
        XCTAssertEqual(bubbles(["username": "P", "message": "gg", "position": 3, "isSpectator": false, "type": "player"]),
                       [.chatBubble(position: 3, message: "gg")])
    }

    func testOlderServerTypeOnly() {
        XCTAssertEqual(bubbles(["username": "fan", "message": "yo", "position": NSNull(), "type": "spectator"]),
                       [.spectatorChatBubble(username: "fan", message: "yo")])
    }

    func testLogKeepsTheSpectatorType() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("chatMessage", ["username": "fan", "message": "hi", "isSpectator": true, "seq": 3]))
        XCTAssertEqual(s.log.entries.last?.type, .spectator)
    }
}

final class WireFormsTests: XCTestCase {
    private func played(_ extra: [String: Any]) -> TableState {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("doneBidding", ["bids": ["1", "1", "1", "1"], "lead": 2, "seq": 3]))
        var d: [String: Any] = ["card": T.card("diamonds", "9"), "position": 2, "seq": 4]
        d.merge(extra) { $1 }
        TableReducer.reduce(&s, T.ev("cardPlayed", d))
        return s
    }

    func testCardPlayedOldAndNewForms() {
        XCTAssertEqual(played(["trump": true]).table.deal?.trumpBroken, true, "today: trump (a Bool) only")
        XCTAssertEqual(played(["trumpBroken": true]).table.deal?.trumpBroken, true, "after V1_REMOVALS #10: trumpBroken only")
        XCTAssertEqual(played(["trump": false, "trumpBroken": true, "playerId": "s"]).table.deal?.trumpBroken, true, "both: trumpBroken wins")
        XCTAssertEqual(played([:]).table.deal?.trumpBroken, false)
    }

    func testServerErrorBothShapesDecode() throws {
        let legacy = try Wire.decode(WirePayload.ServerError.self, ["type": "rateLimit", "message": "Slow down"] as [String: Any], strict: true)
        XCTAssertEqual(legacy.message, "Slow down")
        let v2 = try Wire.decode(WirePayload.ServerError.self, ["code": "rate_limit", "message": "Slow down", "handler": "playCard"] as [String: Any], strict: true)
        XCTAssertEqual(v2.code, "rate_limit")
        XCTAssertEqual(v2.handler, "playCard")
    }
}

final class ResignationClearingTests: XCTestCase {
    /// Seats 2 and 4 resignable, the offer on 2.
    private func offered() -> TableState {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("playerDisconnected", ["position": 2, "username": "L", "seq": 3]))
        TableReducer.reduce(&s, T.ev("playerDisconnected", ["position": 4, "username": "R", "seq": 4]))
        TableReducer.reduce(&s, T.ev("resignationAvailable", ["position": 4, "username": "R", "seq": 5]))
        TableReducer.reduce(&s, T.ev("resignationAvailable", ["position": 2, "username": "L", "seq": 6]))
        XCTAssertEqual(s.players.resignationOffer?.position, 2)
        return s
    }

    func testReconnectOfTheOfferedSeatClearsIt() {
        var s = offered()
        TableReducer.reduce(&s, T.ev("playerReconnected", ["position": 2, "username": "L", "seq": 7]))
        XCTAssertNil(s.players.resignationOffer)
        XCTAssertEqual(s.players.seats[2]?.presence, .connected)
    }

    func testReconnectOfAnotherSeatKeepsIt() {
        var s = offered()
        TableReducer.reduce(&s, T.ev("playerReconnected", ["position": 4, "username": "R", "seq": 7]))
        XCTAssertEqual(s.players.resignationOffer?.position, 2)
    }

    func testTheOfferMoving() {
        var s = offered()
        // the server re-offers the next resignable seat after a reconnect (reofferAfter)
        TableReducer.reduce(&s, T.ev("playerReconnected", ["position": 2, "username": "L", "seq": 7]))
        TableReducer.reduce(&s, T.ev("resignationAvailable", ["position": 4, "username": "R", "seq": 8]))
        XCTAssertEqual(s.players.resignationOffer, ResignationOffer(position: 4, username: "R"))
        // any resign takes the standing offer down
        TableReducer.reduce(&s, T.ev("playerResigned", ["position": 4, "oldUsername": "R", "botUsername": "🤖 Mary", "botPic": 5, "seq": 9]))
        XCTAssertNil(s.players.resignationOffer)
    }

    func testActiveModeAtTheOfferedSeatClearsIt() {
        var s = offered()
        TableReducer.reduce(&s, T.ev("playerActiveMode", ["position": 2, "username": "L", "pic": 2, "seq": 7]))
        XCTAssertNil(s.players.resignationOffer)
    }

    func testSnapshotReplacesIt() throws {
        var s = offered()
        // a snapshot with no offered seat (the offer is gone server-side): cleared
        let plain = try T.snapshot("between-tricks")
        XCTAssertFalse(plain.seats.contains(where: \.offered))
        TableReducer.reduce(&s, .snapshot(plain, .requested("gap-1"), hints: nil))
        XCTAssertNil(s.players.resignationOffer)
    }

    @MainActor
    func testTheViewHidesAnOfferWhoseSeatIsNotResignable() {
        let h = ReplayHarness()
        h.store.apply(.local(.identity(username: "me", playerId: "sid-me")))
        h.store.apply(.local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        h.store.apply(T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["sid-me", "s2", "s3", "s4"],
                                              "usernames": [["username": "me"], ["username": "L"], ["username": "P"], ["username": "R"]], "pics": [1, 2, 3, 4], "seq": 1]))
        // an offer whose seat never went resignable on this client (an out-of-order replay)
        h.store.apply(T.ev("resignationAvailable", ["position": 2, "username": "L", "seq": 2]))
        XCTAssertEqual(h.store.resignationAvailable?.position, 2)
        h.store.apply(T.ev("playerDisconnected", ["position": 2, "username": "L", "seq": 3]))  // never downgrades resignable
        XCTAssertEqual(h.store.resignationAvailable?.position, 2)
        h.store.apply(T.ev("playerReconnected", ["position": 2, "username": "L", "seq": 4]))
        XCTAssertNil(h.store.resignationAvailable)
    }
}

final class ServerErrorDedupeTests: XCTestCase {
    func testTwinsFromBothChannelsShowOnce() {
        var d = ServerErrorDeduper()
        let t = Date()
        XCTAssertTrue(d.accept(.error, message: "Not your turn", handler: "playCard", at: t))
        XCTAssertFalse(d.accept(.serverError, message: "Not your turn", handler: "playCard", at: t.addingTimeInterval(0.01)))
        // either order
        XCTAssertTrue(d.accept(.serverError, message: "Lobby full", handler: "joinLobby", at: t.addingTimeInterval(2)))
        XCTAssertFalse(d.accept(.error, message: "Lobby full", handler: "joinLobby", at: t.addingTimeInterval(2.01)))
    }

    func testARepeatOnTheSameChannelIsANewFailure() {
        var d = ServerErrorDeduper()
        let t = Date()
        XCTAssertTrue(d.accept(.error, message: "Slow down", handler: nil, at: t))
        XCTAssertTrue(d.accept(.error, message: "Slow down", handler: nil, at: t.addingTimeInterval(0.1)))
        // phase B (serverError only): every one shows
        var b = ServerErrorDeduper()
        XCTAssertTrue(b.accept(.serverError, message: "x", handler: "playCard", at: t))
        XCTAssertTrue(b.accept(.serverError, message: "x", handler: "playCard", at: t.addingTimeInterval(0.1)))
    }

    func testDifferentFailuresAndLateTwins() {
        var d = ServerErrorDeduper()
        let t = Date()
        XCTAssertTrue(d.accept(.error, message: "A", handler: nil, at: t))
        XCTAssertTrue(d.accept(.serverError, message: "B", handler: nil, at: t), "another message without a handler")
        XCTAssertTrue(d.accept(.error, message: "C", handler: "playerBid", at: t))
        XCTAssertTrue(d.accept(.serverError, message: "C", handler: "playerBid", at: t.addingTimeInterval(ServerErrorDeduper.window + 0.1)), "too late to be a twin")
        // the same handler, worded differently by the two channels: still one failure
        var w = ServerErrorDeduper()
        XCTAssertTrue(w.accept(.error, message: "Card not in hand", handler: "playCard", at: t))
        XCTAssertFalse(w.accept(.serverError, message: "That card is not in your hand", handler: "playCard", at: t))
    }

    @MainActor
    func testOneToastAndOneTableRouteperFailure() throws {
        let h = ReplayHarness()
        h.store.apply(.snapshot(try T.snapshot("trick-mid-lead3"), .rejoin, hints: nil))
        var routed = 0
        h.store.effectObserver = { _ in routed += 1 }
        let svc = SocketService.shared
        let saved = svc.gameState
        svc.gameState = h.store
        defer { svc.gameState = saved }
        let t = Date().addingTimeInterval(1000)
        svc.handleServerError(["message": "Too many requests", "handler": "requestSnapshot"], channel: .error, at: t)
        let first = svc.serverError
        XCTAssertEqual(first?.message, "Too many requests")
        XCTAssertEqual(routed, 1, "the table route ran (transportError)")
        svc.handleServerError(["code": "rate_limit", "message": "Too many requests", "handler": "requestSnapshot"], channel: .serverError, at: t)
        XCTAssertEqual(svc.serverError?.id, first?.id, "the twin shows no second toast")
        XCTAssertEqual(routed, 1, "and no second table route")
        svc.handleServerError(["message": "Too many requests", "handler": "requestSnapshot"], channel: .error, at: t.addingTimeInterval(5))
        XCTAssertNotEqual(svc.serverError?.id, first?.id, "a later failure shows again")
        XCTAssertEqual(routed, 2)
    }
}

final class ClientHelloTests: XCTestCase {
    func testPayloadAndCaps() {
        let p = ClientHello.payload(version: "1.2.0", build: "3")
        XCTAssertEqual(p["client"] as? String, "ios")
        XCTAssertEqual(p["version"] as? String, "1.2.0")
        XCTAssertEqual(p["build"] as? String, "3")
        XCTAssertEqual(p["caps"] as? [String], ["avatarUrl"])
        // contract/src/c2s.js clientHello: client ^[a-z0-9-]+$ (1-16), version 1-32, build <= 64, caps <= 16
        XCTAssertNotNil((p["client"] as? String)?.range(of: #"^[a-z0-9-]{1,16}$"#, options: .regularExpression))
        XCTAssertLessThanOrEqual((ClientHello.payload(version: String(repeating: "9", count: 50), build: "1")["version"] as? String)?.count ?? 99, 32)
    }

    func testThisBuildsVersion() {
        let p = ClientHello.payload()
        XCTAssertEqual(p["version"] as? String, AppInfo.version)
        XCTAssertEqual(p["build"] as? String, AppInfo.build)
        XCTAssertGreaterThanOrEqual(Int(AppInfo.build) ?? 0, 3)
    }

    func testDebugServerOverrideAcceptsOnlyLocalOrigins() {
        XCTAssertEqual(ServerConfig.validLocalOrigin("http://localhost:3973"), "http://localhost:3973")
        XCTAssertEqual(ServerConfig.validLocalOrigin("http://127.0.0.1:3973/"), "http://127.0.0.1:3973")
        XCTAssertNil(ServerConfig.validLocalOrigin("https://example.com"))
        XCTAssertNil(ServerConfig.validLocalOrigin("http://localhost:3973/x"))
        XCTAssertNil(ServerConfig.validLocalOrigin("ftp://localhost"))
        XCTAssertNil(ServerConfig.validLocalOrigin("http://localhost.evil.test"))
    }
}

final class AvatarUrlTests: XCTestCase {
    private let url = "/avatar/P?v=0123456789abcdef"

    func testGameStartTakesAvatarUrls() {
        var s = T.dealtState()
        TableReducer.reduce(&s, T.ev("gameStart", [
            "gameId": "g1", "hand": [T.card("spades", "2")], "trump": T.card("clubs", "3"), "dealer": 1, "position": 1, "currentHand": 3,
            "score1": 0, "score2": 0, "seq": 3,
            "playerInfo": [["position": 3, "username": "P", "pic": NSNull()], ["position": 2, "username": "L", "pic": 2]],
            "avatarUrls": ["3": url],
        ]))
        XCTAssertEqual(s.players.seats[3]?.avatarUrl, url)
        XCTAssertNil(s.players.seats[2]?.avatarUrl)
        let model = TableRenderModel(s)
        let p = model.opponents.first { $0.position == 3 }!
        XCTAssertEqual(p.pictureKey, url, "the URL first")
        XCTAssertEqual(model.opponents.first { $0.position == 2 }?.pictureKey, "2")
    }

    func testInlineFallbackAndRejoinHints() throws {
        // positionUpdate: one room broadcast with the inline copy AND the URL
        var s = TableState()
        TableReducer.reduce(&s, .local(.enterGameContext(gameId: "g1", tournamentId: nil)))
        TableReducer.reduce(&s, T.ev("positionUpdate", ["positions": [1, 2, 3, 4], "sockets": ["a", "b", "c", "d"],
                                                       "usernames": [["username": "a"], ["username": "b"], ["username": "c"], ["username": "d"]],
                                                       "pics": [1, "data:image/webp;base64,AAAA", 3, 4], "avatarUrls": ["2": url], "seq": 1]))
        let o = TableRenderModel(s).opponents.first { $0.position == 2 }!
        XCTAssertEqual(o.pictureKey, url)
        XCTAssertEqual(o.fallbackPicture, "data:image/webp;base64,AAAA")
        // a rejoin carrier's avatarUrls fill in a custom seat the snapshot has no URL for
        let snap = try T.snapshot("between-tricks") { raw in
            var seats = raw["seats"] as! [[String: Any]]
            seats[1]["hasCustomPic"] = true
            seats[1]["customPic"] = NSNull()
            seats[1]["pic"] = NSNull()
            seats[1].removeValue(forKey: "avatarUrl")
            raw["seats"] = seats
        }
        var hints = LegacySeatHints()
        hints.avatarUrls[snap.seats[1].position] = url
        var r = TableState()
        TableReducer.reduce(&r, .snapshot(snap, .rejoin, hints: hints))
        XCTAssertEqual(r.players.seats[snap.seats[1].position]?.avatarUrl, url)
    }

    func testRejoinEnvelopeDecodesAvatarUrls() throws {
        var dict: [String: Any] = ["gameId": "g", "avatarUrls": ["2": url], "players": [["position": 2, "username": "b", "pic": NSNull(), "socketId": "s2"]]]
        dict["snapshot"] = try FixtureLoader.v2Snapshot("between-tricks")
        guard case .success(let ev) = ServerEvent.decode(name: "rejoinSuccess", payload: [dict], strict: true),
              case .rejoinSuccess(let env) = ev.event else { return XCTFail() }
        XCTAssertEqual(env.hints.avatarUrls, [2: url])
    }

    @MainActor
    func testTextureCacheLoadsAvatarPathsOnce() {
        final class PathLoader: AvatarLoading {
            var paths: [String] = []
            var held: [(UIImage?) -> Void] = []
            func load(_ picNumber: Int, completion: @escaping (UIImage?) -> Void) { completion(nil) }
            func load(path: String, completion: @escaping (UIImage?) -> Void) { paths.append(path); held.append(completion) }
        }
        AvatarTextureCache.resetForTesting()
        let loader = PathLoader()
        var got = 0
        AvatarTextureCache.texture(for: url, loader: loader) { if $0 != nil { got += 1 } }
        AvatarTextureCache.texture(for: url, loader: loader) { if $0 != nil { got += 1 } }
        XCTAssertEqual(loader.paths, [url], "one fetch per picture version")
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { ctx in UIColor.red.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 4, height: 4)) }
        loader.held.forEach { $0(image) }
        XCTAssertEqual(got, 2)
        XCTAssertNotNil(AvatarTextureCache.cached(url))
        AvatarTextureCache.resetForTesting()
    }

    func testOnlySameOriginAvatarPaths() {
        XCTAssertTrue(HTTPAvatarLoader.isAvatarPath(url))
        XCTAssertFalse(HTTPAvatarLoader.isAvatarPath("https://evil.example/avatar/x"))
        XCTAssertFalse(HTTPAvatarLoader.isAvatarPath("/avatar//evil.example"))
        XCTAssertFalse(HTTPAvatarLoader.isAvatarPath("/assets/x.png"))
    }
}

final class VoicePeerSeatTests: XCTestCase {
    func testVoicePeersMapToSeatsByUsername() {
        var s = T.dealtState()
        // socket ids gone from the seats (V1_REMOVALS #9 / #14): the username still finds the seat
        s.players.socketBySeat = [:]
        let model = TableRenderModel(s)
        XCTAssertEqual(model.seat(forVoicePeer: "sid-p", username: "P"), 3)
        XCTAssertNil(model.seat(forVoicePeer: "sid-x", username: "nobody"))
        // a lazy seat shows its bot but the voice peer is the owner
        TableReducer.reduce(&s, T.ev("playerLazyMode", ["position": 3, "botUsername": "🤖 Mary", "botPic": 9, "originalUsername": "P", "seq": 3]))
        XCTAssertEqual(TableRenderModel(s).seat(forVoicePeer: "sid-p", username: "P"), 3)
    }

    func testSocketIdFallback() {
        let s = T.dealtState()
        XCTAssertEqual(TableRenderModel(s).seat(forVoicePeer: "sid-p", username: nil), 3)
    }
}

final class IcePolicyTests: XCTestCase {
    private let turnReply: [String: Any] = [
        "iceServers": [["urls": ["stun:stun.cloudflare.com:3478"]],
                       ["urls": ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp", "http://bad"],
                        "username": "u-test", "credential": "c-test"]],
        "turn": true, "expiresInSec": 14400, "requestId": "ice-1",
    ]

    func testTurnReply() {
        let now = Date()
        let c = IcePolicy.config(from: turnReply, username: "me", now: now)
        XCTAssertTrue(c.turn)
        XCTAssertFalse(c.fallback)
        XCTAssertEqual(c.servers.count, 2)
        XCTAssertEqual(c.servers[1].urls.count, 2, "only stun: / turn: / turns: URLs")
        XCTAssertEqual(c.servers[1].username, "u-test")
        XCTAssertEqual(c.expiresAt, now.addingTimeInterval(14400))
        XCTAssertTrue(IcePolicy.isReusable(c, username: "me", now: now))
        XCTAssertFalse(IcePolicy.isReusable(c, username: "someone else", now: now), "credentials are per user")
        XCTAssertFalse(IcePolicy.isReusable(c, username: "me", now: now.addingTimeInterval(14400 - 29 * 60)), "30 min before expiry: ask again")
        XCTAssertEqual(IcePolicy.refreshDelay(c, now: now), 14400 - 1800)
        // never printed: descriptions leave the credential out
        XCTAssertFalse("\(c) \(c.servers) \(String(reflecting: c.servers[1]))".contains("c-test"))
    }

    func testStunAnswerIsNeverReused() {
        let stun: [String: Any] = ["iceServers": [["urls": ["stun:stun.l.google.com:19302"]], ["urls": ["stun:stun1.l.google.com:19302"]]],
                                   "turn": false, "expiresInSec": NSNull()]
        let c = IcePolicy.config(from: stun, username: "me", now: Date())
        XCTAssertFalse(c.turn)
        XCTAssertNil(c.expiresAt)
        XCTAssertFalse(IcePolicy.isReusable(c, username: "me", now: Date()))
        XCTAssertNil(IcePolicy.refreshDelay(c, now: Date()))
    }

    func testMalformedOrMissingReplyFallsBackToStun() {
        for reply in [nil, ["iceServers": "x"], ["iceServers": [["urls": ["http://x"]]], "turn": true], [:]] as [[String: Any]?] {
            let c = IcePolicy.config(from: reply, username: "me", now: Date())
            XCTAssertEqual(c.servers, IcePolicy.stunServers)
            XCTAssertTrue(c.fallback)
            XCTAssertFalse(c.turn)
        }
    }

    func testRTCConfiguration() {
        let c = IcePolicy.config(from: turnReply, username: "me", now: Date())
        let rtc = VoiceChatManager.rtcConfiguration(c)
        XCTAssertEqual(rtc.iceServers.count, 2)
        XCTAssertEqual(rtc.iceServers[1].username, "u-test")
        XCTAssertEqual(rtc.iceServers[1].credential, "c-test")
        XCTAssertEqual(rtc.sdpSemantics, .unifiedPlan)
        let stun = VoiceChatManager.rtcConfiguration(nil)
        XCTAssertEqual(stun.iceServers.map(\.urlStrings), [["stun:stun.l.google.com:19302"], ["stun:stun1.l.google.com:19302"]])
    }
}

@MainActor
final class IceServerStoreTests: XCTestCase {
    func testAsksWithARequestIdAndUsesTheReply() async {
        var sent: [[String: Any]] = []
        let store = IceServerStore(timeout: 2, emit: { sent.append($0) })
        let task = Task { await store.ensure(username: "me") }
        await Task.yield()
        while sent.isEmpty { await Task.yield() }
        XCTAssertEqual(sent.first?["requestId"] as? String, "ice-1")
        store.handleReply(["requestId": "nope", "iceServers": [["urls": ["stun:x"]]], "turn": false])  // not ours: ignored
        XCTAssertTrue(store.hasPendingRequest)
        store.handleReply(["requestId": "ice-1", "iceServers": [["urls": ["turn:t:3478"], "username": "u", "credential": "c"]], "turn": true, "expiresInSec": 14400])
        let c = await task.value
        XCTAssertTrue(c.turn)
        // reused for the session: no second request
        _ = await store.ensure(username: "me")
        XCTAssertEqual(sent.count, 1)
    }

    func testTimeoutFallsBackToStunAndAsksAgainNextStart() async {
        var sent = 0
        let store = IceServerStore(timeout: 0.05, emit: { _ in sent += 1 })
        let c = await store.ensure(username: "me")
        XCTAssertTrue(c.fallback)
        XCTAssertEqual(c.servers, IcePolicy.stunServers)
        // a STUN answer is never kept: the next voice start (and every restart) asks again
        _ = await store.ensure(username: "me")
        XCTAssertEqual(sent, 2)
        // a late reply to the first request changes nothing
        store.handleReply(["requestId": "ice-1", "iceServers": [["urls": ["turn:t"]]], "turn": true])
        XCTAssertTrue(store.current?.fallback ?? false)
    }

    func testOneRequestInFlight() async {
        var sent: [[String: Any]] = []
        let store = IceServerStore(timeout: 2, emit: { sent.append($0) })
        async let a = store.fetch(username: "me")
        async let b = store.fetch(username: "me")
        while sent.isEmpty { await Task.yield() }
        store.handleReply(["requestId": "ice-1", "iceServers": [["urls": ["stun:s"]]], "turn": false, "expiresInSec": NSNull()])
        let (x, y) = await (a, b)
        XCTAssertEqual(x, y)
        XCTAssertEqual(sent.count, 1)
    }

    func testResetAnswersOpenRequestsAndForgets() async {
        let store = IceServerStore(timeout: 5, emit: { _ in })
        let task = Task { await store.fetch(username: "me") }
        while !store.hasPendingRequest { await Task.yield() }
        store.reset()
        let c = await task.value
        XCTAssertTrue(c.fallback)
        store.reset()
        XCTAssertNil(store.current)
    }
}

final class VoiceRecoveryTests: XCTestCase {
    func testLowerSocketIdRestartsOnceThenUnavailable() {
        var r = VoiceRecovery()
        XCTAssertEqual(r.failed("b-peer", myId: "a-me"), .restartAsOfferer)
        XCTAssertEqual(r.failed("b-peer", myId: "a-me"), .markUnavailable, "one restart only")
        XCTAssertTrue(r.unavailable.contains("b-peer"))
        XCTAssertEqual(r.failed("b-peer", myId: "a-me"), .none)
        // a later offer from the peer retries
        r.offered("b-peer")
        XCTAssertFalse(r.unavailable.contains("b-peer"))
    }

    func testHigherSocketIdWaitsForTheRestart() {
        var r = VoiceRecovery()
        XCTAssertEqual(r.failed("a-peer", myId: "b-me"), .waitForRestart)
        XCTAssertEqual(r.failed("a-peer", myId: "b-me"), .none, "already waiting")
        // the restart's offer arrives and the new connection comes up: all clear
        r.offered("a-peer")
        r.connected("a-peer")
        XCTAssertEqual(r, VoiceRecovery())
        // no offer in time
        XCTAssertEqual(r.failed("a-peer", myId: "b-me"), .waitForRestart)
        XCTAssertEqual(r.waitExpired("a-peer"), .markUnavailable)
        XCTAssertEqual(r.waitExpired("a-peer"), .none)
    }

    func testConnectedClearsAndReplacedConnectionKeepsTheCount() {
        var r = VoiceRecovery()
        XCTAssertEqual(r.failed("b", myId: "a"), .restartAsOfferer)
        r.closed("b", keepRecovery: true)  // the restart replaces the connection
        XCTAssertEqual(r.failed("b", myId: "a"), .markUnavailable)
        r.closed("b", keepRecovery: false)  // the peer left
        XCTAssertEqual(r, VoiceRecovery())
        XCTAssertEqual(r.failed("b", myId: ""), .waitForRestart, "no socket id yet: wait, never offer blind")
    }

    func testTimings() {
        XCTAssertEqual(IcePolicy.fetchTimeout, 4)
        XCTAssertEqual(IcePolicy.connectTimeout, 20)
        XCTAssertEqual(IcePolicy.restartWait, 15)
        XCTAssertEqual(IcePolicy.refreshBefore, 1800)
    }
}

final class SpectatorBadgeLayoutTests: XCTestCase {
    private func check(_ L: TableLayout, spectating: Bool, _ label: String, strict: Bool = true) {
        let badge = L.spectatorBadge(spectating: spectating)
        XCTAssertGreaterThanOrEqual(badge.height, 44, "\(label): 44 pt target")
        XCTAssertGreaterThanOrEqual(badge.minX, L.safeRect.minX - 0.01, label)
        XCTAssertLessThanOrEqual(badge.maxX, L.safeRect.maxX + 0.01, label)
        XCTAssertGreaterThanOrEqual(badge.minY, L.safeRect.minY - 0.01, label)
        XCTAssertLessThanOrEqual(badge.maxY, L.topLimit + 0.01, label)
        guard !L.isDegraded else { return }
        for k in L.spectatorKeeps(spectating: spectating, soft: strict) {
            XCTAssertFalse(TableLayout.overlaps(k, badge), "\(label): badge \(badge) over \(k)")
        }
        let size = CGSize(width: 200, height: 40)  // two lines at the bubble's 200 pt cap
        let c = L.spectatorBubbleCenter(badge: badge, bubbleSize: size, spectating: spectating)
        let bubble = TableLayout.rect(c, size)
        if strict {
            for k in L.spectatorBubbleHardKeeps(spectating: spectating) {
                XCTAssertFalse(TableLayout.overlaps(k, bubble), "\(label): bubble \(bubble) over \(k)")
            }
        }
        XCTAssertGreaterThanOrEqual(bubble.minX, L.safeRect.minX - 0.01, label)
        XCTAssertLessThanOrEqual(bubble.maxX, L.safeRect.maxX + 0.01, label)
        XCTAssertLessThanOrEqual(bubble.maxY, L.topLimit + 0.01, label)
        XCTAssertFalse(TableLayout.overlaps(bubble, badge), "\(label): bubble over the badge")
    }

    func testBadgeKeepsClearAtEveryListedSize() {
        // the item's seven sizes: clear of everything, bid bubbles and history included
        for (size, ins) in TableLayoutTests.scopeSizes {
            for bar: CGFloat in [0, 45] {
                let L = TableLayout(size: size, chrome: TableLayoutTests.chrome(ins, bottomBar: bar))
                check(L, spectating: false, "seat \(size) \(ins) bar \(bar)")
                check(L, spectating: true, "spectator \(size) \(ins) bar \(bar)")
            }
        }
        // every listed size (the SE at zero insets is packed): never over the always-on parts
        for (size, ins) in TableLayoutTests.listedSizes {
            for bar: CGFloat in [0, 45] {
                let L = TableLayout(size: size, chrome: TableLayoutTests.chrome(ins, bottomBar: bar))
                check(L, spectating: false, "seat \(size) \(ins) bar \(bar)", strict: false)
                check(L, spectating: true, "spectator \(size) \(ins) bar \(bar)")
            }
        }
    }

    func testIPhone18ProSeatedSitsByTheAccessory() {
        let L = TableLayout(size: CGSize(width: 402, height: 874), chrome: TableLayoutTests.chrome(TableLayoutTests.insets(62, 0, 34, 0)))
        let badge = L.spectatorBadge(spectating: false)
        XCTAssertGreaterThan(badge.midX, 0, "the right half, by HSI / voice")
        XCTAssertLessThan(badge.minY, L.trickRect(.right).maxY, "below the right trick card's top: the voice buttons' height")
        let corner = L.spectatorBadge(spectating: true)
        XCTAssertEqual(corner.maxX, L.safeRect.maxX - TableLayout.margin, accuracy: 0.01, "a spectator's: the bottom-right corner")
        XCTAssertLessThan(corner.minY, L.trickRect(.bottom).minY)
    }
}

@MainActor
final class SpectatorBubbleSceneTests: XCTestCase {
    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    func testOneBubbleAtATimeByTheBadge() throws {
        let h = ReplayHarness()
        let scene = GameSKScene(size: SceneRenderTests.size)
        scene.animator = HoldingAnimator()
        scene.configure(gameState: h.store, actions: h.actions)
        scene.didMove(to: SKView(frame: CGRect(origin: .zero, size: SceneRenderTests.size)))
        h.store.apply(.snapshot(try T.snapshot("spectator-mid-hand"), .spectate, hints: nil))
        let seq = h.store.state.sync.lastSeq ?? 0
        h.store.apply(T.ev("chatMessage", ["username": "Zach", "message": "hello", "position": NSNull(), "isSpectator": true, "seq": seq + 1]))
        h.store.apply(T.ev("chatMessage", ["username": "Amy", "message": "nice", "position": NSNull(), "isSpectator": true, "seq": seq + 2]))
        let bubbles = scene.transientLayer.children.filter { $0.name == "chat.spectator" }
        XCTAssertEqual(bubbles.count, 1, "one at a time: the newest replaces it")
        let label = bubbles.first?.children.compactMap { $0 as? SKLabelNode }.first
        XCTAssertEqual(label?.text, "Amy: nice")
        let badge = scene.layout.spectatorBadge(spectating: true)
        XCTAssertLessThan(hypot(bubbles[0].position.x - badge.midX, bubbles[0].position.y - badge.midY), 200, "by the badge")
    }
}

/// The badge's real content fits the layout's `spectatorBadgeSize` rect at every
/// Dynamic Type size (the badge caps its own scaling), for one, two and three
/// character counts: a too-narrow rect squeezed "12" to "1".
@MainActor
final class SpectatorBadgeFitTests: XCTestCase {
    static let counts = [1, 9, 12, 50, 99, 100, 250]

    private func idealSize(count: Int, _ size: DynamicTypeSize) -> CGSize {
        let watching = WatchingList(spectators: [], count: count)
        let vc = UIHostingController(rootView: SpectatorBadgeView(watching: watching, myUsername: nil)
            .environment(\.dynamicTypeSize, size))
        return vc.sizeThatFits(in: CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude))
    }

    func testBadgeFitsItsRectAtEveryTextSize() {
        let rect = TableLayout.spectatorBadgeSize
        for size in DynamicTypeSize.allCases {
            for n in Self.counts {
                let s = idealSize(count: n, size)
                XCTAssertLessThanOrEqual(s.width, rect.width + 0.5, "count \(n) at \(size): \(s.width) pt wide in a \(rect.width) pt rect")
                XCTAssertLessThanOrEqual(s.height, rect.height + 0.5, "count \(n) at \(size)")
                XCTAssertGreaterThanOrEqual(s.width, 44, "the 44 pt target")
            }
        }
    }

    func testBadgeTextStopsAtThreeCharacters() {
        XCTAssertEqual(WatchingList(spectators: [], count: 1).badgeText, "1")
        XCTAssertEqual(WatchingList(spectators: [], count: 99).badgeText, "99")
        XCTAssertEqual(WatchingList(spectators: [], count: 100).badgeText, "99+")
        XCTAssertEqual(WatchingList(spectators: [], count: 100).accessibilityLabel, "100 people watching", "VoiceOver reads the real count")
    }
}

/// Reduce Motion (HIG; Theme+Motion.swift): the repeating rings hold still under it
/// and pulse without it; a slide becomes a cross-fade.
@MainActor
final class ReduceMotionTests: XCTestCase {
    override func setUp() {
        super.setUp()
        OpponentHandNode.avatarLoader = StubAvatarLoader()
    }

    override func tearDown() {
        Theme.Motion.reduceMotionOverride = nil
        super.tearDown()
    }

    func testRingsHoldStillUnderReduceMotion() throws {
        Theme.Motion.reduceMotionOverride = true
        XCTAssertTrue(Theme.Motion.reduceMotion)
        let seat = OpponentHandNode(position: .left, username: "A")
        seat.showTurnGlow()
        seat.showSpeakingGlow()
        for name in ["glow.turn", "glow.speaking"] {
            let glow = try XCTUnwrap(seat.childNode(withName: name), name)
            XCTAssertFalse(glow.hasActions(), "\(name): no repeating pulse under Reduce Motion")
            XCTAssertEqual(glow.alpha, Theme.Motion.steadyGlowAlpha, accuracy: 0.001, "\(name): held at the lit alpha")
        }
    }

    func testRingsPulseWithoutReduceMotion() throws {
        Theme.Motion.reduceMotionOverride = false
        let seat = OpponentHandNode(position: .left, username: "A")
        seat.showTurnGlow()
        seat.showSpeakingGlow()
        for name in ["glow.turn", "glow.speaking"] {
            XCTAssertTrue(try XCTUnwrap(seat.childNode(withName: name), name).hasActions(), "\(name) pulses")
        }
    }

    func testStartPulseGlowFollowsTheArgument() {
        let still = SKNode(), pulsing = SKNode()
        CardAnimations.startPulseGlow(on: still, reduceMotion: true)
        CardAnimations.startPulseGlow(on: pulsing, reduceMotion: false)
        XCTAssertFalse(still.hasActions())
        XCTAssertTrue(pulsing.hasActions())
    }

    func testReadsTheSystemSettingWhenNotPinned() {
        Theme.Motion.reduceMotionOverride = nil
        XCTAssertEqual(Theme.Motion.reduceMotion, UIAccessibility.isReduceMotionEnabled)
    }
}

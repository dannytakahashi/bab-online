import XCTest
@preconcurrency import WebRTC
@testable import BAB_Online

/// The SFU transport (PR 3; docs/claude/voice.md "The client protocol", "SFU voice, iOS"): every
/// step and error code against `FakeSfuServer` (a scripted server whose sessions are real
/// RTCPeerConnections on the silent audio device), with the transport's clock run by hand
/// (`SfuTestClock`), so the 12 s reply wait, the backoff, the 2 s disconnect wait, the 25 s
/// window, the 20 s hold and the stall detector are exact.
@MainActor
final class SfuVoiceTests: XCTestCase {
    // MARK: - Harness

    private var clock: SfuTestClock!
    private var server: FakeSfuServer!
    private var manager: VoiceChatManager!
    private var claims = 0, releases = 0
    private var sfu: SfuVoice { manager.sfu }

    override func setUp() async throws {
        clock = SfuTestClock()
        server = FakeSfuServer()
        claims = 0
        releases = 0
        let server = self.server!
        manager = VoiceChatManager.silent(configureAudioSession: { [weak self] in self?.claims += 1 },
                                          deactivateAudioSession: { [weak self] in self?.releases += 1 },
                                          sendSfu: { event, payload in server.receive(event, payload) },
                                          sfuClock: clock.hooks)
        server.deliver = { [weak manager] in manager?.sfu.handleReply($0) }
    }

    override func tearDown() async throws {
        manager.shutdown()
        server.close()
        manager = nil
        server = nil
    }

    private func waitFor(_ what: String, timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line,
                         _ cond: () -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while !cond() {
            if Date() > end {
                XCTFail("timed out waiting for \(what)", file: file, line: line)
                return
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    /// A short real wait: whatever the transport would do next has had its chance.
    private func settle() async {
        for _ in 0..<20 { try? await Task.sleep(nanoseconds: 5_000_000) }
    }

    private static func member(_ username: String, session: String?, track: String? = "mic", state: String = "live") -> [String: Any] {
        ["username": username, "sessionId": session ?? NSNull(), "trackName": (session == nil ? nil : track) ?? NSNull(), "state": state]
    }

    private func roster(_ members: [[String: Any]], status: String = "admitted", boot: String = "boot-1",
                        me: [String: Any]? = nil, cap: Int = 100) -> SfuRoster {
        SfuRoster.from(["tournamentId": "T1", "bootId": boot, "rev": 1, "status": status, "cap": cap, "graceMs": 38000,
                        "self": me ?? ["sessionId": NSNull(), "trackName": NSNull(), "state": "live"],
                        "members": members])!
    }

    private func memberEvent(_ event: String, _ m: [String: Any], boot: String = "boot-1") -> SfuMemberEvent {
        SfuMemberEvent.from(["tournamentId": "T1", "bootId": boot, "rev": 2, "event": event, "member": m])!
    }

    /// `n` other members, each publishing on its own session (the fake knows their names).
    private func publishers(_ names: [String]) -> [[String: Any]] {
        names.map { name in
            let sid = "pub-\(name)"
            server.publishers[sid] = name
            return Self.member(name, session: sid)
        }
    }

    /// Voice running, admitted with `members`, and every resulting pull done.
    private func startIn(_ members: [[String: Any]], unmuted: Bool = false) async throws {
        try await manager.initialize()
        manager.applySfuRoster(roster(members))
        if unmuted { manager.unmute() }
    }

    private func pulledAll(_ names: [String]) async {
        await waitFor("pulls of \(names)") { Set(sfu.pulls.keys) == Set(names) && server.count("sfuRenegotiate") > 0 && sfu.generation >= 0 }
        await waitFor("idle") { server.busy == 0 }
    }

    private func publish() async {
        manager.unmute()
        await waitFor("the push") { sfu.publishedTrackName != nil }
    }

    // MARK: - The wire and the rules (pure)

    func testTheCapEventsAndWire() {
        XCTAssertTrue(ClientHello.caps.contains("sfuVoice"))
        XCTAssertEqual(SfuPolicy.cap, "sfuVoice")
        XCTAssertEqual([SocketEvents.Client.sfuSession, SocketEvents.Client.sfuPush, SocketEvents.Client.sfuPull,
                        SocketEvents.Client.sfuRenegotiate, SocketEvents.Client.sfuClose, SocketEvents.Client.sfuIceRestart,
                        SocketEvents.Client.sfuResume, SocketEvents.Client.sfuLeave],
                       ["sfuSession", "sfuPush", "sfuPull", "sfuRenegotiate", "sfuClose", "sfuIceRestart", "sfuResume", "sfuLeave"])
        XCTAssertEqual([SocketEvents.Server.sfuReply, SocketEvents.Server.sfuRoster, SocketEvents.Server.sfuMember],
                       ["sfuReply", "sfuRoster", "sfuMember"])
        let r = roster([Self.member("ann", session: "s1"), Self.member("bo", session: nil, state: "reconnecting")],
                       me: ["sessionId": "mine", "trackName": "mic", "state": "reconnecting"])
        XCTAssertEqual(r.status, .admitted)
        XCTAssertEqual(r.me, SfuRoster.Me(sessionId: "mine", trackName: "mic", state: .reconnecting))
        XCTAssertEqual(r.members.map(\.track), [SfuTrackKey(sessionId: "s1", trackName: "mic"), nil])
        XCTAssertEqual(r.members[1].state, .reconnecting)
        XCTAssertNil(SfuRoster.from(["tournamentId": "T1", "status": "admitted"]), "no bootId")
        XCTAssertNil(SfuRoster.from(["tournamentId": "T1", "bootId": "b", "status": "sideways"]))
        let left = memberEvent("left", Self.member("ann", session: nil))
        XCTAssertTrue(left.isLeft)
        let e = SfuError.from(["code": "busy", "retryable": true, "retryAfterMs": 500])
        XCTAssertEqual(e, SfuError(code: "busy", retryable: true, retryAfterMs: 500, status: nil, cfCode: nil))
        XCTAssertEqual(SfuPulledTrack.from(["sessionId": "s", "trackName": "mic", "mid": "3", "errorCode": NSNull()])?.outcome, .pulled)
        XCTAssertEqual(SfuPulledTrack.from(["sessionId": "s", "trackName": "mic", "mid": NSNull(), "errorCode": "empty_track_error"])?.outcome, .retryLater)
        XCTAssertEqual(SfuPulledTrack.from(["sessionId": "s", "trackName": "mic", "mid": NSNull(), "errorCode": "not_found_track_error"])?.outcome, .retryLater)
        for code in ["not_in_room", "own_track", "blocked", "duplicate", "too_many_pulls", "no_result"] {
            XCTAssertEqual(SfuPulledTrack.from(["mid": NSNull(), "errorCode": code])?.outcome, .refused, code)
        }
    }

    /// Step 8, code by code.
    func testEveryErrorCodeHasItsAction() {
        func a(_ code: String, _ retryable: Bool = false) -> SfuErrorAction {
            SfuErrorAction.of(SfuError(code: code, retryable: retryable, retryAfterMs: nil, status: nil, cfCode: nil))
        }
        XCTAssertEqual(a("session_gone"), .newSession)
        XCTAssertEqual(a("client_timeout"), .newSession)
        XCTAssertEqual(a("superseded"), .drop)
        XCTAssertEqual(a("not_your_session"), .resume)
        XCTAssertEqual(a("not_in_room"), .stopUntilRoster)
        for code in ["rate_limited", "busy", "timeout", "cloudflare_unreachable"] { XCTAssertEqual(a(code, true), .retry, code) }
        XCTAssertEqual(a("cloudflare_error", true), .retry)
        XCTAssertEqual(a("cloudflare_error", false), .giveUp)
        XCTAssertEqual(a("server_error", true), .retry)
        for code in ["invalid", "bad_token", "already_published", "no_local_track", "unavailable", "anything_else"] {
            XCTAssertEqual(a(code), .giveUp, code)
        }
        XCTAssertEqual((0..<6).map { SfuPolicy.backoffDelay(attempt: $0, retryAfterMs: nil) }, [0.5, 1, 2, 4, 4, 4])
        XCTAssertEqual(SfuPolicy.backoffDelay(attempt: 0, retryAfterMs: 1000), 1, "at least the server's retryAfterMs")
        XCTAssertEqual(SfuPolicy.replyTimeout, 12)
    }

    func testThePullPlan() {
        let k = { (s: String) in SfuTrackKey(sessionId: s, trackName: "mic") }
        func m(_ u: String, _ s: String?, _ state: SfuMemberRecord.State = .live) -> SfuMemberRecord {
            SfuMemberRecord(username: u, sessionId: s, trackName: s == nil ? nil : "mic", state: state)
        }
        // equal: nothing; left: close; unpublished: close; a new session: close then pull it
        var p = SfuPlan.reconcile(held: ["ann": k("a1"), "bo": k("b1"), "cy": k("c1"), "di": k("d1")],
                                  members: ["ann": m("ann", "a1"), "cy": m("cy", nil), "di": m("di", "d2")])
        XCTAssertEqual(p.close, ["bo", "cy", "di"])
        XCTAssertEqual(p.pull.map(\.username), ["di"])
        XCTAssertEqual(p.pull.first?.key, k("d2"))
        // reconnecting: kept, whatever its record says
        p = SfuPlan.reconcile(held: ["ann": k("a1")], members: ["ann": m("ann", nil, .reconnecting)])
        XCTAssertEqual(p, SfuPlan.Result())
        // the restart hold: missing or null session kept; a changed session still closes
        p = SfuPlan.reconcile(held: ["ann": k("a1"), "bo": k("b1"), "cy": k("c1")],
                              members: ["bo": m("bo", nil), "cy": m("cy", "c2")], holding: true)
        XCTAssertEqual(p.close, ["cy"])
        XCTAssertEqual(p.pull.map(\.username), ["cy"])
        // after the hold
        p = SfuPlan.reconcile(held: ["ann": k("a1"), "bo": k("b1")], members: ["bo": m("bo", nil)])
        XCTAssertEqual(p.close, ["ann", "bo"])
        // busy and refused tracks are not pulled; a refused track's new session is
        p = SfuPlan.reconcile(held: [:], members: ["ann": m("ann", "a1"), "bo": m("bo", "b1"), "cy": m("cy", "c2")],
                              busy: ["ann"], refused: ["bo": k("b1"), "cy": k("c1")])
        XCTAssertEqual(p.pull.map(\.username), ["cy"])
        XCTAssertEqual(SfuPlan.batches(Array(0..<130)).map(\.count), [64, 64, 2])
    }

    func testTheRecoveryChoice() {
        XCTAssertEqual(SfuRecovery.decide(away: 3, sessionGone: false, published: true, restartTries: 0), .iceRestart)
        XCTAssertEqual(SfuRecovery.decide(away: 24.9, sessionGone: false, published: true, restartTries: 1), .iceRestart)
        XCTAssertEqual(SfuRecovery.decide(away: 25, sessionGone: false, published: true, restartTries: 0), .newSession)
        XCTAssertEqual(SfuRecovery.decide(away: 3, sessionGone: true, published: true, restartTries: 0), .newSession)
        XCTAssertEqual(SfuRecovery.decide(away: 3, sessionGone: false, published: false, restartTries: 0), .newSession)
        XCTAssertEqual(SfuRecovery.decide(away: 3, sessionGone: false, published: true, restartTries: 2), .newSession)
        XCTAssertEqual(SfuRecovery.decide(away: 3, sessionGone: false, published: true, restartTries: 0, everConnected: false), .newSession,
                       "a session that never connected is replaced, never restarted")
    }

    func testASessionThatNeverConnectedIsReplacedNotRestarted() async throws {
        try await startIn(publishers(["ann"]), unmuted: true)
        await waitFor("ready") { sfu.pulls["ann"] != nil && sfu.publishedTrackName != nil && server.busy == 0 }
        let old = sfu.sessionId
        sfu.simulateConnection(.connecting)
        sfu.everConnected = false  // never connected (made while the path to the SFU was down)
        sfu.simulateConnection(.failed)
        await waitFor("a new session") { sfu.sessionId != old && sfu.sessionId != nil && sfu.pulls["ann"] != nil && sfu.publishedTrackName != nil }
        XCTAssertEqual(server.count("sfuIceRestart"), 0)
    }

    func testTheStallDetector() {
        var d = SfuStallDetector()
        let t0 = Date(timeIntervalSince1970: 0)
        d.sample("ann", packets: 10, now: t0)
        d.sample("bo", packets: 5, now: t0)
        XCTAssertFalse(d.check(connected: true, pulls: ["ann", "bo"], now: t0.addingTimeInterval(1)))
        d.sample("ann", packets: 10, now: t0.addingTimeInterval(1))
        d.sample("bo", packets: 9, now: t0.addingTimeInterval(1))  // bo still arrives
        XCTAssertFalse(d.check(connected: true, pulls: ["ann", "bo"], now: t0.addingTimeInterval(2.5)), "one member quiet is their network")
        d.sample("bo", packets: 9, now: t0.addingTimeInterval(2.5))
        XCTAssertTrue(d.check(connected: true, pulls: ["ann", "bo"], now: t0.addingTimeInterval(3.1)), "all of them: ours")
        XCTAssertFalse(d.check(connected: true, pulls: ["ann", "bo"], now: t0.addingTimeInterval(9)), "once per 10 s")
        XCTAssertTrue(d.check(connected: true, pulls: ["ann", "bo"], now: t0.addingTimeInterval(13.2)))
        XCTAssertFalse(d.check(connected: false, pulls: ["ann"], now: t0.addingTimeInterval(40)), "not connected: step 9's own path")
        XCTAssertFalse(d.check(connected: true, pulls: [], now: t0.addingTimeInterval(40)), "nothing pulled")
    }

    // MARK: - Steps 1-4: mode, lazy session, one PeerConnection, push on the first unmute

    func testAMutedListenerWithNobodyPublishingMakesNoSession() async throws {
        try await startIn([Self.member("ann", session: nil)])
        await settle()
        XCTAssertEqual(server.requests.count, 0, "no session until there is something to pull or push")
        XCTAssertTrue(manager.tournamentCompany(me: "me"), "the roster's member is company (step 2)")
        // ann publishes: a session, and her track pulled; I push nothing while muted
        server.publishers["sA"] = "ann"
        manager.applySfuMember(memberEvent("published", Self.member("ann", session: "sA")))
        await pulledAll(["ann"])
        XCTAssertEqual(server.requests.map(\.event), ["sfuSession", "sfuPull", "sfuRenegotiate"])
        XCTAssertEqual(server.count("sfuPush"), 0, "a muted-at-start member pushes nothing (step 4)")
        XCTAssertNil(sfu.localTransceiver, "no sending transceiver before the first unmute")
    }

    func testOnePeerConnectionWithMaxBundleAndTheSfusStun() async throws {
        XCTAssertEqual(SfuVoice.Hooks(send: { _, _ in }).iceServers, ["stun:stun.cloudflare.com:3478"])
        try await startIn(publishers(["ann", "bo", "cy"]))
        await pulledAll(["ann", "bo", "cy"])
        XCTAssertEqual(sfu.counts["peerConnection"], 1, "one RTCPeerConnection per session, not per peer")
        XCTAssertEqual(sfu.configuration?.bundlePolicy, .maxBundle)
        XCTAssertEqual(sfu.configuration?.sdpSemantics, .unifiedPlan)
        XCTAssertEqual(manager.peerInfos.keys.sorted(), ["sfu:ann", "sfu:bo", "sfu:cy"])
        XCTAssertEqual(claims, 1, "the PeerConnection claimed the audio session")
    }

    func testTheFirstUnmutePushesASendonlyTrackAndAMuteSendsNothing() async throws {
        try await startIn([Self.member("ann", session: nil)])
        await settle()
        XCTAssertEqual(server.requests.count, 0)
        await publish()
        XCTAssertEqual(server.requests.map(\.event), ["sfuSession", "sfuPush"])
        let push = try XCTUnwrap(server.last("sfuPush"))
        XCTAssertEqual(push["trackName"] as? String, "mic")
        XCTAssertEqual(push["mid"] as? String, sfu.localMid)
        XCTAssertEqual((push["offer"] as? [String: Any])?["type"] as? String, "offer")
        XCTAssertEqual(sfu.localTransceiver?.direction, .sendOnly)
        XCTAssertEqual(manager.localTrackEnabled, true)
        let before = server.requests.count
        manager.mute()
        manager.unmute()
        manager.mute()
        await settle()
        XCTAssertEqual(server.requests.count, before, "mute / unmute after the push is isEnabled, no request")
        XCTAssertEqual(manager.localTrackEnabled, false)
        XCTAssertEqual(sfu.localSender?.track?.isEnabled, false, "the published sender keeps sending silence")
    }

    func testAMyTrackErrorOnThePushLeavesItUnpublished() async throws {
        try await startIn([])
        server.script["sfuPush"] = [.error("already_published")]
        manager.applySfuRoster(roster([Self.member("ann", session: nil)]))
        await publish_attempt()
        XCTAssertNil(sfu.publishedTrackName)
        XCTAssertEqual(server.count("sfuPush"), 1, "already_published is never retried")
    }

    private func publish_attempt() async {
        manager.unmute()
        await waitFor("a push") { server.count("sfuPush") > 0 }
        await settle()
    }

    // MARK: - Step 5: pulls

    func testPullsAreBatchedWithEachMidMappedToItsMember() async throws {
        try await startIn(publishers(["ann", "bo", "cy"]))
        await pulledAll(["ann", "bo", "cy"])
        XCTAssertEqual(server.count("sfuPull"), 1, "one batch")
        let tracks = try XCTUnwrap(server.last("sfuPull")?["tracks"] as? [[String: Any]])
        XCTAssertEqual(tracks.compactMap { $0["sessionId"] as? String }, ["pub-ann", "pub-bo", "pub-cy"])
        for name in ["ann", "bo", "cy"] {
            let mid = try XCTUnwrap(sfu.pulls[name]?.mid)
            XCTAssertEqual(sfu.midOwners[mid], name)
            XCTAssertEqual(server.pulled[sfu.sessionId!]?["pub-\(name)"], mid)
            XCTAssertNotNil(manager.sfuTrack(name), "\(name)'s track")
        }
        // per-player mute and volume on the pulled tracks (RTCAudioTrack.source.volume)
        manager.setPeerVolume("sfu:bo", 1.5)
        XCTAssertEqual(manager.remoteTrackVolume("sfu:bo"), 1.5)
        manager.togglePeerMute("sfu:cy")
        XCTAssertEqual(manager.remoteTrackEnabled("sfu:cy"), false)
        XCTAssertEqual(manager.savedVolume(for: "bo"), 1.5)
        XCTAssertEqual(manager.savedMute(for: "cy"), true)
    }

    func testMoreThan64TracksGoInTwoPulls() async throws {
        let names = (0..<70).map { String(format: "p%02d", $0) }
        try await startIn(publishers(names))
        await waitFor("70 pulls", timeout: 30) { sfu.pulls.count == 70 }
        XCTAssertEqual(server.requests.filter { $0.event == "sfuPull" }.map { ($0.payload["tracks"] as? [Any])?.count ?? 0 }, [64, 6])
        XCTAssertEqual(sfu.counts["peerConnection"], 1)
    }

    func testEmptyTracksAreRetriedEverySecondTenTimesAndRefusalsWaitForTheRoster() async throws {
        server.publishers["pub-ann"] = "ann"
        server.publishers["pub-bo"] = "bo"
        server.script["sfuPull"] = [.trackErrors(["pub-ann": "empty_track_error", "pub-bo": "blocked"])]
        try await startIn([Self.member("ann", session: "pub-ann"), Self.member("bo", session: "pub-bo")])
        await waitFor("the first pull") { server.count("sfuPull") == 1 && server.busy == 0 }
        await settle()
        XCTAssertEqual(server.count("sfuRenegotiate"), 0, "no offer: nothing pulled")
        // ann again after 1 s, alone (bo was refused: blocked)
        server.script["sfuPull"] = Array(repeating: .trackErrors(["pub-ann": "not_found_track_error"]), count: 9)
        for n in 2...10 {
            clock.advance(0.99)
            await settle()
            XCTAssertEqual(server.count("sfuPull"), n - 1, "not before the second")
            clock.advance(0.02)
            await waitFor("pull \(n)") { server.count("sfuPull") == n && server.busy == 0 }
            XCTAssertEqual((server.last("sfuPull")?["tracks"] as? [[String: Any]])?.compactMap { $0["sessionId"] as? String }, ["pub-ann"])
        }
        clock.advance(1.01)
        await waitFor("the 11th") { server.count("sfuPull") == 11 && server.busy == 0 }
        await waitFor("ann pulled at last") { sfu.pulls["ann"] != nil }
        XCTAssertNil(sfu.pulls["bo"], "blocked: not asked again")
        // a roster change: bo is asked again
        manager.applySfuMember(memberEvent("resumed", Self.member("cy", session: nil)))
        await waitFor("bo asked again") { sfu.pulls["bo"] != nil }
    }

    func testEmptyTracksStopAfterTenRetries() async throws {
        server.publishers["pub-ann"] = "ann"
        server.script["sfuPull"] = Array(repeating: .trackErrors(["pub-ann": "empty_track_error"]), count: 20)
        try await startIn([Self.member("ann", session: "pub-ann")])
        await waitFor("the first pull") { server.count("sfuPull") == 1 && server.busy == 0 }
        for _ in 0..<15 {
            clock.advance(1.01)
            await settle()
        }
        XCTAssertEqual(server.count("sfuPull"), 11, "the first and 10 retries")
    }

    // MARK: - Steps 6, 7: closes and roster events

    func testALeftMemberIsClosedNegotiatedAndANewSessionIsPulledAgain() async throws {
        // published: my mic's m-section keeps the bundle when every pull closes (a pull-only
        // session's last close goes by force: `testAPullOnlySessionsLastCloseIsForced`)
        try await startIn(publishers(["ann", "bo"]), unmuted: true)
        await waitFor("ready") { sfu.pulls.count == 2 && sfu.publishedTrackName != nil && server.busy == 0 }
        let annMid = try XCTUnwrap(sfu.pulls["ann"]?.mid)
        manager.applySfuMember(memberEvent("left", Self.member("ann", session: nil)))
        await waitFor("ann closed") { server.count("sfuClose") == 1 && server.busy == 0 && sfu.pulls["ann"] == nil }
        let close = try XCTUnwrap(server.last("sfuClose"))
        XCTAssertEqual(close["mids"] as? [String], [annMid])
        XCTAssertNotNil(close["offer"], "negotiated")
        XCTAssertNil(close["force"])
        XCTAssertNil(manager.peerInfos["sfu:ann"], "her row went")
        // bo on a new session: close the old pull, then pull the new track
        server.publishers["pub-bo-2"] = "bo"
        manager.applySfuMember(memberEvent("session", Self.member("bo", session: "pub-bo-2")))
        await waitFor("bo's new track") { sfu.pulls["bo"]?.key.sessionId == "pub-bo-2" && server.busy == 0 }
        let tail = server.requests.suffix(3).map(\.event)
        XCTAssertEqual(tail, ["sfuClose", "sfuPull", "sfuRenegotiate"])
        // an unknown member's record is a join
        server.publishers["pub-cy"] = "cy"
        manager.applySfuMember(memberEvent("session", Self.member("cy", session: "pub-cy")))
        await waitFor("cy") { sfu.pulls["cy"] != nil }
    }

    func testAPullOnlySessionsLastCloseIsForcedAndTheSessionStaysUsable() async throws {
        try await startIn(publishers(["ann"]))
        await pulledAll(["ann"])
        let sid = sfu.sessionId
        manager.applySfuMember(memberEvent("left", Self.member("ann", session: nil)))
        await waitFor("closed") { server.count("sfuClose") == 1 && server.busy == 0 && sfu.pulls.isEmpty }
        XCTAssertEqual(server.last("sfuClose")?["force"] as? Bool, true, "with max-bundle an offer with every m-section stopped cannot be made")
        XCTAssertEqual(sfu.sessionId, sid)
        // she comes back: pulled again (on this session, or a new one if the SFU's offer cannot be applied)
        manager.applySfuMember(memberEvent("session", Self.member("ann", session: "pub-ann")))
        await waitFor("ann again") { sfu.pulls["ann"] != nil && server.busy == 0 }
    }

    func testAReconnectingMemberKeepsItsPullAndAResumedOneNeedsNothing() async throws {
        try await startIn(publishers(["ann"]))
        await pulledAll(["ann"])
        let n = server.requests.count
        manager.applySfuMember(memberEvent("reconnecting", Self.member("ann", session: "pub-ann", state: "reconnecting")))
        await settle()
        manager.applySfuMember(memberEvent("resumed", Self.member("ann", session: "pub-ann")))
        await settle()
        XCTAssertEqual(server.requests.count, n, "kept, nothing re-pulled")
        XCTAssertNotNil(sfu.pulls["ann"])
    }

    func testACloseThatIsRefusedIsDoneByForce() async throws {
        try await startIn(publishers(["ann"]), unmuted: true)
        await waitFor("ready") { sfu.pulls["ann"] != nil && sfu.publishedTrackName != nil && server.busy == 0 }
        server.script["sfuClose"] = [.error("cloudflare_error", retryable: false)]
        manager.applySfuMember(memberEvent("left", Self.member("ann", session: nil)))
        await waitFor("the force close") { server.count("sfuClose") == 2 && server.busy == 0 }
        XCTAssertEqual(server.last("sfuClose")?["force"] as? Bool, true)
        XCTAssertNil(server.last("sfuClose")?["offer"])
        XCTAssertEqual(sfu.pc?.signalingState, .stable, "the offer was rolled back")
    }

    // MARK: - Step 8: errors, retries, the reply wait, the queue

    func testRetryableRefusalsBackOff() async throws {
        for code in ["rate_limited", "busy", "timeout", "cloudflare_unreachable", "cloudflare_error"] {
            try await setUp()
            server.script["sfuSession"] = [.error(code, retryable: true), .error(code, retryable: true)]
            try await startIn(publishers(["ann"]))
            await waitFor("\(code): first") { server.count("sfuSession") == 1 }
            await settle()
            clock.advance(0.49)
            await settle()
            XCTAssertEqual(server.count("sfuSession"), 1, "\(code): not before 0.5 s")
            clock.advance(0.02)
            await waitFor("\(code): second") { server.count("sfuSession") == 2 }
            await settle()
            clock.advance(0.99)
            await settle()
            XCTAssertEqual(server.count("sfuSession"), 2, "\(code): then 1 s")
            clock.advance(0.02)
            await pulledAll(["ann"])
            XCTAssertEqual(server.count("sfuSession"), 3, code)
            try await tearDown()
        }
        try await setUp()
    }

    func testGiveUpCodesAreNeverRetried() async throws {
        for code in ["invalid", "bad_token", "already_published", "no_local_track", "unavailable"] {
            try await setUp()
            server.script["sfuSession"] = [.error(code)]
            try await startIn(publishers(["ann"]))
            await waitFor("\(code)") { server.count("sfuSession") == 1 }
            for _ in 0..<5 { clock.advance(5); await settle() }
            XCTAssertEqual(server.count("sfuSession"), 1, "\(code): not again")
            XCTAssertNil(sfu.sessionId)
            try await tearDown()
        }
        try await setUp()
    }

    func testSessionGoneMakesANewSessionPushesAgainAndRepullsEveryone() async throws {
        try await startIn(publishers(["ann", "bo"]), unmuted: true)
        await waitFor("published and pulled") { sfu.publishedTrackName != nil && sfu.pulls.count == 2 && server.busy == 0 }
        let old = try XCTUnwrap(sfu.sessionId)
        server.dead.insert(old)
        manager.applySfuMember(memberEvent("left", Self.member("bo", session: nil)))
        await waitFor("a new session") { sfu.sessionId != nil && sfu.sessionId != old && sfu.publishedTrackName != nil && sfu.pulls["ann"] != nil }
        XCTAssertNil(sfu.pulls["bo"])
        XCTAssertEqual(server.count("sfuSession"), 2)
        XCTAssertEqual(server.count("sfuPush"), 2, "pushed again (I was unmuted)")
        XCTAssertEqual(sfu.counts["peerConnection"], 2, "the old PeerConnection closed, a new one")
        XCTAssertFalse(server.requests.contains { $0.event != "sfuSession" && $0.payload["sessionId"] as? String == old && $0.event == "sfuIceRestart" },
                       "never a restart on a 410 session")
    }

    func testSupersededIsDropped() async throws {
        server.script["sfuPull"] = [.error("superseded")]
        try await startIn(publishers(["ann"]))
        await waitFor("the pull") { server.count("sfuPull") == 1 }
        for _ in 0..<3 { clock.advance(5); await settle() }
        XCTAssertEqual(server.count("sfuPull"), 1)
        XCTAssertEqual(server.count("sfuSession"), 1, "no new session for superseded work")
    }

    func testNotYourSessionResumes() async throws {
        server.script["sfuPull"] = [.error("not_your_session")]
        try await startIn(publishers(["ann"]))
        await waitFor("the resume") { server.count("sfuResume") == 1 }
        let resume = try XCTUnwrap(server.last("sfuResume"))
        XCTAssertEqual(resume["sessionId"] as? String, sfu.sessionId)
        XCTAssertEqual((resume["sessionToken"] as? String)?.count, 43)
        XCTAssertTrue(resume["trackName"] is NSNull)
        XCTAssertTrue(resume["mid"] is NSNull)
        await waitFor("then pulled") { sfu.pulls["ann"] != nil }
    }

    func testNotInRoomStopsUntilTheNextRoster() async throws {
        server.script["sfuPull"] = [.error("not_in_room")]
        try await startIn(publishers(["ann"]))
        await waitFor("stopped") { server.count("sfuPull") == 1 && sfu.sessionId == nil }
        XCTAssertEqual(sfu.status, .none)
        for _ in 0..<3 { clock.advance(5); await settle() }
        XCTAssertEqual(server.requests.count, 2, "nothing more")
        manager.applySfuRoster(roster(publishers(["ann"])))
        await pulledAll(["ann"])
    }

    func testAReplyThatNeverComesIsGivenUpAfter12sAndALateOneIgnored() async throws {
        server.script["sfuPull"] = [.noReply]
        try await startIn(publishers(["ann"]))
        await waitFor("the pull") { server.count("sfuPull") == 1 }
        let pullId = try XCTUnwrap(server.last("sfuPull")?["requestId"] as? String)
        clock.advance(11.9)
        await settle()
        XCTAssertEqual(server.count("sfuSession"), 1, "still waiting")
        clock.advance(0.2)
        // the session's state is unknown after a lost pull: a new session, everything again
        await waitFor("a new session") { server.count("sfuSession") == 2 && sfu.pulls["ann"] != nil }
        let session = sfu.sessionId
        sfu.handleReply(["requestId": pullId, "op": "pull", "ok": false, "error": ["code": "session_gone"]])
        await settle()
        XCTAssertEqual(sfu.sessionId, session, "the late reply did nothing")
        XCTAssertEqual(server.count("sfuSession"), 2)
    }

    func testTheQueueIsSerialAndAReplacedSessionDropsItsWork() async throws {
        server.replyDelay = 0.02
        try await startIn(publishers(["ann", "bo", "cy"]), unmuted: true)
        for name in ["dd", "ee", "ff"] {
            server.publishers["pub-\(name)"] = name
            manager.applySfuMember(memberEvent("session", Self.member(name, session: "pub-\(name)")))
        }
        manager.applySfuMember(memberEvent("left", Self.member("ann", session: nil)))
        await waitFor("all done", timeout: 10) { sfu.pulls.count == 5 && sfu.publishedTrackName != nil && server.busy == 0 && sfu.inFlight == 0 }
        XCTAssertEqual(sfu.maxInFlight, 1, "one request at a time")
        XCTAssertEqual(server.maxBusy, 1)
        // queued work of a replaced session answers at once and never reaches the server
        server.script["sfuPull"] = [.noReply]
        server.publishers["pub-gg"] = "gg"
        manager.applySfuMember(memberEvent("session", Self.member("gg", session: "pub-gg")))
        await waitFor("the pull waits") { server.count("sfuPull") >= 2 && sfu.inFlight == 1 }
        let old = sfu.generation
        sfu.renewSession(why: "test")
        XCTAssertEqual(sfu.inFlight, 0, "the waiting request answered at once (superseded)")
        XCTAssertGreaterThan(sfu.generation, old)
        await waitFor("the new session pulls everyone") { sfu.pulls.count == 6 && server.busy == 0 }
    }

    // MARK: - Step 9: media drops

    private func connectedSession(published: Bool = true) async throws {
        try await startIn(publishers(["ann"]), unmuted: published)
        await waitFor("ready") { sfu.pulls["ann"] != nil && (sfu.publishedTrackName != nil) == published && server.busy == 0 }
        sfu.simulateConnection(.connected)
    }

    func testTheFirstDisconnectedWaits2sThenAnIceRestartOnTheSameSession() async throws {
        try await connectedSession()
        let session = sfu.sessionId
        sfu.simulateConnection(.disconnected)
        clock.advance(1.9)
        await settle()
        XCTAssertEqual(server.count("sfuIceRestart"), 0, "never on the first disconnected")
        clock.advance(0.2)
        await waitFor("the restart") { server.count("sfuIceRestart") == 1 && server.busy == 0 }
        let r = try XCTUnwrap(server.last("sfuIceRestart"))
        XCTAssertEqual(r["sessionId"] as? String, session)
        XCTAssertEqual((r["offer"] as? [String: Any])?["type"] as? String, "offer")
        XCTAssertTrue(((r["offer"] as? [String: Any])?["sdp"] as? String ?? "").contains("a=ice-ufrag"), "a new ufrag")
        sfu.simulateConnection(.connected)
        await waitFor("recovered") { !sfu.recovering }
        XCTAssertEqual(sfu.sessionId, session)
        XCTAssertEqual(server.count("sfuSession"), 1)
        XCTAssertEqual(sfu.recoveries.last?.hasPrefix("iceRestart ok"), true)
        // a later forced recovery while connected (a stall, the probe) restarts again
        sfu.recover(force: true, why: "again")
        await waitFor("a second restart") { server.count("sfuIceRestart") == 2 && server.busy == 0 && !sfu.recovering }
        XCTAssertEqual(sfu.restartTries, 0)
    }

    func testAFailedPeerConnectionStopsRetriesSoItsRecoveryRunsFirst() async throws {
        try await connectedSession()
        server.script["sfuPull"] = [.error("timeout", retryable: true), .error("timeout", retryable: true)]
        server.publishers["pub-bo"] = "bo"
        manager.applySfuMember(memberEvent("published", Self.member("bo", session: "pub-bo")))
        await waitFor("the pull's first timeout") { server.count("sfuPull") == 1 && server.busy == 0 }
        await settle()
        sfu.simulateConnection(.failed)  // the recovery queues behind the pull's backoff
        clock.advance(0.6)
        await waitFor("the restart") { server.count("sfuIceRestart") == 1 }
        XCTAssertEqual(server.count("sfuPull"), 2, "ann's, then bo's once: no retry on a failed PeerConnection: \(server.requests.map(\.event))")
        XCTAssertNil(sfu.pulls["bo"])
        sfu.simulateConnection(.connected)
        // connected again: what was given up on is asked again (its second timeout backs off 0.5 s)
        await waitFor("bo asked again") { server.count("sfuPull") == 3 && server.busy == 0 }
        await settle()
        clock.advance(0.6)
        await waitFor("bo pulled") { sfu.pulls["bo"] != nil }
    }

    func testADropThatHealsWithin2sDoesNothing() async throws {
        try await connectedSession()
        sfu.simulateConnection(.disconnected)
        clock.advance(1.5)
        sfu.simulateConnection(.connected)
        clock.advance(5)
        await settle()
        XCTAssertEqual(server.count("sfuIceRestart"), 0)
    }

    func testFailedWithTwoFailedRestartsFallsBackToANewSession() async throws {
        try await connectedSession()
        let old = sfu.sessionId
        sfu.simulateConnection(.failed)
        for _ in 0..<2 {
            let n = server.count("sfuIceRestart")
            await waitFor("restart \(n + 1)") { server.count("sfuIceRestart") == n + 1 && server.busy == 0 }
            await settle()
            clock.advance(6.1)  // never connected
        }
        await waitFor("a new session") { sfu.sessionId != nil && sfu.sessionId != old && sfu.pulls["ann"] != nil && sfu.publishedTrackName != nil }
        XCTAssertEqual(server.count("sfuIceRestart"), 2, "at most 2 tries")
    }

    func testAwayOver25sMakesANewSession() async throws {
        try await connectedSession()
        let old = sfu.sessionId
        sfu.networkPath(satisfied: true, signature: "en0")
        sfu.networkPath(satisfied: false, signature: "none")
        sfu.simulateConnection(.disconnected)
        clock.advance(2.1)
        await settle()
        XCTAssertEqual(server.count("sfuIceRestart"), 0, "the network is down: wait for it")
        clock.advance(30)
        sfu.networkPath(satisfied: true, signature: "en0")  // NWPathMonitor: satisfied again
        await waitFor("a new session") { sfu.sessionId != old && sfu.sessionId != nil && sfu.pulls["ann"] != nil }
        XCTAssertEqual(server.count("sfuIceRestart"), 0, "away 32 s: no restart")
    }

    func testTheNetworkComingBackWithin25sRestartsIce() async throws {
        try await connectedSession()
        sfu.networkPath(satisfied: true, signature: "en0")
        sfu.networkPath(satisfied: false, signature: "none")
        sfu.simulateConnection(.disconnected)
        clock.advance(8)
        await settle()
        XCTAssertEqual(server.count("sfuIceRestart"), 0)
        sfu.networkPath(satisfied: true, signature: "en0")
        await waitFor("the restart on network up") { server.count("sfuIceRestart") == 1 }
    }

    func testAPathChangeRestartsIceThoughConnected() async throws {
        try await connectedSession()
        sfu.networkPath(satisfied: true, signature: "en0")
        sfu.networkPath(satisfied: true, signature: "pdp_ip0")  // Wi-Fi to cellular
        await waitFor("the restart") { server.count("sfuIceRestart") == 1 }
    }

    func testAPullOnlySessionRecoversWithANewSession() async throws {
        try await connectedSession(published: false)
        let old = sfu.sessionId
        sfu.simulateConnection(.failed)
        await waitFor("a new session") { sfu.sessionId != old && sfu.sessionId != nil && sfu.pulls["ann"] != nil }
        XCTAssertEqual(server.count("sfuIceRestart"), 0, "the restart form needs my own track")
    }

    func testNoLocalTrackOnARestartMakesANewSession() async throws {
        try await connectedSession()
        let old = sfu.sessionId
        server.script["sfuIceRestart"] = [.error("no_local_track")]
        sfu.simulateConnection(.failed)
        await waitFor("a new session") { sfu.sessionId != old && sfu.sessionId != nil && server.busy == 0 && sfu.publishedTrackName != nil }
    }

    // MARK: - Step 10: the downlink stall detector

    func testADownlinkStallRestartsIceAtMostOncePer10s() async throws {
        try await connectedSession()
        sfu.noteInbound("ann", packets: 100)
        clock.advance(1)
        sfu.noteInbound("ann", packets: 150)
        sfu.checkStall()
        clock.advance(1.5)
        sfu.noteInbound("ann", packets: 150)
        sfu.checkStall()
        await settle()
        XCTAssertEqual(server.count("sfuIceRestart"), 0, "1.5 s silent")
        clock.advance(0.6)
        sfu.noteInbound("ann", packets: 150)
        sfu.checkStall()
        await waitFor("the forced restart") { server.count("sfuIceRestart") == 1 && server.busy == 0 }
        await waitFor("recovered") { !sfu.recovering }
        clock.advance(3)
        sfu.noteInbound("ann", packets: 150)
        sfu.checkStall()
        await settle()
        XCTAssertEqual(server.count("sfuIceRestart"), 1, "not again within 10 s")
    }

    // MARK: - Steps 11, 12: socket reconnect and server restart

    func testANewSocketsRosterResumesAtOnceWithMyTrackAndPulls() async throws {
        try await connectedSession()
        let sid = try XCTUnwrap(sfu.sessionId)
        let annMid = try XCTUnwrap(sfu.pulls["ann"]?.mid)
        // tournamentJoined on the new socket: the room change keeps the session for the roster
        manager.changeRoom(keepSfuFor: "T1")
        XCTAssertTrue(sfu.awaitingRoster)
        XCTAssertNotNil(sfu.pc, "kept")
        XCTAssertEqual(releases, 0, "the kept PeerConnection keeps the audio session")
        manager.applySfuRoster(roster([Self.member("ann", session: "pub-ann")], me: ["sessionId": sid, "trackName": "mic", "state": "reconnecting"]))
        await waitFor("the resume") { server.count("sfuResume") == 1 }
        let r = try XCTUnwrap(server.last("sfuResume"))
        XCTAssertEqual(r["sessionId"] as? String, sid)
        XCTAssertEqual(r["trackName"] as? String, "mic")
        XCTAssertEqual(r["mid"] as? String, sfu.localMid)
        XCTAssertEqual((r["pulls"] as? [[String: Any]])?.first?["mid"] as? String, annMid)
        XCTAssertEqual(server.count("sfuSession"), 1, "never a new session for a signaling-only outage")
        XCTAssertFalse(server.requests.contains { $0.event == "sfuLeave" }, "never sfuLeave on a socket drop")
        // voice starts again on the lobby: the kept pull is a row again, nothing re-pulled
        try await manager.initialize()
        await settle()
        XCTAssertNotNil(manager.peerInfos["sfu:ann"])
        XCTAssertEqual(server.count("sfuPull"), 1)
        XCTAssertEqual(sfu.localSender?.track?.isEnabled, false, "the new local track (muted) is the one sent")
        manager.unmute()
        await waitFor("the unmute reaches the published sender") { sfu.localSender?.track?.isEnabled == true }
        XCTAssertEqual(server.count("sfuPush"), 1, "no push again: the track is replaced on the sender")
    }

    func testAReconnectWithADeadPeerConnectionMakesANewSession() async throws {
        try await connectedSession()
        let sid = try XCTUnwrap(sfu.sessionId)
        manager.changeRoom(keepSfuFor: "T1")
        sfu.simulateConnection(.failed)
        try await manager.initialize()
        manager.applySfuRoster(roster(publishers(["ann"]), me: ["sessionId": sid, "trackName": "mic", "state": "reconnecting"]))
        await waitFor("a new session") { sfu.sessionId != sid && sfu.sessionId != nil && sfu.pulls["ann"] != nil }
        XCTAssertEqual(server.count("sfuResume"), 0)
    }

    func testMySessionNullOnTheSameBootIdClosesIt() async throws {
        try await connectedSession(published: false)
        manager.applySfuRoster(roster([Self.member("ann", session: nil)], me: ["sessionId": NSNull(), "trackName": NSNull(), "state": "live"]))
        await settle()
        XCTAssertNil(sfu.sessionId, "the server dropped it (the grace ran out)")
        XCTAssertNil(sfu.pc)
        XCTAssertEqual(server.count("sfuResume"), 0, "never resumed: session_gone")
    }

    func testANewBootIdResumesTheSameSessionAndHoldsPulls20s() async throws {
        try await startIn(publishers(["ann", "bo"]), unmuted: true)
        await waitFor("ready") { sfu.pulls.count == 2 && sfu.publishedTrackName != nil && server.busy == 0 }
        sfu.simulateConnection(.connected)
        let sid = sfu.sessionId
        // the new process: nobody registered yet, then ann joins with no session, then her old one
        manager.applySfuRoster(roster([], boot: "boot-2"))
        await waitFor("the resume") { server.count("sfuResume") == 1 }
        manager.applySfuMember(memberEvent("joined", Self.member("ann", session: nil), boot: "boot-2"))
        await settle()
        XCTAssertEqual(server.count("sfuClose"), 0, "missing and null-session members are held")
        manager.applySfuMember(memberEvent("session", Self.member("ann", session: "pub-ann"), boot: "boot-2"))
        await settle()
        XCTAssertEqual(server.count("sfuPull"), 1, "ann's pull is unchanged: kept")
        clock.advance(19.9)
        await settle()
        XCTAssertEqual(server.count("sfuClose"), 0)
        clock.advance(0.2)
        await waitFor("bo closed after the hold") { server.count("sfuClose") == 1 && sfu.pulls["bo"] == nil }
        XCTAssertNotNil(sfu.pulls["ann"])
        XCTAssertEqual(sfu.sessionId, sid)
        XCTAssertEqual(server.count("sfuSession"), 1)
    }

    // MARK: - Background / foreground

    func testAShortBackgroundRestartsIceAndALongOneMakesANewSession() async throws {
        try await connectedSession()
        let sid = sfu.sessionId
        manager.handleBackground()
        clock.advance(5)
        sfu.simulateConnection(.disconnected)
        manager.handleForeground()
        await waitFor("a restart") { server.count("sfuIceRestart") == 1 }
        sfu.simulateConnection(.connected)
        await waitFor("recovered") { !sfu.recovering }
        XCTAssertEqual(sfu.sessionId, sid)

        manager.handleBackground()
        clock.advance(60)
        sfu.simulateConnection(.failed)
        manager.handleForeground()
        await waitFor("a new session") { sfu.sessionId != sid && sfu.sessionId != nil && sfu.pulls["ann"] != nil }
        XCTAssertEqual(server.count("sfuIceRestart"), 1, "away 60 s: no restart")
    }

    func testAForegroundAfterALongBackgroundNeverResumesAStaleSession() async throws {
        try await connectedSession()
        let sid = try XCTUnwrap(sfu.sessionId)
        manager.handleBackground()
        clock.advance(60)
        sfu.simulateConnection(.disconnected)
        manager.handleForeground()
        // the socket was rebuilt meanwhile: the roster says resume, but the session is past 30 s
        manager.changeRoom(keepSfuFor: "T1")
        manager.applySfuRoster(roster(publishers(["ann"]), me: ["sessionId": sid, "trackName": "mic", "state": "reconnecting"]))
        try await manager.initialize()
        await waitFor("a new session") { sfu.sessionId != sid && sfu.sessionId != nil && sfu.pulls["ann"] != nil }
        XCTAssertEqual(server.count("sfuResume"), 0)
    }

    func testAReconnectAfterASuspensionMakesANewSessionThoughThePeerConnectionReadsConnected() async throws {
        try await connectedSession()
        let sid = try XCTUnwrap(sfu.sessionId)
        manager.handleBackground()
        clock.advance(60)  // suspended: the PeerConnection saw nothing and still reads connected
        manager.handleForeground()
        manager.changeRoom(keepSfuFor: "T1")  // the socket died meanwhile: a new one re-enters
        manager.applySfuRoster(roster(publishers(["ann"]), me: ["sessionId": sid, "trackName": "mic", "state": "reconnecting"]))
        try await manager.initialize()
        await waitFor("a new session") { sfu.sessionId != sid && sfu.sessionId != nil && sfu.pulls["ann"] != nil }
        XCTAssertEqual(server.count("sfuResume"), 0)
    }

    func testAReconnectStillInTheBackgroundAfterASuspensionMakesANewSession() async throws {
        try await connectedSession()
        let sid = try XCTUnwrap(sfu.sessionId)
        manager.handleBackground()
        clock.advance(60)  // resumed in the background: the socket reconnects before the foreground
        manager.changeRoom(keepSfuFor: "T1")
        manager.applySfuRoster(roster(publishers(["ann"]), me: ["sessionId": sid, "trackName": "mic", "state": "reconnecting"]))
        try await manager.initialize()
        await waitFor("a new session") { sfu.sessionId != sid && sfu.sessionId != nil }
        XCTAssertEqual(server.count("sfuResume"), 0)
        manager.handleForeground()
    }

    func testAReconnectAfterAShortBackgroundResumes() async throws {
        try await connectedSession()
        let sid = try XCTUnwrap(sfu.sessionId)
        manager.handleBackground()
        clock.advance(10)
        manager.handleForeground()
        manager.changeRoom(keepSfuFor: "T1")
        manager.applySfuRoster(roster(publishers(["ann"]), me: ["sessionId": sid, "trackName": "mic", "state": "reconnecting"]))
        await waitFor("the resume") { server.count("sfuResume") == 1 }
        XCTAssertEqual(sfu.sessionId, sid)
    }

    // MARK: - Steps 1, 13: leaving, the mesh, the line

    func testLeavingSendsSfuLeaveThenClosesAndASocketDropDoesNot() async throws {
        try await connectedSession()
        let sid = sfu.sessionId
        manager.suspend()  // alone past the grace
        XCTAssertEqual(server.last("sfuLeave")?["sessionId"] as? String, sid)
        XCTAssertNil(sfu.pc)
        XCTAssertTrue(manager.tournamentCompany(me: "me") || sfu.memberNames.isEmpty == false, "the roster stays")
        await waitFor("the audio session released") { releases == 1 }

        try await manager.initialize()
        await waitFor("a session again") { sfu.pulls["ann"] != nil }
        manager.shutdown()  // off the screen
        XCTAssertEqual(server.count("sfuLeave"), 2)
        XCTAssertEqual(sfu.status, .none)
        XCTAssertTrue(sfu.memberNames.isEmpty)
    }

    func testAMeshRoomOrASeatClosesTheSessionWithoutSfuLeave() async throws {
        try await connectedSession()
        manager.changeRoom(keepSfuFor: "T1")
        manager.meshRoomSeen()  // voicePeerList after a deploy onto a process with the flag off
        XCTAssertNil(sfu.pc)
        XCTAssertEqual(server.count("sfuLeave"), 0)
        XCTAssertEqual(sfu.status, .none)

        try await manager.initialize()
        manager.applySfuRoster(roster(publishers(["ann"])))
        await waitFor("again") { sfu.pulls["ann"] != nil }
        manager.changeRoom()  // tournamentGameAssignment: seated at the round's table
        XCTAssertNil(sfu.pc)
        XCTAssertEqual(server.count("sfuLeave"), 0)
        manager.applySfuRoster(roster(publishers(["ann"])))
        try await manager.initialize()
        await waitFor("again") { sfu.pulls["ann"] != nil }
        manager.sfuRoomGone(why: "tournamentLeft")
        XCTAssertNil(sfu.pc)
        XCTAssertEqual(server.count("sfuLeave"), 0)
    }

    func testAKeptSessionWithNoRosterEnds() async throws {
        try await connectedSession()
        manager.changeRoom(keepSfuFor: "T1")
        clock.advance(SfuVoice.awaitRosterLimit + 0.1)
        XCTAssertNil(sfu.pc)
    }

    func testWaitingAndOut() async throws {
        try await connectedSession()
        manager.applySfuRoster(roster([], status: "waiting", cap: 12))
        XCTAssertNil(sfu.pc, "in line: no voice")
        XCTAssertEqual(manager.sfuWaitingCap, 12)
        XCTAssertFalse(manager.tournamentCompany(me: "me"))
        XCTAssertEqual(TournamentVoice.fullNote(cap: 12), "Voice is full (12 people)")
        manager.applySfuRoster(roster(publishers(["ann"])))
        XCTAssertEqual(manager.sfuWaitingCap, nil)
        await waitFor("let in") { sfu.pulls["ann"] != nil }
        manager.applySfuRoster(roster([], status: "out"))
        XCTAssertNil(sfu.pc)
        XCTAssertEqual(server.count("sfuLeave"), 0, "out: no sfuLeave needed")
    }

    func testTheHandlerShowsTheLineOnTheLobbyOnly() {
        let app = AppState()
        let state = TournamentState()
        state.tournamentId = "T1"
        app.screen = .tournamentLobby
        let handler = TournamentSocketHandler(socket: SocketService.shared, tournamentState: state, gameState: GameState(),
                                              appState: app, safetyState: SafetyState(), voice: { [manager] in manager! })
        handler.handleSfuRoster(["tournamentId": "T1", "bootId": "b", "rev": 1, "status": "waiting", "cap": 100, "members": []])
        XCTAssertEqual(state.voiceFullCap, 100)
        handler.handleSfuRoster(["tournamentId": "T1", "bootId": "b", "rev": 2, "status": "admitted", "cap": 100, "members": [], "self": NSNull()])
        XCTAssertNil(state.voiceFullCap)
        app.screen = .mainRoom
        handler.handleSfuRoster(["tournamentId": "T1", "bootId": "b", "rev": 3, "status": "waiting", "cap": 100, "members": []])
        XCTAssertNil(state.voiceFullCap, "only on the tournament lobby screen")
    }

    // MARK: - The manager: audio session, speaking poll at 20+

    func testTheAudioSessionIsTheSessionsPeerConnections() async throws {
        try await startIn([Self.member("ann", session: nil)])
        await settle()
        XCTAssertEqual(claims, 0, "no PeerConnection, no audio session")
        XCTAssertFalse(manager.ownsAudioSession)
        server.publishers["pub-ann"] = "ann"
        manager.applySfuMember(memberEvent("published", Self.member("ann", session: "pub-ann")))
        await pulledAll(["ann"])
        XCTAssertTrue(manager.ownsAudioSession)
        XCTAssertEqual(claims, 1)
        sfu.renewSession(why: "test")  // a new session closes the old PC and opens the next in one turn
        await waitFor("pulled again") { sfu.pulls["ann"] != nil }
        XCTAssertEqual(releases, 0, "not released around a replaced session")
        manager.sfuRoomGone(why: "test")
        await waitFor("released") { releases == 1 }
        XCTAssertFalse(manager.ownsAudioSession)
    }

    func testTheSpeakingPollAsksEachPulledReceiverAndSlowsPast8() async throws {
        let names = (0..<20).map { "m\($0)" }
        try await startIn(publishers(names), unmuted: true)
        await waitFor("20 pulls", timeout: 20) { sfu.pulls.count == 20 && sfu.publishedTrackName != nil && server.busy == 0 }
        await waitFor("the slower poll") { manager.speakingPollPeriod == SpeakingPoll.busyInterval }
        let before = manager.speakingStatsRequests
        try? await Task.sleep(nanoseconds: 700_000_000)
        let after = manager.speakingStatsRequests
        XCTAssertGreaterThanOrEqual(after.receiver - before.receiver, 20, "every pulled receiver asked")
        XCTAssertLessThanOrEqual(after.receiver - before.receiver, 20 * 5, "one request in flight each, every 200 ms")
        XCTAssertGreaterThan(after.sender, before.sender, "my level from the published sender")
        manager.applySfuRoster(roster(publishers(Array(names.prefix(5)))))
        await waitFor("15 closed") { sfu.pulls.count == 5 && server.busy == 0 }
        await waitFor("the faster poll") { manager.speakingPollPeriod == SpeakingPoll.baseInterval }
    }
}

import XCTest
@preconcurrency import WebRTC
@testable import BAB_Online

/// One call per player after a reconnect (owner 2026-11-27, iOS 1.2.8 (49) on the Duo: an update
/// went out during a game and "the voices sounded strange, like there was maybe an echo";
/// docs/claude/voice.md "One call per player after a reconnect"). A deploy's hand-off (or a blip
/// that drops every socket at once) gives every player a new socket id while the calls keep their
/// media and nobody is told the old sockets left; the next peer list made a second call to every
/// player (live before the fix: 2 calls per player after a hand-off, 3 after a blip on top). Real
/// in-process calls whose audio flows (`ToneAudioDevice`), signaled through a relay that knows
/// each manager by its current socket id, as the server does.
@MainActor
final class OneCallPerPlayerTests: XCTestCase {
    /// The server's relay: offers, answers and candidates to the manager on that socket id now;
    /// a candidate waits until its target has a call with the sender.
    @MainActor final class Relay {
        var byId: [String: VoiceChatManager] = [:]
        var names: [String: String] = [:]
        var offers: [(from: String, to: String)] = []
        /// Every trickled candidate's sender and target, in order.
        var candidateTargets: [(from: String, to: String)] = []
        private var held: [(from: String, to: String, candidate: RTCIceCandidate)] = []

        func offer(from: String, to: String, _ sdp: RTCSessionDescription) {
            offers.append((from, to))
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self.byId[to]?.handleOffer(fromSocketId: from, offer: sdp, username: self.names[from] ?? "")
                    self.flush()
                }
            }
        }

        func answer(from: String, to: String, _ sdp: RTCSessionDescription) {
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self.byId[to]?.handleAnswer(fromSocketId: from, answer: sdp) }
            }
        }

        func candidate(from: String, to: String, _ c: RTCIceCandidate) {
            candidateTargets.append((from, to))
            held.append((from, to, c))
            DispatchQueue.main.async { MainActor.assumeIsolated { self.flush() } }
        }

        func flush() {
            held.removeAll { h in
                guard let m = byId[h.to], m.connection(of: h.from) != nil else { return false }
                m.handleIceCandidate(fromSocketId: h.from, candidate: h.candidate)
                return true
            }
        }
    }

    /// A manager's socket id, changed by a reconnect.
    final class Sid { var id: String; init(_ id: String) { self.id = id } }

    private var managers: [VoiceChatManager] = []

    override func tearDown() async throws {
        for m in managers { m.shutdown() }
        managers = []
    }

    private func waitUntil(_ what: String, timeout: TimeInterval = 15, _ condition: () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > end { return XCTFail("timed out: \(what)") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    private func sleep(_ seconds: TimeInterval) async throws {
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    private func make(_ relay: Relay, _ sid: Sid, _ name: String, _ device: ToneAudioDevice) -> VoiceChatManager {
        let m = VoiceChatManager.silent(sendOffer: { to, sdp, _ in relay.offer(from: sid.id, to: to, sdp) },
                                        sendAnswer: { to, sdp in relay.answer(from: sid.id, to: to, sdp) },
                                        socketId: { sid.id },
                                        sendIceCandidate: { to, c in relay.candidate(from: sid.id, to: to, c) },
                                        audioDevice: device)
        relay.byId[sid.id] = m
        relay.names[sid.id] = name
        managers.append(m)
        return m
    }

    /// The listener hears the other's tone now.
    private func hears(_ device: ToneAudioDevice) async throws -> Bool {
        device.resetLevel()
        try await sleep(0.5)
        return device.peakLevel > 0.02
    }

    /// amy (A1) and bob (B1) in a call (amy offered: bob was listed to her), both unmuted, each
    /// hearing the other's tone.
    private func call() async throws -> (relay: Relay, amy: VoiceChatManager, bob: VoiceChatManager, sa: Sid, sb: Sid,
                                          da: ToneAudioDevice, db: ToneAudioDevice) {
        let relay = Relay()
        let sa = Sid("A1"), sb = Sid("B1")
        let da = ToneAudioDevice(), db = ToneAudioDevice()
        let amy = make(relay, sa, "amy", da)
        let bob = make(relay, sb, "bob", db)
        try await amy.initialize()
        try await bob.initialize()
        amy.unmute()
        bob.unmute()
        try await waitUntil("both unmuted") { !amy.isSelfMuted && !bob.isSelfMuted }
        amy.connectToPeer("B1", username: "bob")
        try await waitUntil("bob hears amy") { db.peakLevel > 0.02 }
        try await waitUntil("amy hears bob") { da.peakLevel > 0.02 }
        return (relay, amy, bob, sa, sb, da, db)
    }

    /// The hand-off: both sockets change, the server lists bob@B2 to amy and announces amy@A2 to
    /// bob. Each moves its call to the new id: one connection each, no new offer, still heard.
    func testAfterAHandOffEachSideKeepsItsOneCallOnTheNewIds() async throws {
        let c = try await call()
        let amyPc = try XCTUnwrap(c.amy.connection(of: "B1"))
        let bobPc = try XCTUnwrap(c.bob.connection(of: "A1"))
        XCTAssertEqual(c.relay.offers.count, 1)

        c.sa.id = "A2"
        c.sb.id = "B2"
        c.relay.byId = ["A2": c.amy, "B2": c.bob]
        c.relay.names = ["A2": "amy", "B2": "bob"]
        c.amy.connectToPeer("B2", username: "bob")
        c.bob.peerJoined("A2", username: "amy")
        try await waitUntil("both moved") { c.amy.callIds == ["B2"] && c.bob.callIds == ["A2"] }
        try await sleep(VoiceChatManager.flowSample + 0.5)

        XCTAssertEqual(c.amy.callIds, ["B2"], "one call to bob, on his new socket")
        XCTAssertEqual(c.bob.callIds, ["A2"], "one call to amy, on her new socket")
        XCTAssertTrue(c.amy.connection(of: "B2") === amyPc, "the same connection, moved")
        XCTAssertTrue(c.bob.connection(of: "A2") === bobPc)
        XCTAssertEqual(c.relay.offers.count, 1, "no new offer either way")
        XCTAssertEqual(c.amy.peerInfos["B2"]?.username, "bob", "the voice panel's row moved too")
        XCTAssertNil(c.amy.peerInfos["B1"])
        let amyHears = try await hears(c.da)
        let bobHears = try await hears(c.db)
        XCTAssertTrue(amyHears && bobHears, "still heard both ways")

        // the moved call is checked again later and kept (still flowing)
        try await sleep(VoiceChatManager.rekeyVerify + VoiceChatManager.flowSample + 0.5)
        XCTAssertEqual(c.amy.callIds, ["B2"])
        XCTAssertEqual(c.relay.offers.count, 1)
    }

    /// The other side closed its end (it was told the old socket left, or reloaded): the silent
    /// call is closed and the listed player gets a new call on the new id.
    func testASilentOldCallIsReplacedByANewOne() async throws {
        let c = try await call()
        let amyPc = try XCTUnwrap(c.amy.connection(of: "B1"))
        c.bob.removePeer("A1")  // bob's end of the old call is gone
        try await sleep(0.3)

        c.sa.id = "A2"
        c.sb.id = "B2"
        c.relay.byId = ["A2": c.amy, "B2": c.bob]
        c.relay.names = ["A2": "amy", "B2": "bob"]
        c.amy.connectToPeer("B2", username: "bob")
        try await waitUntil("a new offer to bob's new socket") { c.relay.offers.count == 2 }
        XCTAssertEqual(c.relay.offers.last?.to, "B2")
        XCTAssertEqual(amyPc.signalingState, .closed, "the silent call closed")
        try await waitUntil("the new call plays") { c.amy.callIds == ["B2"] && c.bob.callIds == ["A2"] }
        let bobHears = try await hears(c.db)
        XCTAssertTrue(bobHears)
    }

    /// An offer from a player I hold a call with on an older socket id (they reloaded, or an older
    /// build offers again after its reconnect): that call is replaced, never kept beside the new one.
    func testAnOfferFromThePlayerOnANewSocketReplacesTheOldCall() async throws {
        let c = try await call()
        let amyPc = try XCTUnwrap(c.amy.connection(of: "B1"))
        c.amy.mutePeer("B1")
        // bob reloads: a new app process on B2 (named bob), listed amy and offers
        let sb2 = Sid("B2")
        let bob2 = make(c.relay, sb2, "bob", ToneAudioDevice())
        try await bob2.initialize()
        bob2.connectToPeer("A1", username: "amy")
        try await waitUntil("amy answers bob's new call") { c.amy.callIds == ["B2"] }
        XCTAssertEqual(amyPc.signalingState, .closed, "the old call closed")
        XCTAssertEqual(c.amy.peerInfos["B2"]?.isMuted, true, "my mute of bob carried (by name)")
    }

    /// A moved call that goes silent (the other end closed it after all) is offered again.
    func testAMovedCallThatGoesSilentIsOfferedAgain() async throws {
        let c = try await call()
        c.sa.id = "A2"
        c.sb.id = "B2"
        c.relay.byId = ["A2": c.amy, "B2": c.bob]
        c.relay.names = ["A2": "amy", "B2": "bob"]
        c.amy.connectToPeer("B2", username: "bob")
        try await waitUntil("moved") { c.amy.callIds == ["B2"] }
        // bob never moved his: his end of the old call closes
        c.bob.removePeer("A1")
        try await waitUntil("offered again", timeout: VoiceChatManager.rekeyVerify + 8) { c.relay.offers.count == 2 }
        XCTAssertEqual(c.relay.offers.last?.to, "B2")
        try await waitUntil("one call again, heard") { c.amy.callIds == ["B2"] && c.bob.callIds == ["A2"] }
    }

    // MARK: - Review 2026-11-27

    /// Do this call's inbound audio packets grow over half a second?
    private func packetsGrow(_ pc: RTCPeerConnection) async throws -> Bool {
        func packets() async -> Int {
            await withCheckedContinuation { cont in
                pc.statistics { report in
                    let n = report.statistics.values
                        .filter { $0.type == "inbound-rtp" }
                        .reduce(0) { $0 + (($1.values["packetsReceived"] as? NSNumber)?.intValue ?? 0) }
                    cont.resume(returning: n)
                }
            }
        }
        let a = await packets()
        try await sleep(0.5)
        let b = await packets()
        return b > a
    }

    /// The hand-off's ids, for both sides (amy A2, bob B2).
    private func handOff(_ c: (relay: Relay, amy: VoiceChatManager, bob: VoiceChatManager, sa: Sid, sb: Sid,
                               da: ToneAudioDevice, db: ToneAudioDevice)) {
        c.sa.id = "A2"
        c.sb.id = "B2"
        c.relay.byId = ["A2": c.amy, "B2": c.bob]
        c.relay.names = ["A2": "amy", "B2": "bob"]
    }

    /// A moved call's own signaling (its delegate: ICE candidates) goes to the player's NEW socket
    /// id. Before, the delegate kept the old id (it was looked up by a string-literal
    /// associated-object key, which found nothing), so an ICE restart's candidates went to B1.
    func testTheCandidatesOfAMovedCallGoToTheNewId() async throws {
        let c = try await call()
        handOff(c)
        c.amy.connectToPeer("B2", username: "bob")
        c.bob.peerJoined("A2", username: "amy")
        try await waitUntil("both moved") { c.amy.callIds == ["B2"] && c.bob.callIds == ["A2"] }
        let pc = try XCTUnwrap(c.amy.connection(of: "B2"))
        let before = c.relay.candidateTargets.count
        // an ICE restart on the moved call gathers new candidates
        pc.restartIce()
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let offer = try await pc.offer(for: constraints)
        try await pc.setLocalDescription(offer)
        try await waitUntil("new candidates") { c.relay.candidateTargets.count > before }
        try await sleep(0.3)
        let targets = c.relay.candidateTargets[before...].filter { $0.from == "A2" }.map(\.to)
        XCTAssertFalse(targets.isEmpty)
        XCTAssertEqual(Set(targets), ["B2"], "the moved call's candidates go to bob's new socket")
    }

    /// A moved call that later fails (a network change) reaches the recovery under the new id:
    /// amy (A2 < B2) restarts it with a new offer to B2. Before, its ICE state was reported under
    /// B1 and ignored, so the call was never restarted nor marked unavailable.
    func testAnIceFailureAfterAMoveIsRecovered() async throws {
        let c = try await call()
        handOff(c)
        c.amy.connectToPeer("B2", username: "bob")
        c.bob.peerJoined("A2", username: "amy")
        try await waitUntil("both moved") { c.amy.callIds == ["B2"] && c.bob.callIds == ["A2"] }
        let pc = try XCTUnwrap(c.amy.connection(of: "B2"))
        XCTAssertEqual(c.relay.offers.count, 1)
        // what WebRTC reports when the moved call's ICE fails
        pc.delegate?.peerConnection(pc, didChange: RTCIceConnectionState.failed)
        try await waitUntil("restarted with a new offer to B2") { c.relay.offers.count == 2 }
        XCTAssertEqual(c.relay.offers.last?.from, "A2")
        XCTAssertEqual(c.relay.offers.last?.to, "B2")
        try await waitUntil("one call again, heard") {
            c.amy.callIds == ["B2"] && c.bob.callIds == ["A2"] && c.amy.connection(of: "B2") !== pc
        }
    }

    /// Two reconnects in a row: bob is announced on B2, then on B3 within one flow sample. amy
    /// keeps ONE call, on bob's newest id (before: 2 calls, then one keyed by the stale B2).
    func testTwoReconnectsInARowSettleOnTheNewestId() async throws {
        let c = try await call()
        let amyPc = try XCTUnwrap(c.amy.connection(of: "B1"))
        handOff(c)
        c.amy.connectToPeer("B2", username: "bob")
        c.bob.peerJoined("A2", username: "amy")
        try await sleep(0.2)
        // bob drops again: B3
        c.sb.id = "B3"
        c.relay.byId = ["A2": c.amy, "B3": c.bob]
        c.relay.names = ["A2": "amy", "B3": "bob"]
        c.amy.connectToPeer("B3", username: "bob")
        try await waitUntil("moved to B3") { c.amy.callIds == ["B3"] }
        try await sleep(VoiceChatManager.rekeyVerify + VoiceChatManager.livenessSample + 1)
        XCTAssertEqual(c.amy.callIds, ["B3"], "one call, on bob's newest socket")
        XCTAssertTrue(c.amy.connection(of: "B3") === amyPc, "the same connection")
        XCTAssertEqual(c.relay.offers.count, 1, "no new offer")
        let hearsBob = try await hears(c.da)
        XCTAssertTrue(hearsBob)
    }

    /// A player who sends no audio (a muted web tab with a suspended AudioContext, a spectator):
    /// the call is still alive (its transport answers), so it moves rather than closing. Before,
    /// only inbound packets counted, and the call was closed and offered anew (a gap of seconds).
    func testACallFromAPlayerWhoSendsNoAudioStillMoves() async throws {
        let c = try await call()
        let amyPc = try XCTUnwrap(c.amy.connection(of: "B1"))
        // bob's side sends no audio packet at all from now on (his device records nothing)
        c.db.recordsNothing = true
        try await sleep(0.5)
        let still = try await packetsGrow(amyPc)
        XCTAssertFalse(still, "bob sends no audio now")
        handOff(c)
        c.amy.connectToPeer("B2", username: "bob")
        try await waitUntil("moved", timeout: VoiceChatManager.flowSample + VoiceChatManager.livenessSample + 3) {
            c.amy.callIds == ["B2"] && c.amy.connection(of: "B2") === amyPc
        }
        XCTAssertEqual(amyPc.signalingState, .stable, "kept, not closed")
        XCTAssertEqual(c.relay.offers.count, 1, "no new offer")
    }
}

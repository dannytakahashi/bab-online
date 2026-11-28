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
}

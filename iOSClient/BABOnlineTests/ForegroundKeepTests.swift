import XCTest
import Combine
import SocketIO
@testable import BAB_Online

/// One extra restore after a long background (owner 2026-11-14): a foreground after the
/// keep-alive replaced even a connection that had already recovered (~2 s of reconnect and
/// restore for nothing). `SocketService.resumeAfterKeepAlive` keeps a connection that is
/// connected, session-ready AND answers a round trip on the same socket within
/// `foregroundProbeTimeout`; everything else is rebuilt at once, as before
/// (ForegroundReconnectTests covers the rebuild itself). A real SocketManager against
/// FakeSocketIOServer (or a refused port).
final class ForegroundKeepTests: XCTestCase {
    private var service: SocketService { SocketService.shared }  // the app skips its socket under XCTest
    private var server: FakeSocketIOServer!
    private var bag: Set<AnyCancellable> = []

    override func setUpWithError() throws {
        server = FakeSocketIOServer()
        try server.start()
    }

    override func tearDown() {
        bag = []
        service.disconnect()
        service.serverURLOverride = nil
        service.isConnected = false
        service.isSessionReady = false
        server.stop()
        server = nil
        super.tearDown()
    }

    private func wait(_ what: String, timeout: TimeInterval = 10, until done: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !done() && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        XCTAssertTrue(done(), what)
    }

    private func spin(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    /// Connected through the fake server, the session restored (as the restore's answer
    /// would leave it), and the keep-alive long gone.
    private func connectAndSignIn() throws -> SocketManager {
        service.serverURLOverride = server.url
        service.connect()
        wait("connected to the local server") { service.isConnected && service.socket?.status == .connected }
        service.noteSessionEstablished()
        XCTAssertEqual(server.handshakes, 1)
        return try XCTUnwrap(service.manager)
    }

    private var probes: [[String: Any]] {
        server.events.filter { $0.name == "requestSnapshot" }.map(\.payload)
    }

    // MARK: - The decision table

    func testDecisionTable() {
        typealias C = SocketService.ForegroundCheck
        func check(_ m: SocketIOStatus?, _ s: SocketIOStatus?, _ c: Bool, _ r: Bool) -> C {
            SocketService.foregroundCheck(managerStatus: m, socketStatus: s, isConnected: c, isSessionReady: r)
        }
        // the only state that is even probed
        XCTAssertEqual(check(.connected, .connected, true, true), .probe)
        // everything else: a new connection at once
        XCTAssertEqual(check(nil, nil, false, false), .rebuild(reason: "no connection"))
        for s in [SocketIOStatus.connecting, .notConnected, .disconnected] {
            XCTAssertEqual(check(.connected, s, true, true), .rebuild(reason: "socket \(s)"))
            XCTAssertEqual(check(s, .connected, true, true), .rebuild(reason: "manager \(s)"))
        }
        // mid-backoff (the 2026-11-12 case): socket connecting, manager not connected
        XCTAssertEqual(check(.notConnected, .connecting, false, false), .rebuild(reason: "socket connecting"))
        XCTAssertEqual(check(.connected, .connected, false, true), .rebuild(reason: "not connected"))
        // connected, restore not answered yet (or signed out: nobody to restore)
        XCTAssertEqual(check(.connected, .connected, true, false), .rebuild(reason: "session not ready"))
    }

    // MARK: - Keep

    /// The server answers: the same manager and socket stay, no handshake, and nothing the
    /// UI watches ever goes false (no Reconnecting toast, no disabled buttons).
    func testLiveSessionReadyConnectionIsKept() throws {
        let manager = try connectAndSignIn()
        let socket = try XCTUnwrap(service.socket)
        let opened = service.connectionsOpened
        var flags: [String] = []
        service.$isConnected.dropFirst().sink { flags.append("isConnected=\($0)") }.store(in: &bag)
        service.$isSessionReady.dropFirst().sink { flags.append("isSessionReady=\($0)") }.store(in: &bag)

        service.resumeAfterKeepAlive()

        wait("the probe answered") { service.lastForegroundOutcome == .kept }
        XCTAssertTrue(service.manager === manager, "the same manager")
        XCTAssertTrue(service.socket === socket, "the same socket")
        XCTAssertEqual(service.connectionsOpened, opened, "no new connection")
        XCTAssertEqual(server.handshakes, 1, "no new handshake")
        XCTAssertEqual(server.namespaceConnects, 1)
        XCTAssertTrue(service.isConnected)
        XCTAssertTrue(service.isSessionReady)
        XCTAssertEqual(flags, [], "nothing the UI shows changed")
        // the probe is the table resync request
        XCTAssertEqual(probes.count, 1)
        XCTAssertTrue((probes.first?["requestId"] as? String)?.hasPrefix("fg-") == true)
        XCTAssertEqual(probes.first?["log"] as? Bool, false)
        // the probe's handlers are gone: the socket has exactly the handlers it had
        spin(SocketService.foregroundProbeTimeout + 0.3)
        XCTAssertEqual(service.lastForegroundOutcome, .kept, "the bound passing later changes nothing")
        XCTAssertTrue(service.manager === manager)
    }

    /// Kept again and again: every foreground probes, never rebuilds.
    func testRepeatedForegroundsKeepTheSameConnection() throws {
        let manager = try connectAndSignIn()
        for i in 1...3 {
            service.resumeAfterKeepAlive()
            wait("probe \(i) answered") { self.probes.count == i && service.lastForegroundOutcome == .kept }
        }
        XCTAssertTrue(service.manager === manager)
        XCTAssertEqual(server.handshakes, 1)
        XCTAssertEqual(Set(probes.compactMap { $0["requestId"] as? String }).count, 3, "a new requestId each time")
    }

    // MARK: - Rebuild at once

    /// Connected but the restore has not answered (or nobody is signed in): no probe, a new
    /// connection now, exactly as before.
    func testSessionNotReadyRebuildsAtOnce() throws {
        let manager = try connectAndSignIn()
        service.isSessionReady = false

        service.resumeAfterKeepAlive()

        XCTAssertFalse(service.manager === manager, "a new manager at once")
        XCTAssertEqual(service.lastForegroundOutcome, .rebuilt(reason: "session not ready"))
        XCTAssertEqual(manager.status, .disconnected, "the old one retired")
        XCTAssertEqual(probes.count, 0, "no probe")
        wait("the new connection's handshake") { self.server.handshakes == 2 }
    }

    /// The library mid-backoff (the 2026-11-12 case): rebuilt at once, never probed.
    func testNotConnectedRebuildsAtOnce() throws {
        service.serverURLOverride = ForegroundReconnectTests.refusedURL
        service.connect()
        let old = try XCTUnwrap(service.manager)
        wait("the library is reconnecting") { service.socket?.status == .connecting && old.status != .connected }
        service.isSessionReady = true  // even with a stale flag

        service.resumeAfterKeepAlive()

        XCTAssertFalse(service.manager === old)
        XCTAssertEqual(old.status, .disconnected)
        guard case .rebuilt = service.lastForegroundOutcome else { return XCTFail("\(String(describing: service.lastForegroundOutcome))") }
    }

    // MARK: - Fault injection: the probe fails, the old bug class still recovers

    /// The server never answers (a connection that looks connected but whose namespace or
    /// session is gone, the 2026-11-12 bug, or a dead link): kept until the bound, then a new
    /// connection, whose handshake and namespace connect go through.
    func testUnansweredProbeRebuildsAfterTheBound() throws {
        let manager = try connectAndSignIn()
        server.answersSnapshots = false
        let started = Date()

        service.resumeAfterKeepAlive()

        spin(SocketService.foregroundProbeTimeout - 0.4)
        XCTAssertTrue(service.manager === manager, "not before the bound")
        XCTAssertTrue(service.isConnected, "no flash while it waits")
        wait("rebuilt after the bound", timeout: 5) { !(service.manager === manager) }
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), SocketService.foregroundProbeTimeout - 0.05)
        guard case .rebuilt(let reason) = service.lastForegroundOutcome else { return XCTFail("not rebuilt") }
        XCTAssertTrue(reason.hasPrefix("probe unanswered"), reason)
        XCTAssertEqual(manager.status, .disconnected, "the old manager retired")
        XCTAssertFalse(manager.reconnects)
        wait("the new connection connects") { service.isConnected && self.server.handshakes == 2 && self.server.namespaceConnects == 2 }
        XCTAssertFalse(service.isSessionReady, "the restore has to answer first (session gate)")
    }

    /// The server restarted while the app was away: the probe's request is refused with
    /// Engine.IO's "Session ID unknown", the old socket fails, and the rebuild starts then,
    /// without waiting out the bound.
    func testServerRestartedWhileBackgroundedRebuildsWithoutWaiting() throws {
        let manager = try connectAndSignIn()
        let oldSocket = try XCTUnwrap(service.socket)
        server.restart()
        let started = Date()

        service.resumeAfterKeepAlive()

        wait("rebuilt", timeout: 5) { !(service.manager === manager) }
        guard case .rebuilt(let reason) = service.lastForegroundOutcome else { return XCTFail("not rebuilt") }
        XCTAssertFalse(reason.hasPrefix("probe unanswered"), "the failure, not the bound: \(reason)")
        XCTAssertLessThan(Date().timeIntervalSince(started), SocketService.foregroundProbeTimeout)
        // The old manager's own reconnect may have sent a handshake before it was retired
        // (its late answer can even open that engine), but it joins no namespace: retired.
        wait("reconnected to the restarted server") { service.isConnected && self.server.handshakes >= 2 }
        XCTAssertFalse(manager.reconnects)
        XCTAssertNil(manager.nsps["/"])
        XCTAssertTrue(oldSocket.handlers.isEmpty)
        XCTAssertEqual(server.namespaceConnects, 2, "one namespace on the old server, one on the restarted one")
    }

    /// An answer that comes after the bound changes nothing: the connection was already
    /// replaced, and the new one is not replaced again.
    func testLateAnswerAfterTheBoundIsIgnored() throws {
        let manager = try connectAndSignIn()
        server.answersSnapshots = false
        service.resumeAfterKeepAlive()
        wait("rebuilt after the bound", timeout: 5) { !(service.manager === manager) }
        let fresh = try XCTUnwrap(service.manager)
        let opened = service.connectionsOpened
        spin(SocketService.foregroundProbeTimeout + 0.3)
        XCTAssertTrue(service.manager === fresh)
        XCTAssertEqual(service.connectionsOpened, opened, "one rebuild per foreground")
    }

    /// Sign-out (forceReconnect) while the probe waits: one new connection, the probe's
    /// bound does not replace it again.
    func testSignOutDuringTheProbeWinsOnce() throws {
        _ = try connectAndSignIn()
        server.answersSnapshots = false
        service.resumeAfterKeepAlive()
        service.forceReconnect()
        let afterSignOut = try XCTUnwrap(service.manager)
        let opened = service.connectionsOpened
        spin(SocketService.foregroundProbeTimeout + 0.3)
        XCTAssertTrue(service.manager === afterSignOut)
        XCTAssertEqual(service.connectionsOpened, opened)
    }

    /// Backgrounded again while the probe waits: the probe is dropped, so its bound cannot
    /// replace the connection at the next foreground (which runs its own check).
    func testBackgroundCancelsTheProbe() throws {
        let manager = try connectAndSignIn()
        server.answersSnapshots = false
        service.resumeAfterKeepAlive()
        service.beginBackgroundKeepAlive()
        service.endBackgroundKeepAlive()
        spin(SocketService.foregroundProbeTimeout + 0.3)
        XCTAssertTrue(service.manager === manager, "no rebuild from a cancelled probe")
    }
}

import XCTest
@testable import BAB_Online

/// c2s clientError from iOS (ErrorReporter): once per kind per launch, sent only while the
/// sender takes it (connected), a few buffered for the next connect, cut to the server's
/// limits; an uncaught exception saved for the next launch; TableLog's decode failures and
/// the unreadable table go through it.
final class ErrorReporterTests: XCTestCase {
    private var sent: [[String: Any]] = []
    private var connected = true
    private var defaults: UserDefaults!
    private let suite = "ErrorReporterTests"

    override func setUp() {
        super.setUp()
        sent = []
        connected = true
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private func reporter() -> ErrorReporter {
        let r = ErrorReporter(build: "10", defaults: defaults)
        r.sender = { [unowned self] payload in
            guard connected else { return false }
            sent.append(payload)
            return true
        }
        return r
    }

    private var kinds: [String] { sent.compactMap { $0["kind"] as? String } }

    func testAReportIsTheContractPayload() {
        let r = reporter()
        r.page = { "game" }
        XCTAssertTrue(r.report(kind: "decode", message: "cardPlayed undecodable: keyNotFound card", location: "cardPlayed"))
        XCTAssertEqual(sent.count, 1)
        let p = sent[0]
        XCTAssertEqual(p["kind"] as? String, "decode")
        XCTAssertEqual(p["message"] as? String, "cardPlayed undecodable: keyNotFound card")
        XCTAssertEqual(p["where"] as? String, "cardPlayed")
        XCTAssertEqual(p["build"] as? String, "10")
        XCTAssertEqual(p["page"] as? String, "game")
        XCTAssertNil(p["stack"])
        // only the contract's keys, all strings
        XCTAssertTrue(Set(p.keys).isSubset(of: ["kind", "message", "stack", "where", "build", "page"]))
        for value in p.values { XCTAssertTrue(value is String) }
    }

    func testOncePerKindPerLaunch() {
        let r = reporter()
        r.report(kind: "decode", message: "a")
        r.report(kind: "decode", message: "b")
        r.report(kind: "socket", message: "c")
        XCTAssertEqual(kinds, ["decode", "socket"])
        XCTAssertEqual(r.deduped, 1)
    }

    func testAtMostMaxKinds() {
        let r = reporter()
        for i in 0..<(ErrorReporter.maxKinds + 5) { r.report(kind: "k\(i)", message: "x") }
        XCTAssertEqual(sent.count, ErrorReporter.maxKinds)
    }

    func testAKindTheServerWouldRefuseIsNeverSent() {
        let r = reporter()
        XCTAssertFalse(r.report(kind: "bad kind!", message: "x"))
        XCTAssertFalse(r.report(kind: "", message: "x"))
        XCTAssertFalse(r.report(kind: String(repeating: "k", count: 33), message: "x"))
        XCTAssertTrue(sent.isEmpty)
    }

    func testDisconnectedReportsWaitThenFlushInOrder() {
        let r = reporter()
        connected = false
        for i in 0..<(ErrorReporter.maxBuffer + 2) { r.report(kind: "k\(i)", message: "x") }
        XCTAssertTrue(sent.isEmpty)
        XCTAssertEqual(r.pending, ErrorReporter.maxBuffer)
        XCTAssertEqual(r.dropped, 2)
        r.flush()  // still disconnected: nothing goes, nothing lost
        XCTAssertEqual(r.pending, ErrorReporter.maxBuffer)
        connected = true
        r.flush()
        XCTAssertEqual(kinds, ["k0", "k1", "k2", "k3", "k4"])
        XCTAssertEqual(r.pending, 0)
    }

    func testAReportBehindAWaitingBufferKeepsItsPlace() {
        let r = reporter()
        connected = false
        r.report(kind: "first", message: "x")
        connected = true
        r.report(kind: "second", message: "x")  // the buffer is not empty: queued behind it
        XCTAssertTrue(sent.isEmpty)
        r.flush()
        XCTAssertEqual(kinds, ["first", "second"])
    }

    func testNoSenderBuffers() {
        let r = ErrorReporter(build: "10", defaults: defaults)
        XCTAssertTrue(r.report(kind: "decode", message: "x"))
        XCTAssertEqual(r.pending, 1)
    }

    func testAReportWhileSendingIsDropped() {
        let r = ErrorReporter(build: "10", defaults: defaults)
        var calls = 0
        r.sender = { _ in
            calls += 1
            r.report(kind: "nested", message: "x")
            return true
        }
        r.report(kind: "outer", message: "x")
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(r.pending, 0)
    }

    func testFieldsAreCutToTheServerLimits() throws {
        let long = String(repeating: "é", count: 1000) + "🙂"
        let stack = (0..<40).map { "frame \($0)" }.joined(separator: "\n")
        let report = try XCTUnwrap(ErrorReporter.makeReport(kind: "exception", message: long, location: long, stack: stack + long,
                                                            build: long, page: "a/b c?d"))
        XCTAssertLessThanOrEqual(report.message.utf16.count, ErrorReporter.limits.message)
        XCTAssertLessThanOrEqual(try XCTUnwrap(report.location).utf16.count, ErrorReporter.limits.location)
        XCTAssertLessThanOrEqual(try XCTUnwrap(report.build).utf16.count, ErrorReporter.limits.build)
        XCTAssertEqual(try XCTUnwrap(report.stack).split(separator: "\n").count, 12)
        XCTAssertEqual(report.page, "abcd")
        XCTAssertEqual(ErrorReporter.makeReport(kind: "x", message: "  ")?.message, "(no message)")
        XCTAssertEqual(ErrorReporter.cut("short", 10), "short")
        XCTAssertEqual(ErrorReporter.cut("abcdefghijk", 5), "abcd…")
    }

    func testExpectedSocketErrorsAreNotReported() {
        XCTAssertTrue(ErrorReporter.isExpectedSocketError("The Internet connection appears to be offline."))
        XCTAssertTrue(ErrorReporter.isExpectedSocketError("The request timed out."))
        XCTAssertTrue(ErrorReporter.isExpectedSocketError("Could not connect to the server."))
        XCTAssertTrue(ErrorReporter.isExpectedSocketError("The network connection was lost."))
        XCTAssertTrue(ErrorReporter.isExpectedSocketError("Tried emitting when not connected"))
        XCTAssertFalse(ErrorReporter.isExpectedSocketError("Got unknown error from server {\"message\":\"x\"}"))
        XCTAssertFalse(ErrorReporter.isExpectedSocketError("Invalid packet type"))
    }

    func testAnUncaughtExceptionIsSavedAndSentOnceOnTheNextLaunch() {
        let crashed = reporter()
        crashed.savePendingCrash(name: "NSRangeException", reason: "index 5 beyond bounds", stack: "0 CoreFoundation\n1 BAB Online")
        XCTAssertTrue(sent.isEmpty)  // the process is ending: nothing is sent now

        let nextLaunch = reporter()
        nextLaunch.reportPendingCrash()
        XCTAssertEqual(kinds, ["exception"])
        XCTAssertEqual(sent[0]["message"] as? String, "previous launch: NSRangeException: index 5 beyond bounds")
        XCTAssertEqual(sent[0]["stack"] as? String, "0 CoreFoundation\n1 BAB Online")
        XCTAssertNil(defaults.dictionary(forKey: ErrorReporter.pendingCrashKey))

        let third = reporter()
        third.reportPendingCrash()
        XCTAssertEqual(sent.count, 1)  // forgotten once sent
    }

    func testTableLogReportsEachDecodeFailureKind() {
        let r = reporter()
        TableLog.decodeFailed(.decode(event: "cardPlayed", message: "keyNotFound card"), reporter: r)
        TableLog.decodeFailed(.decode(event: "bidReceived", message: "typeMismatch bid"), reporter: r)  // same kind: once
        TableLog.decodeFailed(.snapshot(event: "stateSnapshot", requestId: "snap-1", problem: .undecodable("keyNotFound snapshot.watching")), reporter: r)
        TableLog.unreadable(failures: 3, reporter: r)
        XCTAssertEqual(kinds, ["decode", "snapshot", "unreadable"])
        XCTAssertEqual(sent[0]["message"] as? String, "cardPlayed undecodable: keyNotFound card")
        XCTAssertEqual(sent[0]["where"] as? String, "cardPlayed")
        XCTAssertEqual(sent[1]["where"] as? String, "stateSnapshot")
        XCTAssertEqual(sent[2]["message"] as? String, "table unreadable after 3 snapshots")
    }

    /// The production wiring: an undecodable table event through the real store reaches the
    /// shared reporter (which buffers here: under XCTest the app opens no socket).
    @MainActor
    func testTheStoreReportsAnUndecodableEventToTheSharedReporter() {
        let before = ErrorReporter.shared.pending
        let store = GameState()
        store.apply(serverEvent: "cardPlayed", payload: [["card": "not a card", "position": 2]])
        XCTAssertGreaterThanOrEqual(ErrorReporter.shared.pending + ErrorReporter.shared.deduped, before + 1)
    }
}

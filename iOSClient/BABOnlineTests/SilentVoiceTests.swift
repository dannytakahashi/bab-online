import XCTest
@preconcurrency import WebRTC
@testable import BAB_Online

/// The unit tests' voice managers never reach CoreAudio (docs/claude/voice.md, Tests): WebRTC
/// plays and records through `SilentAudioDevice`, never its VoiceProcessingIO unit, whose
/// initialisation against the simulator's audio HAL aborted whole runs on a busy Mac.
@MainActor
final class SilentVoiceTests: XCTestCase {
    final class Wire {
        var offers: [RTCSessionDescription] = []
        var answers: [RTCSessionDescription] = []
    }

    private var managers: [VoiceChatManager] = []

    override func tearDown() async throws {
        for m in managers { m.shutdown() }
        managers = []
    }

    private func waitUntil(_ what: String, timeout: TimeInterval = 10, _ condition: () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > end { return XCTFail("timed out: \(what)") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    /// A negotiated call starts playout on the injected device: WebRTC uses it, so its own
    /// audio unit (the one that deadlocked) is never initialised.
    func testANegotiatedCallPlaysThroughTheSilentDevice() async throws {
        let wa = Wire(), wb = Wire()
        let da = SilentAudioDevice(), db = SilentAudioDevice()
        let a = VoiceChatManager.silent(sendOffer: { _, sdp, _ in wa.offers.append(sdp) }, audioDevice: da)
        let b = VoiceChatManager.silent(sendAnswer: { _, sdp in wb.answers.append(sdp) }, audioDevice: db)
        managers = [a, b]
        XCTAssertTrue(da.isInitialized, "the factory initialised the injected device")
        try await a.initialize()
        try await b.initialize()
        a.connectToPeer("B", username: "bob")
        try await waitUntil("A's offer") { wa.offers.count == 1 }
        b.handleOffer(fromSocketId: "A", offer: wa.offers[0], username: "amy")
        try await waitUntil("B's answer") { wb.answers.count == 1 }
        a.handleAnswer(fromSocketId: "B", answer: wb.answers[0])
        try await waitUntil("A stable") { a.signalingState(of: "B") == .stable }
        try await waitUntil("B plays out through its silent device") { db.playoutStarts > 0 }
        try await waitUntil("A plays out through its silent device") { da.playoutStarts > 0 }
    }

    /// Every unit-test manager comes from `VoiceChatManager.silent` (a plain `VoiceChatManager()`
    /// would get WebRTC's real audio unit and the live AVAudioSession hooks), and no test
    /// starts the app's shared manager.
    func testEveryTestManagerIsSilent() throws {
        let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let files = FileManager.default.enumerator(at: tests, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
        XCTAssertGreaterThan(files.count, 20, "read the test sources from the checkout")
        var offenders: [String] = []
        for file in files where !["SilentVoice.swift", "SilentVoiceTests.swift"].contains(file.lastPathComponent) {
            let text = try String(contentsOf: file, encoding: .utf8)
            for (n, line) in text.components(separatedBy: "\n").enumerated() {
                let code = line.components(separatedBy: "//").first ?? line
                if code.contains("VoiceChatManager(") || code.contains("shared.initialize(")
                    || code.contains("shared.connectToPeer(") || code.contains("shared.handleOffer(") {
                    offenders.append("\(file.lastPathComponent):\(n + 1)")
                }
            }
        }
        XCTAssertEqual(offenders, [], "build test managers with VoiceChatManager.silent(...)")
    }
}

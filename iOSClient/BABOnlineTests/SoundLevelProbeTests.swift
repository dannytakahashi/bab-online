import AVFoundation
import XCTest
@testable import BAB_Online

/// Opt-in measurement (iOS 1.2.6; owner 2026-11-24: card sounds "very quiet" on an iPhone in a
/// tournament where nobody had voice): a table sound's output level under (a) the ambient session
/// the sounds use without voice and (b) voice's playAndRecord / voiceChat session
/// (`VoiceAudioPolicy`), which the sounds played through from every voice start before 1.2.6.
/// It plays `card-1` at the default volume through an AVAudioEngine and taps the main mixer (the
/// app's whole output before the system's output stage), and the same file through an
/// AVAudioPlayer with metering (the app's real player), and reports the session each time
/// (category, mode, output volume, route, sample rate). Plain AVAudioSession, never WebRTC or
/// RTCAudioSession (docs/claude/voice.md "iOS voice tests (no CoreAudio)").
///
/// Run (mute the Mac first: `osascript -e 'set volume output muted true'`):
/// `TEST_RUNNER_BAB_SOUND_PROBE=1 xcodebuild test ... -only-testing:BABOnlineTests/SoundLevelProbeTests`.
/// The numbers go to the log (`[SoundProbe]`) and the test's attachment.
@MainActor
final class SoundLevelProbeTests: XCTestCase {
    private typealias Level = ProbeLevel

    private enum Session: String, CaseIterable { case ambient, voice }

    private func use(_ session: Session) throws -> String {
        let s = AVAudioSession.sharedInstance()
        switch session {
        case .ambient: try s.setCategory(.ambient, mode: .default, options: [])
        case .voice: try s.setCategory(VoiceAudioPolicy.category, mode: VoiceAudioPolicy.mode, options: VoiceAudioPolicy.options)
        }
        try s.setActive(true)
        let outs = s.currentRoute.outputs.map { "\($0.portType.rawValue)" }.joined(separator: ",")
        return "category=\(s.category.rawValue) mode=\(s.mode.rawValue) outputVolume=\(s.outputVolume) "
            + "route=\(outs) rate=\(Int(s.sampleRate)) io=\(String(format: "%.4f", s.ioBufferDuration))"
    }

    /// The engine's mixed output while the file plays at `volume` (RMS over the frames above
    /// -80 dBFS, so the silence around the click does not count; the peak sample).
    private func engineLevel(file url: URL, volume: Float) async throws -> Level {
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let file = try AVAudioFile(forReading: url)
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: file.processingFormat)
        player.volume = volume
        let box = Accumulator()
        let format = engine.mainMixerNode.outputFormat(forBus: 0)
        engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in box.add(buffer) }
        try engine.start()
        let done = expectation(description: "played")
        player.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { _ in done.fulfill() }
        player.play()
        await fulfillment(of: [done], timeout: 10)
        try await Task.sleep(nanoseconds: 100_000_000)
        engine.mainMixerNode.removeTap(onBus: 0)
        engine.stop()
        return box.level
    }

    /// The app's own player (AVAudioPlayer at `volume`) with metering, polled every 5 ms.
    private func playerLevel(file url: URL, volume: Float) async throws -> Level {
        let p = try AVAudioPlayer(contentsOf: url)
        p.isMeteringEnabled = true
        p.volume = volume
        p.prepareToPlay()
        XCTAssertTrue(p.play())
        var level = Level()
        let end = Date().addingTimeInterval(p.duration + 0.3)
        while Date() < end {
            p.updateMeters()
            level.rmsDB = max(level.rmsDB, Double(p.averagePower(forChannel: 0)))
            level.peakDB = max(level.peakDB, Double(p.peakPower(forChannel: 0)))
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        p.stop()
        return level
    }

    func testCardSoundLevelUnderTheAmbientAndTheVoiceSession() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["BAB_SOUND_PROBE"] == "1",
                          "opt-in: TEST_RUNNER_BAB_SOUND_PROBE=1 (plays sounds; mute the Mac first)")
        let url = try XCTUnwrap(Bundle.main.url(forResource: "card-1", withExtension: "m4a"))
        let volume = SoundPlayer.defaultVolume * SoundKind.card.gain
        var lines: [String] = ["file=card-1 volume=\(volume)"]
        var engine: [Session: Level] = [:]
        var meter: [Session: Level] = [:]
        for session in Session.allCases {
            let state = try use(session)
            engine[session] = try await engineLevel(file: url, volume: volume)
            meter[session] = try await playerLevel(file: url, volume: volume)
            lines.append("\(session.rawValue): \(state) | engine mix \(engine[session]!) | AVAudioPlayer meter \(meter[session]!)")
        }
        try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        let report = lines.joined(separator: "\n")
        print("[SoundProbe]\n\(report)")
        let attachment = XCTAttachment(string: report)
        attachment.name = "sound-levels"
        attachment.lifetime = .keepAlways
        add(attachment)
        // the app hands the system the same signal either way: what differs on a device is the
        // system's output stage for a playAndRecord / voiceChat session
        let a = try XCTUnwrap(engine[.ambient]), v = try XCTUnwrap(engine[.voice])
        XCTAssertGreaterThan(a.rmsDB, -60, "the sound played")
        XCTAssertEqual(a.rmsDB, v.rmsDB, accuracy: 1.0)
    }
}

/// The tap's running sums (the tap runs on an audio thread).
private final class Accumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var sumSquares = 0.0
    private var frames = 0
    private var peak = 0.0
    private static let floor = pow(10.0, -80.0 / 20)

    func add(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData else { return }
        let n = Int(buffer.frameLength), channels = Int(buffer.format.channelCount)
        lock.lock(); defer { lock.unlock() }
        for i in 0..<n {
            var frame = 0.0
            for c in 0..<channels { frame = max(frame, abs(Double(data[c][i]))) }
            peak = max(peak, frame)
            guard frame > Self.floor else { continue }
            for c in 0..<channels { sumSquares += Double(data[c][i]) * Double(data[c][i]) }
            frames += channels
        }
    }

    var level: ProbeLevel {
        lock.lock(); defer { lock.unlock() }
        let rms = frames > 0 ? (sumSquares / Double(frames)).squareRoot() : 0
        return ProbeLevel(rmsDB: Self.db(rms), peakDB: Self.db(peak))
    }

    private static func db(_ v: Double) -> Double { v > 0 ? 20 * log10(v) : -.infinity }
}

private struct ProbeLevel: CustomStringConvertible {
    var rmsDB: Double = -.infinity
    var peakDB: Double = -.infinity
    var description: String { String(format: "rms %.1f dBFS, peak %.1f dBFS", rmsDB, peakDB) }
}

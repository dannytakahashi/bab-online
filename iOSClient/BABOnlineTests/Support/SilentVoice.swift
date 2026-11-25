import Foundation
@preconcurrency import WebRTC
@testable import BAB_Online

/// An `RTCAudioDevice` that never opens audio: no audio unit, no AVAudioSession, no
/// RTCAudioSession. WebRTC's own audio device module initialises the VoiceProcessingIO unit
/// against the simulator's audio HAL as soon as a call has an audio track, and on a busy Mac
/// (several simulators) that HAL call stalled until CoreAudio aborted the whole unit run
/// ("Initialize: RPC timeout. Apparently deadlocked. Aborting now."; docs/claude/voice.md,
/// Tests). With this device the peer connections, SDP, transceiver directions and track
/// state are WebRTC's real ones; only the samples never flow.
class SilentAudioDevice: NSObject, RTCAudioDevice, @unchecked Sendable {
    private let lock = NSLock()
    private var initialized = false
    private var playoutReady = false, playing = false
    private var recordingReady = false, recording = false
    private var starts = (playout: 0, recording: 0)

    /// How often WebRTC asked this device to play / record (it reached the device, not the
    /// default module).
    var playoutStarts: Int { locked { starts.playout } }
    var recordingStarts: Int { locked { starts.recording } }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    var deviceInputSampleRate: Double { 48_000 }
    var inputIOBufferDuration: TimeInterval { 0.01 }
    var inputNumberOfChannels: Int { 1 }
    var inputLatency: TimeInterval { 0 }
    var deviceOutputSampleRate: Double { 48_000 }
    var outputIOBufferDuration: TimeInterval { 0.01 }
    var outputNumberOfChannels: Int { 1 }
    var outputLatency: TimeInterval { 0 }

    var isInitialized: Bool { locked { initialized } }
    func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool { locked { initialized = true; return true } }
    func terminateDevice() -> Bool {
        locked { initialized = false; playoutReady = false; playing = false; recordingReady = false; recording = false; return true }
    }

    var isPlayoutInitialized: Bool { locked { playoutReady } }
    func initializePlayout() -> Bool { locked { playoutReady = true; return true } }
    var isPlaying: Bool { locked { playing } }
    func startPlayout() -> Bool { locked { playing = true; starts.playout += 1; return true } }
    func stopPlayout() -> Bool { locked { playing = false; return true } }

    var isRecordingInitialized: Bool { locked { recordingReady } }
    func initializeRecording() -> Bool { locked { recordingReady = true; return true } }
    var isRecording: Bool { locked { recording } }
    func startRecording() -> Bool { locked { recording = true; starts.recording += 1; return true } }
    func stopRecording() -> Bool { locked { recording = false; return true } }
}

extension VoiceChatManager {
    /// The unit tests' manager: real WebRTC negotiation between in-process managers, with
    /// nothing outside the process touched (no permission prompt, no AVAudioSession, the
    /// `SilentAudioDevice` in place of WebRTC's audio unit, no socket). Every test builds its
    /// managers here (`SilentVoiceTests.testEveryTestManagerIsSilent`).
    static func silent(requestRecordPermission: @escaping @MainActor () async -> Bool = { true },
                       recordPermissionGranted: @escaping @MainActor () -> Bool = { false },
                       sendOffer: @escaping @MainActor (String, RTCSessionDescription, String?) -> Void = { _, _, _ in },
                       sendAnswer: @escaping @MainActor (String, RTCSessionDescription) -> Void = { _, _ in },
                       notify: @escaping @MainActor (String) -> Void = { _ in },
                       socketId: @escaping @MainActor () -> String? = { nil },
                       configureAudioSession: @escaping @MainActor () throws -> Void = {},
                       deactivateAudioSession: @escaping @MainActor () -> Void = {},
                       sendIceCandidate: @escaping @MainActor (String, RTCIceCandidate) -> Void = { _, _ in },
                       audioDevice: SilentAudioDevice = SilentAudioDevice(),
                       after: ((TimeInterval, @escaping @MainActor () -> Void) -> Void)? = nil) -> VoiceChatManager {
        VoiceChatManager(hooks: .init(requestRecordPermission: requestRecordPermission,
                                      recordPermissionGranted: recordPermissionGranted,
                                      configureAudioSession: configureAudioSession,
                                      deactivateAudioSession: deactivateAudioSession,
                                      sendOffer: sendOffer,
                                      sendAnswer: sendAnswer,
                                      notify: notify,
                                      socketId: socketId,
                                      sendIceCandidate: sendIceCandidate),
                         iceStore: IceServerStore(timeout: 0.05, emit: { _ in }),
                         audioDevice: audioDevice,
                         after: after)
    }
}

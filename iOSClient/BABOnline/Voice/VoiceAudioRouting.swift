import Foundation

/// The platform's audio for a voice call (`VoiceChatManager.Hooks.live`): iOS configures and
/// activates the shared audio session through RTCAudioSession (`VoiceAudioSession`, with its
/// loudspeaker policy and route safety net); a platform without such a session has its own
/// (`PlatformVoiceAudio`). Never used by the unit tests (silent hooks and `SilentAudioDevice`).
@MainActor
protocol VoiceAudioRouting: AnyObject {
    /// WebRTC's audio configuration replaced by the app's, before any audio unit can start.
    nonisolated static func installWebRTCConfiguration()
    /// The call's audio is ready (throws: no audio for the call; the manager listens only).
    func activate() throws
    /// The call's audio given back (balanced with `activate`).
    func deactivate()
}

enum VoiceAudio {
    /// This platform's routing (iOS: `VoiceAudioSession.shared`).
    @MainActor static var routing: VoiceAudioRouting { PlatformVoiceAudio.shared }

    /// `PlatformVoiceAudio.installWebRTCConfiguration()`, where the app's factory with WebRTC's
    /// default audio device module is made.
    static func installWebRTCConfiguration() {
        PlatformVoiceAudio.installWebRTCConfiguration()
    }
}

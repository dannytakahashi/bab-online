import Foundation

/// s2c `voiceSettings` (private, unsequenced; server/voice/gameVoice.js `settingsFor`): what
/// a casual game's voice room says to this socket. Only a socket that sent the
/// casualSpectators cap (1.2.2, build 12) gets it, at the start, on spectating and when a seat
/// owner drops, returns or reclaims. Since 2026-11-18 (owner: "we don't need the spectator
/// voice host toggle") spectators always may talk: the server always sends spectatorsCanTalk
/// true and canChange false, and this build acts on the role alone (every field is still
/// decoded; builds 12 to 15 read them).
struct VoiceSettings: Equatable {
    enum Role: String, Equatable {
        /// A seat owner or entrant in voice.
        case player
        /// Admitted to the voice room as a spectator: talks like a player.
        case spectator
        /// A capable spectator with no slot: voice is full (8 people).
        case none
    }

    var gameId: String
    var host: String?
    var spectatorsCanTalk: Bool
    var role: Role
    var canTalk: Bool
    /// Builds 12 to 15 showed their in-game switch while this was true; always false now.
    var canChange: Bool

    /// nil for a payload this build cannot read (no game id, an unknown role).
    static func from(_ dict: [String: Any]) -> VoiceSettings? {
        guard let gameId = dict["gameId"] as? String, !gameId.isEmpty,
              let role = (dict["role"] as? String).flatMap(Role.init(rawValue:)) else { return nil }
        return VoiceSettings(gameId: gameId, host: dict["host"] as? String,
                             spectatorsCanTalk: dict["spectatorsCanTalk"] as? Bool ?? true, role: role,
                             canTalk: dict["canTalk"] as? Bool ?? false, canChange: dict["canChange"] as? Bool ?? false)
    }
}

/// The words of voice (the web says the same where it has them).
enum VoiceCopy {
    static let voiceFull = "Voice is full (8 people)"
    /// The mic button and the panel's own row once the microphone was refused (headphones).
    static let noMic = "Listening only (no mic access)"
    /// VoiceOver's hint on those buttons: a tap tries the microphone again (iOS shows its prompt
    /// only once; after a refusal the person allows it in Settings, then the tap unmutes).
    static let noMicHint = "Double-tap to try the microphone again. Allow it for BAB Online in Settings first."
    /// VoiceOver's hint on the mic button: the long press opens the voice panel.
    static let panelHint = "Touch and hold for the voice panel"
    /// The toast of a refused microphone (the web's words).
    static let micDenied = "Microphone access denied. You can still listen."
    /// The voice panel's note while muted: WebRTC's one VoIP audio unit records and plays
    /// together, so once the microphone was allowed iOS may keep its mic indicator on.
    static let mutedNote = "Muted \u{2014} nothing is sent, even if your iPhone shows the mic dot."
    /// The voice panel's note after a refusal (iOS asks only once; Settings can allow it).
    static let deniedNote = "No mic access \u{2014} you can still listen. To talk, allow the microphone for BAB Online in Settings."
    static let lobbyHint = "The first 4 to tap Ready play; everyone else watches and can talk"
    static let tableFull = "Table full \u{2014} you'll watch"
}

extension VoiceSocketHandler {
    /// `voiceSettings`: the role. Static (and the manager passed in) so the unit tests drive it
    /// without a socket.
    /// - A spectator's voice starts if it is not running (`start`), muted like every voice
    ///   start: no mic prompt on Spectate. A lobby extra's lobby session carries on, its mute
    ///   as it was.
    /// - A player's voice is started by the table.
    /// - role none: no slot (the pill says so).
    /// A copy for another game than the table's (a late one after leaving) is ignored.
    @MainActor
    static func applyVoiceSettings(_ dict: [String: Any], manager: VoiceChatManager, gameState: GameState,
                                   start: @MainActor (VoiceChatManager) -> Void = { $0.ensureStarted() }) {
        guard let s = VoiceSettings.from(dict) else { return }
        if let gameId = gameState.gameId, gameId != s.gameId {
            print("[Voice] voiceSettings for another game (\(s.gameId)): ignored")
            return
        }
        manager.settings = s
        manager.casualVoiceGameId = s.gameId
        if s.role == .spectator, !manager.isActive { start(manager) }
        print("[Voice] voiceSettings: \(s.role.rawValue)")
    }
}

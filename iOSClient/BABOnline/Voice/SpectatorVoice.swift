import Foundation

/// s2c `voiceSettings` (private, unsequenced; server/voice/gameVoice.js `settingsFor`): what
/// a casual game's voice room says to this socket. Only a socket that sent the
/// casualSpectators cap (1.2.3, build 12) gets it, at the start, on spectating, on each
/// applied "Spectators can talk" change and when a seat owner drops, returns or reclaims.
struct VoiceSettings: Equatable {
    enum Role: String, Equatable {
        /// A seat owner or entrant in voice: always talks.
        case player
        /// Admitted to the voice room as a spectator: talks only while `canTalk`.
        case spectator
        /// A capable spectator with no slot: voice is full (8 people).
        case none
    }

    var gameId: String
    var host: String?
    var spectatorsCanTalk: Bool
    var role: Role
    var canTalk: Bool
    /// May send setSpectatorsCanTalk (the host while seated and connected, else a capable player).
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

/// The words of spectator voice (the spec's copy; the web says the same).
enum VoiceCopy {
    static let talkOff = "The host turned off spectator talk \u{2014} you can still listen"
    static let voiceFull = "Voice is full (8 people)"
    static let listeningOnly = "Listening only"
    static let noMic = "Listening only (no mic access)"
    static let tapToTalk = "Tap to talk"
    /// The voice panel's note while listen-only: WebRTC's one VoIP audio unit records and
    /// plays together, so iOS may keep its mic indicator on (not verified on a device).
    static let micDotNote = "Listening only \u{2014} your iPhone may show the mic dot; nothing is sent."
    static let switchLabel = "Spectators can talk"
    static let lobbyHintOn = "The first 4 to tap Ready play; everyone else watches and can talk"
    static let lobbyHintOff = "The first 4 to tap Ready play; everyone else watches and can only listen"
    static let tableFull = "Table full \u{2014} you'll watch"

    /// The mic button's word in listen-only: "Tap to talk" when a tap would turn the mic on.
    static func listenOnlyLabel(talkAllowed: Bool, micDenied: Bool) -> String {
        if micDenied { return noMic }
        return talkAllowed ? tapToTalk : listeningOnly
    }
}

extension VoiceSocketHandler {
    /// `voiceSettings`: the talk mode, the in-game switch and the "voice is full" pill.
    /// Static (and the manager passed in) so the unit tests drive it without a socket.
    /// - A spectator gets its mode (`canTalk`); a lobby extra keeps the mic it held in the
    ///   lobby, a main-room spectator listens until it taps to talk (no mic prompt on
    ///   Spectate). Voice starts if it is not running (`start`).
    /// - A player keeps talking; while spectators may not talk it mutes the spectators it
    ///   hears (a backstop: the server drops their audio).
    /// - role none: no slot (the pill says so).
    /// A copy for another game than the table's (a late one after leaving) is ignored.
    @MainActor
    static func applyVoiceSettings(_ dict: [String: Any], manager: VoiceChatManager, gameState: GameState,
                                   start: @MainActor (VoiceChatManager) -> Void = { $0.ensureStarted() },
                                   notify: @MainActor (String) -> Void = { SocketService.shared.serverError = ServerErrorNotice(message: $0, kind: .info) }) {
        guard let s = VoiceSettings.from(dict) else { return }
        if let gameId = gameState.gameId, gameId != s.gameId {
            print("[Voice] voiceSettings for another game (\(s.gameId)): ignored")
            return
        }
        let previous = manager.settings
        let sameGame = previous?.gameId == s.gameId
        manager.settings = s
        manager.switchPending = nil
        switch s.role {
        case .player:
            manager.setDesiredMode(canTalk: true, wantsMic: true)
            manager.applyForcedMutes(watching: gameState.watching.spectators.map(\.username))
        case .spectator:
            // first word as a spectator of this game: a session already talking (the lobby's
            // mesh carried over) keeps its mic; anyone else waits for "Tap to talk"
            let wasSpectator = sameGame && previous?.role == .spectator
            let wantsMic = wasSpectator ? manager.wantsMic : (manager.isActive && !manager.isListenOnly)
            manager.setForcedMuted([])
            manager.setDesiredMode(canTalk: s.canTalk, wantsMic: wantsMic)
            if !manager.isActive { start(manager) }
            if wasSpectator, previous?.spectatorsCanTalk == true, !s.spectatorsCanTalk { notify(VoiceCopy.talkOff) }
        case .none:
            manager.setForcedMuted([])
        }
        print("[Voice] voiceSettings: \(s.role.rawValue), canTalk \(s.canTalk), spectatorsCanTalk \(s.spectatorsCanTalk), canChange \(s.canChange)")
    }
}

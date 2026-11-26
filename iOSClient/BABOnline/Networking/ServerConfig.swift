import Foundation

/// The game server's origin (socket and HTTP: avatars, stock art): the
/// simulator (and a Debug Mac build) talks to localhost:3000, a device to production.
///
/// Debug builds only: `-serverURL http://localhost:<port>` (a launch
/// argument, so it lands in the arguments domain of UserDefaults) points the
/// simulator at a local server on another port for live checks; anything that
/// is not a plain http(s) localhost origin is ignored.
enum ServerConfig {
    static var baseURL: String {
        #if DEBUG
        if let override = debugOverride { return override }
        #endif
        // a Debug Mac build is the simulator's peer: a local server, never production by accident
        #if targetEnvironment(simulator) || (os(macOS) && DEBUG)
        return "http://localhost:3000"
        #else
        return "https://babonline.io"
        #endif
    }

    #if DEBUG
    static var debugOverride: String? {
        guard let raw = UserDefaults.standard.string(forKey: "serverURL") else { return nil }
        return validLocalOrigin(raw)
    }
    #endif

    /// `raw` when it is `http(s)://localhost[:port]` or `127.0.0.1[:port]` with no path, else nil.
    static func validLocalOrigin(_ raw: String) -> String? {
        guard let c = URLComponents(string: raw), let scheme = c.scheme, ["http", "https"].contains(scheme),
              let host = c.host, ["localhost", "127.0.0.1"].contains(host),
              c.path.isEmpty || c.path == "/", c.query == nil, c.user == nil else { return nil }
        return raw.hasSuffix("/") ? String(raw.dropLast()) : raw
    }
}

/// This build's version, as App Store Connect and the upgrade gate see it.
enum AppInfo {
    /// CFBundleShortVersionString (MARKETING_VERSION), e.g. "1.2.0".
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }
    /// CFBundleVersion (CURRENT_PROJECT_VERSION), e.g. "3": the User-Agent build the upgrade gate reads.
    static var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0" }
}

/// c2s `clientHello` (contract/src/c2s.js; server/socket/clientInfo.js): sent on
/// every connect, before restoreSession, so every payload the server builds
/// for this socket afterwards uses the capable shapes (custom pictures as
/// `avatarUrl` / `avatarUrls`, docs/avatars.md). No reply; the last hello wins.
enum ClientHello {
    /// The capabilities this build acts on ($defs.clientCap, $defs.clientCapCasualSpectators).
    /// `casualSpectators` (1.2.2, build 12): this build shows a lobby of up to 8 (`members`,
    /// `capacity`, the host's "Spectators can talk"), watches the game as a lobby extra
    /// (spectatorJoined at CREATED), and follows `voiceSettings` (listen-only offers, the
    /// in-game switch). `playAgain` (1.2.2, build 12): at the end of a casual game a lobby
    /// started, the server moves this socket back into that lobby (`lobbyReturn`); the app keeps
    /// the score screen up and enters the lobby on its Return to Lobby (`LobbyReturn`). Builds
    /// 6 to 11 sent only avatarUrl and stay "legacy" to the server. `assist` (the build after
    /// 1.2.3 (17)): the server answers this socket's /help with the private s2c `assistHint`
    /// (AssistCardView) instead of private plain-text game-log lines; builds <= 17 keep the lines.
    /// `tutorial` (the build after 20; $defs.clientCapTutorial): this build renders the
    /// tutorial's rule tips (assistHint kind `tip`, the welcome's Keep / Turn off) and s2c
    /// assistState (the "Tutorial on" chip), so the server may auto-start the tutorial in a new
    /// account's first game (State/Table/Tutorial.swift); older builds never get the auto-start.
    /// `shoulderView` (2026-11-21; $defs.clientCapShoulderView): this build watches a seat's hand
    /// over the player's shoulder as a spectator (c2s watchHand, viewer.shoulder, gameStart
    /// .shoulder, assistHint watched, spectator entries' shoulder; State/Table/Shoulder.swift);
    /// without it the server sends none of them and drops a watchHand silently.
    /// `tournamentVoice` (iOS 1.2.6; `TournamentVoice.cap`): this build runs voice in the
    /// tournament room (the lobby, between rounds, a finished table's members back in the room),
    /// so the server announces it there (voicePeerList / voicePeerJoined / voicePeerLeft for the
    /// room `tournament:<id>`) and relays its offers; without it a tournament member has voice
    /// only at its table.
    /// `tournamentPairings` (iOS 1.2.7, build 41; `TournamentPairingRules.cap`): this build shows
    /// each round's pairings and "Partners so far" from the tournament events' `pairings`, and a
    /// tournament table's `startDraw.teams` / snapshot `draw.teams` as a draw for first deal, so
    /// the server draws such a table honestly (each player the card they picked) when every human
    /// and spectator there has it; else (until PR #417, which removes the staged draw once the
    /// upgrade gate requires build 41) it stages the draw as before.
    /// `tournamentVoiceStatus` (iOS 1.2.7 (41); `TournamentVoice.statusCap`,
    /// $defs.clientCapTournamentVoiceStatus): this build shows the over-cap notice "Voice is full
    /// (N people)" while it waits in line for a full tournament voice room, so the server sends it
    /// the private s2c tournamentVoiceStatus.
    /// `badges` (iOS 1.2.7 (41); `Badges.cap`, $defs.clientCapBadges): this build shows earned
    /// badges on profiles and the "Badge earned" toast, so the profile replies carry `badges`
    /// and the server sends the private s2c badgesAwarded after a game that earned one.
    /// `cutForABuck` (iOS 1.2.7 (41); `CutForABuck.cap`, $defs.clientCapCutForABuck): this build plays
    /// Cut for a buck, the tournament's finale (phase 'cut', the cutForABuck* events, the inline final
    /// lobby in the complete phase).
    static let caps = ["avatarUrl", "casualSpectators", "playAgain", "assist", "tutorial", ShoulderRules.cap,
                       TournamentVoice.cap, TournamentPairingRules.cap, TournamentVoice.statusCap, Badges.cap, CutForABuck.cap]

    static func payload(version: String = AppInfo.version, build: String = AppInfo.build) -> [String: Any] {
        ["client": "ios", "version": String(version.prefix(32)), "build": String(build.prefix(64)), "caps": caps]
    }
}

import Foundation
import Combine
import UIKit

/// The "server restarted" notice (owner 2026-11-11, roadmap #17; the web's
/// restart banner). The server sends `serverShutdown {message}` about 1 s
/// before it closes every socket, on every deploy (server/utils/shutdown.js).
/// Games, lobbies and tournaments live in its memory, so whatever the player
/// was in is gone after it. An unfinished game writes no gameRecords and no
/// stats (gameHandlers.js calls recordGameStats only after `gameEnd`; the
/// abort and shutdown paths write none), so the seat message says so.
///
/// `RestartNotice` is the pure part: what was lost and when. SocketService
/// records it on serverShutdown; the restore paths report where the reconnect
/// landed: `lost` (the restore found no game / tournament, rejoinFailed, a
/// not_in_game snapshot, tournamentLeft) or `survived` (rejoinSuccess, the
/// tournament back). The first `lost` within `window` gives the ONE message;
/// later paths and anything after the window give nothing. Nothing is shown
/// when nothing was lost (the main room, a finished game).
struct RestartNotice: Equatable {
    enum Place: String, Codable, Equatable {
        case seat, spectating, lobby, tournament, tournamentGame
    }

    /// About 2 minutes, through the reconnect (in memory: RestartNotices).
    static let window: TimeInterval = 120

    private(set) var place: Place?
    private(set) var at: Date?

    init(place: Place? = nil, at: Date? = nil) {
        self.place = place
        self.at = at
    }

    /// serverShutdown: remember what the player is in now (nil: nothing to lose).
    mutating func shutdown(place: Place?, at now: Date) {
        // a second notice (the restart restarting) keeps the first loss
        if let p = self.place, let t = at, now.timeIntervalSince(t) < Self.window, place == nil || place == p { self.at = now; return }
        self.place = place
        self.at = place == nil ? nil : now
    }

    /// The reconnect landed and the place is gone: the message, once.
    mutating func lost(at now: Date) -> String? {
        defer { clear() }
        guard let p = place, let t = at, now.timeIntervalSince(t) >= 0, now.timeIntervalSince(t) <= Self.window else { return nil }
        return Self.message(p)
    }

    /// The place came back (a rejoin, the tournament): nothing to say.
    mutating func survived() { clear() }

    var isPending: Bool { place != nil }

    private mutating func clear() {
        place = nil
        at = nil
    }

    static func message(_ place: Place) -> String {
        switch place {
        case .seat:
            return "Your game ended because the server restarted for an update. It won't count toward your stats."
        case .spectating:
            return "The game you were watching ended because the server restarted for an update."
        case .lobby:
            return "Your lobby closed because the server restarted for an update."
        case .tournament:
            return "Your tournament ended because the server restarted for an update."
        case .tournamentGame:
            return "Your tournament ended because the server restarted for an update. The unfinished game won't count toward your stats."
        }
    }

    /// What a serverShutdown would cost the player on `screen`.
    static func place(screen: AppState.Screen, role: ViewerRole, phase: PhaseKind, inTournament: Bool) -> Place? {
        switch screen {
        case .signIn, .register, .mainRoom:
            return nil
        case .gameLobby:
            return .lobby
        case .tournamentLobby:
            return .tournament
        case .game:
            if role == .spectator { return .spectating }
            if phase == .ended || phase == .none { return inTournament ? .tournament : nil }
            return inTournament ? .tournamentGame : .seat
        }
    }
}

/// The app's one RestartNotice: the toast state while the server restarts and
/// the alert message after it. In memory only: the app process outlives the
/// server's restart (the socket reconnects by itself), and persisting it would
/// put UserDefaults, a required-reason API, into release code and the privacy
/// manifest (README "Privacy manifest"). A relaunch inside the window shows
/// nothing; the player lands in the main room as before.
@MainActor
final class RestartNotices: ObservableObject {
    static let shared = RestartNotices()

    /// serverShutdown came and the socket is not back yet ("Restarting for an update…").
    @Published private(set) var isRestarting = false
    /// The one message to show (an alert); nil once dismissed.
    @Published var message: String?

    private(set) var notice = RestartNotice()
    /// How long the toast waits for the disconnect a serverShutdown announces before giving up.
    static let disconnectWait: TimeInterval = 8
    private var waitGeneration = 0

    init() {}

    /// serverShutdown {message} (SocketService.handleServerShutdown).
    func serverShutdown(place: RestartNotice.Place?, now: Date = Date()) {
        notice.shutdown(place: place, at: now)
        isRestarting = true
        UIAccessibility.post(notification: .announcement, argument: Self.restartingText)
        // a notice the server never followed with a disconnect must not leave the toast up
        waitGeneration += 1
        let gen = waitGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.disconnectWait) { [weak self] in
            guard let self, self.waitGeneration == gen, SocketService.shared.isConnected, !self.sawDisconnect else { return }
            self.isRestarting = false
        }
        sawDisconnect = false
    }

    private var sawDisconnect = false

    /// The socket dropped (after the notice, as the server closes it).
    func disconnected() { if isRestarting { sawDisconnect = true } }

    /// The socket is back: the toast says connected and goes.
    func reconnected() {
        if isRestarting && sawDisconnect { isRestarting = false }
    }

    /// The restore found the place gone: show the message once (VoiceOver reads the alert).
    func lost(now: Date = Date()) {
        guard notice.isPending else { return }
        if let text = notice.lost(at: now) { message = text }
    }

    /// The place came back: forget the notice.
    func survived() {
        guard notice.isPending else { return }
        notice.survived()
    }

    static let restartingText = "Restarting for an update\u{2026}"
}

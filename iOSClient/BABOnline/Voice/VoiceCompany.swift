import Foundation

/// No voice alone (owner 2026-11-19: "No voice when you're the only human"; the web's
/// `client/src/voice/voiceCompany.js`, docs/claude/voice.md "No voice alone"). Voice (the
/// WebRTC session, the microphone, the audio session) runs only while at least one OTHER human
/// shares my room: in a lobby another human member; at a table another human seat owner whose
/// presence is not gone (connected, grace, resignable, a lazy or resigned owner watching or
/// away) or a spectator. Bots never count, nor my own name (my other device). Alone with bots
/// voice is never started (no audio session: table sounds stay on the ambient session).
///
/// Pure: the screens read who is present from what they already receive (lobby members with
/// `isBot`, the table's seats from positionUpdate / snapshots / seatLeft, `watching`) and tell
/// the manager's `VoiceGate`.
struct VoicePerson: Equatable {
    var username: String?
    var isBot = false
    /// Left for good (a seat whose owner's presence is gone).
    var gone = false
}

enum VoiceCompany {
    /// How long voice keeps running after the last other human left (the web's
    /// VOICE_ALONE_GRACE_MS): a quick reconnect or step away does not flap.
    static let grace: TimeInterval = 30

    /// The rule: another human who has not left, never a bot or my own name.
    static func hasCompany(_ people: [VoicePerson], me: String?) -> Bool {
        people.contains { p in
            guard !p.isBot, !p.gone, let name = p.username, !name.isEmpty else { return false }
            return name != me
        }
    }

    /// A lobby's members (family `members`, else the frozen `players`): a seat held for its
    /// reconnect grace and a play-again place kept for someone not back yet still count.
    static func people(lobby players: [LobbyPlayer]) -> [VoicePerson] {
        players.map { VoicePerson(username: $0.username, isBot: $0.isBot) }
    }

    /// The people at a table, nil while the table does not say who sits there yet (the draw of
    /// a lobby's game before its positionUpdate: the screen keeps what it had). Seat owners of
    /// the table's `seats` (four, or Get Your Bid's three: TableSlice.seats; a native bot has no
    /// owner; a lazy / resigned seat keeps its owner; presence gone, or none, has left), else a
    /// snapshot's entrants before seating, plus every spectator in `watching` (counted by name;
    /// more than the list names means others) when `spectators` (the table has casual voice: a
    /// tournament table never admits a watcher).
    static func people(table players: PlayersSlice, seats: Int = 4, spectators: Bool = true) -> [VoicePerson]? {
        var out: [VoicePerson]
        if players.seats.count >= seats {
            out = players.seats.values.sorted { $0.position < $1.position }.map { seat in
                VoicePerson(username: seat.ownerUsername,
                            isBot: seat.controller == .bot || seat.ownerUsername == nil,
                            gone: seat.presence == .gone || seat.presence == .none)
            }
        } else if let entrants = players.entrantHumans {
            out = entrants.map { VoicePerson(username: $0) }
        } else {
            return nil
        }
        if spectators { out += players.watching.spectators.map { VoicePerson(username: $0.username) } }
        return out
    }

    /// Lobby: another human member is here.
    static func lobby(_ players: [LobbyPlayer], me: String?) -> Bool {
        hasCompany(people(lobby: players), me: me)
    }

    /// Table: another human is here; nil while not known (`people(table:)`). A watching count
    /// beyond the names the list carries (it names at most 50) is company too. `spectators`
    /// false: the watchers never count (a table with no casual voice, e.g. a tournament table,
    /// whose watchers can never join voice: review 2026-11-19).
    static func table(_ players: PlayersSlice, seats: Int = 4, me: String?, spectators: Bool = true) -> Bool? {
        if spectators, players.watching.count > players.watching.spectators.count { return true }
        guard let people = people(table: players, seats: seats, spectators: spectators) else {
            // spectators are known whatever the seats say
            guard spectators else { return nil }
            return hasCompany(players.watching.spectators.map { VoicePerson(username: $0.username) }, me: me) ? true : nil
        }
        return hasCompany(people, me: me)
    }

    /// Does this table admit watchers into voice? Only a casual game this socket got
    /// voiceSettings for (`VoiceChatManager.casualVoiceGameId`).
    static func spectatorsInVoice(gameId: String?, casualVoiceGameId: String?) -> Bool {
        guard let gameId, let casualVoiceGameId else { return false }
        return gameId == casualVoiceGameId
    }

    /// The tournament room (iOS 1.2.6; the server's `tournament:<id>` voice room, clientHello cap
    /// `tournamentVoice`, server/voice/tournamentVoice.js): exactly who the server announced to
    /// this socket there (`VoiceChatManager.tournamentPeers`: voicePeerList / voicePeerJoined
    /// since this socket entered the room, less voicePeerLeft), never my own name, as the web's
    /// tournament lobby. The server knows the room (members on the tournament lobby screen with
    /// the cap, at most 8, never a blocked pair); the payloads alone do not (a member on a
    /// finished table's score screen, an older app without the cap).
    static func tournament(announced: [String], me: String?) -> Bool {
        hasCompany(announced.map { VoicePerson(username: $0) }, me: me)
    }

    /// The table screen: the table's people, except on the score screen of a game whose end
    /// returned me to a lobby (play again: `lobbyReturn` moved me into that lobby's voice room,
    /// `returnFromGameId` is this game), where the lobby's members count.
    static func tableScreen(_ players: PlayersSlice, seats: Int = 4, gameId: String?, returnFromGameId: String?,
                            lobbyId: String, lobbyPlayers: [LobbyPlayer], me: String?,
                            spectators: Bool = true) -> Bool? {
        if let gameId, returnFromGameId == gameId, !lobbyId.isEmpty {
            return lobby(lobbyPlayers, me: me)
        }
        return table(players, seats: seats, me: me, spectators: spectators)
    }
}

/// Starts and stops voice by company (the web's `createVoiceGate`). A screen says it wants
/// voice (`want`: the game lobby, a seat at the table, a voice spectator) and when that ends
/// (`release`: every shutdown); the screens on show say who is here (`setCompany(_:from:)`).
/// Voice starts while wanted and another human is here; alone, a running voice stops after
/// `grace` (`suspend`: the session ends, the screen's voice settings stay so the next arrival
/// starts it again, muted as every start is); a return within the grace keeps the session.
/// Company not known yet (nil: a table before its seating) holds: nothing starts or stops.
@MainActor
final class VoiceGate {
    /// Who says who is here: the screen on show. The latest to say counts; a screen going away
    /// clears only its own word (the next screen may have spoken first).
    enum Source: Hashable { case lobby, table, tournament }

    private(set) var wanted = false
    private var said: [Source: Bool?] = [:]
    private(set) var current: Source?
    /// The grace runs: voice ends when it runs out (unless someone comes back).
    private(set) var graceRunning = false
    private var graceToken = 0

    let grace: TimeInterval
    private let isRunning: @MainActor () -> Bool
    private let start: @MainActor () -> Void
    private let suspend: @MainActor () -> Void
    private let after: (TimeInterval, @escaping @MainActor () -> Void) -> Void

    init(grace: TimeInterval = VoiceCompany.grace,
         isRunning: @escaping @MainActor () -> Bool,
         start: @escaping @MainActor () -> Void,
         suspend: @escaping @MainActor () -> Void,
         after: @escaping (TimeInterval, @escaping @MainActor () -> Void) -> Void = { delay, run in
             DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated { run() } }
         }) {
        self.grace = grace
        self.isRunning = isRunning
        self.start = start
        self.suspend = suspend
        self.after = after
    }

    /// Another human is here (true), I am alone with bots (false), or not known yet (nil).
    var company: Bool? {
        guard let current, let value = said[current] else { return nil }
        return value
    }

    /// This screen wants voice: it runs while another human is here.
    func want() {
        wanted = true
        update()
    }

    /// The screen no longer wants voice (the manager's shutdown stops it).
    func release() {
        wanted = false
        cancelGrace()
    }

    /// The screen on show says who is here.
    func setCompany(_ value: Bool?, from source: Source) {
        said[source] = .some(value)
        current = source
        update()
    }

    /// That screen went away: its word no longer counts (unless another screen spoke since).
    func clearCompany(from source: Source) {
        said[source] = nil
        if current == source { current = nil }
        update()
    }

    /// A room change (iOS 1.2.6, TournamentVoice): every screen's word was about the old room,
    /// so none counts until the new room's screen speaks (a grace in flight ends: the session it
    /// would stop is gone). Still wanted.
    func forgetCompany() {
        said = [:]
        current = nil
        cancelGrace()
    }

    /// A peer's offer reached me while who is here is not known yet (nil: a table before its
    /// positionUpdate, e.g. a tournament table's draw, up to ~35 s with the 30 s auto-draw).
    /// The offerer runs voice in my voice room, so that is company: voice starts now and the
    /// buffered offer is answered at the start, inside the offerer's 20 s connect timer
    /// (`IcePolicy.connectTimeout`), instead of at the seating. A known "alone" (false) or a
    /// screen that does not want voice never starts this way; the seating's word then counts
    /// as usual (alone: the grace, then a suspend).
    func peerOffered() {
        guard wanted, company == nil, !isRunning() else { return }
        start()
    }

    func update() {
        guard wanted else {
            cancelGrace()
            return
        }
        switch company {
        case .some(true):
            cancelGrace()
            if !isRunning() { start() }
        case .some(false):
            // alone: nothing to start; a running voice ends after the grace
            guard isRunning(), !graceRunning else { return }
            graceRunning = true
            graceToken &+= 1
            let token = graceToken
            after(grace) { [weak self] in self?.graceEnded(token) }
        case .none:
            break  // not known yet: hold (a running grace runs on)
        }
    }

    private func graceEnded(_ token: Int) {
        guard token == graceToken, graceRunning else { return }
        graceRunning = false
        if wanted, isRunning(), company == false { suspend() }
    }

    private func cancelGrace() {
        guard graceRunning else { return }
        graceRunning = false
        graceToken &+= 1
    }
}

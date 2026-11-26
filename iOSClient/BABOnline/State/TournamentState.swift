import Foundation

/// State for the tournament lobby screen.
final class TournamentState: ObservableObject {
    @Published var tournamentId: String = ""
    @Published var name: String = ""
    @Published var phase: String = "lobby"      // lobby, round_active, between_rounds, cut, complete
    @Published var currentRound: Int = 0
    @Published var totalRounds: Int = 4
    @Published var players: [TournamentPlayer] = []
    @Published var messages: [ChatMessage] = []
    @Published var scoreboard: [TournamentScoreEntry] = []
    @Published var winners: [String] = []
    @Published var activeGames: [TournamentActiveGame] = []
    @Published var creatorUsername: String = ""
    @Published var isSpectator: Bool = false
    @Published var isReady: Bool = false
    /// Between rounds, past the server's ready deadline (`readyDeadlinePassed` on
    /// tournamentReadyUpdate / tournamentJoined, additive 2026-11-15; an older server never
    /// sends it): the host's Begin starts the round with the ready members and the rest sit
    /// out (`TournamentBegin`). Each between-rounds wait starts its own deadline.
    @Published var readyDeadlinePassed: Bool = false
    /// Each planned round's tables and teams (the events' additive `pairings`, owner 2026-11-25:
    /// partners are shown openly; `TournamentPairingRules`). Empty: nothing to show (an older
    /// server, the lobby phase, a 1-member tournament).
    @Published var pairings: [TournamentRoundPairings] = []
    /// Cut for a buck as it stands (iOS 1.2.7 (41), the clientHello cap `cutForABuck`; phase 'cut'),
    /// from the cutForABuck* events (`CutState.reduce`) or tournamentJoined.cut; nil: no cut. It is
    /// fed on any screen (the last table's score screen shows it as a strip: GameEndView).
    @Published var cut: CutState?
    /// The cut's result in the complete phase (tournamentComplete / tournamentJoined `cutForABuck`);
    /// nil when no cut ran.
    @Published var cutResult: CutResult?
    /// The over-cap notice (s2c tournamentVoiceStatus, iOS 1.2.7; TournamentVoice.fullNote): the
    /// room's cap while this member waits in line for a full tournament voice room; nil when
    /// admitted, never told, or off the lobby screen (seated at a table, the screen left).
    @Published var voiceFullCap: Int?
    /// The unsent chat line (survives a recreated view; not @Published).
    var chatDraft = ""
    /// The joinTournament a restore sent for the tournament lobby on screen
    /// (`RestoreRoute.tournamentLobby`), until tournamentJoined or its refusal answers. The
    /// lobby's actions wait for it.
    @Published var rejoiningTournamentId: String?
    /// The socket that joinTournament went out on: one per socket.
    var rejoinSocketId: String?
    /// Bumped on every re-entry sent: the answer wait (`TournamentRejoin.answerWait`) acts
    /// only on its own one.
    var rejoinGeneration = 0
    /// A re-entry left before its answer (Leave, or the wait ran out; `TournamentRejoin.abandon`):
    /// its late tournamentJoined or refusal is dropped. Cleared by that answer (or another
    /// tournament's tournamentJoined), tournamentLeft, the next mainRoomJoined, a restore on
    /// another socket (`rejoinSocketId` stays the abandoned one's), or a create / join /
    /// spectate from the main room (`TournamentRejoin.startFromMainRoom`).
    var abandonedRejoinTournamentId: String?

    func reset() {
        chatDraft = ""
        rejoiningTournamentId = nil
        rejoinSocketId = nil
        abandonedRejoinTournamentId = nil
        tournamentId = ""
        name = ""
        phase = "lobby"
        currentRound = 0
        totalRounds = 4
        players = []
        messages = []
        scoreboard = []
        winners = []
        activeGames = []
        creatorUsername = ""
        isSpectator = false
        isReady = false
        readyDeadlinePassed = false
        pairings = []
        cut = nil
        cutResult = nil
        voiceFullCap = nil
    }

    /// The host's round count from tournamentSettingsUpdated (or the host's own pick, shown at
    /// once as the web does): a count outside 1...5 is ignored. False when nothing changed.
    @discardableResult
    func applyTotalRounds(_ any: Any?) -> Bool {
        guard let n = TournamentRounds.count(any), n != totalRounds else { return false }
        totalRounds = n
        return true
    }

    /// The tournament is in Cut for a buck (this app sent the cap, so the server says 'cut').
    var isCutPhase: Bool { phase == CutForABuck.phase }

    /// The wire's `cut.drawn` says only who drew (never "auto"): a rejoin mid-round keeps what this
    /// app already knew of the same round's draws, so "We drew a card for you" and the tap that says
    /// I am back survive a return from the score screen.
    static func keepAutoDraws(_ new: CutState, from old: CutState?) -> CutState {
        guard let old, old.round == new.round, old.stage == .drawing, new.stage == .drawing else { return new }
        var s = new
        for (u, d) in new.drawn { if let o = old.drawn[u], o.slot == d.slot { s.drawn[u]?.auto = o.auto } }
        return s
    }

    /// One cutForABuck* event (start puts the tournament in phase 'cut').
    func applyCut(_ type: CutState.Event, _ data: [String: Any], now: Date = Date()) {
        if type == .start { phase = CutForABuck.phase }
        cut = CutState.reduce(cut, type, data, now: now)
    }

    /// An event's `pairings`, when it carries the key (absent: kept).
    func applyPairings(_ any: Any?) {
        if let list = TournamentRoundPairings.list(any) { pairings = list }
    }

    func loadFromServerState(_ dict: [String: Any]) {
        // the same tournament's cut as this app had it (keepAutoDraws)
        let previousCut = (dict["tournamentId"] as? String) == tournamentId ? cut : nil
        tournamentId = dict["tournamentId"] as? String ?? ""
        name = dict["name"] as? String ?? ""
        phase = dict["phase"] as? String ?? "lobby"
        currentRound = dict["currentRound"] as? Int ?? 0
        // the host's pick, 1 to 5 (TournamentRounds); anything else: the default
        totalRounds = TournamentRounds.count(dict["totalRounds"]) ?? TournamentRounds.defaultCount
        creatorUsername = dict["creatorUsername"] as? String ?? ""
        isSpectator = dict["isSpectator"] as? Bool ?? false
        // between rounds only; absent (another phase, an older server): not passed
        readyDeadlinePassed = dict["readyDeadlinePassed"] as? Bool ?? false

        if let playersArr = dict["players"] as? [[String: Any]] {
            players = playersArr.compactMap { TournamentPlayer.from($0) }
        }

        if let messagesArr = dict["messages"] as? [[String: Any]] {
            messages = messagesArr.compactMap { ChatMessage.from($0) }
        }

        if let scoreboardArr = dict["scoreboard"] as? [[String: Any]] {
            scoreboard = scoreboardArr.compactMap { TournamentScoreEntry.from($0) }
        }

        winners = dict["winners"] as? [String] ?? []

        if let gamesArr = dict["activeGames"] as? [[String: Any]] {
            activeGames = gamesArr.compactMap { TournamentActiveGame.from($0) }
        }
        // the whole state: no key, nothing to show
        pairings = TournamentRoundPairings.list(dict["pairings"]) ?? []
        // Cut for a buck as it stands (phase 'cut' only), and the complete phase's result
        cut = phase == CutForABuck.phase ? CutState.fromWire(dict["cut"]).map { Self.keepAutoDraws($0, from: previousCut) } : nil
        cutResult = phase == "complete" ? CutResult.from(dict["cutForABuck"]) : nil
    }
}

/// The host's Begin button and the "Sitting out" rows, as the web's TournamentLobby.js
/// (`beginLabel`, `startsWithReadyOnly`, `canBegin`) and the server's
/// `TournamentState.canBegin`: every connected member ready, or, between rounds past the
/// ready deadline, always (the host plays, the ready members play, the rest sit out).
enum TournamentBegin {
    /// Disconnected members sit out rounds and never ready up: they do not gate Begin
    /// (the server ignores them too).
    static func allConnectedReady(_ players: [TournamentPlayer]) -> Bool {
        let connected = players.filter { $0.connected }
        return !connected.isEmpty && connected.allSatisfy { $0.isReady }
    }

    /// Past the deadline with someone not ready: Begin leaves them out.
    static func startsWithReadyOnly(phase: String, deadlinePassed: Bool, players: [TournamentPlayer]) -> Bool {
        phase == "between_rounds" && deadlinePassed && !allConnectedReady(players)
    }

    static func canBegin(phase: String, deadlinePassed: Bool, players: [TournamentPlayer]) -> Bool {
        allConnectedReady(players) || startsWithReadyOnly(phase: phase, deadlinePassed: deadlinePassed, players: players)
    }

    static func label(phase: String, deadlinePassed: Bool, players: [TournamentPlayer]) -> String {
        if phase != "between_rounds" { return "Begin Tournament" }
        return startsWithReadyOnly(phase: phase, deadlinePassed: deadlinePassed, players: players)
            ? "Start with ready players" : "Begin Next Round"
    }

    /// Past the deadline a connected member who is not ready sits the next round out
    /// (never the host: pressing Begin puts the host in the round).
    static func sitsOut(_ player: TournamentPlayer, phase: String, deadlinePassed: Bool) -> Bool {
        phase == "between_rounds" && deadlinePassed && !player.isReady && !player.isCreator && player.connected
    }
}

/// The toasts the web shows for a host change and a cancellation (client/src/main.js
/// onTournamentPlayerLeft / onTournamentCancelled).
enum TournamentNotice {
    static let cancelled = "Tournament has been cancelled by the host"

    /// tournamentPlayerLeft's newCreator (the host left, or was idle: reason 'hostIdle').
    static func hostChanged(to newCreator: String, me: String?) -> String {
        newCreator == me ? "You are now the tournament host" : "\(newCreator) is now the tournament host"
    }
}

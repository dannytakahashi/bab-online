#if DEBUG
import SwiftUI

/// Cut for a buck in fixture mode (spec section 6, iOS extras): `-uiFixture tournament-cut -uiCut
/// "<n 2..20> <stage>"` seeds the tournament lobby in the cut with n players (me, ivy, first in the
/// participants' list unless `-uiCutSeat <k>` puts me at k), built by replaying wire-shaped events
/// through `CutState.reduce`, so the fixture goes through the same reducer as the server's events.
/// Stages:
///   gather     the 15 s gather (12 s left: the intro plays; `-uiCutIntroFrame <s>` holds a frame)
///   drawing    round 3, a third of the others drawn, my draw open (a tap sends cutForABuckDraw)
///   away       round 3, the server drew for me ("We drew a card for you"; a tap says I am back)
///   reveal     round 3 revealed: two players out with 3s, me safe with a 9
///   out        round 4 drawing, me out in round 3 and still watching
///   redraw     round 2 revealed: everyone tied on 7s
///   reshuffle  round 4 drawing after a reshuffle ("Not enough cards left...")
///   winner     the last reveal and the winner (kim; `-uiCutWin YES`: me)
///   complete   the complete phase with the cut's result (the final lobby)
/// `-uiSpectator YES`: watched by a spectator (lou). `game-end-tournament -uiCut "<n> gather|drawing"`:
/// the last table's score screen with the cut's strip. In the drawing stages a draw is answered as
/// the server would: my cutForABuckDrew at once, then (`-uiCutPlay YES`) the others' and the reveal
/// with me safe (`-uiCutLose YES`: me out), and after a tap in `away`, nothing but the send.
extension UIFixture {
    static let cutSpec: (n: Int, stage: String)? = {
        guard isActive, let raw = UserDefaults.standard.string(forKey: "uiCut") else { return nil }
        let parts = raw.split(separator: " ").map(String.init)
        guard parts.count == 2, let n = Int(parts[0]) else { return nil }
        return (min(20, max(2, n)), parts[1])
    }()
    static let cutIntroFrame: TimeInterval? = isActive ? UserDefaults.standard.string(forKey: "uiCutIntroFrame").flatMap(Double.init) : nil
    static let cutPlays: Bool = isActive && UserDefaults.standard.bool(forKey: "uiCutPlay")
    static let cutLoses: Bool = isActive && UserDefaults.standard.bool(forKey: "uiCutLose")

    static let cutNames = ["ivy", "kim", "hal", "jon", "ora", "max", "pat", "ned", "Christopher Johnson1", "bea", "cy", "dan",
                           "eve", "fay", "gus", "al", "bo", "lee", "mo", "sam"]

    private static weak var fixtureCutTournament: TournamentState?

    /// The participants for n: ivy (me) at `-uiCutSeat` (default 0) among the first n names.
    static func cutPlayers(_ n: Int) -> [String] {
        var names = Array(cutNames.prefix(n))
        if let k = UserDefaults.standard.string(forKey: "uiCutSeat").flatMap(Int.init), k > 0, k < n {
            names.removeFirst()
            names.insert("ivy", at: k)
        }
        return names
    }

    private static func card(_ rank: String, _ suit: String) -> [String: Any] { ["rank": rank, "suit": suit] }

    /// The cut's state for a stage, through the reducer (wire-shaped events, as the server sends them).
    static func cutState(n: Int, stage: String, me: String = "ivy", winnerIsMe: Bool = false, now: Date = Date()) -> CutState? {
        let players = cutPlayers(n)
        var s: CutState? = CutState.reduce(nil, .start, ["candidates": players, "startsInMs": 12000, "deckCount": 54], now: now)
        if stage == "gather" { return s }
        // the deck as the server keeps it: drawn cards stay out until fewer are left than players
        var deck = 54
        func round(_ r: Int, alive: [String], forceReshuffle: Bool = false) {
            let reshuffled = forceReshuffle || deck < alive.count
            if reshuffled { deck = 54 }
            s = CutState.reduce(s, .round, ["round": r, "participants": players, "alive": alive, "deckCount": deck,
                                            "reshuffled": reshuffled, "closesInMs": 12000], now: now)
        }
        func reveal(_ r: Int, _ draws: [(String, String, String)], out: [String], alive: [String], redraw: Bool = false) {
            let d: [[String: Any]] = draws.enumerated().map { i, x in ["username": x.0, "slot": i, "card": card(x.1, x.2)] }
            s = CutState.reduce(s, .reveal, ["round": r, "draws": d, "eliminated": out, "redraw": redraw, "alive": alive,
                                             "nextInMs": alive.count == 1 ? 6000 : 4000], now: now)
            deck -= draws.count
        }
        let ranks = ["9", "J", "Q", "K", "A", "10", "8", "6", "5", "4", "HI", "7"]
        let suits = ["spades", "hearts", "diamonds", "clubs"]
        func cards(_ alive: [String], low: [String], lowRank: String, mine: String = "9") -> [(String, String, String)] {
            alive.enumerated().map { i, u in
                if low.contains(u) { return (u, lowRank, suits[i % 4]) }
                if u == me { return (u, mine, "hearts") }
                return (u, ranks[(i + 1) % ranks.count] == lowRank ? "K" : ranks[(i + 1) % ranks.count], suits[(i + 2) % 4])
            }
        }
        // round 1: a redraw (everyone on 7s); round 2: the last one out with a 2
        var alive = players
        round(1, alive: alive)
        reveal(1, alive.enumerated().map { ($1, "7", suits[$0 % 4]) }, out: [], alive: alive, redraw: true)
        if stage == "redraw" { return s }
        round(2, alive: alive)
        let out2 = [alive[alive.count - 1]]
        reveal(2, cards(alive, low: out2, lowRank: "2"), out: out2, alive: alive.filter { !out2.contains($0) })
        alive.removeAll { out2.contains($0) }
        // round 3: two out with 3s (never me)
        let others = alive.filter { $0 != me }
        let out3 = Array(others.suffix(min(2, others.count - (alive.count > 2 ? 1 : 0))))
        round(3, alive: alive)
        if stage == "drawing" || stage == "away" {
            let drew = others.prefix(max(1, others.count / 3))
            for (i, u) in drew.enumerated() {
                s = CutState.reduce(s, .drew, ["round": 3, "username": u, "slot": i * 3 + 1, "auto": i == 1], now: now)
            }
            if stage == "away" {
                s = CutState.reduce(s, .drew, ["round": 3, "username": me, "slot": 20, "auto": true], now: now)
            }
            return s
        }
        reveal(3, cards(alive, low: out3, lowRank: "3"), out: out3, alive: alive.filter { !out3.contains($0) })
        alive.removeAll { out3.contains($0) }
        if stage == "reveal" { return s }
        if stage == "out" {
            // round 4: me out with a 2 at the last reveal, still watching the next round
            round(4, alive: alive)
            let rev: [(String, String, String)] = alive.map { $0 == me ? ($0, "2", "clubs") : ($0, "Q", "hearts") }
            reveal(4, rev, out: [me], alive: alive.filter { $0 != me })
            alive.removeAll { $0 == me }
            round(5, alive: alive)
            if let first = alive.first { s = CutState.reduce(s, .drew, ["round": 5, "username": first, "slot": 4, "auto": false], now: now) }
            return s
        }
        if stage == "reshuffle" {
            round(4, alive: alive, forceReshuffle: true)
            return s
        }
        if stage == "winner" || stage == "complete" {
            // the last round: two left, then the winner
            let winner = winnerIsMe ? me : (alive.first { $0 != me } ?? me)
            let last = alive.filter { $0 != winner }
            round(4, alive: alive)
            reveal(4, alive.map { $0 == winner ? ($0, "A", "spades") : ($0, "4", "diamonds") }, out: last, alive: [winner])
            s = CutState.reduce(s, .winner, ["winner": winner, "participants": players, "rounds": 4], now: now)
            return s
        }
        return s
    }

    /// `tournament-cut`: the lobby in the cut (or the complete phase).
    @MainActor
    static func seedCut(_ appState: AppState, tournament: TournamentState, auth: AuthState) {
        guard let spec = cutSpec else { return }
        let spectator = UserDefaults.standard.bool(forKey: "uiSpectator")
        auth.username = spectator ? "lou" : "ivy"
        let players = cutPlayers(spec.n)
        tournament.tournamentId = "t1"
        tournament.name = "Sunday Cup"
        tournament.currentRound = 2
        tournament.totalRounds = 2
        tournament.creatorUsername = "kim"
        tournament.isSpectator = spectator
        tournament.players = players.map {
            TournamentPlayer(id: "sid-\($0)", username: $0, pic: nil, isReady: true, isCreator: $0 == "kim", connected: $0 != "ned")
        }
        tournament.scoreboard = players.enumerated().map { i, u in
            let rounds = [140 - i * 11, 120 - i * 7]
            return TournamentScoreEntry(id: u, username: u, totalScore: rounds.reduce(0, +), roundScores: rounds)
        }
        let state = cutState(n: spec.n, stage: spec.stage, winnerIsMe: UserDefaults.standard.bool(forKey: "uiCutWin"))
        if spec.stage == "complete" {
            tournament.phase = "complete"
            tournament.winners = [players[0]]
            tournament.cutResult = state?.winner.map { CutResult(winner: $0, participants: players, rounds: 4) }
            tournament.cut = nil
        } else {
            tournament.phase = CutForABuck.phase
            if var restored = state {
                restored.last = .restore
                tournament.cut = restored
            }
        }
        tournament.messages = [
            ChatMessage(username: "System", message: "Cut for a buck! Everyone still here draws a card. The lowest card is out, round after round, until one player is left.",
                        type: .system, timestamp: Date().addingTimeInterval(-60)),
            ChatMessage(username: "kim", message: "good luck all", type: .player, timestamp: Date().addingTimeInterval(-30)),
        ]
        fixtureCutTournament = tournament
        appState.screen = .tournamentLobby
    }

    /// The score screen's strip: the table fixture's tournament gets the cut (no screen change).
    @MainActor
    static func seedCutOnScoreScreen(_ store: GameState, tournament: TournamentState) {
        guard let spec = cutSpec, name == "game-end-tournament" else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            tournament.tournamentId = store.tournamentId ?? "t1"
            tournament.phase = CutForABuck.phase
            tournament.cut = cutState(n: spec.n, stage: spec.stage, me: store.username ?? "ivy")
        }
    }

    /// The lobby's cut screen in fixture mode: the sounds stay off (`SoundPlayer` is silent in
    /// fixtures anyway).
    @MainActor
    static func configureCut(_ model: CutScreenModel, tournament: TournamentState) {
        fixtureCutTournament = tournament
    }

    /// recordSent's cutForABuckDraw: answered as the server does.
    static func emulateCutDraw(_ data: [String: Any]) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            MainActor.assumeIsolated {
                guard let t = fixtureCutTournament, let s = t.cut, let round = data["round"] as? Int, round == s.round else { return }
                let me = "ivy"
                // a repeat (the server drew for me): dropped, only the strikes cleared
                if s.drawn[me]?.local != true { return }
                let free = s.freeSlots
                let slot = (data["slot"] as? Int) ?? free[free.count / 2]
                t.applyCut(.drew, ["round": round, "username": me, "slot": slot, "auto": false])
                guard cutPlays else { return }
                var delay = 0.4
                for u in s.alive where t.cut?.drawn[u] == nil {
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                        MainActor.assumeIsolated {
                            let f = t.cut?.freeSlots ?? [0]
                            t.applyCut(.drew, ["round": round, "username": u, "slot": f.first ?? 0, "auto": false])
                        }
                    }
                    delay += 0.15
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + delay + 0.4) {
                    MainActor.assumeIsolated { revealFixtureRound(t, round: round) }
                }
            }
        }
    }

    @MainActor
    private static func revealFixtureRound(_ t: TournamentState, round: Int) {
        guard let s = t.cut, s.round == round else { return }
        let me = "ivy"
        let others = s.alive.filter { $0 != me }
        let low = cutLoses ? [me] : Array(others.suffix(1))
        let draws: [[String: Any]] = s.alive.map { u in
            let slot = s.drawn[u]?.slot ?? 0
            let c: [String: Any] = low.contains(u) ? ["rank": "3", "suit": "clubs"] : u == me ? ["rank": "9", "suit": "hearts"] : ["rank": "K", "suit": "spades"]
            return ["username": u, "slot": slot, "card": c]
        }
        let alive = s.alive.filter { !low.contains($0) }
        t.applyCut(.reveal, ["round": round, "draws": draws, "eliminated": low, "redraw": false, "alive": alive,
                             "nextInMs": alive.count == 1 ? 6000 : 4000])
        if alive.count == 1 {
            t.applyCut(.winner, ["winner": alive[0], "participants": s.participants, "rounds": round])
        }
    }
}
#endif

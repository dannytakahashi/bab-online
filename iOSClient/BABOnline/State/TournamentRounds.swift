import Foundation

/// The host's round count (owner 2026-11-25; iOS 1.2.7 (41), the web's #407): the host picks 1 to
/// 5 rounds (default 4) in the tournament lobby before Begin. c2s `setTournamentRounds
/// {totalRounds}` (host only, lobby phase only; refused with serverError otherwise); the room gets
/// s2c `tournamentSettingsUpdated {totalRounds, by}` and an unstored system line ("kim set the
/// tournament to 3 rounds."). Ready flags are kept. Every tournament event already carries
/// `totalRounds`, so the round line and the scoreboard's R1..RN columns follow it. Web reference:
/// `client/src/ui/components/RoundsPicker.js`, `ui/screens/TournamentLobby.js` (roundLine).
enum TournamentRounds {
    /// server TournamentState.MIN_ROUNDS / MAX_ROUNDS / DEFAULT_ROUNDS.
    static let min = 1
    static let max = 5
    static let defaultCount = 4
    static let counts = Array(min...max)

    /// A count the server takes (TournamentState.setTotalRounds: an integer 1...5).
    static func isCount(_ n: Int?) -> Bool {
        guard let n else { return false }
        return (min...max).contains(n)
    }

    /// A wire count, or nil when it is not one the server would send (absent, 0, a string).
    static func count(_ any: Any?) -> Int? {
        // a JSON boolean bridges to Int too (true == 1): never a count
        if isBoolean(any) { return nil }
        guard let n = any as? Int, isCount(n) else { return nil }
        return n
    }

    /// A JSON (or Swift) boolean: `true as? Int` is 1, so it is checked first.
    static func isBoolean(_ any: Any?) -> Bool {
        guard let n = any as? NSNumber else { return false }
        return CFGetTypeID(n) == CFBooleanGetTypeID()
    }

    /// "1 round" / "3 rounds" (the web's roundsLabel).
    static func label(_ n: Int) -> String { "\(n) round\(n == 1 ? "" : "s")" }

    /// The header's round line (the web's roundLine, plus iOS's "complete" between rounds):
    /// "Waiting to start · 3 rounds", "Round 2 of 3", "Round 2 of 3 complete".
    static func roundLine(phase: String, currentRound: Int, totalRounds: Int) -> String {
        switch phase {
        case "lobby": return "Waiting to start · \(label(totalRounds))"
        case "round_active": return "Round \(currentRound) of \(totalRounds)"
        case "between_rounds": return "Round \(currentRound) of \(totalRounds) complete"
        case "complete": return "Tournament complete"
        default: return ""
        }
    }

    /// The main room's card in the lobby phase (the web's MainRoom.js): "Waiting to start · 3 rounds".
    static func lobbyCardLine(totalRounds: Int?) -> String {
        guard let n = totalRounds, isCount(n) else { return "Waiting to start" }
        return "Waiting to start · \(label(n))"
    }

    /// The Rounds picker shows for the host in the lobby phase only (it follows host hand-offs
    /// like Begin and Cancel and goes once the tournament begins). Never for a spectator.
    static func showsPicker(phase: String, isCreator: Bool, isSpectator: Bool) -> Bool {
        phase == "lobby" && isCreator && !isSpectator
    }

    /// The scoreboard's round columns: 1...N, never an empty or reversed range (a count of 0
    /// from an odd payload would crash `1...0`).
    static func columns(_ totalRounds: Int) -> ClosedRange<Int> {
        1...Swift.max(1, totalRounds)
    }

    /// The server's system line after a change (tournamentHandlers.setTournamentRounds; fixture
    /// mode answers with it).
    static func changedLine(by host: String, to n: Int) -> String {
        "\(host) set the tournament to \(label(n))."
    }
}

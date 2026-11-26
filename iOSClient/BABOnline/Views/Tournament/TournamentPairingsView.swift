import SwiftUI

/// The tournament screen's pairings (owner 2026-11-25: partners are shown openly; the web's
/// TournamentLobby "Round N pairings" / "Partners so far", client/src/ui/screens/tournamentPairings.js):
/// a member sees the latest round's tables (my table first, "You & Hannah vs Danny & Clara") and
/// each round's partner so far ("Round 1 · Hannah", "Round 2 · a bot", "Round 3 · sat out"); a
/// spectator sees every round's tables, the latest first. Nothing while there is nothing to show
/// (`TournamentPairingRules.hasPairings`). The rows wrap (never cut) and VoiceOver reads "and" /
/// "versus".
struct TournamentPairingsView: View {
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var tournamentState: TournamentState

    var body: some View {
        let pairings = tournamentState.pairings
        if TournamentPairingRules.hasPairings(pairings) {
            VStack(alignment: .leading, spacing: 0) {
                if tournamentState.isSpectator {
                    spectatorRounds(pairings)
                } else {
                    memberSections(pairings, me: authState.username)
                }
            }
            .padding(.bottom, Theme.Space.s2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface)
            .cornerRadius(Theme.Radius.md)
            .padding(.horizontal)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("pairings")
        }
    }

    @ViewBuilder
    private func memberSections(_ pairings: [TournamentRoundPairings], me: String) -> some View {
        if let latest = TournamentPairingRules.latestRound(pairings, me: me), !latest.round.tables.isEmpty {
            heading("Round \(latest.round.roundNumber) pairings", id: "pairings.round")
            ForEach(Array(latest.round.tables.enumerated()), id: \.offset) { index, table in
                row(table.teams, me: me, mine: latest.mine && index == 0, n: index)
            }
        }
        let partners = TournamentPairingRules.partnersSoFar(pairings, me: me)
        if !me.isEmpty, !partners.isEmpty {
            heading("Partners so far", id: "pairings.partners")
            ForEach(partners, id: \.roundNumber) { p in
                Text("Round \(p.roundNumber) · \(p.partner)")
                    .font(.caption)
                    .foregroundColor(p.partner == TournamentPairingRules.satOut ? Theme.textDim : Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.vertical, Theme.Space.s1)
                    .accessibilityLabel("Round \(p.roundNumber): \(p.partner)")
                    .accessibilityIdentifier("pairings.partner.\(p.roundNumber)")
            }
        }
    }

    @ViewBuilder
    private func spectatorRounds(_ pairings: [TournamentRoundPairings]) -> some View {
        let rounds = Array(pairings.reversed().filter { !$0.tables.isEmpty })
        // rows numbered across the rounds shown, as the web's data-row
        let starts = rounds.indices.map { i in rounds[..<i].reduce(0) { $0 + $1.tables.count } }
        ForEach(Array(rounds.enumerated()), id: \.element.roundNumber) { i, round in
            heading("Round \(round.roundNumber) pairings", id: i == 0 ? "pairings.round" : "pairings.round.\(round.roundNumber)")
            ForEach(Array(round.tables.enumerated()), id: \.offset) { index, table in
                row(table.teams, me: nil, mine: false, n: starts[i] + index)
            }
        }
    }

    private func heading(_ text: String, id: String) -> some View {
        Text(text)
            .font(.caption.bold())
            .foregroundColor(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal)
            .padding(.top, Theme.Space.s3)
            .padding(.bottom, Theme.Space.s1)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier(id)
    }

    private func row(_ teams: [[String?]], me: String?, mine: Bool, n: Int) -> some View {
        Text(TournamentPairingRules.line(teams, me: me))
            .font(.caption)
            .foregroundColor(mine ? Theme.primary : Theme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal)
            .padding(.vertical, Theme.Space.s1)
            .background(mine ? Theme.primary.opacity(0.1) : Color.clear)
            .accessibilityLabel(TournamentPairingRules.spoken(teams, me: me))
            .accessibilityIdentifier("pairings.row.\(n)")
    }
}

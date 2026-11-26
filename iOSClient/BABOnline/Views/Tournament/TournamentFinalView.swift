import SwiftUI

/// A finished tournament on iOS 1.2.7 (41) (spec section 6 "Final lobby"; the web's
/// FinalResultsCard.js): the tournament lobby itself in the complete phase, in place of the
/// old results overlay (removed after 1.2.7), so the chat and voice stay.
/// The score winner(s) ("kim wins the tournament!"), the cut's winner when a cut ran ("dan won cut
/// for a buck"), the players with their chips ("Winner", "Won the cut") and the final scoreboard
/// (R1..RN, TournamentResultsTable). Return to Main Room and "This lobby stays open for about 10
/// minutes" are the screen's buttons (TournamentLobbyView).
struct TournamentFinalView: View {
    @EnvironmentObject var tournamentState: TournamentState
    @EnvironmentObject var authState: AuthState

    private var winners: [String] {
        Self.winners(tournamentState.winners, scoreboard: tournamentState.scoreboard)
    }

    /// The server's winners (co-winners on a tie); without them (an older server's rejoin
    /// after the end) everyone on the top score, as the web works it out.
    static func winners(_ winners: [String], scoreboard: [TournamentScoreEntry]) -> [String] {
        if !winners.isEmpty { return winners }
        guard let top = scoreboard.map(\.totalScore).max() else { return [] }
        return scoreboard.filter { $0.totalScore == top }.map(\.username)
    }

    var body: some View {
        let me = authState.username
        let cut = tournamentState.cutResult
        VStack(spacing: Theme.Space.s3) {
            Image(systemName: "trophy.fill")
                .font(.largeTitle)
                .foregroundColor(Theme.warning)
                .accessibilityHidden(true)
            Text(CutCopy.tournamentWinnerLine(winners, me: me))
                .themeFont(Theme.TypeScale.xl, weight: Theme.Weight.bold, design: .rounded, relativeTo: .title)
                .foregroundColor(Theme.warning)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("results.winner")
            if cut != nil {
                HStack(spacing: Theme.Space.s1) {
                    Image(systemName: "dollarsign.circle.fill")
                        .foregroundStyle(Theme.gold)
                        .accessibilityHidden(true)
                    Text(CutCopy.cutWonLine(cut, me: me))
                        .font(.headline)
                        .foregroundStyle(Theme.textPrimary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("results.cut")
            }
            players(me: me, cut: cut)
            VStack(spacing: Theme.Space.s2) {
                TournamentResultsTable(scoreboard: tournamentState.scoreboard, totalRounds: tournamentState.totalRounds, me: me)
                TournamentFlagLegend(scoreboard: tournamentState.scoreboard)
            }
        }
        .padding(Theme.Space.s4)
        .frame(maxWidth: 560)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.lg).fill(Theme.surface))
        .padding(.horizontal, Theme.Space.s3)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tournament.results")
    }

    /// The players by final standing, with their chips.
    private func players(me: String, cut: CutResult?) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s1) {
            ForEach(tournamentState.scoreboard) { row in
                let chips = TournamentFinalView.chips(row.username, winners: winners, cut: cut)
                HStack(spacing: Theme.Space.s2) {
                    Text(row.username == me ? "\(row.username) (you)" : row.username)
                        .font(.subheadline.weight(row.username == me ? .semibold : .regular))
                        .foregroundStyle(row.username == me ? Theme.primary : Theme.textPrimary)
                    ForEach(chips, id: \.self) { chip in
                        Text(chip)
                            .font(.caption2.bold())
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill((chip == "Winner" ? Theme.gold : Theme.success).opacity(0.2)))
                            .foregroundStyle(chip == "Winner" ? Theme.gold : Theme.success)
                    }
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("results.player.\(row.username)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func chips(_ username: String, winners: [String], cut: CutResult?) -> [String] {
        var out: [String] = []
        if winners.contains(username) { out.append("Winner") }
        if cut?.winner == username { out.append("Won the cut") }
        return out
    }
}

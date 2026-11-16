import SwiftUI

/// The finished tournament: the winner(s) and the whole scoreboard, every round's score
/// beside the total (the web's results modal holds the same table), with the rounds that
/// did not come from a finished table marked (`TournamentRoundFlag`).
struct TournamentResultsView: View {
    @EnvironmentObject var tournamentState: TournamentState
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var authState: AuthState
    /// The standings' natural height: they scroll only when the card would not fit.
    @State private var standingsHeight: CGFloat = 0
    @State private var hingeTick = 0

    /// The server's winners (co-winners on a tie); without them (an older server's rejoin
    /// after the end) everyone on the top score, as the web works it out.
    static func winners(_ winners: [String], scoreboard: [TournamentScoreEntry]) -> [String] {
        if !winners.isEmpty { return winners }
        guard let top = scoreboard.map(\.totalScore).max() else { return [] }
        return scoreboard.filter { $0.totalScore == top }.map(\.username)
    }

    static func winnerText(_ winners: [String]) -> String? {
        switch winners.count {
        case 0: return nil
        case 1: return "\(winners[0]) wins!"
        default: return "\(winners.joined(separator: " & ")) tie!"
        }
    }

    private var winnerText: String? {
        Self.winnerText(Self.winners(tournamentState.winners, scoreboard: tournamentState.scoreboard))
    }

    var body: some View {
        ZStack {
            Theme.scrim.ignoresSafeArea()

            // In book pose the card sits on the left page: it never spans the hinge.
            GeometryReader { geo in
                let _ = hingeTick  // re-read the fold after a hinge change
                card
                    .frame(width: FoldReader.bookHinge(geo)?.lowerBound ?? geo.size.width, height: geo.size.height)
            }
            .modifier(HingeTick(tick: $hingeTick))
        }
    }

    private var card: some View {
        VStack(spacing: Theme.Space.s4) {
            // Trophy icon
            Image(systemName: "trophy.fill")
                .themeFont(Theme.TypeScale.display, relativeTo: .largeTitle)
                .foregroundColor(Theme.warning)
                .accessibilityHidden(true)

            Text("Tournament Complete!")
                .themeFont(Theme.TypeScale.xl, weight: Theme.Weight.bold, design: .rounded, relativeTo: .title)
                .foregroundColor(Theme.warning)
                .multilineTextAlignment(.center)

            if let winnerText = winnerText {
                Text(winnerText)
                    .font(.title2.bold())
                    .foregroundColor(Theme.textPrimary)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("results.winner")
            }

            // Final standings, round by round
            ScrollView {
                VStack(spacing: Theme.Space.s2) {
                    TournamentResultsTable(scoreboard: tournamentState.scoreboard,
                                           totalRounds: tournamentState.totalRounds,
                                           me: authState.username)
                    TournamentFlagLegend(scoreboard: tournamentState.scoreboard)
                }
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { standingsHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: standingsHeight)

            Button(action: returnToMainRoom) {
                Text("Return to Main Room")
                    .font(.body.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Theme.buttonBackground)
                    .foregroundColor(Theme.buttonForeground)
                    .cornerRadius(Theme.Radius.md)
            }
            .padding(.horizontal, Theme.Space.s6)
            .accessibilityIdentifier("results.return")
        }
        .padding(.vertical, Theme.Space.s6)
        .padding(.horizontal, Theme.Space.s3)
        .frame(maxWidth: 560)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .fill(Theme.surface)
        )
        .padding(.horizontal, Theme.Space.s4)
        .padding(.vertical, Theme.Space.s4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tournament.results")
    }

    private func returnToMainRoom() {
        tournamentState.reset()
        appState.screen = .mainRoom
        LobbyEmitter.joinMainRoom()
    }
}

/// The results' scoreboard: rank, player, R1...Rn, total. When the fixed columns leave the
/// name less than `nameWidth` (larger text, a narrow window, many rounds), each player's
/// rounds go on a second line instead. Chosen by fit, not by text size category.
struct TournamentResultsTable: View {
    let scoreboard: [TournamentScoreEntry]
    let totalRounds: Int
    let me: String

    @ScaledMetric(relativeTo: .footnote) private var rankWidth: CGFloat = 22
    @ScaledMetric(relativeTo: .footnote) private var roundWidth: CGFloat = 42
    @ScaledMetric(relativeTo: .footnote) private var totalWidth: CGFloat = 46
    /// The least room the name column needs beside the round columns.
    @ScaledMetric(relativeTo: .footnote) private var nameWidth: CGFloat = 72

    private var rounds: Range<Int> { 0..<max(0, totalRounds) }

    /// The side-by-side table's least width (its rows' horizontal padding included).
    static func wideWidth(rank: CGFloat, round: CGFloat, total: CGFloat, name: CGFloat, rounds: Int) -> CGFloat {
        rank + name + CGFloat(max(0, rounds)) * round + total + 2 * Theme.Space.s2
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            table(stacked: false)
                .frame(idealWidth: Self.wideWidth(rank: rankWidth, round: roundWidth, total: totalWidth,
                                                  name: nameWidth, rounds: totalRounds),
                       maxWidth: .infinity)
            table(stacked: true)
        }
    }

    private func table(stacked: Bool) -> some View {
        VStack(spacing: 0) {
            if !stacked { header }
            ForEach(Array(scoreboard.enumerated()), id: \.element.id) { index, entry in
                Group {
                    if stacked { stackedRow(index, entry) } else { row(index, entry) }
                }
                .padding(.horizontal, Theme.Space.s2)
                .padding(.vertical, 6)
                .background(entry.username == me ? Theme.primary.opacity(0.1) : Color.clear)
                .cornerRadius(Theme.Radius.sm)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(entry.spokenSummary(rank: index + 1, totalRounds: totalRounds))
                .accessibilityIdentifier("results.row.\(entry.username)")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(stacked ? "results.table.stacked" : "results.table.wide")
    }

    private var header: some View {
        HStack(spacing: 0) {
            Text("#").frame(width: rankWidth, alignment: .leading)
            Text("Player").frame(maxWidth: .infinity, alignment: .leading)
            ForEach(rounds, id: \.self) { round in
                Text("R\(round + 1)").frame(width: roundWidth, alignment: .trailing)
            }
            Text("Total").bold().frame(width: totalWidth, alignment: .trailing)
        }
        .font(.caption)
        .foregroundColor(Theme.textSecondary)
        .padding(.horizontal, Theme.Space.s2)
        .padding(.vertical, Theme.Space.s1)
        .accessibilityHidden(true)
    }

    private func row(_ index: Int, _ entry: TournamentScoreEntry) -> some View {
        HStack(spacing: 0) {
            Text("\(index + 1)")
                .bold()
                .foregroundColor(rankColor(index))
                .frame(width: rankWidth, alignment: .leading)
            Text(entry.username)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(rounds, id: \.self) { round in
                Text(entry.cellText(round: round))
                    .foregroundColor(round < entry.roundScores.count ? Theme.textPrimary : Theme.textDim)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(width: roundWidth, alignment: .trailing)
            }
            Text("\(entry.totalScore)")
                .bold()
                .foregroundColor(rankColor(index))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .frame(width: totalWidth, alignment: .trailing)
        }
        .font(.footnote.monospacedDigit())
        .foregroundColor(entry.username == me ? Theme.primary : Theme.textPrimary)
    }

    private func stackedRow(_ index: Int, _ entry: TournamentScoreEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(index + 1). \(entry.username)")
                    .bold()
                    .foregroundColor(entry.username == me ? Theme.primary : Theme.textPrimary)
                Spacer()
                Text("\(entry.totalScore)")
                    .bold()
                    .foregroundColor(rankColor(index))
            }
            .frame(maxWidth: .infinity)
            Text(rounds.map { "R\($0 + 1) \(entry.cellText(round: $0))" }.joined(separator: " \u{00B7} "))
                .foregroundColor(Theme.textSecondary)
        }
        .font(.footnote.monospacedDigit())
    }

    private func rankColor(_ index: Int) -> Color {
        Theme.medal(rank: index + 1) ?? Theme.textSecondary
    }
}

/// What the round markers mean, listed only for the kinds on this scoreboard (none on a
/// tournament whose every table finished).
struct TournamentFlagLegend: View {
    let scoreboard: [TournamentScoreEntry]

    static func flags(in scoreboard: [TournamentScoreEntry]) -> [TournamentRoundFlag] {
        let present = Set(scoreboard.flatMap { $0.roundFlags.values })
        return TournamentRoundFlag.allCases.filter(present.contains)
    }

    var body: some View {
        let flags = Self.flags(in: scoreboard)
        if !flags.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(flags, id: \.self) { flag in
                    Text("\(flag.marker) \(flag.legend)")
                }
            }
            .font(.caption2)
            .foregroundColor(Theme.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Theme.Space.s2)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("tournament.flagLegend")
        }
    }
}

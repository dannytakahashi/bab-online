import SwiftUI

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

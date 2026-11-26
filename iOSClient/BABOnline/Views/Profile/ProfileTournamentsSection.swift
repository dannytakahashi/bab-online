import SwiftUI

/// A profile's Tournaments section (owner 2026-11-25; iOS 1.2.7 (41); the web's
/// createTournamentHistorySection, after Statistics and before Badges on both profiles):
/// tournaments played and won, Cut for a buck wins of cuts played (only once a cut was played),
/// and the last five results, newest first: the tournament's name, "Won" / "Won (tied)" /
/// "2nd of 6", the date, players and rounds, and "Won cut for a buck" or "Cut for a buck: kim".
/// Shown only when there is something (`TournamentHistory.isEmpty`), so a player who never
/// finished a tournament gets no section. The same in every stats scope: a scope switch never
/// changes it. User text (tournament and player names) only as text; people by name.
struct ProfileTournamentsSection: View {
    let history: TournamentHistory
    /// The profile's player (their own cut wins read "Won cut for a buck").
    let username: String
    @Environment(\.dynamicTypeSize) private var typeSize

    private typealias C = TournamentHistoryCopy

    private struct Stat: Identifiable {
        let id: String
        let label: String
        let value: String
        let spoken: String
    }

    private var stats: [Stat] {
        var out = [Stat(id: "played", label: C.played, value: "\(history.played)", spoken: "Tournaments played"),
                   Stat(id: "won", label: C.won, value: "\(history.won)", spoken: "Tournaments won")]
        if let cut = C.cutStat(history) {
            out.append(Stat(id: "cut", label: C.cut, value: cut, spoken: "Cut for a buck wins"))
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s3) {
            Text(C.title)
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
                .accessibilityAddTraits(.isHeader)

            let columns = Array(repeating: GridItem(.flexible(), spacing: Theme.Space.s2),
                                count: typeSize.isAccessibilitySize ? 1 : 3)
            LazyVGrid(columns: columns, spacing: Theme.Space.s2) {
                ForEach(stats) { stat in
                    VStack(spacing: Theme.Space.s1) {
                        Text(stat.value)
                            .font(.title3.bold().monospacedDigit())
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                        Text(stat.label)
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(2)
                            .minimumScaleFactor(0.8)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .padding(.vertical, Theme.Space.s2)
                    .padding(.horizontal, Theme.Space.s1)
                    .background(Theme.surfaceLight)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(stat.spoken)
                    .accessibilityValue(stat.value)
                    .accessibilityIdentifier("profile.tournamentStat.\(stat.id)")
                }
            }

            if !history.recent.isEmpty {
                Text(C.recent)
                    .font(.subheadline.bold())
                    .foregroundStyle(Theme.textSecondary)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, Theme.Space.s1)
                VStack(alignment: .leading, spacing: Theme.Space.s2) {
                    ForEach(Array(history.recent.enumerated()), id: \.element.id) { index, result in
                        ResultRow(result: result, username: username, stacked: typeSize.isAccessibilitySize)
                            .accessibilityIdentifier("profile.tournament.\(index)")
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("profile.tournaments")
    }
}

/// One finished tournament: the name with the result beside it (under it at the accessibility
/// sizes), the date, players and rounds, and the cut's winner. One VoiceOver element.
private struct ResultRow: View {
    let result: TournamentHistory.Result
    let username: String
    let stacked: Bool

    private typealias C = TournamentHistoryCopy

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s1) {
            if stacked {
                name
                resultText
            } else {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s2) {
                    name
                    Spacer(minLength: Theme.Space.s2)
                    resultText
                }
            }
            let meta = C.meta(result)
            if !meta.isEmpty {
                Text(meta)
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let cut = C.cutLine(result, username: username) {
                HStack(spacing: Theme.Space.s1) {
                    Image(systemName: "dollarsign.circle.fill")
                        .accessibilityHidden(true)
                    Text(cut)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(result.cutWinner == username ? Theme.warning : Theme.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Space.s2)
        .background(Theme.surfaceLight)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(C.spoken(result, username: username))
    }

    private var name: some View {
        Text(result.name.isEmpty ? "Tournament" : result.name)
            .font(.subheadline.bold())
            .foregroundStyle(Theme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var resultText: some View {
        Text(C.resultLabel(result))
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(result.won ? Theme.warning : Theme.textSecondary)
            .fixedSize(horizontal: !stacked, vertical: true)
    }
}

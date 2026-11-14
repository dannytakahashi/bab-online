import SwiftUI

/// Game end modal showing final scores and, as the web's score modal does
/// (client/src/ui/components/ScoreModal.js showFinalScoreOverlay), each player's
/// game stats: Bids, Tricks, Faults, Avg HSI. Spectators see the same.
struct GameEndView: View {
    @EnvironmentObject var gameState: GameState
    @EnvironmentObject var appState: AppState
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.horizontalSizeClass) private var hSize

    /// A compact width (a phone, the closed Duo) gives the stats table more room.
    private var compact: Bool { hSize == .compact }

    var body: some View {
        ZStack {
            Theme.scrim.ignoresSafeArea()

            // centered while it fits, scrolls when it does not (large text, the open Duo in landscape)
            GeometryReader { geo in
                ScrollView {
                    card
                        .frame(maxWidth: 460)  // readable on the open Duo and the iPad
                        .padding(.horizontal, compact ? Theme.Space.s4 : Theme.Space.s6)
                        .padding(.vertical, Theme.Space.s4)
                        .frame(maxWidth: .infinity, minHeight: geo.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
    }

    private var card: some View {
        VStack(spacing: Theme.Space.s6) {
            if let data = gameState.gameEndData {
                // Winner banner
                if gameState.isSpectator {
                    Text("Game Over")
                        .themeFont(Theme.TypeScale.xxl, weight: Theme.Weight.bold, design: .rounded, relativeTo: .largeTitle)
                        .foregroundColor(Theme.textSecondary)
                } else {
                    let myTeam = Positions.getTeamNumber(gameState.position ?? 1)
                    let didWin = data.winningTeam == myTeam

                    Text(didWin ? "Victory!" : "Defeat")
                        .themeFont(Theme.TypeScale.xxl, weight: Theme.Weight.bold, design: .rounded, relativeTo: .largeTitle)
                        .foregroundColor(didWin ? Theme.success : Theme.error)
                }

                // Score summary (the teams side by side; one above the other at accessibility text sizes)
                let summary = typeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(spacing: Theme.Space.s4)) : AnyLayout(HStackLayout(spacing: Theme.Space.s10))
                summary {
                    VStack(spacing: Theme.Space.s2) {
                        Text("Team 1")
                            .font(.caption.bold())
                            .foregroundColor(Theme.teamA)
                        Text(data.team1Players.joined(separator: "\n"))
                            .font(.caption)
                            .foregroundColor(Theme.textSecondary)
                            .multilineTextAlignment(.center)
                        Text("\(data.team1Score)")
                            .font(.title.bold())
                            .foregroundColor(data.winningTeam == 1 ? Theme.success : Theme.textPrimary)
                    }

                    Text("vs")
                        .foregroundColor(Theme.textDim)

                    VStack(spacing: Theme.Space.s2) {
                        Text("Team 2")
                            .font(.caption.bold())
                            .foregroundColor(Theme.teamB)
                        Text(data.team2Players.joined(separator: "\n"))
                            .font(.caption)
                            .foregroundColor(Theme.textSecondary)
                            .multilineTextAlignment(.center)
                        Text("\(data.team2Score)")
                            .font(.title.bold())
                            .foregroundColor(data.winningTeam == 2 ? Theme.success : Theme.textPrimary)
                    }
                }

                // Player stats (an older server sends none: no section, as on the web)
                if !data.playerStats.isEmpty {
                    GameEndStatsView(rows: data.playerStats)
                }
            }

            Button(action: returnAction) {
                Text(gameState.tournamentId != nil ? "Return to Tournament" : "Return to Lobby")
                    .font(.body.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(gameState.tournamentId != nil ? Theme.warning : Theme.buttonBackground)
                    .foregroundColor(gameState.tournamentId != nil ? Theme.warningForeground : Theme.buttonForeground)
                    .cornerRadius(Theme.Radius.md)
            }
            .padding(.horizontal, Theme.Space.s10)
        }
        .padding(.vertical, Theme.Space.s8)
        .padding(.horizontal, compact ? Theme.Space.s5 : Theme.Space.s8)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .fill(Theme.surface)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("gameEnd")
    }

    private func returnAction() {
        let savedTournamentId = gameState.tournamentId
        gameState.reset()
        if savedTournamentId != nil {
            TournamentEmitter.returnToTournament()
        } else {
            appState.screen = .mainRoom
            LobbyEmitter.joinMainRoom()
        }
    }
}

/// The per-player stats table: the web's `.result-stats` grid (Player, Bids, Tricks,
/// Faults, Avg HSI; seats 1...4, names in their team's color, faults above 0 in
/// danger.text). Each player is ONE row view, so VoiceOver reads one sentence per
/// player (`PlayerEndStats.accessibilityLabel`; the header row is hidden from it); the
/// number columns line up by measuring their widest cell (a SwiftUI Grid applies a
/// row's accessibility modifiers to every cell). Where the five columns do not fit
/// (accessibility text sizes, a narrow window at large type) each player stacks as
/// label / value lines.
struct GameEndStatsView: View {
    let rows: [PlayerEndStats]
    @Environment(\.dynamicTypeSize) private var typeSize
    /// The widest cell of each number column (header included).
    @State private var columnWidths: [CGFloat] = Array(repeating: 0, count: 4)
    /// The name column's narrowest width before the table gives way to the stacked layout.
    @ScaledMetric(relativeTo: .subheadline) private var nameMinWidth: CGFloat = 64

    static let headers = ["Bids", "Tricks", "Faults", "Avg HSI"]

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                stacked
            } else {
                ViewThatFits(in: .horizontal) {
                    table
                    stacked
                }
            }
        }
        .onChange(of: typeSize) { _, _ in columnWidths = Array(repeating: 0, count: 4) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("gameEnd.stats")
    }

    private func values(_ r: PlayerEndStats) -> [String] {
        [PlayerEndStats.format(r.totalBids), PlayerEndStats.format(r.totalTricks),
         PlayerEndStats.format(r.setsCaused), PlayerEndStats.format(r.avgHSI)]
    }

    /// Faults (column 2) above 0 in the error color, as the web's `.is-fault`.
    private func valueColor(_ r: PlayerEndStats, _ column: Int) -> Color {
        column == 2 && (r.setsCaused ?? 0) > 0 ? Theme.error : Theme.textPrimary
    }

    /// A number column's cell: its natural width, widened to the column's widest cell.
    private func cell(_ column: Int, _ text: Text) -> some View {
        text
            .lineLimit(1)
            .fixedSize()
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { w in
                if w > columnWidths[column] { columnWidths[column] = w }
            }
            .frame(minWidth: columnWidths[column])
    }

    private func nameColumn<V: View>(_ content: V) -> some View {
        content.frame(minWidth: nameMinWidth, idealWidth: nameMinWidth, maxWidth: .infinity, alignment: .leading)
    }

    private var table: some View {
        VStack(spacing: Theme.Space.s2) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s3) {
                nameColumn(Text("Player").lineLimit(1))
                ForEach(Array(Self.headers.enumerated()), id: \.offset) { i, h in cell(i, Text(h)) }
            }
            .font(.caption)
            .foregroundColor(Theme.textSecondary)
            .accessibilityHidden(true)

            Rectangle()
                .fill(Theme.divider)
                .frame(height: 1)
                .accessibilityHidden(true)

            ForEach(rows) { r in
                HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s3) {
                    nameColumn(
                        Text(r.username)
                            .fontWeight(Theme.Weight.medium)
                            .foregroundColor(Theme.team(r.team))
                            .lineLimit(2)
                    )
                    ForEach(Array(values(r).enumerated()), id: \.offset) { i, v in
                        cell(i, Text(v).monospacedDigit().foregroundColor(valueColor(r, i)))
                    }
                }
                .font(.subheadline)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(r.accessibilityLabel)
                .accessibilityIdentifier("gameEnd.stats.\(r.position)")
            }
        }
    }

    private var stacked: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s4) {
            ForEach(rows) { r in
                VStack(alignment: .leading, spacing: Theme.Space.s1) {
                    Text(r.username)
                        .font(.subheadline.weight(Theme.Weight.semibold))
                        .foregroundColor(Theme.team(r.team))
                    ForEach(Array(zip(Self.headers, values(r)).enumerated()), id: \.offset) { i, pair in
                        HStack(alignment: .firstTextBaseline) {
                            Text(pair.0).foregroundColor(Theme.textSecondary)
                            Spacer(minLength: Theme.Space.s2)
                            Text(pair.1).monospacedDigit().foregroundColor(valueColor(r, i))
                        }
                        .font(.subheadline)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(r.accessibilityLabel)
                .accessibilityIdentifier("gameEnd.stats.\(r.position)")
            }
        }
    }
}

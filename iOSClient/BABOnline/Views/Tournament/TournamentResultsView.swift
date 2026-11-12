import SwiftUI

struct TournamentResultsView: View {
    @EnvironmentObject var tournamentState: TournamentState
    @EnvironmentObject var appState: AppState

    private var winnerText: String? {
        // Server-provided winners handle co-winners on tie; fall back to the
        // scoreboard leader when winners is empty (e.g. rejoin after complete)
        if !tournamentState.winners.isEmpty {
            if tournamentState.winners.count == 1 {
                return "\(tournamentState.winners[0]) wins!"
            }
            return "\(tournamentState.winners.joined(separator: " & ")) tie!"
        }
        if let first = tournamentState.scoreboard.first {
            return "\(first.username) wins!"
        }
        return nil
    }

    var body: some View {
        ZStack {
            Theme.scrim.ignoresSafeArea()

            VStack(spacing: Theme.Space.s6) {
                // Trophy icon
                Image(systemName: "trophy.fill")
                    .themeFont(Theme.TypeScale.display, relativeTo: .largeTitle)
                    .foregroundColor(Theme.warning)
                    .accessibilityHidden(true)

                Text("Tournament Complete!")
                    .themeFont(Theme.TypeScale.xl, weight: Theme.Weight.bold, design: .rounded, relativeTo: .title)
                    .foregroundColor(Theme.warning)

                if let winnerText = winnerText {
                    Text(winnerText)
                        .font(.title2.bold())
                        .foregroundColor(Theme.textPrimary)
                }

                // Final standings
                VStack(spacing: Theme.Space.s1) {
                    ForEach(Array(tournamentState.scoreboard.enumerated()), id: \.element.id) { index, entry in
                        HStack {
                            Text("\(index + 1).")
                                .font(.body.bold())
                                .frame(width: 24, alignment: .trailing)
                                .foregroundColor(rankColor(index))

                            Text(entry.username)
                                .font(.body)
                                .foregroundColor(Theme.textPrimary)

                            Spacer()

                            Text("\(entry.totalScore)")
                                .font(.body.bold())
                                .foregroundColor(rankColor(index))
                        }
                        .padding(.horizontal, Theme.Space.s5)
                        .padding(.vertical, 6)
                    }
                }
                .padding(.vertical, Theme.Space.s2)

                Button(action: returnToMainRoom) {
                    Text("Return to Main Room")
                        .font(.body.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Theme.buttonBackground)
                        .foregroundColor(Theme.buttonForeground)
                        .cornerRadius(Theme.Radius.md)
                }
                .padding(.horizontal, Theme.Space.s10)
            }
            .padding(Theme.Space.s8)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.lg)
                    .fill(Theme.surface)
            )
            .padding(.horizontal, Theme.Space.s6)
        }
    }

    private func rankColor(_ index: Int) -> Color {
        return Theme.medal(rank: index + 1) ?? Theme.textSecondary
    }

    private func returnToMainRoom() {
        tournamentState.reset()
        appState.screen = .mainRoom
        LobbyEmitter.joinMainRoom()
    }
}

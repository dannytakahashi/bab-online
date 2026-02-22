import SwiftUI

struct TournamentResultsView: View {
    @EnvironmentObject var tournamentState: TournamentState
    @EnvironmentObject var appState: AppState

    private var winner: TournamentScoreEntry? {
        tournamentState.scoreboard.first
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.7).ignoresSafeArea()

            VStack(spacing: 24) {
                // Trophy icon
                Image(systemName: "trophy.fill")
                    .font(.system(size: 48))
                    .foregroundColor(Color.Theme.warning)

                Text("Tournament Complete!")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundColor(Color.Theme.warning)

                if let winner = winner {
                    Text("\(winner.username) wins!")
                        .font(.title2.bold())
                        .foregroundColor(Color.Theme.textPrimary)
                }

                // Final standings
                VStack(spacing: 4) {
                    ForEach(Array(tournamentState.scoreboard.enumerated()), id: \.element.id) { index, entry in
                        HStack {
                            Text("\(index + 1).")
                                .font(.body.bold())
                                .frame(width: 24, alignment: .trailing)
                                .foregroundColor(rankColor(index))

                            Text(entry.username)
                                .font(.body)
                                .foregroundColor(Color.Theme.textPrimary)

                            Spacer()

                            Text("\(entry.totalScore)")
                                .font(.body.bold())
                                .foregroundColor(rankColor(index))
                        }
                        .padding(.horizontal, 20)
                        .padding(.vertical, 6)
                    }
                }
                .padding(.vertical, 8)

                Button(action: returnToMainRoom) {
                    Text("Return to Main Room")
                        .font(.body.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color.Theme.buttonBackground)
                        .foregroundColor(.white)
                        .cornerRadius(10)
                }
                .padding(.horizontal, 40)
            }
            .padding(32)
            .background(
                RoundedRectangle(cornerRadius: 20)
                    .fill(Color.Theme.surface)
            )
            .padding(.horizontal, 24)
        }
    }

    private func rankColor(_ index: Int) -> Color {
        switch index {
        case 0: return Color(red: 1.0, green: 0.84, blue: 0.0)   // gold
        case 1: return Color(white: 0.75)                          // silver
        case 2: return Color(red: 0.8, green: 0.5, blue: 0.2)    // bronze
        default: return Color.Theme.textSecondary
        }
    }

    private func returnToMainRoom() {
        tournamentState.reset()
        appState.screen = .mainRoom
        LobbyEmitter.joinMainRoom()
    }
}

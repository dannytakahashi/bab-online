import SwiftUI

/// Game end modal showing final scores.
struct GameEndView: View {
    @EnvironmentObject var gameState: GameState
    @EnvironmentObject var appState: AppState

    var body: some View {
        ZStack {
            Color.black.opacity(0.7).ignoresSafeArea()

            VStack(spacing: 24) {
                if let data = gameState.gameEndData {
                    // Winner banner
                    let myTeam = Positions.getTeamNumber(gameState.position ?? 1)
                    let didWin = data.winningTeam == myTeam

                    Text(didWin ? "Victory!" : "Defeat")
                        .font(.system(size: 36, weight: .bold, design: .rounded))
                        .foregroundColor(didWin ? Color.Theme.success : Color.Theme.oppColor)

                    // Score summary
                    HStack(spacing: 40) {
                        VStack(spacing: 8) {
                            Text("Team 1")
                                .font(.caption.bold())
                                .foregroundColor(Color.Theme.teamColor)
                            Text(data.team1Players.joined(separator: "\n"))
                                .font(.caption)
                                .foregroundColor(Color.Theme.textSecondary)
                                .multilineTextAlignment(.center)
                            Text("\(data.team1Score)")
                                .font(.title.bold())
                                .foregroundColor(data.winningTeam == 1 ? Color.Theme.success : Color.Theme.textPrimary)
                        }

                        Text("vs")
                            .foregroundColor(Color.Theme.textDim)

                        VStack(spacing: 8) {
                            Text("Team 2")
                                .font(.caption.bold())
                                .foregroundColor(Color.Theme.oppColor)
                            Text(data.team2Players.joined(separator: "\n"))
                                .font(.caption)
                                .foregroundColor(Color.Theme.textSecondary)
                                .multilineTextAlignment(.center)
                            Text("\(data.team2Score)")
                                .font(.title.bold())
                                .foregroundColor(data.winningTeam == 2 ? Color.Theme.success : Color.Theme.textPrimary)
                        }
                    }
                }

                Button(action: returnToMainRoom) {
                    Text("Return to Lobby")
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

    private func returnToMainRoom() {
        gameState.reset()
        appState.screen = .mainRoom
        LobbyEmitter.joinMainRoom()
    }
}

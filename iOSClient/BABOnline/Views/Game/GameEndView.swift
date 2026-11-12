import SwiftUI

/// Game end modal showing final scores.
struct GameEndView: View {
    @EnvironmentObject var gameState: GameState
    @EnvironmentObject var appState: AppState

    var body: some View {
        ZStack {
            Theme.scrim.ignoresSafeArea()

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

                    // Score summary
                    HStack(spacing: Theme.Space.s10) {
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
            .padding(Theme.Space.s8)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.lg)
                    .fill(Theme.surface)
            )
            .frame(maxWidth: 460)  // readable on the open Duo and the iPad
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("gameEnd")
            .padding(.horizontal, Theme.Space.s6)
        }
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

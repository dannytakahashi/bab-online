import SwiftUI

struct TournamentActiveGamesView: View {
    @EnvironmentObject var tournamentState: TournamentState

    var body: some View {
        let activeGames = tournamentState.activeGames.filter { $0.status == "active" }

        if tournamentState.phase == "round_active" && !activeGames.isEmpty {
            VStack(spacing: 0) {
                HStack {
                    Text("Active Games")
                        .font(.caption.bold())
                        .foregroundColor(Color.Theme.textSecondary)
                    Spacer()
                }
                .padding(.horizontal)
                .padding(.top, 12)
                .padding(.bottom, 4)

                ForEach(activeGames) { game in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(game.humanPlayers.joined(separator: ", "))
                                .font(.caption)
                                .foregroundColor(Color.Theme.textPrimary)
                                .lineLimit(1)

                            if game.botCount > 0 {
                                Text("+ \(game.botCount) bot\(game.botCount == 1 ? "" : "s")")
                                    .font(.caption2)
                                    .foregroundColor(Color.Theme.textDim)
                            }
                        }

                        Spacer()

                        Button(action: {
                            TournamentEmitter.spectateTournamentGame(gameId: game.id)
                        }) {
                            Text("Watch")
                                .font(.caption.bold())
                                .foregroundColor(.white)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 6)
                                .background(Color(red: 0.376, green: 0.647, blue: 0.98))
                                .cornerRadius(6)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                }
            }
            .background(Color.Theme.surface)
            .cornerRadius(10)
            .padding(.horizontal)
        }
    }
}

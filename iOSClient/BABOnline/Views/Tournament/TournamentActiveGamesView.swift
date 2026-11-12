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
                        .foregroundColor(Theme.textSecondary)
                    Spacer()
                }
                .padding(.horizontal)
                .padding(.top, Theme.Space.s3)
                .padding(.bottom, Theme.Space.s1)

                ForEach(activeGames) { game in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(game.humanPlayers.joined(separator: ", "))
                                .font(.caption)
                                .foregroundColor(Theme.textPrimary)
                                .lineLimit(1)

                            if game.botCount > 0 {
                                Text("+ \(game.botCount) bot\(game.botCount == 1 ? "" : "s")")
                                    .font(.caption2)
                                    .foregroundColor(Theme.textDim)
                            }
                        }

                        Spacer()

                        Button(action: {
                            TournamentEmitter.spectateTournamentGame(gameId: game.id)
                        }) {
                            Text("Watch")
                                .font(.caption.bold())
                                .padding(.horizontal, Theme.Space.s3)
                                .padding(.vertical, Theme.Space.s2)
                                .secondaryButtonStyle()
                        }
                    }
                    .padding(.horizontal)
                    .padding(.vertical, Theme.Space.s2)
                }
            }
            .background(Theme.surface)
            .cornerRadius(Theme.Radius.md)
            .padding(.horizontal)
        }
    }
}

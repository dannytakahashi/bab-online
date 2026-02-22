import SwiftUI

struct TournamentPlayerListView: View {
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var tournamentState: TournamentState

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Players")
                    .font(.caption.bold())
                    .foregroundColor(Color.Theme.textSecondary)
                Spacer()
            }
            .padding(.horizontal)
            .padding(.top, 12)
            .padding(.bottom, 4)

            VStack(spacing: 8) {
                ForEach(tournamentState.players) { player in
                    playerRow(player)
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 8)
        }
    }

    private func playerRow(_ player: TournamentPlayer) -> some View {
        let isCurrentUser = player.username == authState.username

        return HStack(spacing: 12) {
            // Avatar
            Circle()
                .fill(isCurrentUser ? Color.Theme.primary.opacity(0.3) : Color.Theme.surfaceLight)
                .frame(width: 40, height: 40)
                .overlay(
                    Image(systemName: "person.fill")
                        .foregroundColor(isCurrentUser ? Color.Theme.primary : Color.Theme.textSecondary)
                )

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(player.username)
                        .font(.body.bold())
                        .foregroundColor(isCurrentUser ? Color.Theme.primary : Color.Theme.textPrimary)

                    if isCurrentUser {
                        Text("(you)")
                            .font(.caption)
                            .foregroundColor(Color.Theme.textDim)
                    }

                    if player.isCreator {
                        Text("HOST")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(Color.Theme.warning)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.Theme.warning.opacity(0.15))
                            .cornerRadius(4)
                    }
                }
            }

            Spacer()

            // Ready indicator
            if player.isReady {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(Color.Theme.success)
                    .font(.title3)
            } else {
                Image(systemName: "circle")
                    .foregroundColor(Color.Theme.textDim)
                    .font(.title3)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(Color.Theme.surface)
        .cornerRadius(10)
    }
}

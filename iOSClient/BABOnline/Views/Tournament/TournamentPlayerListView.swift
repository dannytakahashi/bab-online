import SwiftUI

struct TournamentPlayerListView: View {
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var tournamentState: TournamentState

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Players")
                    .font(.caption.bold())
                    .foregroundColor(Theme.textSecondary)
                Spacer()
            }
            .padding(.horizontal)
            .padding(.top, Theme.Space.s3)
            .padding(.bottom, Theme.Space.s1)

            VStack(spacing: Theme.Space.s2) {
                ForEach(tournamentState.players) { player in
                    playerRow(player)
                }
            }
            .padding(.horizontal)
            .padding(.bottom, Theme.Space.s2)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tournament.players")
    }

    private func playerRow(_ player: TournamentPlayer) -> some View {
        let isCurrentUser = player.username == authState.username

        return HStack(spacing: Theme.Space.s3) {
            // Avatar
            Circle()
                .fill(isCurrentUser ? Theme.primary.opacity(0.3) : Theme.surfaceLight)
                .frame(width: 40, height: 40)
                .overlay(
                    Image(systemName: "person.fill")
                        .foregroundColor(isCurrentUser ? Theme.primary : Theme.textSecondary)
                        .accessibilityHidden(true)
                )

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(player.username)
                        .font(.body.bold())
                        .foregroundColor(isCurrentUser ? Theme.primary : Theme.textPrimary)

                    if isCurrentUser {
                        Text("(you)")
                            .font(.caption)
                            .foregroundColor(Theme.textDim)
                    }

                    if player.isCreator {
                        Text("HOST")
                            .font(.caption2.bold())
                            .foregroundColor(Theme.warning)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Theme.warning.opacity(0.15))
                            .cornerRadius(Theme.Radius.sm)
                    }
                }

                if !player.connected {
                    Text("reconnecting\u{2026}")
                        .font(.caption2)
                        .foregroundColor(Theme.textDim)
                        .italic()
                }
            }

            Spacer()

            // Ready indicator
            if player.isReady {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(Theme.success)
                    .font(.title3)
                    .accessibilityLabel("Ready")
            } else {
                Image(systemName: "circle")
                    .foregroundColor(Theme.textDim)
                    .font(.title3)
                    .accessibilityLabel("Not ready")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(Theme.surface)
        .cornerRadius(Theme.Radius.md)
        .opacity(player.connected ? 1.0 : 0.5)
    }
}

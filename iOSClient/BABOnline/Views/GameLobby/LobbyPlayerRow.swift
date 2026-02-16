import SwiftUI

struct LobbyPlayerRow: View {
    let player: LobbyPlayer
    let isCurrentUser: Bool

    var body: some View {
        HStack(spacing: 12) {
            // Avatar
            Circle()
                .fill(isCurrentUser ? Color.Theme.primary.opacity(0.3) : Color.Theme.surfaceLight)
                .frame(width: 40, height: 40)
                .overlay(
                    Group {
                        if player.isBot {
                            Image(systemName: "cpu")
                                .foregroundColor(Color.Theme.warning)
                        } else {
                            Image(systemName: "person.fill")
                                .foregroundColor(isCurrentUser ? Color.Theme.primary : Color.Theme.textSecondary)
                        }
                    }
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

                    if player.isBot {
                        Text("BOT")
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

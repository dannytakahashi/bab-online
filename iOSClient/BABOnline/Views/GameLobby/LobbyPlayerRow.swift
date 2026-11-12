import SwiftUI

struct LobbyPlayerRow: View {
    let player: LobbyPlayer
    let isCurrentUser: Bool

    var body: some View {
        HStack(spacing: Theme.Space.s3) {
            // Avatar
            Circle()
                .fill(isCurrentUser ? Theme.primary.opacity(0.3) : Theme.surfaceLight)
                .frame(width: 40, height: 40)
                .overlay(
                    Group {
                        if player.isBot {
                            Image(systemName: "cpu")
                                .foregroundColor(Theme.warning)
                                .accessibilityHidden(true)
                        } else {
                            Image(systemName: "person.fill")
                                .foregroundColor(isCurrentUser ? Theme.primary : Theme.textSecondary)
                                .accessibilityHidden(true)
                        }
                    }
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

                    if player.isBot {
                        Text("BOT")
                            .font(.caption2.bold())
                            .foregroundColor(Theme.warning)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Theme.warning.opacity(0.15))
                            .cornerRadius(Theme.Radius.sm)
                    }
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
    }
}

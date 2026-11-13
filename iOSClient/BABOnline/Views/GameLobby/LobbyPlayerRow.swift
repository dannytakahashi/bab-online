import SwiftUI

struct LobbyPlayerRow: View {
    let player: LobbyPlayer
    let isCurrentUser: Bool
    /// Removes this bot (LobbyEmitter.removeBot); nil: no remove control. The
    /// control shows only for a bot that is not ready (`LobbyPlayer.canBeRemoved`).
    var onRemove: (() -> Void)? = nil
    /// Sent and waiting for the server's list: the control is disabled so a
    /// double tap cannot send a second removeBot (answered "Bot not found").
    var isRemoving = false

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

            // Remove (a bot that is not ready), left of the ready indicator so the
            // indicators stay in one column: a 44 pt target around a 28 pt disc,
            // as the web's 44 px target around its 32 px button
            if let onRemove, player.canBeRemoved {
                Button(action: onRemove) {
                    Image(systemName: "xmark")
                        .font(.footnote.bold())
                        .foregroundColor(Theme.textSecondary)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(Theme.surfaceLight))
                        .frame(width: Theme.hitTarget, height: Theme.hitTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                // lays out 40 pt tall like the avatar, so a bot's row is as tall as
                // the others; the 44 pt target reaches 2 pt into the row's padding
                .padding(.vertical, -(Theme.hitTarget - 40) / 2)
                .disabled(isRemoving)
                .opacity(isRemoving ? 0.4 : 1)
                .accessibilityLabel(player.removeBotLabel)
                .accessibilityIdentifier("lobby.removeBot")
                .help(player.removeBotLabel)
            }

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

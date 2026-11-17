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
    /// The server holds this seat while its player reconnects (`LobbyState.isReconnecting`):
    /// the row says so instead of looking like an idle player who has not readied.
    var isReconnecting = false
    /// Sets "Spectators can talk" (family lobbies, 1.2.3): "(host)" after the name.
    var isHost = false
    /// A family lobby's Playing / Will watch / Sitting out (nil in a lobby of 4 or fewer).
    var status: LobbySeatStatus? = nil
    /// "Don't wait for <name>" on a returning row (play again, 1.2.3; `LobbyState.canRelease`);
    /// nil: no control.
    var onRelease: (() -> Void)? = nil
    /// Sent and waiting for the server's list.
    var isReleasing = false

    /// A held seat's avatar, name and ready mark are dimmed; its controls ("Don't wait") are
    /// not: a play-again hold is also `reconnecting`, and a dimmed row made the host's working
    /// button look disabled (0.28 while it waited) with too little text contrast.
    private var dim: Double { isReconnecting ? 0.7 : 1 }

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
                .opacity(dim)

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

                    if isHost {
                        Text("(host)")
                            .font(.caption)
                            .foregroundColor(Theme.textDim)
                            .accessibilityIdentifier("lobby.host")
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

                if player.returning, !player.isBot {
                    // play again: a place held for someone not back from the last game yet
                    Text(PlayAgainCopy.notBackYet)
                        .font(.caption2)
                        .foregroundColor(Theme.textSecondary)
                        .italic()
                        .accessibilityIdentifier("lobby.returning")
                } else if isReconnecting {
                    Text("Reconnecting\u{2026}")
                        .font(.caption2)
                        .foregroundColor(Theme.textSecondary)
                        .italic()
                        .accessibilityIdentifier("lobby.reconnecting")
                } else if let status {
                    Text(status.rawValue)
                        .font(.caption2)
                        .foregroundColor(status == .playing ? Theme.success : Theme.textSecondary)
                        .accessibilityIdentifier("lobby.status.\(player.username)")
                }
            }
            .opacity(dim)

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

            if let onRelease, player.returning, !player.isBot {
                DontWaitButton(username: player.username, isReleasing: isReleasing, action: onRelease)
            }

            // Ready indicator
            Group {
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
            .opacity(dim)
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(Theme.surface)
        .cornerRadius(Theme.Radius.md)
    }
}

/// The words of play again (the spec's copy; the web says the same).
enum PlayAgainCopy {
    static let notBackYet = "Not back yet"
    static let expected = "Expected"
    static let dontWait = "Don't wait"
    static func dontWaitFor(_ name: String) -> String { "Don't wait for \(name)" }
}

/// "Don't wait" for a returning row or an expected player (play again, 1.2.3): releases the
/// place at once (LobbyEmitter.releaseLobbyHold). VoiceOver says whom it is for.
struct DontWaitButton: View {
    let username: String
    var isReleasing = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(PlayAgainCopy.dontWait)
                .font(.caption.bold())
                .foregroundColor(Theme.textPrimary)
                .padding(.horizontal, Theme.Space.s3)
                .frame(minHeight: Theme.hitTarget)
                .background(Capsule().fill(Theme.surfaceLight))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -(Theme.hitTarget - 40) / 2)
        .disabled(isReleasing)
        .opacity(isReleasing ? 0.4 : 1)
        .accessibilityLabel(PlayAgainCopy.dontWaitFor(username))
        .accessibilityIdentifier("lobby.dontWait.\(username)")
    }
}

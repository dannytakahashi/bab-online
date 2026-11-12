import SwiftUI

/// Shows disconnected player notifications with bot replacement option.
struct DisconnectBannerView: View {
    @EnvironmentObject var gameState: GameState

    var body: some View {
        VStack(spacing: Theme.Space.s2) {
            ForEach(Array(gameState.disconnectedPlayers), id: \.key) { position, username in
                HStack(spacing: Theme.Space.s2) {
                    Image(systemName: "wifi.slash")
                        .foregroundColor(Theme.dangerForeground)
                        .font(.caption)

                    Text("\(username) disconnected")
                        .font(.caption.bold())
                        .foregroundColor(Theme.dangerForeground)

                    Text("— waiting for reconnection...")
                        .font(.caption)
                        .foregroundColor(Theme.dangerForeground)

                    Spacer()
                }
                .padding(.horizontal, Theme.Space.s3)
                .padding(.vertical, Theme.Space.s2)
                .background(Theme.danger)
                .cornerRadius(Theme.Radius.md)
            }

            // Resignation prompt
            if let resign = gameState.resignationAvailable {
                HStack(spacing: Theme.Space.s2) {
                    Text("\(resign.username) timed out")
                        .font(.caption)
                        .foregroundColor(Theme.textPrimary)

                    Spacer()

                    Button(action: { replaceWithBot(position: resign.position) }) {
                        Text("Replace with Bot")
                            .font(.caption.bold())
                            .foregroundColor(Theme.dangerForeground)
                            .padding(.horizontal, Theme.Space.s3)
                            .padding(.vertical, Theme.Space.s2)
                            .background(Theme.danger)
                            .cornerRadius(Theme.Radius.sm)
                    }
                }
                .padding(.horizontal, Theme.Space.s3)
                .padding(.vertical, Theme.Space.s2)
                // the connection banner's look: the panel surface, a warning edge
                .background(Theme.surface.opacity(0.95))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).stroke(Theme.warning, lineWidth: 1))
                .cornerRadius(Theme.Radius.md)
            }
        }
        .padding(.horizontal, Theme.Space.s3)
    }

    private func replaceWithBot(position: Int) {
        GameEmitter.forceResign(position: position)
    }
}

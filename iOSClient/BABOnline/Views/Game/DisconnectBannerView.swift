import SwiftUI

/// Shows disconnected player notifications with bot replacement option.
struct DisconnectBannerView: View {
    @EnvironmentObject var gameState: GameState

    var body: some View {
        VStack(spacing: 8) {
            ForEach(Array(gameState.disconnectedPlayers), id: \.key) { position, username in
                HStack(spacing: 8) {
                    Image(systemName: "wifi.slash")
                        .foregroundColor(.white)
                        .font(.caption)

                    Text("\(username) disconnected")
                        .font(.caption.bold())
                        .foregroundColor(.white)

                    Text("— waiting for reconnection...")
                        .font(.caption)
                        .foregroundColor(.white.opacity(0.8))

                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.Theme.disconnectBanner)
                .cornerRadius(8)
            }

            // Resignation prompt
            if let resign = gameState.resignationAvailable {
                HStack(spacing: 8) {
                    Text("\(resign.username) timed out")
                        .font(.caption)
                        .foregroundColor(.white)

                    Spacer()

                    Button(action: { replaceWithBot(position: resign.position) }) {
                        Text("Replace with Bot")
                            .font(.caption.bold())
                            .foregroundColor(.white)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Color.Theme.oppColor)
                            .cornerRadius(6)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.Theme.warning.opacity(0.8))
                .cornerRadius(8)
            }
        }
        .padding(.horizontal, 12)
    }

    private func replaceWithBot(position: Int) {
        GameEmitter.forceResign(position: position)
    }
}

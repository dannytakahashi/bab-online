import SwiftUI

/// Shows disconnected player notifications with bot replacement option.
struct DisconnectBannerView: View {
    @EnvironmentObject var gameState: GameState
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(spacing: Theme.Space.s2) {
            ForEach(Array(gameState.disconnectedPlayers), id: \.key) { position, username in
                HStack(spacing: Theme.Space.s2) {
                    Image(systemName: "wifi.slash")
                        .foregroundColor(Theme.dangerForeground)
                        .font(.caption)
                        .accessibilityHidden(true)

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

            // Resignation prompt: a seat that timed out, or (a tournament table's idle-seat
            // offer, resignationAvailable `idle: true`) a connected player slow on their turn,
            // in the web dialog's words: "<name> seems idle" / "Replace with a bot?"
            if let resign = gameState.resignationOffer {
                let row = typeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: Theme.Space.s2)) : AnyLayout(HStackLayout(spacing: Theme.Space.s2))
                row {
                    HStack(spacing: Theme.Space.s2) {
                        if resign.idle {
                            Image(systemName: "hourglass")
                                .foregroundColor(Theme.warning)
                                .font(.caption)
                                .accessibilityHidden(true)
                        }
                        VStack(alignment: .leading, spacing: 0) {
                            Text(resign.title)
                                .font(resign.idle ? .caption.bold() : .caption)
                                .foregroundColor(Theme.textPrimary)
                            if resign.idle {
                                Text(resign.question)
                                    .font(.caption)
                                    .foregroundColor(Theme.textSecondary)
                            }
                        }
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(resign.idle ? resign.spoken : resign.title)
                    .accessibilityIdentifier("resignOffer.message")

                    if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }

                    HStack(spacing: Theme.Space.s2) {
                        if resign.idle {
                            // the web dialog's Wait: the offer goes until the server asks again
                            Button(action: { gameState.waitOnOffer() }) {
                                Text("Wait")
                                    .font(.caption.bold())
                                    .foregroundColor(Theme.textPrimary)
                                    .padding(.horizontal, Theme.Space.s3)
                                    .padding(.vertical, Theme.Space.s2)
                                    .background(Theme.surfaceLight)
                                    .cornerRadius(Theme.Radius.sm)
                            }
                            .accessibilityIdentifier("resignOffer.wait")
                        }
                        Button(action: { replaceWithBot(position: resign.position) }) {
                            Text("Replace with Bot")
                                .font(.caption.bold())
                                .foregroundColor(Theme.dangerForeground)
                                .padding(.horizontal, Theme.Space.s3)
                                .padding(.vertical, Theme.Space.s2)
                                .background(Theme.danger)
                                .cornerRadius(Theme.Radius.sm)
                        }
                        .accessibilityIdentifier("resignOffer.replace")
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
        // it stays up over the table (a grace period, an offer until someone answers): its text
        // stops growing at accessibility2, where it already stacks, so it never covers the seats
        // and trick it is about
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
    }

    private func replaceWithBot(position: Int) {
        GameEmitter.forceResign(position: position)
    }
}

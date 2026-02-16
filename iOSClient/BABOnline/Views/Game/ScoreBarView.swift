import SwiftUI

/// Score/bids/tricks header bar at top of game screen.
struct ScoreBarView: View {
    @EnvironmentObject var gameState: GameState

    var body: some View {
        HStack(spacing: 0) {
            // Team side
            VStack(spacing: 2) {
                Text("Your Team")
                    .font(.system(size: 10))
                    .foregroundColor(Color.Theme.textDim)
                Text("\(gameState.teamScore)")
                    .font(.title3.bold())
                    .foregroundColor(Color.Theme.teamColor)

                HStack(spacing: 8) {
                    if let bids = gameState.teamBids {
                        Label(bids, systemImage: "target")
                            .font(.system(size: 11))
                            .foregroundColor(Color.Theme.textSecondary)
                    }
                    Text("Tricks: \(gameState.teamTricks)")
                        .font(.system(size: 11))
                        .foregroundColor(Color.Theme.textSecondary)
                }
            }
            .frame(maxWidth: .infinity)

            // Center info
            VStack(spacing: 2) {
                if let trump = gameState.trump {
                    HStack(spacing: 4) {
                        Text("Trump:")
                            .font(.system(size: 10))
                            .foregroundColor(Color.Theme.textDim)
                        Text(trumpSymbol(trump))
                            .font(.system(size: 14))
                            .foregroundColor(trumpColor(trump))
                    }
                }
                Text("Hand \(handNumber)")
                    .font(.system(size: 10))
                    .foregroundColor(Color.Theme.textDim)

                if gameState.team1Mult > 1 || gameState.team2Mult > 1 {
                    Text(multiplierText)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(Color.Theme.warning)
                }
            }
            .frame(width: 80)

            // Opponent side
            VStack(spacing: 2) {
                Text("Opponents")
                    .font(.system(size: 10))
                    .foregroundColor(Color.Theme.textDim)
                Text("\(gameState.oppScore)")
                    .font(.title3.bold())
                    .foregroundColor(Color.Theme.oppColor)

                HStack(spacing: 8) {
                    if let bids = gameState.oppBids {
                        Label(bids, systemImage: "target")
                            .font(.system(size: 11))
                            .foregroundColor(Color.Theme.textSecondary)
                    }
                    Text("Tricks: \(gameState.oppTricks)")
                        .font(.system(size: 11))
                        .foregroundColor(Color.Theme.textSecondary)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.Theme.surface.opacity(0.9))
    }

    private var handNumber: String {
        let idx = gameState.currentHand
        if idx >= 0 && idx < CardConstants.handProgression.count {
            return "\(CardConstants.handProgression[idx])"
        }
        return "\(idx)"
    }

    private var multiplierText: String {
        var parts: [String] = []
        if gameState.team1Mult > 1 {
            let level = ["", "B", "2B", "3B", "4B"]
            let idx = [1: 0, 2: 1, 4: 2, 8: 3, 16: 4][gameState.team1Mult] ?? 0
            parts.append("T1: \(level[idx])")
        }
        if gameState.team2Mult > 1 {
            let level = ["", "B", "2B", "3B", "4B"]
            let idx = [1: 0, 2: 1, 4: 2, 8: 3, 16: 4][gameState.team2Mult] ?? 0
            parts.append("T2: \(level[idx])")
        }
        return parts.joined(separator: " | ")
    }

    private func trumpSymbol(_ trump: Card) -> String {
        switch trump.suit {
        case .spades:   return "\u{2660}"
        case .hearts:   return "\u{2665}"
        case .diamonds: return "\u{2666}"
        case .clubs:    return "\u{2663}"
        case .joker:    return "NT"
        }
    }

    private func trumpColor(_ trump: Card) -> Color {
        switch trump.suit {
        case .hearts, .diamonds: return .red
        case .spades, .clubs: return .white
        case .joker: return Color.Theme.warning
        }
    }
}

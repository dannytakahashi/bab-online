import SwiftUI

/// Score/bids/tricks header bar at top of game screen.
struct ScoreBarView: View {
    @EnvironmentObject var gameState: GameState

    var body: some View {
        HStack(spacing: 0) {
            // Team side (positions 1 & 3)
            VStack(spacing: 2) {
                Text(team1Label)
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
                        Text(trumpDisplay(trump))
                            .font(.system(size: 13, weight: .semibold))
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
            .frame(width: 100)

            // Opponent side (positions 2 & 4)
            VStack(spacing: 2) {
                Text(team2Label)
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

    private var team1Label: String {
        if gameState.isSpectator {
            let p1 = gameState.players[1]?.username.prefix(1) ?? "?"
            let p3 = gameState.players[3]?.username.prefix(1) ?? "?"
            return "\(p1) & \(p3)"
        }
        return "Your Team"
    }

    private var team2Label: String {
        if gameState.isSpectator {
            let p2 = gameState.players[2]?.username.prefix(1) ?? "?"
            let p4 = gameState.players[4]?.username.prefix(1) ?? "?"
            return "\(p2) & \(p4)"
        }
        return "Opponents"
    }

    private var handNumber: String {
        // currentHand is the hand SIZE (12, 10, 8, ...), display it directly
        return "\(gameState.currentHand)"
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

    private func trumpDisplay(_ trump: Card) -> String {
        let suitSymbol: String
        switch trump.suit {
        case .spades:   suitSymbol = "\u{2660}"
        case .hearts:   suitSymbol = "\u{2665}"
        case .diamonds: suitSymbol = "\u{2666}"
        case .clubs:    suitSymbol = "\u{2663}"
        case .joker:    return trump.rank == .hi ? "High Joker" : "Low Joker"
        }
        return "\(trump.rank.rawValue)\(suitSymbol)"
    }

    private func trumpColor(_ trump: Card) -> Color {
        switch trump.suit {
        case .hearts, .diamonds: return .red
        case .spades, .clubs: return .white
        case .joker: return Color.Theme.warning
        }
    }
}

import SwiftUI

/// Score/bids/tricks header bar at top of game screen.
struct ScoreBarView: View {
    @EnvironmentObject var gameState: GameState

    var body: some View {
        HStack(spacing: 0) {
            // Team side (positions 1 & 3)
            VStack(spacing: 2) {
                Text(team1Label)
                    .font(.caption2)
                    .foregroundColor(Theme.textDim)
                Text("\(gameState.teamScore)")
                    .font(.title3.bold())
                    .foregroundColor(Theme.team(myTeam))

                HStack(spacing: Theme.Space.s2) {
                    if let bids = gameState.teamBids {
                        Label(bids, systemImage: "target")
                            .font(.caption2)
                            .foregroundColor(Theme.textSecondary)
                    }
                    Text(Self.tricksText(gameState.teamTricks, of: gameState.bidTotals?.mine))
                        .font(.caption2)
                        .foregroundColor(Theme.textSecondary)
                }
                // one line ("Tricks: 12/13" beside "3B/2" on a 375 pt phone): shrink, never wrap
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            }
            .frame(maxWidth: .infinity)

            // Center info
            VStack(spacing: 2) {
                if let trump = gameState.trump {
                    HStack(spacing: Theme.Space.s1) {
                        Text("Trump:")
                            .font(.caption2)
                            .foregroundColor(Theme.textDim)
                        Text(trumpDisplay(trump))
                            .font(.footnote.weight(.semibold))
                            .foregroundColor(trumpColor(trump))
                    }
                }
                Text("Hand \(handNumber)")
                    .font(.caption2)
                    .foregroundColor(Theme.textDim)

                if gameState.team1Mult > 1 || gameState.team2Mult > 1 {
                    Text(multiplierText)
                        .font(.caption2.bold())
                        .foregroundColor(Theme.warning)
                }
            }
            .frame(width: 100)

            // Opponent side (positions 2 & 4)
            VStack(spacing: 2) {
                Text(team2Label)
                    .font(.caption2)
                    .foregroundColor(Theme.textDim)
                Text("\(gameState.oppScore)")
                    .font(.title3.bold())
                    .foregroundColor(Theme.team(3 - myTeam))

                HStack(spacing: Theme.Space.s2) {
                    if let bids = gameState.oppBids {
                        Label(bids, systemImage: "target")
                            .font(.caption2)
                            .foregroundColor(Theme.textSecondary)
                    }
                    Text(Self.tricksText(gameState.oppTricks, of: gameState.bidTotals?.theirs))
                        .font(.caption2)
                        .foregroundColor(Theme.textSecondary)
                }
                // one line ("Tricks: 12/13" beside "3B/2" on a 375 pt phone): shrink, never wrap
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, Theme.Space.s3)
        .padding(.vertical, Theme.Space.s2)
        // never into a safe-area inset: the system's zones (the status band on top, the
        // Duo's vertical bar on the side) show the felt, like the table
        .background(Theme.surface.opacity(0.9), ignoresSafeAreaEdges: [])
        // capped so the table layout's top bar stays <= 84 pt (TableLayoutTests): the
        // caption2 labels (Dynamic Type) reach it at xLarge
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
    }

    /// "Tricks: 2" while bidding, then "Tricks: 2/7" (the team's bid total: a bore is the whole hand).
    static func tricksText(_ won: Int, of total: Int?) -> String {
        total.map { "Tricks: \(won)/\($0)" } ?? "Tricks: \(won)"
    }

    /// The viewer's team (1 for a spectator: seats 1 and 3 on the left), colored as on the web.
    private var myTeam: Int { Positions.getTeamNumber(gameState.viewPosition) }

    private var team1Label: String {
        if gameState.isSpectator {
            let p1 = gameState.players.seats[1]?.username?.prefix(1) ?? "?"
            let p3 = gameState.players.seats[3]?.username?.prefix(1) ?? "?"
            return "\(p1) & \(p3)"
        }
        return "Your Team"
    }

    private var team2Label: String {
        if gameState.isSpectator {
            let p2 = gameState.players.seats[2]?.username?.prefix(1) ?? "?"
            let p4 = gameState.players.seats[4]?.username?.prefix(1) ?? "?"
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
        return Theme.suitOnDark(trump.suit)
    }
}

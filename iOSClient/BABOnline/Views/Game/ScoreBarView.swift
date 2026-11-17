import SwiftUI

/// Score/bids/tricks header bar at top of game screen.
struct ScoreBarView: View {
    @EnvironmentObject var gameState: GameState

    var body: some View {
        HStack(spacing: 0) {
            // Team side (positions 1 & 3)
            VStack(spacing: 2) {
                namesLabel(team1Label, side: .mine)
                Text("\(gameState.teamScore)")
                    .font(.title3.bold())
                    .foregroundColor(Theme.team(myTeam))

                HStack(spacing: Theme.Space.s2) {
                    if let bids = gameState.teamBids {
                        Self.bidLabel(bids)
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
                namesLabel(team2Label, side: .theirs)
                Text("\(gameState.oppScore)")
                    .font(.title3.bold())
                    .foregroundColor(Theme.team(3 - myTeam))

                HStack(spacing: Theme.Space.s2) {
                    if let bids = gameState.oppBids {
                        Self.bidLabel(bids)
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

    /// The team's bids ("2/4", "B/1") behind the target icon, read as "Bid 2/4" (the icon is
    /// decorative: VoiceOver said "Target With Concentric Rings").
    static func bidLabel(_ bids: String) -> some View {
        Label {
            Text(bids)
        } icon: {
            Image(systemName: "target")
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(bidAccessibilityLabel(bids))
    }

    static func bidAccessibilityLabel(_ bids: String) -> String { "Bid \(bids)" }

    /// "Tricks: 2" while bidding, then "Tricks: 2/7" (the team's bid total: a bore is the whole hand).
    static func tricksText(_ won: Int, of total: Int?) -> String {
        total.map { "Tricks: \(won)/\($0)" } ?? "Tricks: \(won)"
    }

    /// The viewer's team (1 for a spectator: seats 1 and 3 on the left), colored as on the web.
    private var myTeam: Int { Positions.getTeamNumber(gameState.viewPosition) }

    /// The two sides of the bar: mine (the left; seats 1 and 3 for a spectator) and theirs.
    enum Side { case mine, theirs }

    /// A side's names on one line (owner 2026-11-17: the players' names, never "Your Team" /
    /// "Opponents"): long names shrink, then truncate in the middle so both partners keep a
    /// part ("averylongn…partnername"). The line is always one full-size caption2 line tall
    /// (a hidden " " sets it, the names sit over it), so neither an empty side (names not
    /// known yet) nor a shrunk long name changes the bar's height: no jump when the names
    /// come, and the bar stays inside its 84 pt cap (TableLayoutTests, SceneLayoutTests).
    /// VoiceOver reads which side it is first (`namesAccessibilityLabel`). Identifiers:
    /// `scoreBar.teamNames` / `scoreBar.oppNames`.
    private func namesLabel(_ text: String, side: Side) -> some View {
        Text(" ")
            .font(.caption2)
            .frame(maxWidth: .infinity)
            .hidden()
            .overlay {
                Text(text)
                    .font(.caption2)
                    .foregroundColor(Theme.textDim)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .truncationMode(.middle)
                    .accessibilityLabel(Self.namesAccessibilityLabel(text, side: side, spectator: gameState.isSpectator))
                    .accessibilityIdentifier(side == .mine ? "scoreBar.teamNames" : "scoreBar.oppNames")
            }
    }

    /// The left side's label: a seat's "me/partner", a spectator's initials of seats 1 and 3.
    private var team1Label: String {
        if gameState.isSpectator {
            let p1 = gameState.players.seats[1]?.username?.prefix(1) ?? "?"
            let p3 = gameState.players.seats[3]?.username?.prefix(1) ?? "?"
            return "\(p1) & \(p3)"
        }
        return seatNames.team
    }

    /// The right side's label: a seat's "opp1/opp2", a spectator's initials of seats 2 and 4.
    private var team2Label: String {
        if gameState.isSpectator {
            let p2 = gameState.players.seats[2]?.username?.prefix(1) ?? "?"
            let p4 = gameState.players.seats[4]?.username?.prefix(1) ?? "?"
            return "\(p2) & \(p4)"
        }
        return seatNames.opp
    }

    private var seatNames: (team: String, opp: String) {
        Self.seatTeamNames(position: gameState.position, usernames: gameState.players.seats.compactMapValues(\.username))
    }

    /// A seated player's two sides by name, as the web's score header (client
    /// ScoreModal.scoreHeaderNames): mine "me/partner", theirs "opp1/opp2" (opp1 the next
    /// seat clockwise, `Positions.getRelativePositions`). A side whose two names are not both
    /// known is "" (never a placeholder), and both are "" while my own seat is not known.
    static func seatTeamNames(position: Int?, usernames: [Int: String]) -> (team: String, opp: String) {
        guard let me = position, (1...4).contains(me) else { return ("", "") }
        let r = Positions.getRelativePositions(myPos: me)
        func pair(_ a: Int, _ b: Int) -> String {
            guard let x = usernames[a], !x.isEmpty, let y = usernames[b], !y.isEmpty else { return "" }
            return "\(x)/\(y)"
        }
        return (pair(me, r.partner), pair(r.opp1, r.opp2))
    }

    /// What VoiceOver reads for a side's names. The bar shows only names, so a seat's label
    /// says which side it is first (sighted players get that from the side and the team
    /// colour): "Your team, ann and cat" / "Opponents, bob and dan" ("/" read as "and", not
    /// "slash"); just "Your team" / "Opponents" while the names are not known. A spectator's
    /// initials are read as shown ("a & c": "a and c"), as before.
    static func namesAccessibilityLabel(_ text: String, side: Side, spectator: Bool) -> String {
        if spectator { return text }
        let title = side == .mine ? "Your team" : "Opponents"
        let names = text.split(separator: "/", maxSplits: 1).map(String.init)
        return names.isEmpty ? title : "\(title), \(names.joined(separator: " and "))"
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

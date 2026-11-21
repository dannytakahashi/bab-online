import SwiftUI

/// Score/bids/tricks header bar at top of game screen.
struct ScoreBarView: View {
    @EnvironmentObject var gameState: GameState

    var body: some View {
        HStack(spacing: 0) {
            // Team side (positions 1 & 3)
            VStack(spacing: 2) {
                namesLabel(team1Names, side: .mine)
                scoreLine(gameState.teamScore, team: myTeam, mult: sideMults.mine, names: team1Names, side: .mine)

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
            }
            .frame(width: 100)

            // Opponent side (positions 2 & 4)
            VStack(spacing: 2) {
                namesLabel(team2Names, side: .theirs)
                scoreLine(gameState.oppScore, team: 3 - myTeam, mult: sideMults.theirs, names: team2Names, side: .theirs)

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

    /// A side's score in its team's colour and, while that team has bored, its bore level
    /// ("B", "2B", "3B", "4B": the bid's own word, as the web's header shows it in the team's
    /// "Bids: B/1") just after the score on its baseline, caption2 bold in the warning colour
    /// (`BoreScoreLine`). The score never shrinks, and caption2 on title3's baseline adds no
    /// height (the 84 pt cap: `ScoreBarNamesTests.testBoreLevelsKeepTheBarsSize`). It was one
    /// "T1: B | T2: 2B" line in the centre column (owner 2026-11-17: never a team number).
    /// VoiceOver: `multiplierAccessibilityLabel`. Identifiers `scoreBar.teamMult` /
    /// `scoreBar.oppMult` (the scores `scoreBar.teamScore` / `scoreBar.oppScore`).
    @ViewBuilder
    private func scoreLine(_ score: Int, team: Int, mult: Int, names: SideNames?, side: Side) -> some View {
        if let level = Self.boreLevel(mult) {
            BoreScoreLine(
                score: score,
                color: Theme.team(team),
                level: level,
                levelAccessibilityLabel: Self.multiplierAccessibilityLabel(level, names: names),
                scoreIdentifier: side == .mine ? "scoreBar.teamScore" : "scoreBar.oppScore",
                levelIdentifier: side == .mine ? "scoreBar.teamMult" : "scoreBar.oppMult"
            )
        } else {
            Text("\(score)")
                .font(.title3.bold())
                .foregroundColor(Theme.team(team))
                .accessibilityIdentifier(side == .mine ? "scoreBar.teamScore" : "scoreBar.oppScore")
        }
    }

    /// A bored team's score and its level. Where the column has room, a hidden copy of the
    /// level before the score keeps the score centred; where it has not (a 320 pt bar at
    /// xLarge gives each side 98 pt, and "-2080" with "4B" needs 110 with the copy), the copy
    /// goes and the score and its level sit side by side, centred together: neither is ever
    /// cut (`ScoreBarNamesTests.testABoreLevelIsNeverCutInANarrowColumn`).
    struct BoreScoreLine: View {
        let score: Int
        let color: Color
        let level: String
        var levelAccessibilityLabel = ""
        var scoreIdentifier = ""
        var levelIdentifier = ""

        var body: some View {
            ViewThatFits(in: .horizontal) {
                line(centred: true)
                line(centred: false)
            }
        }

        private var levelText: Text { Text(level).font(.caption2.bold()) }

        private func line(centred: Bool) -> some View {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s1) {
                if centred { levelText.hidden().accessibilityHidden(true) }
                Text("\(score)")
                    .font(.title3.bold())
                    .foregroundColor(color)
                    .accessibilityIdentifier(scoreIdentifier)
                levelText
                    .foregroundColor(Theme.warning)
                    .accessibilityLabel(levelAccessibilityLabel)
                    .accessibilityIdentifier(levelIdentifier)
            }
            .fixedSize()
        }
    }

    /// A team's multiplier as its bore level: 2 "B", 4 "2B", 8 "3B", 16 "4B"; nil for 1 (no
    /// bore) or anything else.
    static func boreLevel(_ mult: Int) -> String? {
        [2: "B", 4: "2B", 8: "3B", 16: "4B"][mult]
    }

    /// The (left, right) sides' multipliers from the absolute teams' (team 1 = seats 1 and 3):
    /// the viewer's team on the left (team 1 for a spectator).
    static func sideMults(team1: Int, team2: Int, myTeam: Int) -> (mine: Int, theirs: Int) {
        myTeam == 2 ? (team2, team1) : (team1, team2)
    }

    private var sideMults: (mine: Int, theirs: Int) {
        Self.sideMults(team1: gameState.team1Mult, team2: gameState.team2Mult, myTeam: myTeam)
    }

    /// VoiceOver for a side's bore level: whose it is, as that side's names are read, then the
    /// level ("ann and cat, bore B"); while the names are not known just "bore B", for a seat
    /// and a spectator alike (never "Your team" or a seat-number stand-in for the team).
    static func multiplierAccessibilityLabel(_ level: String, names: SideNames?) -> String {
        let who = namesAccessibilityLabel(names)
        return who.isEmpty ? "bore \(level)" : "\(who), bore \(level)"
    }

    /// A side's names on one line (owner 2026-11-17: the players' names, never "Your Team" /
    /// "Opponents"): `ScoreBarNamesLabel`, which shrinks, then cuts each name at its end so
    /// both names and the "/" always show. The line is always one full-size caption2 line tall
    /// (a hidden " " sets it, the names sit over it), so neither an empty side (names not
    /// known yet) nor a shrunk long name changes the bar's height: no jump when the names
    /// come, and the bar stays inside its 84 pt cap (TableLayoutTests, SceneLayoutTests).
    /// VoiceOver reads the two names (`namesAccessibilityLabel`). Identifiers:
    /// `scoreBar.teamNames` / `scoreBar.oppNames`.
    private func namesLabel(_ names: SideNames?, side: Side) -> some View {
        Text(" ")
            .font(.caption2)
            .frame(maxWidth: .infinity)
            .hidden()
            .overlay {
                ScoreBarNamesLabel(
                    names: names,
                    accessibilityLabel: Self.namesAccessibilityLabel(names),
                    identifier: side == .mine ? "scoreBar.teamNames" : "scoreBar.oppNames"
                )
            }
    }

    /// One side's two names and what goes between them: "ann" "/" "cat". Kept apart (not one
    /// joined string) so the bar can cut each name on its own and VoiceOver reads the two
    /// names whatever is in them.
    struct SideNames: Equatable {
        let first: String
        let second: String
        var separator = "/"
        var joined: String { first + separator + second }
    }

    /// The left side: a seat's "me/partner", a spectator's seats 1 and 3 ("ann/cat").
    private var team1Names: SideNames? { seatTeams.team }

    /// The right side: a seat's "opp1/opp2", a spectator's seats 2 and 4 ("bob/dan").
    private var team2Names: SideNames? { seatTeams.opp }

    private var seatTeams: (team: SideNames?, opp: SideNames?) {
        // a watcher's bar reads from the watched seat (the over-the-shoulder view), as its scores
        Self.viewerTeams(position: gameState.watchedSeat ?? gameState.position, spectator: gameState.isPlainSpectator,
                         usernames: gameState.players.seats.compactMapValues(\.username))
    }

    /// The bar's two sides for the viewer: a seat's `seatTeams`; a spectator's as seat 1's
    /// ("seat1/seat3", "seat2/seat4": the web's scoreHeaderNames for a spectator, which were
    /// the initials "a & c" until 2026-11-17).
    static func viewerTeams(position: Int?, spectator: Bool, usernames: [Int: String]) -> (team: SideNames?, opp: SideNames?) {
        seatTeams(position: spectator ? 1 : position, usernames: usernames)
    }

    /// A seated player's two sides by name, as the web's score header (client
    /// ScoreModal.scoreHeaderNames): mine me + partner, theirs opp1 + opp2 (opp1 the next
    /// seat clockwise, `Positions.getRelativePositions`). A side whose two names are not both
    /// known is nil (shown empty, never a placeholder), and both are nil while my own seat is
    /// not known.
    static func seatTeams(position: Int?, usernames: [Int: String]) -> (team: SideNames?, opp: SideNames?) {
        guard let me = position, (1...4).contains(me) else { return (nil, nil) }
        let r = Positions.getRelativePositions(myPos: me)
        func pair(_ a: Int, _ b: Int) -> SideNames? {
            guard let x = usernames[a], !x.isEmpty, let y = usernames[b], !y.isEmpty else { return nil }
            return SideNames(first: x, second: y)
        }
        return (pair(me, r.partner), pair(r.opp1, r.opp2))
    }

    /// `seatTeams` as the text the bar shows when it fits: "me/partner", "opp1/opp2", "" when
    /// not known.
    static func seatTeamNames(position: Int?, usernames: [Int: String]) -> (team: String, opp: String) {
        let t = seatTeams(position: position, usernames: usernames)
        return (t.team?.joined ?? "", t.opp?.joined ?? "")
    }

    /// What VoiceOver reads for a side's names, built from the two names (never by splitting
    /// the shown text, so a "/" inside a username is read as part of it): "ann and cat" (read
    /// "and", not "slash"), for a seat and a spectator alike; "" while the names are not known.
    /// Never "Your team" / "Opponents" (owner 2026-11-17, as the web's announcer): a seat's
    /// own side is the one with its own name, read first.
    static func namesAccessibilityLabel(_ names: SideNames?) -> String {
        names.map { "\($0.first) and \($0.second)" } ?? ""
    }

    /// The smallest the names shrink to before they are cut (the bids line's factor).
    static let namesMinScale: CGFloat = 0.75

    /// The text a side shows in `width` points, `measure` giving a string's full-size width:
    /// the whole pair when it fits at up to `namesMinScale` (the Text shrinks it), else each
    /// name cut at its end ("Bartholo…/Christop…") into its share of the line so both names and
    /// the separator always show. (Middle truncation of the joined text dropped the "/" first,
    /// so two long names read as one.) A name that fits in half the line keeps all of it and
    /// the other gets the rest.
    static func fittedNames(_ names: SideNames, width: CGFloat, measure: (String) -> CGFloat) -> String {
        // a hair under the line, so the Text's own measure never truncates what is left
        let budget = max(0, width / namesMinScale - 2)
        if measure(names.joined) <= budget { return names.joined }
        let room = max(0, budget - measure(names.separator))
        let wa = measure(names.first), wb = measure(names.second)
        let (ra, rb): (CGFloat, CGFloat) = wa <= room / 2 ? (wa, room - wa)
            : wb <= room / 2 ? (room - wb, wb)
            : (room / 2, room / 2)
        return cut(names.first, to: ra, measure: measure) + names.separator + cut(names.second, to: rb, measure: measure)
    }

    /// `name` whole if it fits `width`, else its longest start that fits with "…" (at least
    /// one character: the Text's own tail truncation takes care of a line narrower than that).
    static func cut(_ name: String, to width: CGFloat, measure: (String) -> CGFloat) -> String {
        if measure(name) <= width { return name }
        let chars = Array(name)
        var k = chars.count - 1
        while k > 1 {
            let head = String(chars[..<k]).trimmingCharacters(in: .whitespaces)
            if !head.isEmpty, measure(head + "…") <= width { return head + "…" }
            k -= 1
        }
        return String(chars[..<1]) + "…"
    }

    /// A string's width in the caption2 font of `typeSize` (the names' font, full size).
    static func captionWidth(_ typeSize: DynamicTypeSize) -> (String) -> CGFloat {
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(typeSize))
        let font = UIFont.preferredFont(forTextStyle: .caption2, compatibleWith: traits)
        return { ($0 as NSString).size(withAttributes: [.font: font]).width }
    }

    private var handNumber: String {
        // currentHand is the hand SIZE (12, 10, 8, ...), display it directly
        return "\(gameState.currentHand)"
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

/// A score bar side's names, fitted to the line it sits over (`ScoreBarView.fittedNames`, in
/// the caption2 of the bar's capped Dynamic Type size, read here inside the cap): one line,
/// shrunk up to `namesMinScale`, then each name cut so both names and the separator show.
struct ScoreBarNamesLabel: View {
    let names: ScoreBarView.SideNames?
    let accessibilityLabel: String
    let identifier: String
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        GeometryReader { geo in
            Text(names.map { ScoreBarView.fittedNames($0, width: geo.size.width, measure: ScoreBarView.captionWidth(typeSize)) } ?? "")
                .font(.caption2)
                .foregroundColor(Theme.textDim)
                .lineLimit(1)
                .minimumScaleFactor(ScoreBarView.namesMinScale)
                .truncationMode(.tail)
                .accessibilityLabel(accessibilityLabel)
                .accessibilityIdentifier(identifier)
                .frame(width: geo.size.width, height: geo.size.height)
        }
    }
}

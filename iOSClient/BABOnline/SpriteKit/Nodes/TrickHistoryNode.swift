import SpriteKit

/// Stacked won tricks for each team, set from the trick counts (idempotent):
/// `history.team.<i>` (my team's) and `history.opp.<i>` (theirs), `spacing` apart (from the
/// layout), each in its team's absolute color (team 1 blue, team 2 coral), as the score bar
/// and the pips: a viewer on team 2 has a coral bottom row. My team's row is the lower
/// one, nearer my hand (owner 2026-11-14); the opponents' row sits above it.
///
/// At a three-seat table (Get Your Bid: no teams, `solo` set) every seat has its own pile, as
/// the web's TrickManager team / opp / opp2 piles: mine (`history.team.`), the next in turn's
/// (`history.opp.`) and the one after's (`history.opp2.`), bottom to top in turn order, each in
/// its seat's colour (Positions.colour: blue, coral, gold) with its own bid's border. The three
/// rows use a squatter icon (`soloIcon`) at a 17 pt pitch so the block stays inside the same
/// envelope as the two rows (the layout's history rect, the borders' 2 pt pad included): every
/// layout keeps the piles where it already does. (The web puts the third pile in the top right;
/// here it stays in the history block, by construction clear of what the layout keeps clear.)
///
/// Once the bidding is over each row also shows its team's bid total (the web's
/// TrickManager piles; a bore counts as the whole hand, BidTotals): the bid's slots not
/// won yet as dim boxes (`history.<row>.slot.<i>`) and a border (`history.<row>.border`)
/// in danger until the team has its total, then safe. Everything stays inside the
/// layout's history rect (13 icons per row) but for the border's 2 pt pad, inside the
/// layout's 6 pt gaps.
///
/// Those are the nodes' `role`s, not names: drawing only (the score bar reads "Tricks:
/// 2/7"), so none of it is an accessibility element (SpriteKit lists named nodes).
class TrickHistoryNode: SKNode {
    private(set) var stackSpacing: CGFloat = 14
    private(set) var counts = (team: 0, opp: 0, opp2: 0)
    /// (my team's, theirs, the second opponent's at three seats) bid totals; nil while bidding / between hands.
    private(set) var totals: (team: Int, opp: Int, opp2: Int)?
    /// The viewer's team (1 or 2; 1 for a spectator), which colors the rows; at three seats
    /// the viewer's seat colour (1...3).
    private(set) var myTeam = 1
    /// A three-seat table's two opponents' seat colours (the next in turn's, the one after's:
    /// Positions.colour); nil: the two team rows.
    private(set) var solo: Solo?

    struct Solo: Equatable {
        var opp: Int
        var opp2: Int
    }

    static let borderPad: CGFloat = 2
    /// The two rows inside the history rect (y up): the opponents' on top, my team's 30 pt
    /// lower, nearer my hand.
    static let oppRowY: CGFloat = 0
    static let teamRowY: CGFloat = -30
    /// Three seats: the icon and the rows (bottom to top: mine, the next in turn's, the one
    /// after's). Bordered, each row is 15 pt tall with 2.5 pt between: the three span exactly
    /// the two rows' bordered envelope (oppRowY + 8 + pad down to teamRowY - 8 - pad).
    static let soloIcon = CGSize(width: 12, height: 11)
    static let soloTeamRowY: CGFloat = -32.5
    static let soloOppRowY: CGFloat = -15
    static let soloOpp2RowY: CGFloat = 2.5

    override init() {
        super.init()
        role = "history"
        hideFromAccessibility()
    }

    required init?(coder aDecoder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// `spacing`: the layout's icon step (nil keeps the current one); existing icons move to it.
    /// `totals`: the bid totals the border and slots show (nil: none); `opp2Total` the second
    /// opponent's at three seats.
    /// `myTeam`: the viewer's team, or seat colour at three seats (nil keeps the current one);
    /// existing icons recolor.
    /// `opp2`: the second opponent's won tricks at three seats (nil keeps the current count).
    /// `solo`: the two opponents' seat colours at a three-seat table, `.some(nil)` the two team
    /// rows (`.none` keeps the current mode).
    func setCounts(team: Int, opp: Int, opp2: Int? = nil, spacing: CGFloat? = nil, totals: (team: Int, opp: Int)?? = .none,
                   opp2Total: Int? = nil, myTeam: Int? = nil, solo: Solo?? = .none) {
        if let spacing { stackSpacing = spacing }
        if case .some(let m) = solo { self.solo = m }
        if case .some(let t) = totals { self.totals = t.map { (team: $0.team, opp: $0.opp, opp2: opp2Total ?? 0) } }
        // 3: a Get Your Bid seat's colour (gold)
        if let myTeam { self.myTeam = (1...3).contains(myTeam) ? myTeam : 1 }
        let opp2Count = self.solo == nil ? 0 : (opp2 ?? counts.opp2)
        if let m = self.solo {
            let icon = Self.soloIcon
            sync(prefix: "history.team.", count: team, y: Self.soloTeamRowY, color: Theme.SK.team(self.myTeam), icon: icon)
            sync(prefix: "history.opp.", count: opp, y: Self.soloOppRowY, color: Theme.SK.team(m.opp), icon: icon)
            sync(prefix: "history.opp2.", count: opp2Count, y: Self.soloOpp2RowY, color: Theme.SK.team(m.opp2), icon: icon)
        } else {
            let icon = TableLayout.historyIcon
            sync(prefix: "history.team.", count: team, y: Self.teamRowY, color: Theme.SK.team(self.myTeam), icon: icon)
            sync(prefix: "history.opp.", count: opp, y: Self.oppRowY, color: Theme.SK.team(3 - min(2, self.myTeam)), icon: icon)
            sync(prefix: "history.opp2.", count: 0, y: Self.oppRowY, color: Theme.SK.team(1), icon: icon)
        }
        counts = (team, opp, opp2Count)
        syncPile(row: "team", count: team, total: self.totals?.team, y: rowY("team"))
        syncPile(row: "opp", count: opp, total: self.totals?.opp, y: rowY("opp"))
        syncPile(row: "opp2", count: opp2Count, total: self.solo == nil ? nil : self.totals?.opp2, y: rowY("opp2"))
        children.forEach { $0.hideFromAccessibility() }
    }

    /// A row's y (the three-seat rows at a Get Your Bid table).
    func rowY(_ row: String) -> CGFloat {
        switch (row, solo != nil) {
        case ("team", false): return Self.teamRowY
        case ("team", true): return Self.soloTeamRowY
        case ("opp2", _): return Self.soloOpp2RowY
        case (_, true): return Self.soloOppRowY
        default: return Self.oppRowY
        }
    }

    /// The border's state per row (tests): nil without totals (and for "opp2" at four seats).
    func border(_ row: String) -> BidTotals.PileBorder? {
        guard let t = totals else { return nil }
        switch row {
        case "team": return BidTotals.pileBorder(won: counts.team, total: t.team)
        case "opp2": return solo == nil ? nil : BidTotals.pileBorder(won: counts.opp2, total: t.opp2)
        default: return BidTotals.pileBorder(won: counts.opp, total: t.opp)
        }
    }

    private func sync(prefix: String, count: Int, y: CGFloat, color: PlatformColor, icon: CGSize) {
        let existing = children.filter { ($0.role?.hasPrefix(prefix) == true) && Int($0.role!.dropFirst(prefix.count)) != nil }
        for node in existing {
            guard let i = Int(node.role!.dropFirst(prefix.count)) else { continue }
            if i >= count { node.removeFromParent(); continue }
            node.position = CGPoint(x: CGFloat(i) * stackSpacing, y: y)
            (node as? SKSpriteNode)?.color = color
            (node as? SKSpriteNode)?.size = icon
        }
        for i in 0..<max(0, count) where !children.contains(where: { $0.role == "\(prefix)\(i)" }) {
            let sprite = SKSpriteNode(color: color, size: icon)
            sprite.role = "\(prefix)\(i)"
            sprite.position = CGPoint(x: CGFloat(i) * stackSpacing, y: y)
            sprite.zPosition = CGFloat(i) + 1
            addChild(sprite)
        }
    }

    /// The bid's empty slots and the row's border (redrawn: a few nodes per row).
    private func syncPile(row: String, count: Int, total: Int?, y: CGFloat) {
        children.filter { $0.role?.hasPrefix("history.\(row).slot.") == true || $0.role == "history.\(row).border" }
            .forEach { $0.removeFromParent() }
        guard let total else { return }
        let slots = min(SeatPips.maxSlots, max(1, total, count))
        let icon = solo == nil ? TableLayout.historyIcon : Self.soloIcon
        for i in stride(from: max(0, count), to: min(total, SeatPips.maxSlots), by: 1) {
            let slot = SKSpriteNode(color: Theme.SK.pileSlot, size: icon)
            slot.role = "history.\(row).slot.\(i)"
            slot.position = CGPoint(x: CGFloat(i) * stackSpacing, y: y)
            slot.zPosition = 0
            addChild(slot)
        }
        let pad = Self.borderPad
        let rect = CGRect(x: -icon.width / 2 - pad, y: y - icon.height / 2 - pad,
                          width: icon.width + CGFloat(slots - 1) * stackSpacing + 2 * pad, height: icon.height + 2 * pad)
        // the stroke inside the rect: the frame is exactly `rect`
        let border = SKShapeNode(rect: rect.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 3)
        border.role = "history.\(row).border"
        border.lineWidth = 1
        border.fillColor = .clear
        border.strokeColor = BidTotals.pileBorder(won: count, total: total) == .safe ? Theme.SK.pileSafe : Theme.SK.pileDanger
        border.zPosition = 30
        addChild(border)
    }

    func clearAll() { setCounts(team: 0, opp: 0, opp2: 0, totals: .some(nil)) }
}

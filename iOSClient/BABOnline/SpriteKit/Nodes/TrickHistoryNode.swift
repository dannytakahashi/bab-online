import SpriteKit

/// Stacked won tricks for each team, set from the trick counts (idempotent):
/// `history.team.<i>` (my team's, team A's color) and `history.opp.<i>` (theirs, team B),
/// `spacing` apart (from the layout).
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
    private(set) var counts = (team: 0, opp: 0)
    /// (my team's, theirs) bid totals; nil while bidding / between hands.
    private(set) var totals: (team: Int, opp: Int)?

    static let borderPad: CGFloat = 2

    override init() {
        super.init()
        role = "history"
        hideFromAccessibility()
    }

    required init?(coder aDecoder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// `spacing`: the layout's icon step (nil keeps the current one); existing icons move to it.
    /// `totals`: the bid totals the border and slots show (nil: none).
    func setCounts(team: Int, opp: Int, spacing: CGFloat? = nil, totals: (team: Int, opp: Int)?? = .none) {
        if let spacing { stackSpacing = spacing }
        if case .some(let t) = totals { self.totals = t }
        sync(prefix: "history.team.", count: team, y: 0, color: Theme.SK.teamA)
        sync(prefix: "history.opp.", count: opp, y: -30, color: Theme.SK.teamB)
        counts = (team, opp)
        syncPile(row: "team", count: team, total: self.totals?.team, y: 0)
        syncPile(row: "opp", count: opp, total: self.totals?.opp, y: -30)
        children.forEach { $0.hideFromAccessibility() }
    }

    /// The border's state per row (tests): nil without totals.
    func border(_ row: String) -> BidTotals.PileBorder? {
        guard let t = totals else { return nil }
        let (won, total) = row == "team" ? (counts.team, t.team) : (counts.opp, t.opp)
        return BidTotals.pileBorder(won: won, total: total)
    }

    private func sync(prefix: String, count: Int, y: CGFloat, color: UIColor) {
        let existing = children.filter { ($0.role?.hasPrefix(prefix) == true) && Int($0.role!.dropFirst(prefix.count)) != nil }
        for node in existing {
            guard let i = Int(node.role!.dropFirst(prefix.count)) else { continue }
            if i >= count { node.removeFromParent() } else { node.position = CGPoint(x: CGFloat(i) * stackSpacing, y: y) }
        }
        for i in 0..<max(0, count) where !children.contains(where: { $0.role == "\(prefix)\(i)" }) {
            let icon = SKSpriteNode(color: color, size: TableLayout.historyIcon)
            icon.role = "\(prefix)\(i)"
            icon.position = CGPoint(x: CGFloat(i) * stackSpacing, y: y)
            icon.zPosition = CGFloat(i) + 1
            addChild(icon)
        }
    }

    /// The bid's empty slots and the row's border (redrawn: a few nodes per row).
    private func syncPile(row: String, count: Int, total: Int?, y: CGFloat) {
        children.filter { $0.role?.hasPrefix("history.\(row).slot.") == true || $0.role == "history.\(row).border" }
            .forEach { $0.removeFromParent() }
        guard let total else { return }
        let slots = min(SeatPips.maxSlots, max(1, total, count))
        let icon = TableLayout.historyIcon
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

    func clearAll() { setCounts(team: 0, opp: 0, totals: .some(nil)) }
}

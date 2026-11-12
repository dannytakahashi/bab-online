import SpriteKit

/// Stacked won tricks for each team, set from the trick counts (idempotent):
/// `history.team.<i>` (team 1, team A's color) and `history.opp.<i>` (team 2, team B),
/// `spacing` apart (from the layout).
class TrickHistoryNode: SKNode {
    private(set) var stackSpacing: CGFloat = 14
    private(set) var counts = (team: 0, opp: 0)

    override init() {
        super.init()
        name = "history"
    }

    required init?(coder aDecoder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// `spacing`: the layout's icon step (nil keeps the current one); existing icons move to it.
    func setCounts(team: Int, opp: Int, spacing: CGFloat? = nil) {
        if let spacing { stackSpacing = spacing }
        sync(prefix: "history.team.", count: team, y: 0, color: Theme.SK.teamA)
        sync(prefix: "history.opp.", count: opp, y: -30, color: Theme.SK.teamB)
        counts = (team, opp)
    }

    private func sync(prefix: String, count: Int, y: CGFloat, color: UIColor) {
        let existing = children.filter { $0.name?.hasPrefix(prefix) == true }
        for node in existing {
            guard let i = Int(node.name!.dropFirst(prefix.count)) else { continue }
            if i >= count { node.removeFromParent() } else { node.position = CGPoint(x: CGFloat(i) * stackSpacing, y: y) }
        }
        for i in 0..<max(0, count) where childNode(withName: "\(prefix)\(i)") == nil {
            let icon = SKSpriteNode(color: color, size: CGSize(width: 12, height: 16))
            icon.name = "\(prefix)\(i)"
            icon.position = CGPoint(x: CGFloat(i) * stackSpacing, y: y)
            icon.zPosition = CGFloat(i)
            addChild(icon)
        }
    }

    func clearAll() { setCounts(team: 0, opp: 0) }
}

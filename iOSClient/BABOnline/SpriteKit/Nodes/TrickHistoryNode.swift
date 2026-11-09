import SpriteKit

/// Stacked won tricks for each team, set from the trick counts (idempotent):
/// `history.team.<i>` and `history.opp.<i>`.
class TrickHistoryNode: SKNode {
    private let stackSpacing: CGFloat = 14
    private(set) var counts = (team: 0, opp: 0)

    override init() {
        super.init()
        name = "history"
    }

    required init?(coder aDecoder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func setCounts(team: Int, opp: Int) {
        sync(prefix: "history.team.", count: team, y: 0, color: UIColor(red: 0.2, green: 0.8, blue: 0.4, alpha: 1))
        sync(prefix: "history.opp.", count: opp, y: -30, color: UIColor(red: 0.9, green: 0.3, blue: 0.3, alpha: 1))
        counts = (team, opp)
    }

    private func sync(prefix: String, count: Int, y: CGFloat, color: UIColor) {
        let existing = children.filter { $0.name?.hasPrefix(prefix) == true }
        for node in existing {
            if let i = Int(node.name!.dropFirst(prefix.count)), i >= count { node.removeFromParent() }
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

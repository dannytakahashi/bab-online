import SpriteKit

/// Displays stacked won tricks for each team.
class TrickHistoryNode: SKNode {
    private var teamStacks: [SKSpriteNode] = []
    private var oppStacks: [SKSpriteNode] = []

    private let stackSpacing: CGFloat = 14

    func addTeamTrick() {
        let icon = makeStackIcon(color: UIColor(red: 0.2, green: 0.8, blue: 0.4, alpha: 1))
        icon.position = CGPoint(x: CGFloat(teamStacks.count) * stackSpacing, y: 0)
        icon.zPosition = CGFloat(teamStacks.count)
        addChild(icon)
        teamStacks.append(icon)
    }

    func addOppTrick() {
        let icon = makeStackIcon(color: UIColor(red: 0.9, green: 0.3, blue: 0.3, alpha: 1))
        icon.position = CGPoint(x: CGFloat(oppStacks.count) * stackSpacing, y: -30)
        icon.zPosition = CGFloat(oppStacks.count)
        addChild(icon)
        oppStacks.append(icon)
    }

    func clearAll() {
        teamStacks.forEach { $0.removeFromParent() }
        oppStacks.forEach { $0.removeFromParent() }
        teamStacks.removeAll()
        oppStacks.removeAll()
    }

    private func makeStackIcon(color: UIColor) -> SKSpriteNode {
        let size = CGSize(width: 12, height: 16)
        let node = SKSpriteNode(color: color, size: size)
        node.name = "trick_stack"
        return node
    }
}

import SpriteKit

/// The only place the scene moves nodes over time. Tests swap in
/// InstantAnimator (end state now, completion now), so a rendered tree can be
/// compared without a running SKView.
protocol Animator {
    func move(_ node: SKNode, to point: CGPoint, duration: TimeInterval, completion: (() -> Void)?)
    func collect(_ nodes: [SKNode], to point: CGPoint, completion: @escaping () -> Void)
    func pop(_ node: SKNode)
    func fadeAndRemove(_ node: SKNode, after delay: TimeInterval)
    func run(_ node: SKNode, _ action: SKAction, final: (SKNode) -> Void)
}

struct LiveAnimator: Animator {
    func move(_ node: SKNode, to point: CGPoint, duration: TimeInterval, completion: (() -> Void)?) {
        let move = SKAction.move(to: point, duration: duration)
        move.timingMode = .easeOut
        node.removeAction(forKey: "move")
        node.run(SKAction.sequence([move, SKAction.run { completion?() }]), withKey: "move")
    }

    func collect(_ nodes: [SKNode], to point: CGPoint, completion: @escaping () -> Void) {
        guard !nodes.isEmpty else { return completion() }
        // A counter, not a DispatchGroup: a scene reset stops these actions
        // (their closures are released and never run), and a group freed
        // with an unbalanced enter would trap
        var remaining = nodes.count
        for n in nodes {
            n.removeAllActions()
            n.run(CardAnimations.collectToWinner(x: point.x, y: point.y)) { [weak n] in
                n?.removeFromParent()
                remaining -= 1
                if remaining == 0 { DispatchQueue.main.async(execute: completion) }
            }
        }
    }

    func pop(_ node: SKNode) {
        node.alpha = 0
        node.setScale(0.6)
        node.run(SKAction.group([CardAnimations.fadeIn(duration: 0.2), SKAction.scale(to: 1, duration: 0.2)]), withKey: "pop")
    }

    func fadeAndRemove(_ node: SKNode, after delay: TimeInterval) {
        node.run(SKAction.sequence([SKAction.wait(forDuration: delay), SKAction.fadeOut(withDuration: 0.3), SKAction.removeFromParent()]))
    }

    func run(_ node: SKNode, _ action: SKAction, final: (SKNode) -> Void) {
        node.run(action)
    }
}

struct InstantAnimator: Animator {
    func move(_ node: SKNode, to point: CGPoint, duration: TimeInterval, completion: (() -> Void)?) {
        node.removeAction(forKey: "move")
        node.position = point
        completion?()
    }

    func collect(_ nodes: [SKNode], to point: CGPoint, completion: @escaping () -> Void) {
        nodes.forEach { $0.removeFromParent() }
        completion()
    }

    func pop(_ node: SKNode) {
        node.alpha = 1
        node.setScale(1)
    }

    func fadeAndRemove(_ node: SKNode, after delay: TimeInterval) {
        node.removeFromParent()
    }

    func run(_ node: SKNode, _ action: SKAction, final: (SKNode) -> Void) {
        final(node)
    }
}

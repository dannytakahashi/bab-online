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
    /// A relayout: re-aim a node's running "move" at `point` (or put it there).
    func retarget(_ node: SKNode, to point: CGPoint)
    /// Scale to `scale` (keyed "scale").
    func scale(_ node: SKNode, to scale: CGFloat, duration: TimeInterval)
    /// The deal (keyed `Deal.key`): `node`, already at rest where the render put it, waits
    /// `delay` hidden, then flies there from `from(node)` (asked when its flight starts, so a
    /// relayout meanwhile is honoured) in `duration`. Under Reduce Motion it fades in where it is.
    func deal(_ node: SKNode, delay: TimeInterval, duration: TimeInterval, from: @escaping (SKNode) -> Deal.Start?)
}

/// Instant defaults (InstantAnimator and the tests' animators).
extension Animator {
    /// Instant: the node is already where the deal ends.
    func deal(_ node: SKNode, delay: TimeInterval, duration: TimeInterval, from: @escaping (SKNode) -> Deal.Start?) {}

    func retarget(_ node: SKNode, to point: CGPoint) {
        node.removeAction(forKey: "move")
        node.position = point
    }

    func scale(_ node: SKNode, to scale: CGFloat, duration: TimeInterval) {
        node.removeAction(forKey: "scale")
        node.setScale(scale)
    }
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

    /// A move in flight is re-issued toward the new target (0.15 s, its
    /// completion is nil at every call site); a node at rest just moves.
    func retarget(_ node: SKNode, to point: CGPoint) {
        if node.action(forKey: "move") != nil {
            move(node, to: point, duration: 0.15, completion: nil)
        } else {
            node.position = point
        }
    }

    func scale(_ node: SKNode, to scale: CGFloat, duration: TimeInterval) {
        node.removeAction(forKey: "scale")
        node.run(SKAction.scale(to: scale, duration: duration), withKey: "scale")
    }

    func deal(_ node: SKNode, delay: TimeInterval, duration: TimeInterval, from: @escaping (SKNode) -> Deal.Start?) {
        node.finishDeal()
        if Theme.Motion.reduceMotion {
            // a dissolve in place of the flight (Apple HIG, Reduce Motion), all at once
            node.deal = Deal(node, flies: false)
            node.alpha = 0
            node.run(SKAction.sequence([SKAction.fadeIn(withDuration: Deal.fade), SKAction.run { [weak node] in node?.deal = nil }]),
                     withKey: Deal.key)
            return
        }
        let d = Deal(node, flies: true)
        node.deal = d
        node.isHidden = true
        let begin = SKAction.run { [weak node] in
            guard let node else { return }
            node.isHidden = false
            guard let s = from(node) else { return }
            d.start = s
            node.position = s.point
            node.setScale(s.scale)
            node.zRotation = s.rotation
        }
        let fly = SKAction.customAction(withDuration: duration) { node, elapsed in
            guard let s = d.start else { return }
            let e = Deal.ease(duration > 0 ? min(1, Double(elapsed) / duration) : 1)
            node.position = CGPoint(x: s.point.x + (d.target.x - s.point.x) * e, y: s.point.y + (d.target.y - s.point.y) * e)
            node.setScale(s.scale + (d.scale - s.scale) * e)
            node.zRotation = s.rotation + (d.rotation - s.rotation) * e
        }
        let land = SKAction.run { [weak node] in node?.finishDeal() }
        node.run(SKAction.sequence([SKAction.wait(forDuration: delay), begin, fly, land]), withKey: Deal.key)
    }
}

/// A node's deal in flight (`SKNode.deal`): where it lands (kept current by the renders and
/// relayouts that run meanwhile: `retarget`) and the scale and turn it lands at.
final class Deal: NSObject {
    /// Where a flight starts (the node's parent's coordinates) and its scale and turn there.
    struct Start: Equatable {
        var point: CGPoint
        var scale: CGFloat
        var rotation: CGFloat
    }

    static let key = "deal"
    /// The web's deal (CardManager.js): a 200 ms wait at the deck, then each card's
    /// `slow * 2` flight, `dealStagger` after the one before it (motion tokens).
    static let wait: TimeInterval = 0.2
    static var flight: TimeInterval { Theme.Motion.slow * 2 }
    static var stagger: TimeInterval { Theme.Motion.dealStagger }
    /// Reduce Motion's dissolve.
    static let fade: TimeInterval = Theme.Motion.base

    /// false: a Reduce Motion fade in place (nothing to aim).
    let flies: Bool
    private(set) var target: CGPoint
    let scale: CGFloat
    let rotation: CGFloat
    var start: Start?

    init(_ node: SKNode, flies: Bool) {
        self.flies = flies
        target = node.position
        scale = node.xScale
        rotation = node.zRotation
    }

    /// A render or relayout moved the node's resting place: a flight lands there; a node
    /// still waiting (hidden) or fading in place goes there now.
    func retarget(_ node: SKNode, to point: CGPoint) {
        target = point
        if !flies || start == nil { node.position = point }
    }

    /// The emphasized ease, cubic-bezier(.2, .8, .2, 1) (Theme.Motion.emphasized; the web's EASE_EMPHASIZED).
    static func ease(_ x: Double) -> CGFloat {
        CGFloat(CubicBezier.emphasized.y(atX: x))
    }
}

/// A CSS cubic-bezier(x1, y1, x2, y2) easing (the web's ui/motion.js cubicBezier).
struct CubicBezier {
    let x1, y1, x2, y2: Double

    static let emphasized: CubicBezier = {
        let p = Theme.Motion.emphasized
        return CubicBezier(x1: p[0], y1: p[1], x2: p[2], y2: p[3])
    }()

    private func sample(_ t: Double, _ a: Double, _ b: Double) -> Double {
        let u = 1 - t
        return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t
    }

    /// y at x in [0, 1]: x(t) = x solved by bisection (x(t) is monotonic for 0 <= x1, x2 <= 1).
    func y(atX x: Double) -> Double {
        if x <= 0 { return 0 }
        if x >= 1 { return 1 }
        var lo = 0.0, hi = 1.0, t = x
        for _ in 0..<40 {
            let v = sample(t, x1, x2)
            if abs(v - x) < 1e-7 { break }
            if v < x { lo = t } else { hi = t }
            t = (lo + hi) / 2
        }
        return sample(t, y1, y2)
    }
}

extension SKNode {
    /// The deal this node is in (nil once it landed): LiveAnimator.deal.
    var deal: Deal? {
        get { userData?[Deal.key] as? Deal }
        set {
            if let newValue {
                if userData == nil { userData = NSMutableDictionary() }
                userData?[Deal.key] = newValue
            } else {
                userData?.removeObject(forKey: Deal.key)
            }
        }
    }

    /// Lands a deal in flight at once (a tap, a card leaving the hand, a new deal): at its
    /// resting place, scale and turn, shown. A node that is not being dealt is left alone.
    func finishDeal() {
        guard let d = deal else { return }
        removeAction(forKey: Deal.key)
        deal = nil
        isHidden = false
        alpha = 1
        if d.flies {
            position = d.target
            setScale(d.scale)
            zRotation = d.rotation
        }
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

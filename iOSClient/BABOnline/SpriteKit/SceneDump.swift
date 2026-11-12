#if DEBUG
import SpriteKit

/// A comparable text form of the table's node tree (render and replay tests):
/// one line per node under the stable layers (transient excluded), siblings
/// sorted. Card sprites print their card and on-screen size, so a hand sprite
/// that moved into the trick reads like a freshly built trick card.
enum SceneDump {
    static let stableLayers = ["background", "opponents", "hand", "trick", "history", "bids"]

    static func dump(_ scene: SKScene) -> [String] {
        var out: [String] = []
        for name in stableLayers {
            // the layers have no name (SpriteKit reads a named node by its name): their role
            if let layer = scene.children.first(where: { ($0.name ?? $0.role) == name }) {
                walk(layer, path: name, inHand: name == "hand", into: &out)
            }
        }
        return out
    }

    private static func r(_ v: CGFloat) -> String {
        let x = (v * 2).rounded() / 2
        return x == x.rounded() ? String(Int(x)) : String(format: "%.1f", x)
    }

    private static func line(_ node: SKNode, path: String, inHand: Bool) -> String {
        var parts = [path]
        if let sprite = node as? SKSpriteNode, let card = (node as? CardSpriteNode)?.card ?? cardFromName(node.name) {
            parts.append("card=\(card.id) size=\(r(sprite.frame.width))x\(r(sprite.frame.height))")
            if inHand, let c = node as? CardSpriteNode { parts.append("legal=\(c.isLegal) lifted=\(c.isLifted)") }
        } else {
            parts.append(String(describing: type(of: node)))
            if let sprite = node as? SKSpriteNode { parts.append("size=\(r(sprite.frame.width))x\(r(sprite.frame.height))") }
        }
        parts.append("pos=(\(r(node.position.x)),\(r(node.position.y))) z=\(r(node.zPosition))")
        if !((node.name ?? node.role)?.hasPrefix("glow.") ?? false) { parts.append("a=\(r(node.alpha))") }  // glows pulse
        if node.isHidden { parts.append("hidden") }
        // a scaled container (the hand at s < 1); sprites already print their on-screen size
        if !(node is SKSpriteNode) && node.xScale != 1 { parts.append("scale=\(String(format: "%.2f", node.xScale))") }
        if let label = node as? SKLabelNode { parts.append("text=\(label.text ?? "")") }
        return parts.joined(separator: " ")
    }

    private static func cardFromName(_ name: String?) -> Card? {
        guard let name, name.hasPrefix("trick.") else { return nil }
        let id = name.split(separator: ".", maxSplits: 2).last.map(String.init) ?? ""
        let bits = id.split(separator: "_")
        guard bits.count == 2, let rank = Rank(rawValue: String(bits[0])), let suit = Suit(rawValue: String(bits[1])) else { return nil }
        return Card(suit: suit, rank: rank)
    }

    private static func walk(_ node: SKNode, path: String, inHand: Bool, into out: inout [String]) {
        out.append(line(node, path: path, inHand: inHand))
        let kids = node.children.map { child -> (String, SKNode) in
            let key = (child.name ?? child.role ?? "~") + "|" + String(describing: type(of: child)) + "|" + r(child.position.x) + "," + r(child.position.y)
            return (key, child)
        }.sorted { $0.0 < $1.0 }
        for (_, child) in kids {
            walk(child, path: path + "/" + (child.name ?? child.role ?? String(describing: type(of: child))), inHand: inHand, into: &out)
        }
    }
}
#endif

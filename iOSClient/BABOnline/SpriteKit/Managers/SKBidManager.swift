import SpriteKit

/// Bid bubbles from state (`bid.<pos>`): up from the bid until the hand's
/// first card; a new bid pops.
class SKBidManager {
    let layer: SKNode
    private(set) var bubbles: [Int: BidBubbleNode] = [:]

    init(layer: SKNode) { self.layer = layer }

    func apply(bubbles wanted: [Int: String], viewPosition: Int, layout: TableLayout) {
        for (pos, node) in bubbles where wanted[pos] == nil {
            node.removeFromParent()
            bubbles[pos] = nil
        }
        for (pos, bid) in wanted {
            let node: BidBubbleNode
            if let existing = bubbles[pos], existing.bid == bid {
                node = existing
            } else {
                bubbles[pos]?.removeFromParent()
                node = BidBubbleNode(bid: bid)
                node.zPosition = 60
                layer.addChild(node)
                bubbles[pos] = node
            }
            node.name = "bid.\(pos)"
            // a pop animates only alpha and scale, so the position is set (unless a fold glide moves it)
            if node.action(forKey: "move") == nil {
                node.position = layout.bubbleAnchor(Positions.getRelative(target: pos, from: viewPosition))
            }
        }
    }

    /// Relayout: every bubble to its seat's new anchor; a pop keeps going.
    func apply(layout: TableLayout, viewPosition: Int, animator: Animator, animated: Bool) {
        for (pos, node) in bubbles {
            let target = layout.bubbleAnchor(Positions.getRelative(target: pos, from: viewPosition))
            if animated {
                animator.move(node, to: target, duration: LayoutConstants.playCardDuration, completion: nil)
            } else {
                node.removeAction(forKey: "move")
                node.position = target
            }
        }
    }

    func pop(position: Int, animator: Animator) {
        guard let node = bubbles[position] else { return }
        animator.pop(node)
    }

    func cleanup() {
        bubbles.values.forEach { $0.removeFromParent() }
        bubbles.removeAll()
    }
}

/// Chat bubbles by the speaker's seat (22.6): transient, one per seat,
/// replaced by a newer message, gone after LayoutConstants.bubbleLifetime.
/// Up to two lines within the layout's chatMaxWidth, placed by
/// TableLayout.chatPosition (above the seat, else below it).
class SKChatBubbleManager {
    let layer: SKNode
    private(set) var bubbles: [Int: (node: SKNode, rel: Positions.RelativePosition, size: CGSize)] = [:]

    init(layer: SKNode) { self.layer = layer }

    /// The spectator bubble ("Name: text" by the badge): one at a time, as a seat's.
    private(set) var spectatorBubble: (node: SKNode, size: CGSize, spectating: Bool)?

    func show(position: Int, message: String, viewPosition: Int, layout: TableLayout, animator: Animator) {
        bubbles[position]?.node.removeFromParent()
        let (bubble, size) = Self.makeBubble(message, maxWidth: layout.chatMaxWidth, name: "chat.\(position)",
                                             fill: Theme.SK.chatFill, text: Theme.SK.chatText)
        let rel = Positions.getRelative(target: position, from: viewPosition)
        bubble.position = layout.chatPosition(rel, bubbleSize: size)
        layer.addChild(bubble)
        bubbles[position] = (bubble, rel, size)
        animator.fadeAndRemove(bubble, after: LayoutConstants.bubbleLifetime)
    }

    /// A spectator's line by the spectator badge (V1_REMOVALS "iOS spectator badge" 7): tinted
    /// like the log's spectator lines, the seats' two lines and lifetime, the newest replaces it.
    func showSpectator(username: String, message: String, spectating: Bool, layout: TableLayout, animator: Animator) {
        spectatorBubble?.node.removeFromParent()
        let prefix = username.isEmpty ? "" : "\(username): "
        // narrower than a seat's (it wraps sooner), so it fits beside the trick cards by the badge
        let (bubble, size) = Self.makeBubble(prefix + message, maxWidth: min(layout.chatMaxWidth, Self.spectatorMaxWidth), name: "chat.spectator",
                                             fill: Self.spectatorFill, text: Theme.SK.spectatorChatText, limit: prefix.count + 40)
        bubble.position = layout.spectatorBubbleCenter(badge: layout.spectatorBadge(spectating: spectating), bubbleSize: size, spectating: spectating)
        layer.addChild(bubble)
        spectatorBubble = (bubble, size, spectating)
        animator.fadeAndRemove(bubble, after: LayoutConstants.bubbleLifetime)
    }

    static let spectatorMaxWidth: CGFloat = 200

    /// The spectator tint (the lit felt), dark enough for text.primary 13 pt text (a tokens.json AA pair).
    static let spectatorFill = Theme.SK.spectatorChatFill

    /// SKLabelNode wraps past `numberOfLines` (a long spectator line took three): drop words
    /// (or, for one long word, characters) from the end until the text fits two lines, ending in "…".
    static func fitTwoLines(_ label: SKLabelNode) {
        guard let text = label.text, !text.isEmpty else { return }
        let twoLines = twoLineHeight(text, like: label) + 0.5
        guard label.frame.height > twoLines else { return }
        var body = text.hasSuffix("\u{2026}") ? String(text.dropLast()) : text
        while !body.isEmpty {
            if let space = body.lastIndex(of: " "), body[..<space].trimmingCharacters(in: .whitespaces).count > 0 {
                body = String(body[..<space])
            } else {
                body.removeLast()
            }
            label.text = body.trimmingCharacters(in: .whitespaces) + "\u{2026}"
            if label.frame.height <= twoLines { return }
        }
    }

    /// The tallest two lines `text` can wrap to in `label`'s font: two unwrapped lines that each hold
    /// every glyph of it (and "Ag"). A line with an emoji is taller than a text line (13 pt: two text
    /// lines 32 pt, two emoji lines 45 pt), so a fixed "Ag\nAg" probe took an emoji message on two lines
    /// for three and cut it to one; any three lines are still taller (three text lines 47 pt, with an
    /// emoji 53 pt).
    static func twoLineHeight(_ text: String, like label: SKLabelNode) -> CGFloat {
        let line = "Ag" + text.replacingOccurrences(of: "\n", with: " ")
        let probe = SKLabelNode(text: line + "\n" + line)
        probe.fontName = label.fontName
        probe.fontSize = label.fontSize
        probe.numberOfLines = 0
        probe.preferredMaxLayoutWidth = 0  // no wrapping: exactly two lines
        // in `label`'s units: a label drawn for the table's zoom is scaled back (drawForTableZoom)
        return probe.frame.height * label.yScale
    }

    /// One bubble node: the text (at most `limit` characters, two lines) on a rounded background.
    static func makeBubble(_ message: String, maxWidth: CGFloat, name: String, fill: UIColor, text: UIColor, limit: Int = 40) -> (SKNode, CGSize) {
        let label = SKLabelNode(text: message.count > limit ? String(message.prefix(limit - 1)) + "\u{2026}" : message)
        label.fontName = Theme.SK.fontName(.regular)
        label.fontSize = 13
        label.fontColor = text
        label.numberOfLines = 2
        label.lineBreakMode = .byWordWrapping
        label.preferredMaxLayoutWidth = maxWidth - 16
        label.drawForTableZoom()
        label.verticalAlignmentMode = .center
        label.horizontalAlignmentMode = .center
        Self.fitTwoLines(label)
        let size = CGSize(width: max(40, label.frame.width + 16), height: label.frame.height + 10)
        let bg = SKShapeNode(rectOf: size, cornerRadius: Theme.Radius.md)
        bg.fillColor = fill
        bg.strokeColor = .clear
        // the label's block may sit off the node's origin: center it in the background
        label.position = CGPoint(x: -label.frame.midX, y: -label.frame.midY)
        let bubble = SKNode()
        bubble.name = name
        bubble.speak(message)  // the whole line, not "chat.2" (SpriteKit reads a named node by its name)
        label.hideFromAccessibility()
        bubble.addChild(bg)
        bubble.addChild(label)
        bubble.zPosition = 80
        return (bubble, size)
    }

    #if DEBUG
    /// Fixture screenshots (`-uiChat`): the live bubbles stay up.
    func freeze() {
        for n in bubbles.values.map(\.node) + [spectatorBubble?.node].compactMap({ $0 }) {
            n.removeAllActions()
            n.alpha = 1
        }
    }
    #endif

    /// Relayout: live bubbles to their new place; gone ones are forgotten.
    func apply(layout: TableLayout) {
        for (pos, b) in bubbles {
            guard b.node.parent != nil else { bubbles[pos] = nil; continue }
            b.node.position = layout.chatPosition(b.rel, bubbleSize: b.size)
        }
        if let b = spectatorBubble {
            if b.node.parent == nil {
                spectatorBubble = nil
            } else {
                b.node.position = layout.spectatorBubbleCenter(badge: layout.spectatorBadge(spectating: b.spectating), bubbleSize: b.size, spectating: b.spectating)
            }
        }
    }
}

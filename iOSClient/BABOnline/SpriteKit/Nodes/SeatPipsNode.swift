import SpriteKit

/// A seat's trick pips (SeatPips), drawn idempotently: `.ring` on a seat's
/// avatar ring (TableLayout.seatPipDots, a horseshoe open at the bottom over the
/// name), `.box` for my own seat (a pill of one row, or two balanced rows,
/// TableLayout.myPipDots). An empty slot is a hollow dot, a won one the seat's
/// team color, one past the bid gold; a bore seat gets the bore chip's red
/// outline (the horseshoe's arc, or the box's edge). Children (by `role`, see
/// SKNode.role): `pip.<i>` with userData state "empty" / "won" / "over",
/// `pips.box` and `pips.bore`.
///
/// None of these nodes has a `name`: SpriteKit puts every named node (and every
/// label's text) in the accessibility tree under that name, so "pip.3" or
/// "pips.box" reached VoiceOver and UI tests; GameContainerView's pips elements
/// speak the counts instead ("kim: 2 of 3 tricks").
final class SeatPipsNode: SKNode {
    enum Style { case ring, box }
    let style: Style
    private(set) var pips: SeatPips?
    private var team = 1

    init(style: Style) {
        self.style = style
        super.init()
        role = style == .box ? "pips.mine" : "pips"
        zPosition = 2
        hideFromAccessibility()
    }

    required init?(coder aDecoder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// What the pips show now, for the tests: (slots, filled, over, bore).
    var shown: (slots: Int, filled: Int, over: Int, bore: Bool) {
        let dots = children.filter { $0.role?.hasPrefix("pip.") == true }
        let state = { (n: SKNode, s: String) in (n.userData?["state"] as? String) == s }
        return (dots.count, dots.filter { state($0, "won") }.count, dots.filter { state($0, "over") }.count,
                children.contains { $0.role == "pips.bore" })
    }

    func update(_ p: SeatPips?, team: Int) {
        guard p != pips || team != self.team else { return }
        pips = p
        self.team = team
        removeAllChildren()
        guard let p, p.slots > 0 else { return }
        let dots = style == .ring ? TableLayout.seatPipDots(p.slots) : TableLayout.myPipDots(p.slots)
        if style == .box {
            let pill = TableLayout.myPipsPill(p.slots)
            let box = SKShapeNode(rectOf: pill, cornerRadius: pill.height / 2)
            box.role = p.isBore ? "pips.bore" : "pips.box"
            box.fillColor = Theme.SK.pipBox
            box.strokeColor = p.isBore ? Theme.SK.pipBore : .clear
            box.lineWidth = p.isBore ? 1 : 0
            box.zPosition = 0
            addChild(box)
        } else if p.isBore {
            // the horseshoe the dots sit on, open at the bottom over the name
            let ring = SKShapeNode(path: Self.boreArc())
            ring.role = "pips.bore"
            ring.fillColor = .clear
            ring.strokeColor = Theme.SK.pipBore
            ring.lineWidth = TableLayout.seatBoreLine
            ring.lineCap = .round
            ring.zPosition = 0
            addChild(ring)
        }
        let r = TableLayout.pipDot / 2
        for (i, c) in dots.enumerated() {
            let dot = SKShapeNode(circleOfRadius: r - 0.5)
            dot.position = c
            dot.lineWidth = 1
            let state: String
            // the web's is-won / is-over: won within the bid, won past it
            if i < p.won && i < p.need { state = "won" } else if i < p.won { state = "over" } else { state = "empty" }
            switch state {
            case "won":
                dot.fillColor = Theme.SK.team(team)
                dot.strokeColor = Theme.SK.team(team)
            case "over":
                dot.fillColor = Theme.SK.pipOver
                dot.strokeColor = Theme.SK.pipOver
            default:
                dot.fillColor = Theme.SK.pipBox
                dot.strokeColor = Theme.SK.pipEmpty
            }
            dot.userData = ["state": state]
            dot.role = "pip.\(i)"
            dot.zPosition = 1
            addChild(dot)
        }
        children.forEach { $0.hideFromAccessibility() }
    }

    /// The bore outline: an arc over the top between the horseshoe's ends (TableLayout.seatArcHalfSpan).
    static func boreArc() -> CGPath {
        let path = CGMutablePath()
        let half = TableLayout.seatArcHalfSpan
        // angles from +x, counterclockwise: the top is pi / 2
        path.addArc(center: .zero, radius: TableLayout.seatBoreRadius, startAngle: .pi / 2 + half, endAngle: .pi / 2 - half, clockwise: true)
        return path
    }
}

extension SKNode {
    /// A drawing node's part ("pip.3", "pips.bore", "history.team.slot.2") in its userData, where
    /// `name` would put it in the accessibility tree (SpriteKit lists named nodes by name).
    var role: String? {
        get { userData?["role"] as? String }
        set {
            if userData == nil { userData = [:] }
            userData?["role"] = newValue
        }
    }

    /// Not an accessibility element (also no `name`: see `role`).
    func hideFromAccessibility() {
        isAccessibilityElement = false
        accessibilityElementsHidden = true
    }

    /// An accessibility element reading `label` (a card, a seat's name, a chat line, a bid). A named
    /// node may keep its `name` for lookups only with a label: SpriteKit reads a node without one by
    /// its name ("hand.card.Q_clubs", "seat.left"). Containers and drawing nodes take a `role` instead.
    func speak(_ label: String, traits: UIAccessibilityTraits = .none) {
        isAccessibilityElement = true
        accessibilityLabel = label
        accessibilityTraits = traits
    }
}

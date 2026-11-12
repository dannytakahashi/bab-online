import SpriteKit

/// A seat's trick pips (SeatPips), drawn idempotently: `.ring` on a seat's
/// avatar ring (TableLayout.seatPipDots), `.box` for my own seat (a pill of
/// up to two rows, TableLayout.myPipDots). An empty slot is a hollow dot, a
/// won one the seat's team color, one past the bid gold; a bore seat gets the
/// bore chip's red outline (the ring's circle, or the box's edge). Children:
/// `pip.<i>` with userData state "empty" / "won" / "over", and `pips.bore`.
final class SeatPipsNode: SKNode {
    enum Style { case ring, box }
    let style: Style
    private(set) var pips: SeatPips?
    private var team = 1

    init(style: Style) {
        self.style = style
        super.init()
        name = "pips"
        zPosition = 2
    }

    required init?(coder aDecoder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// What the pips show now, for the tests: (slots, filled, over, bore).
    var shown: (slots: Int, filled: Int, over: Int, bore: Bool) {
        let dots = children.filter { $0.name?.hasPrefix("pip.") == true }
        let state = { (n: SKNode, s: String) in (n.userData?["state"] as? String) == s }
        return (dots.count, dots.filter { state($0, "won") }.count, dots.filter { state($0, "over") }.count,
                childNode(withName: "pips.bore") != nil)
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
            box.name = "pips.box"
            box.fillColor = Theme.SK.pipBox
            box.strokeColor = p.isBore ? Theme.SK.pipBore : .clear
            box.lineWidth = p.isBore ? 1 : 0
            box.zPosition = 0
            addChild(box)
            if p.isBore { box.name = "pips.bore" }
        } else if p.isBore {
            let ring = SKShapeNode(circleOfRadius: TableLayout.seatPipRadius + TableLayout.pipDot / 2 + 1.5)
            ring.name = "pips.bore"
            ring.fillColor = .clear
            ring.strokeColor = Theme.SK.pipBore
            ring.lineWidth = 1.5
            ring.zPosition = 0
            addChild(ring)
        }
        let r = TableLayout.pipDot / 2
        for (i, c) in dots.enumerated() {
            let dot = SKShapeNode(circleOfRadius: r - 0.5)
            dot.name = "pip.\(i)"
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
            dot.zPosition = 1
            addChild(dot)
        }
    }
}

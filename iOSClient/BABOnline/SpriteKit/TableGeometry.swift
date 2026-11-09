import CoreGraphics

/// Every table position, from the scene size (center origin). The numbers
/// are the ones the managers used before (SKOpponentManager, SKCardManager,
/// TrickAreaNode, SKBidManager), now in one place.
struct TableGeometry: Equatable {
    let size: CGSize

    init(size: CGSize) { self.size = size }

    private var halfW: CGFloat { size.width / 2 }
    private var halfH: CGFloat { size.height / 2 }
    private var scaleX: CGFloat { size.width / LayoutConstants.referenceWidth }
    private var scaleY: CGFloat { size.height / LayoutConstants.referenceHeight }

    /// Name / avatar anchor of a seat.
    func seatAnchor(_ rel: Positions.RelativePosition) -> CGPoint {
        switch rel {
        case .bottom: return CGPoint(x: 0, y: -halfH + 140)
        case .top: return CGPoint(x: 0, y: halfH - 220)
        case .left: return CGPoint(x: -halfW + 60, y: 0)
        case .right: return CGPoint(x: halfW - 60, y: 0)
        }
    }

    /// Resting place of a seat's card in the trick.
    func trickSlot(_ rel: Positions.RelativePosition) -> CGPoint {
        let ox = LayoutConstants.trickOffsetX * scaleX
        let oy = LayoutConstants.trickOffsetY * scaleY
        switch rel {
        case .bottom: return CGPoint(x: 0, y: -oy)
        case .top: return CGPoint(x: 0, y: oy)
        case .left: return CGPoint(x: -ox, y: 0)
        case .right: return CGPoint(x: ox, y: 0)
        }
    }

    /// Where a played card flies in from: off-screen toward the seat (3x the
    /// slot for the bottom seat when there is no hand sprite to start from).
    func trickEntry(_ rel: Positions.RelativePosition) -> CGPoint {
        switch rel {
        case .top: return CGPoint(x: 0, y: halfH + 100 * scaleY)
        case .left: return CGPoint(x: -halfW - 100 * scaleX, y: 0)
        case .right: return CGPoint(x: halfW + 100 * scaleX, y: 0)
        case .bottom:
            let slot = trickSlot(.bottom)
            return CGPoint(x: slot.x * 3, y: slot.y * 3)
        }
    }

    /// Where a collected trick goes (toward the winner).
    func collectPoint(_ rel: Positions.RelativePosition) -> CGPoint {
        switch rel {
        case .bottom: return CGPoint(x: 0, y: -200 * scaleY)
        case .top: return CGPoint(x: 0, y: 200 * scaleY)
        case .left: return CGPoint(x: -200 * scaleX, y: 0)
        case .right: return CGPoint(x: 200 * scaleX, y: 0)
        }
    }

    /// The hand's center line (raised above the bottom edge for the bid overlay).
    var handBaseline: CGPoint { CGPoint(x: 0, y: -halfH + LayoutConstants.cardHeight / 2 + 60) }

    /// Card centers in the hand, left to right (relative to handBaseline).
    func handSlots(count: Int) -> [CGPoint] {
        guard count > 0 else { return [] }
        let overlap = size.width < LayoutConstants.compactWidthThreshold ? LayoutConstants.cardOverlapCompact : LayoutConstants.cardOverlap
        let total = LayoutConstants.cardWidth + overlap * CGFloat(count - 1)
        let startX = -total / 2 + LayoutConstants.cardWidth / 2
        return (0..<count).map { CGPoint(x: startX + CGFloat($0) * overlap, y: 0) }
    }

    var historyOrigin: CGPoint { CGPoint(x: -halfW + 20, y: -halfH + 100) }

    /// Bid bubble anchor of a seat. Bubbles stay up for the whole bidding, so
    /// they sit clear of the seat's avatar, turn glow and name label (the name
    /// is 36 below the avatar's center): beside the top seat, below the side
    /// seats' names; mine beside my trick slot.
    func bubbleAnchor(_ rel: Positions.RelativePosition) -> CGPoint {
        let seat = seatAnchor(rel)
        switch rel {
        case .bottom: return CGPoint(x: 80, y: -halfH + 280)
        case .top: return CGPoint(x: seat.x + 75, y: seat.y)
        case .left, .right: return CGPoint(x: seat.x, y: seat.y - 66)
        }
    }

    /// Chat bubbles sit above the seat's name.
    func chatAnchor(_ rel: Positions.RelativePosition) -> CGPoint {
        let a = seatAnchor(rel)
        return CGPoint(x: a.x, y: a.y + 48)
    }
}

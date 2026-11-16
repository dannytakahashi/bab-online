import SpriteKit

/// Tap a seat's avatar to open that player's profile (iOS 1.2.2; the web's avatar plate click,
/// OpponentManager.js). The seats take no touches of their own (only the hand's cards do), so a
/// touch on one reaches the scene: one that ends on a seat's avatar or name sends that seat's
/// current name, a bot's included as on the web, to `SeatTaps`, and the table's profile host
/// (GameContainerView `playerProfileHost(seatTaps:)`) opens the sheet. Nothing else in the
/// scene changes: no node is added and none becomes interactive.
extension GameSKScene {
    /// The tap target around a seat's anchor, in the seat's own coordinates (the avatar is a
    /// 20 pt circle at the origin, the name sits under it): at least 44 pt each way.
    static let seatTapRect = CGRect(x: -40, y: -44, width: 80, height: 70)

    /// The name at the seat a scene point falls on; nil off every seat or with no table shown.
    func seatName(at point: CGPoint) -> String? {
        guard lastModel?.showsTable == true, let manager = opponentManager, !manager.layer.isHidden else { return nil }
        for node in manager.nodes.values where node.parent != nil && !node.isHidden {
            if Self.seatTapRect.contains(convert(point, to: node)), !node.fullName.isEmpty { return node.fullName }
        }
        return nil
    }

    open override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        guard touches.count == 1, let touch = touches.first, touch.tapCount == 1,
              let name = seatName(at: touch.location(in: self)) else { return }
        SeatTaps.subject.send(name)
    }
}

import SpriteKit

/// Tap a seat's avatar to open that player's profile (iOS 1.2.2; the web's avatar plate click,
/// OpponentManager.js). The seats take no touches of their own, so a touch on one reaches the
/// scene: one that goes down and ends on the same seat's avatar or name sends that seat's
/// current name, a bot's included as on the web, to `SeatTaps`, and the table's profile host
/// (GameContainerView `playerProfileHost(seatTaps:)`) opens the sheet. Nothing else in the
/// scene changes: no node is added and none becomes interactive.
///
/// A hand card takes its own `touchesBegan` (CardSpriteNode) but not the touch's end, which
/// UIKit forwards to the scene. Such a touch never began on the scene, so it is no seat tap;
/// neither is one that ends over a touchable card.
extension GameSKScene {
    /// The tap target around a seat's anchor, in the seat's own coordinates (the avatar is a
    /// 20 pt circle at the origin, the name sits under it): at least 44 pt each way.
    static let seatTapRect = CGRect(x: -40, y: -44, width: 80, height: 70)

    /// The touch that went down on the scene itself and where (main thread; one table at a time).
    private static var seatTouchDown: (touch: ObjectIdentifier, point: CGPoint)?

    /// The name at the seat a scene point falls on; nil off every seat or with no table shown.
    func seatName(at point: CGPoint) -> String? { seat(at: point)?.name }

    /// The seat (position and name) a scene point falls on.
    func seat(at point: CGPoint) -> (position: Int, name: String)? {
        guard lastModel?.showsTable == true, let manager = opponentManager, !manager.layer.isHidden else { return nil }
        for (pos, node) in manager.nodes where node.parent != nil && !node.isHidden {
            if Self.seatTapRect.contains(convert(point, to: node)), !node.fullName.isEmpty { return (pos, node.fullName) }
        }
        return nil
    }

    /// A tapped seat: a pure spectator watches it over the shoulder where that is allowed
    /// (State/Table/Shoulder.swift `ShoulderRules.tap`), else its player's profile opens (the
    /// watched seat itself, a tournament table, a seat owner, the own-seat rule's other seats).
    func seatTapped(position: Int, name: String) {
        if let gs = gameState, ShoulderRules.tap(gs.state, position: position) == .watch {
            gs.apply(.local(.watchSeat(position)))
            HapticManager.selection()
            return
        }
        SeatTaps.subject.send(name)
    }

    /// The seat a touch taps: `began` is where it went down on the scene (nil when a node took
    /// the touch's beginning, i.e. a hand card), `ended` where it lifted. Both on the same seat,
    /// and no touchable card under the end point.
    func seatTapName(began: CGPoint?, ended: CGPoint) -> String? {
        guard let began, let name = seatName(at: ended), seatName(at: began) == name else { return nil }
        if nodes(at: ended).contains(where: { ($0 as? CardSpriteNode)?.isUserInteractionEnabled == true }) { return nil }
        return name
    }

    open override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesBegan(touches, with: event)
        Self.seatTouchDown = touches.count == 1 ? touches.first.map { (ObjectIdentifier($0), $0.location(in: self)) } : nil
    }

    open override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesCancelled(touches, with: event)
        Self.seatTouchDown = nil
    }

    open override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        let down = Self.seatTouchDown
        Self.seatTouchDown = nil
        let end = touch(touches)?.location(in: self)
        guard touches.count == 1, let touch = touches.first, touch.tapCount == 1, let end,
              let name = seatTapName(began: down?.touch == ObjectIdentifier(touch) ? down?.point : nil, ended: end),
              let seat = seat(at: end), seat.name == name else { return }
        seatTapped(position: seat.position, name: name)
    }

    private func touch(_ touches: Set<UITouch>) -> UITouch? { touches.count == 1 ? touches.first : nil }
}

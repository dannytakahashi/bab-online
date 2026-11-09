import SpriteKit

/// Reusable SKAction sequences for card animations.
enum CardAnimations {
    /// Play card from hand to trick area
    static func playToTrickArea(x: CGFloat, y: CGFloat, duration: TimeInterval = LayoutConstants.playCardDuration) -> SKAction {
        let move = SKAction.move(to: CGPoint(x: x, y: y), duration: duration)
        move.timingMode = .easeOut
        let scale = SKAction.scale(to: 1.0, duration: duration)
        return SKAction.group([move, scale])
    }

    /// Collect trick cards to winner position
    static func collectToWinner(x: CGFloat, y: CGFloat, duration: TimeInterval = LayoutConstants.collectTrickDuration) -> SKAction {
        let move = SKAction.move(to: CGPoint(x: x, y: y), duration: duration)
        move.timingMode = .easeIn
        let fade = SKAction.fadeOut(withDuration: duration)
        let scale = SKAction.scale(to: 0.5, duration: duration)
        return SKAction.group([move, fade, scale])
    }

    /// Lift card slightly (selected state)
    static func lift(by amount: CGFloat = LayoutConstants.cardLiftY) -> SKAction {
        let move = SKAction.moveBy(x: 0, y: amount, duration: 0.15)
        move.timingMode = .easeOut
        return move
    }

    /// Lower card back (deselected state)
    static func lower(by amount: CGFloat = LayoutConstants.cardLiftY) -> SKAction {
        let move = SKAction.moveBy(x: 0, y: -amount, duration: 0.15)
        move.timingMode = .easeOut
        return move
    }

    /// Fade in
    static func fadeIn(duration: TimeInterval = 0.3) -> SKAction {
        SKAction.fadeIn(withDuration: duration)
    }

    /// Fade out
    static func fadeOut(duration: TimeInterval = 0.3) -> SKAction {
        SKAction.fadeOut(withDuration: duration)
    }

    /// Pulse glow effect (for turn indicator)
    static func pulseGlow() -> SKAction {
        let fadeUp = SKAction.fadeAlpha(to: 0.8, duration: 0.6)
        let fadeDown = SKAction.fadeAlpha(to: 0.3, duration: 0.6)
        return SKAction.repeatForever(SKAction.sequence([fadeUp, fadeDown]))
    }
}

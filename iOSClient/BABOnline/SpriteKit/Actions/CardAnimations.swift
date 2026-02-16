import SpriteKit

/// Reusable SKAction sequences for card animations.
enum CardAnimations {
    /// Deal card from off-screen to hand position
    static func dealToPosition(x: CGFloat, y: CGFloat, duration: TimeInterval = LayoutConstants.dealDuration) -> SKAction {
        let move = SKAction.move(to: CGPoint(x: x, y: y), duration: duration)
        move.timingMode = .easeOut
        return move
    }

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

    /// Card flip (scale X to 0, change texture, scale back)
    static func flip(to texture: SKTexture, duration: TimeInterval = LayoutConstants.flipCardDuration) -> SKAction {
        let halfDuration = duration / 2
        let scaleDown = SKAction.scaleX(to: 0, duration: halfDuration)
        scaleDown.timingMode = .easeIn
        let changeTexture = SKAction.setTexture(texture)
        let scaleUp = SKAction.scaleX(to: 1.0, duration: halfDuration)
        scaleUp.timingMode = .easeOut
        return SKAction.sequence([scaleDown, changeTexture, scaleUp])
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

    /// Whisk off screen (for draw phase cleanup)
    static func whiskOffScreen(to point: CGPoint, duration: TimeInterval = 0.8) -> SKAction {
        let move = SKAction.move(to: point, duration: duration)
        move.timingMode = .easeIn
        let scale = SKAction.scale(to: 0.3, duration: duration)
        return SKAction.group([move, scale])
    }

    /// Pulse glow effect (for turn indicator)
    static func pulseGlow() -> SKAction {
        let fadeUp = SKAction.fadeAlpha(to: 0.8, duration: 0.6)
        let fadeDown = SKAction.fadeAlpha(to: 0.3, duration: 0.6)
        return SKAction.repeatForever(SKAction.sequence([fadeUp, fadeDown]))
    }

    /// Rainbow shimmer effect
    static func rainbowShimmer() -> SKAction {
        let colors: [UIColor] = [.red, .orange, .yellow, .green, .cyan, .blue, .purple]
        var actions: [SKAction] = []
        for color in colors {
            actions.append(SKAction.colorize(with: color, colorBlendFactor: 0.5, duration: 0.15))
        }
        actions.append(SKAction.colorize(withColorBlendFactor: 0, duration: 0.2))
        return SKAction.sequence(actions)
    }
}

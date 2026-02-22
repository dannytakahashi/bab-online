import SpriteKit
import UIKit

/// Generates resolution-independent card textures at runtime using Core Graphics.
/// Caches textures to avoid redundant rendering.
enum CardTextureGenerator {
    private static var cache: [String: SKTexture] = [:]
    private static let cardPixelWidth: CGFloat = 300
    private static let cardPixelHeight: CGFloat = 435
    private static let cornerRadius: CGFloat = 24

    /// Returns a cached or freshly rendered texture for the given card.
    static func texture(for card: Card) -> SKTexture {
        let key = card.id
        if let cached = cache[key] { return cached }

        let tex: SKTexture
        if card.isJoker {
            tex = renderJoker(card: card)
        } else {
            tex = renderStandardCard(card: card)
        }
        tex.filteringMode = .linear
        cache[key] = tex
        return tex
    }

    /// Returns a cached or freshly rendered card-back texture.
    static func cardBackTexture() -> SKTexture {
        let key = "__card_back__"
        if let cached = cache[key] { return cached }

        let tex = renderCardBack()
        tex.filteringMode = .linear
        cache[key] = tex
        return tex
    }

    // MARK: - Standard Card

    private static func renderStandardCard(card: Card) -> SKTexture {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: cardPixelWidth, height: cardPixelHeight))
        let image = renderer.image { ctx in
            let rect = CGRect(x: 0, y: 0, width: cardPixelWidth, height: cardPixelHeight)
            let gc = ctx.cgContext

            // White background with rounded corners
            let path = UIBezierPath(roundedRect: rect, cornerRadius: cornerRadius)
            UIColor.white.setFill()
            path.fill()

            // Thin gray border
            UIColor(white: 0.7, alpha: 1).setStroke()
            path.lineWidth = 3
            path.stroke()

            // Suit color
            let color = suitColor(card.suit)

            // Rank text
            let rankStr = rankString(card.rank)
            let suitStr = suitSymbol(card.suit)

            // Top-left rank + suit
            let smallFont = UIFont.systemFont(ofSize: 40, weight: .bold)
            let smallAttrs: [NSAttributedString.Key: Any] = [
                .font: smallFont,
                .foregroundColor: color,
            ]

            let rankSize = (rankStr as NSString).size(withAttributes: smallAttrs)
            let topLeftX: CGFloat = 20
            let topLeftY: CGFloat = 16
            (rankStr as NSString).draw(at: CGPoint(x: topLeftX, y: topLeftY), withAttributes: smallAttrs)

            let suitSmallFont = UIFont.systemFont(ofSize: 32, weight: .regular)
            let suitSmallAttrs: [NSAttributedString.Key: Any] = [
                .font: suitSmallFont,
                .foregroundColor: color,
            ]
            (suitStr as NSString).draw(
                at: CGPoint(x: topLeftX + (rankSize.width - (suitStr as NSString).size(withAttributes: suitSmallAttrs).width) / 2,
                            y: topLeftY + rankSize.height - 2),
                withAttributes: suitSmallAttrs
            )

            // Bottom-right rank + suit (rotated 180)
            gc.saveGState()
            gc.translateBy(x: cardPixelWidth, y: cardPixelHeight)
            gc.rotate(by: .pi)
            (rankStr as NSString).draw(at: CGPoint(x: topLeftX, y: topLeftY), withAttributes: smallAttrs)
            (suitStr as NSString).draw(
                at: CGPoint(x: topLeftX + (rankSize.width - (suitStr as NSString).size(withAttributes: suitSmallAttrs).width) / 2,
                            y: topLeftY + rankSize.height - 2),
                withAttributes: suitSmallAttrs
            )
            gc.restoreGState()

            // Large center suit symbol
            let bigFont = UIFont.systemFont(ofSize: 100, weight: .regular)
            let bigAttrs: [NSAttributedString.Key: Any] = [
                .font: bigFont,
                .foregroundColor: color,
            ]
            let bigSize = (suitStr as NSString).size(withAttributes: bigAttrs)
            (suitStr as NSString).draw(
                at: CGPoint(x: (cardPixelWidth - bigSize.width) / 2,
                            y: (cardPixelHeight - bigSize.height) / 2),
                withAttributes: bigAttrs
            )
        }
        return SKTexture(image: image)
    }

    // MARK: - Joker

    private static func renderJoker(card: Card) -> SKTexture {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: cardPixelWidth, height: cardPixelHeight))
        let image = renderer.image { ctx in
            let rect = CGRect(x: 0, y: 0, width: cardPixelWidth, height: cardPixelHeight)

            // White background with rounded corners
            let path = UIBezierPath(roundedRect: rect, cornerRadius: cornerRadius)
            UIColor.white.setFill()
            path.fill()

            // Purple border for jokers
            UIColor.purple.setStroke()
            path.lineWidth = 4
            path.stroke()

            let isHigh = card.rank == .hi
            let color = UIColor.purple
            let label = isHigh ? "HI" : "LO"

            // Top-left label
            let smallFont = UIFont.systemFont(ofSize: 34, weight: .bold)
            let smallAttrs: [NSAttributedString.Key: Any] = [
                .font: smallFont,
                .foregroundColor: color,
            ]
            (label as NSString).draw(at: CGPoint(x: 20, y: 16), withAttributes: smallAttrs)

            // Bottom-right label (rotated)
            let gc = ctx.cgContext
            gc.saveGState()
            gc.translateBy(x: cardPixelWidth, y: cardPixelHeight)
            gc.rotate(by: .pi)
            (label as NSString).draw(at: CGPoint(x: 20, y: 16), withAttributes: smallAttrs)
            gc.restoreGState()

            // Star symbol
            let starFont = UIFont.systemFont(ofSize: 72, weight: .regular)
            let starAttrs: [NSAttributedString.Key: Any] = [
                .font: starFont,
                .foregroundColor: color,
            ]
            let star = "\u{2605}"
            let starSize = (star as NSString).size(withAttributes: starAttrs)
            (star as NSString).draw(
                at: CGPoint(x: (cardPixelWidth - starSize.width) / 2,
                            y: (cardPixelHeight - starSize.height) / 2 - 40),
                withAttributes: starAttrs
            )

            // "JOKER" text below star
            let jokerFont = UIFont.systemFont(ofSize: 36, weight: .heavy)
            let jokerAttrs: [NSAttributedString.Key: Any] = [
                .font: jokerFont,
                .foregroundColor: color,
            ]
            let jokerStr = "JOKER"
            let jokerSize = (jokerStr as NSString).size(withAttributes: jokerAttrs)
            (jokerStr as NSString).draw(
                at: CGPoint(x: (cardPixelWidth - jokerSize.width) / 2,
                            y: (cardPixelHeight - jokerSize.height) / 2 + 40),
                withAttributes: jokerAttrs
            )
        }
        return SKTexture(image: image)
    }

    // MARK: - Card Back

    private static func renderCardBack() -> SKTexture {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: cardPixelWidth, height: cardPixelHeight))
        let image = renderer.image { _ in
            let rect = CGRect(x: 0, y: 0, width: cardPixelWidth, height: cardPixelHeight)

            // Dark green background
            let path = UIBezierPath(roundedRect: rect, cornerRadius: cornerRadius)
            UIColor(red: 0.1, green: 0.3, blue: 0.15, alpha: 1).setFill()
            path.fill()

            // Lighter green border
            UIColor(red: 0.2, green: 0.5, blue: 0.25, alpha: 1).setStroke()
            path.lineWidth = 4
            path.stroke()

            // Inner rectangle pattern
            let inset: CGFloat = 24
            let innerRect = rect.insetBy(dx: inset, dy: inset)
            let innerPath = UIBezierPath(roundedRect: innerRect, cornerRadius: cornerRadius - 8)
            UIColor(red: 0.15, green: 0.4, blue: 0.2, alpha: 1).setStroke()
            innerPath.lineWidth = 2
            innerPath.stroke()

            // Diamond pattern in center
            let centerX = cardPixelWidth / 2
            let centerY = cardPixelHeight / 2
            let diamondSize: CGFloat = 40

            let diamond = UIBezierPath()
            diamond.move(to: CGPoint(x: centerX, y: centerY - diamondSize))
            diamond.addLine(to: CGPoint(x: centerX + diamondSize * 0.7, y: centerY))
            diamond.addLine(to: CGPoint(x: centerX, y: centerY + diamondSize))
            diamond.addLine(to: CGPoint(x: centerX - diamondSize * 0.7, y: centerY))
            diamond.close()
            UIColor(red: 0.25, green: 0.55, blue: 0.3, alpha: 1).setFill()
            diamond.fill()
            UIColor(red: 0.3, green: 0.65, blue: 0.35, alpha: 1).setStroke()
            diamond.lineWidth = 2
            diamond.stroke()
        }
        return SKTexture(image: image)
    }

    // MARK: - Helpers

    private static func suitColor(_ suit: Suit) -> UIColor {
        switch suit {
        case .hearts, .diamonds:
            return UIColor(red: 0.85, green: 0.1, blue: 0.1, alpha: 1)
        case .spades, .clubs:
            return UIColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1)
        case .joker:
            return .purple
        }
    }

    private static func suitSymbol(_ suit: Suit) -> String {
        switch suit {
        case .spades:   return "\u{2660}"
        case .hearts:   return "\u{2665}"
        case .diamonds: return "\u{2666}"
        case .clubs:    return "\u{2663}"
        case .joker:    return "\u{2605}"
        }
    }

    private static func rankString(_ rank: Rank) -> String {
        switch rank {
        case .ace:   return "A"
        case .king:  return "K"
        case .queen: return "Q"
        case .jack:  return "J"
        case .hi:    return "HI"
        case .lo:    return "LO"
        default:     return rank.rawValue
        }
    }
}

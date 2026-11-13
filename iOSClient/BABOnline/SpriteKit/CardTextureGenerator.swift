import SpriteKit
import UIKit

/// Card face textures, drawn at runtime with Core Graphics and cached for the
/// app's lifetime (54 faces at ~0.5 MB each on a 3x screen; never evicted).
///
/// Thread safety: the cache is guarded by a lock, so `prewarm()` renders every
/// face on a background queue while the main thread may already ask for one
/// (`texture(for:)` renders on demand and the first texture stored for a card
/// wins, so a sprite never sees two textures for one card).
enum CardTextureGenerator {
    private static let lock = NSLock()
    private static var cache: [String: SKTexture] = [:]
    private static var prewarmStarted = false
    #if DEBUG
    /// Renders done inside `texture(for:)` / `cardBackTexture()` (a cache miss on the
    /// caller's thread, normally main) and by `prewarm()`: tests prove the scene hits the cache.
    private(set) static var onDemandRenders = 0
    private(set) static var prewarmRenders = 0
    /// Card faces drawn on the main thread, by either path.
    private(set) static var mainThreadRenders = 0
    #endif

    /// Drawing canvas, in canvas units (not pixels). All drawing code below uses this
    /// 300x435 coordinate space; `renderCard` maps it onto the output bitmap.
    private static let cardPixelWidth: CGFloat = 300
    private static let cardPixelHeight: CGFloat = 435
    private static let cornerRadius: CGFloat = 24

    /// The screen scale textures are rendered for. Read on the main thread first
    /// (`prewarm()` and every scene build touch it there); a static let is initialized once.
    static let displayScale: CGFloat = UIGraphicsImageRendererFormat.preferred().scale

    /// The largest zoom this device's table reaches: TableLayout.maxZoom, except on a phone
    /// (an iPhone, the Duo open or closed), whose panes never reach TableLayout.zoomMinSide, so
    /// its textures stay what they were (1:1 at zoom 1). Read on the main thread first, as
    /// `displayScale`.
    static let textureZoom: CGFloat = UIDevice.current.userInterfaceIdiom == .phone ? 1 : TableLayout.maxZoom

    /// Bitmap size of every card texture: the largest on-screen card
    /// (`TableLayout.maxScreenCardPoints`: a hand card at s = 1 and the device's largest
    /// zoom, 100 x 145 pt on a phone, 140 x 203 pt on an iPad; trick cards are at most 0.8
    /// of it) times the screen scale, so hand cards sample 1:1 at that zoom
    /// (300 x 435 px on a 3x phone, 280 x 406 px on a 2x iPad).
    static func pixelSize(scale: CGFloat = displayScale, zoom: CGFloat = textureZoom) -> CGSize {
        let pts = TableLayout.maxScreenCardPoints(zoom: zoom)
        return CGSize(width: (pts.width * scale).rounded(.up), height: (pts.height * scale).rounded(.up))
    }

    /// Every face the game deals: 52 + HI / LO jokers. (The card back is not prewarmed:
    /// no table sprite uses it; the draw shows SwiftUI card shapes.)
    static let allCards: [Card] = {
        let ranks: [Rank] = [.two, .three, .four, .five, .six, .seven, .eight, .nine, .ten, .jack, .queen, .king, .ace]
        let suits: [Suit] = [.spades, .hearts, .diamonds, .clubs]
        return suits.flatMap { s in ranks.map { Card(suit: s, rank: $0) } }
            + [Card(suit: .joker, rank: .hi), Card(suit: .joker, rank: .lo)]
    }()

    /// Render the 300x435 canvas into a bitmap of `pixelSize(scale:zoom:)`: scale 1 (one
    /// image point = one pixel), 8-bit sRGB (the default `.automatic` range may pick a
    /// 16-bit float extended-range bitmap on a wide-color screen, twice the bytes for
    /// colors that are all sRGB), with alpha (rounded corners).
    private static func renderCard(scale: CGFloat, _ draw: (UIGraphicsImageRendererContext) -> Void) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        format.preferredRange = .standard
        let pixelSize = pixelSize(scale: scale, zoom: textureZoom)
        let renderer = UIGraphicsImageRenderer(size: pixelSize, format: format)
        return renderer.image { ctx in
            ctx.cgContext.scaleBy(x: pixelSize.width / cardPixelWidth, y: pixelSize.height / cardPixelHeight)
            draw(ctx)
        }
    }

    /// Linear filtering, no mipmaps: the smallest static card is a trick card at
    /// 0.8 x 0.6 = 0.48 of the hand size (tabletop), which bilinear filtering samples
    /// without visible shimmer, and a mip level blended in would soften every trick
    /// card's rank text (usesMipmaps also changed nothing measurable in SpriteKit on
    /// the iOS 27.2 simulator, POT or not, and would add a third to the memory).
    private static func makeTexture(_ image: UIImage) -> SKTexture {
        let tex = SKTexture(image: image)
        tex.filteringMode = .linear
        return tex
    }

    private static func cached(_ key: String) -> SKTexture? {
        lock.lock(); defer { lock.unlock() }
        return cache[key]
    }

    /// Store `tex` unless another thread stored one first; returns the one in the cache.
    private static func store(_ tex: SKTexture, for key: String) -> SKTexture {
        lock.lock(); defer { lock.unlock() }
        if let existing = cache[key] { return existing }
        cache[key] = tex
        return tex
    }

    /// The texture for a card face: from the cache, or rendered now on the caller's thread.
    static func texture(for card: Card) -> SKTexture {
        if let hit = cached(card.id) { return hit }
        let tex = makeTexture(renderFace(card, scale: displayScale))
        #if DEBUG
        lock.lock(); onDemandRenders += 1; lock.unlock()
        #endif
        return store(tex, for: card.id)
    }

    /// Returns a cached or freshly rendered card-back texture.
    static func cardBackTexture() -> SKTexture {
        let key = "__card_back__"
        if let hit = cached(key) { return hit }
        let tex = makeTexture(renderCardBack(scale: displayScale))
        #if DEBUG
        lock.lock(); onDemandRenders += 1; lock.unlock()
        #endif
        return store(tex, for: key)
    }

    /// Render every face the game deals on a background queue (once per process), so
    /// the first deal finds them cached instead of drawing 13 cards on the main thread.
    /// Called when a game lobby, tournament lobby or game screen shows. Faces already
    /// rendered on demand are skipped (and kept). `completion` runs on the main queue
    /// once every face is cached (at once when an earlier call already started).
    @MainActor
    static func prewarm(completion: (@Sendable () -> Void)? = nil) {
        let scale = displayScale  // read on main
        _ = textureZoom
        lock.lock()
        let started = prewarmStarted
        prewarmStarted = true
        lock.unlock()
        guard !started else {
            if let completion { DispatchQueue.main.async(execute: completion) }
            return
        }
        DispatchQueue.global(qos: .utility).async {
            for card in allCards where cached(card.id) == nil {
                _ = store(makeTexture(renderFace(card, scale: scale)), for: card.id)
                #if DEBUG
                lock.lock(); prewarmRenders += 1; lock.unlock()
                #endif
            }
            if let completion { DispatchQueue.main.async(execute: completion) }
        }
    }

    #if DEBUG
    /// Tests only: forget every texture and counter (sprites keep the textures they hold).
    static func resetForTesting() {
        lock.lock(); defer { lock.unlock() }
        cache = [:]
        prewarmStarted = false
        onDemandRenders = 0
        prewarmRenders = 0
        mainThreadRenders = 0
    }

    /// Tests only: the cached texture for a key (a card id), without rendering.
    static func cachedTexture(_ id: String) -> SKTexture? { cached(id) }
    #endif

    private static func renderFace(_ card: Card, scale: CGFloat) -> UIImage {
        #if DEBUG
        if Thread.isMainThread { lock.lock(); mainThreadRenders += 1; lock.unlock() }
        #endif
        return card.isJoker ? renderJoker(card: card, scale: scale) : renderStandardCard(card: card, scale: scale)
    }

    // MARK: - Standard Card

    private static func renderStandardCard(card: Card, scale: CGFloat) -> UIImage {
        renderCard(scale: scale) { ctx in
            let rect = CGRect(x: 0, y: 0, width: cardPixelWidth, height: cardPixelHeight)
            let gc = ctx.cgContext

            // White background with rounded corners
            let path = UIBezierPath(roundedRect: rect, cornerRadius: cornerRadius)
            Theme.Palette.Card.face.uiColor.setFill()
            path.fill()

            // Thin gray border
            Theme.Palette.Card.border.uiColor.setStroke()
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
    }

    // MARK: - Joker

    private static func renderJoker(card: Card, scale: CGFloat) -> UIImage {
        renderCard(scale: scale) { ctx in
            let rect = CGRect(x: 0, y: 0, width: cardPixelWidth, height: cardPixelHeight)

            // White background with rounded corners
            let path = UIBezierPath(roundedRect: rect, cornerRadius: cornerRadius)
            Theme.Palette.Card.face.uiColor.setFill()
            path.fill()

            // Purple border for jokers
            Theme.CardInk.joker.uiColor.setStroke()
            path.lineWidth = 4
            path.stroke()

            let isHigh = card.rank == .hi
            let color = Theme.CardInk.joker.uiColor
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
    }

    // MARK: - Card Back

    private static func renderCardBack(scale: CGFloat) -> UIImage {
        renderCard(scale: scale) { _ in
            let rect = CGRect(x: 0, y: 0, width: cardPixelWidth, height: cardPixelHeight)

            // Dark green background
            let path = UIBezierPath(roundedRect: rect, cornerRadius: cornerRadius)
            Theme.Palette.Card.back.uiColor.setFill()
            path.fill()

            // Lighter green border
            Theme.Palette.Card.backBorder.uiColor.setStroke()
            path.lineWidth = 4
            path.stroke()

            // Inner rectangle pattern
            let inset: CGFloat = 24
            let innerRect = rect.insetBy(dx: inset, dy: inset)
            let innerPath = UIBezierPath(roundedRect: innerRect, cornerRadius: cornerRadius - 8)
            Theme.Palette.Card.backInner.uiColor.setStroke()
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
            Theme.Palette.Card.backDiamond.uiColor.setFill()
            diamond.fill()
            Theme.Palette.Card.backDiamondStroke.uiColor.setStroke()
            diamond.lineWidth = 2
            diamond.stroke()
        }
    }

    // MARK: - Helpers

    private static func suitColor(_ suit: Suit) -> UIColor {
        switch suit {
        case .hearts, .diamonds:
            return Theme.CardInk.red.uiColor
        case .spades, .clubs:
            return Theme.CardInk.black.uiColor
        case .joker:
            return Theme.CardInk.joker.uiColor
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

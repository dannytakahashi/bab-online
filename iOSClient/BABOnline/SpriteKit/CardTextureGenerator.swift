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
    /// The same bitmaps as UIImages, only for the cards SwiftUI asked for (the draw for
    /// deal: four faces and the back), a few at a time (NSCache is thread safe).
    private static let images: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.countLimit = 8
        return c
    }()
    private static let backKey = "__card_back__"
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

    /// Every face the game deals: 52 + HI / LO jokers. (No table sprite uses the card
    /// back's texture; only the draw for deal shows the back, through `cardBackImage(width:)`,
    /// which `prewarm()` renders at the draw's expected size.)
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
        renderCard(pixelSize: pixelSize(scale: scale, zoom: textureZoom), draw)
    }

    /// The same at an explicit bitmap size (the draw's card back, rendered at its on-screen size).
    private static func renderCard(pixelSize: CGSize, _ draw: (UIGraphicsImageRendererContext) -> Void) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        format.preferredRange = .standard
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
        let key = backKey
        if let hit = cached(key) { return hit }
        let tex = makeTexture(renderCardBack(pixelSize: pixelSize()))
        #if DEBUG
        lock.lock(); onDemandRenders += 1; lock.unlock()
        #endif
        return store(tex, for: key)
    }

    /// The face as a UIImage for SwiftUI (DrawPhaseView): the bitmap the textures are
    /// made from (renderFace at the screen scale), so the draw shows the table's card art
    /// pixel for pixel (`pixelSize()`: sharp up to `TableLayout.maxScreenCardPoints(zoom: textureZoom)`;
    /// the draw's cards are at most `TableLayout.maxCardPoints`, so on an iPad they sample down).
    /// Rendered here (about a millisecond), not read back from the SKTexture:
    /// `SKTexture.cgImage()` copies the bitmap back out of SpriteKit, 100x the render's
    /// cost, on the main thread in the frame a card arrives.
    static func image(for card: Card) -> UIImage {
        uiImage(card.id) { renderFace(card, scale: displayScale) }
    }

    /// The card back as a UIImage of the textures' size (`pixelSize()`), drawn for that density.
    static func cardBackImage() -> UIImage {
        uiImage(backKey) { renderCardBack(pixelSize: pixelSize()) }
    }

    /// The card back as the draw shows it (its deck and face-down slots): rendered at the
    /// draw card's on-screen size, `width` points at the screen scale (`backPixelSize`), so it
    /// samples 1:1 and the lattice hints itself for the pixels it really gets (renderCardBack).
    /// Cached per pixel width; `prewarm()` renders the one the draw is expected to ask for.
    static func cardBackImage(width: CGFloat) -> UIImage {
        let px = backPixelSize(width: width)
        return uiImage("\(backKey)@\(Int(px.width))") { renderCardBack(pixelSize: px) }
    }

    /// The draw back's bitmap: `width` points at `scale`, the card's 300 x 435 aspect.
    static func backPixelSize(width: CGFloat, scale: CGFloat = displayScale) -> CGSize {
        let w = max(1, (width * scale).rounded(.up))
        return CGSize(width: w, height: (w * cardPixelHeight / cardPixelWidth).rounded(.up))
    }

    /// The draw card's width (DrawMetrics) for the key window's safe width, read on the main
    /// thread for `prewarm()`; nil without a window (then the draw renders its back on demand).
    @MainActor
    private static func expectedDrawCardWidth() -> CGFloat? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first, window.bounds.width > 0 else { return nil }
        return DrawMetrics(width: window.bounds.inset(by: window.safeAreaInsets).width).card.width
    }

    /// `render` gives a scale-1 bitmap (`pixelSize()`, or the draw back's `backPixelSize`); the
    /// cached UIImage wraps the same pixels at the screen scale (pixels / `displayScale` points).
    private static func uiImage(_ key: String, _ render: () -> UIImage) -> UIImage {
        if let hit = images.object(forKey: key as NSString) { return hit }
        let bitmap = render()
        let image = bitmap.cgImage.map { UIImage(cgImage: $0, scale: displayScale, orientation: .up) } ?? bitmap
        images.setObject(image, forKey: key as NSString)
        return image
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
        let drawCardWidth = expectedDrawCardWidth()
        lock.lock()
        let started = prewarmStarted
        prewarmStarted = true
        lock.unlock()
        guard !started else {
            if let completion { DispatchQueue.main.async(execute: completion) }
            return
        }
        DispatchQueue.global(qos: .utility).async {
            // the draw for deal's deck at its expected size (NSCache is thread safe)
            if let drawCardWidth { _ = cardBackImage(width: drawCardWidth) }
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
        images.removeAllObjects()
        prewarmStarted = false
        onDemandRenders = 0
        prewarmRenders = 0
        mainThreadRenders = 0
    }

    /// Tests only: the cached texture for a key (a card id), without rendering.
    static func cachedTexture(_ id: String) -> SKTexture? { cached(id) }

    /// Tests only: forget the SwiftUI images (`image(for:)`, `cardBackImage()`), keep the textures.
    static func removeImagesForTesting() { images.removeAllObjects() }

    /// Tests only: a face rendered now, as the textures' source bitmap (nothing cached).
    static func renderFaceForTesting(_ card: Card) -> UIImage { renderFace(card, scale: displayScale) }

    /// Tests only: the back rendered now at `pixelSize` (nothing cached).
    static func renderBackForTesting(pixelSize: CGSize) -> UIImage { renderCardBack(pixelSize: pixelSize) }
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

    // MARK: - Shared paths

    /// The web's roundRectPath (cardFaces.js): circular corners of `radius` (at most half the
    /// box), as canvas arcTo draws them. (UIBezierPath's rounded rect has continuous corners;
    /// the standard faces keep it.)
    private static func roundRectPath(_ box: CGRect, _ radius: CGFloat) -> CGPath {
        let rr = max(0, min(radius, box.width / 2, box.height / 2))
        let (x, y, w, h) = (box.minX, box.minY, box.width, box.height)
        let p = CGMutablePath()
        p.move(to: CGPoint(x: x + rr, y: y))
        p.addLine(to: CGPoint(x: x + w - rr, y: y))
        p.addArc(tangent1End: CGPoint(x: x + w, y: y), tangent2End: CGPoint(x: x + w, y: y + rr), radius: rr)
        p.addLine(to: CGPoint(x: x + w, y: y + h - rr))
        p.addArc(tangent1End: CGPoint(x: x + w, y: y + h), tangent2End: CGPoint(x: x + w - rr, y: y + h), radius: rr)
        p.addLine(to: CGPoint(x: x + rr, y: y + h))
        p.addArc(tangent1End: CGPoint(x: x, y: y + h), tangent2End: CGPoint(x: x, y: y + h - rr), radius: rr)
        p.addLine(to: CGPoint(x: x, y: y + rr))
        p.addArc(tangent1End: CGPoint(x: x, y: y), tangent2End: CGPoint(x: x + rr, y: y), radius: rr)
        p.closeSubpath()
        return p
    }

    /// The whole card's rounded rect (the web's corner radius 24).
    private static var cardPath: CGPath {
        roundRectPath(CGRect(x: 0, y: 0, width: cardPixelWidth, height: cardPixelHeight), cornerRadius)
    }

    /// The web's cardBase: the card filled, its edge stroked `lineWidth` wide and clipped to
    /// the card (so half of it shows).
    private static func cardBase(_ gc: CGContext, fill: UIColor, stroke: UIColor, lineWidth: CGFloat) {
        gc.addPath(cardPath)
        gc.setFillColor(fill.cgColor)
        gc.fillPath()
        gc.saveGState()
        gc.addPath(cardPath)
        gc.clip()
        gc.addPath(cardPath)
        gc.setLineWidth(lineWidth)
        gc.setStrokeColor(stroke.cgColor)
        gc.strokePath()
        gc.restoreGState()
    }

    // MARK: - Joker

    /// The rank index's place and font on every standard face (renderStandardCard): the
    /// system bold at 40 canvas units, drawn at (20, 16). The joker's word is drawn the same way.
    static let indexOrigin = CGPoint(x: 20, y: 16)
    static let indexFontSize: CGFloat = 40

    /// The sprite's card (x 11..52, y 2..61: 42 x 60 px) on the canvas (cardFaces.js SPRITE).
    private static let jokerSprite = (x: CGFloat(11), y: CGFloat(2), sx: cardPixelWidth / 42, sy: cardPixelHeight / 60)
    /// White kept round the joker's word, cutting the inner border behind it (JOKER_WORD_PAD).
    private static let jokerWordPad: CGFloat = 6

    /// The ink box of `str` in `font`, pen at x = 0 on the baseline, y up (CoreText glyph bounds).
    static func inkBounds(_ str: String, _ font: UIFont) -> CGRect {
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: str, attributes: [.font: font]))
        return CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
    }

    /// The joker word's font: the rank index's (system bold 40), unless the wider word ("LO")
    /// would then reach further right than the widest rank ("10"); then both words shrink
    /// alike until it does not (the web's jokerWordSize: the word never passes the index
    /// column), so a joker's corner shows in a hand's strip whenever a 10's does.
    static let jokerWordFont: UIFont = {
        let rank = UIFont.systemFont(ofSize: indexFontSize, weight: .bold)
        let ten = inkBounds("10", rank).maxX
        let word = max(inkBounds("HI", rank).maxX, inkBounds("LO", rank).maxX)
        let size = word > ten ? indexFontSize * ten / word : indexFontSize
        return UIFont.systemFont(ofSize: size, weight: .bold)
    }()

    /// The joker word's ink box on the canvas (y down): pen at indexOrigin.x, its cap top
    /// where a rank's cap top is (indexOrigin.y + the line's ascender less its cap height).
    static func jokerWordInk(_ word: String) -> (drawAt: CGPoint, ink: CGRect) {
        let rank = UIFont.systemFont(ofSize: indexFontSize, weight: .bold)
        let font = jokerWordFont
        let capTop = indexOrigin.y + rank.ascender - rank.capHeight
        let drawAt = CGPoint(x: indexOrigin.x, y: capTop - (font.ascender - font.capHeight))
        let baseline = drawAt.y + font.ascender
        let b = inkBounds(word, font)
        return (drawAt, CGRect(x: drawAt.x + b.minX, y: baseline - b.maxY, width: b.width, height: b.height))
    }

    /// One open stroked path (the sprite's lines: butt ends, round joins).
    private static func strokeLines(_ gc: CGContext, _ color: UIColor, _ lineWidth: CGFloat, _ build: (CGMutablePath) -> Void) {
        let p = CGMutablePath()
        build(p)
        gc.addPath(p)
        gc.setLineWidth(lineWidth)
        gc.setStrokeColor(color.cgColor)
        gc.setLineCap(.butt)
        gc.setLineJoin(.round)
        gc.strokePath()
    }

    /// The sprite's boxy double-bar dollar (cardFaces.js jokerDollar), in sprite pixels.
    private static func jokerDollar(_ gc: CGContext, _ color: UIColor, _ lineWidth: CGFloat) {
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
        // the S
        strokeLines(gc, color, lineWidth) { p in
            p.move(to: pt(36.5, 28.9))
            p.addLine(to: pt(36.5, 27.2))
            p.addCurve(to: pt(34.6, 25.5), control1: pt(36.5, 26.1), control2: pt(35.7, 25.5))
            p.addLine(to: pt(29.1, 25.5))
            p.addCurve(to: pt(27.5, 27.3), control1: pt(28.0, 25.5), control2: pt(27.5, 26.2))
            p.addLine(to: pt(27.5, 30.6))
            p.addCurve(to: pt(29.2, 32.2), control1: pt(27.5, 31.5), control2: pt(28.3, 31.9))
            p.addLine(to: pt(34.3, 34.2))
            p.addCurve(to: pt(36.5, 36.7), control1: pt(35.7, 34.7), control2: pt(36.5, 35.5))
            p.addLine(to: pt(36.5, 38.0))
            p.addCurve(to: pt(34.8, 39.5), control1: pt(36.5, 39.0), control2: pt(35.8, 39.5))
            p.addLine(to: pt(28.9, 39.5))
            p.addCurve(to: pt(27.5, 38.0), control1: pt(28.0, 39.5), control2: pt(27.5, 38.9))
            p.addLine(to: pt(27.5, 36.6))
        }
        // the two bars and the loop that joins them under the S
        strokeLines(gc, color, lineWidth) { p in
            p.move(to: pt(29.5, 23.5))
            p.addLine(to: pt(29.5, 39.6))
            p.addCurve(to: pt(34.5, 39.6), control1: pt(29.5, 41.9), control2: pt(34.5, 41.9))
            p.addLine(to: pt(34.5, 23.5))
        }
        // top serifs
        strokeLines(gc, color, lineWidth) { p in
            p.move(to: pt(27.9, 23.5)); p.addLine(to: pt(31.1, 23.5))
            p.move(to: pt(32.9, 23.5)); p.addLine(to: pt(36.1, 23.5))
        }
    }

    /// A panel corner flourish (sprite pixels, the corner at (0, 0)): an L bracket and a ring.
    private static func jokerFlourish(_ gc: CGContext, _ color: UIColor, _ lineWidth: CGFloat) {
        strokeLines(gc, color, lineWidth) { p in
            p.move(to: CGPoint(x: 6, y: 1.5))
            p.addLine(to: CGPoint(x: 1.5, y: 1.5))
            p.addLine(to: CGPoint(x: 1.5, y: 6))
        }
        gc.addEllipse(in: CGRect(x: 2.5 - 0.95, y: 2.5 - 0.95, width: 1.9, height: 1.9))
        gc.setLineWidth(lineWidth)
        gc.setStrokeColor(color.cgColor)
        gc.strokePath()
    }

    /// The joker (owner 2026-11-13: the web's faithful joker, cardFaces.js drawJokerFace): a
    /// slate outline, a light-blue inner border and centre panel with white corner flourishes,
    /// the black double-bar dollar, and HI (card red) or LO (card black) as the top-left corner
    /// index in the system bold, like the ranks (no top-right label, no bottom-right copy).
    private static func renderJoker(card: Card, scale: CGFloat) -> UIImage {
        renderCard(scale: scale) { ctx in
            let gc = ctx.cgContext
            let ink = Theme.JokerInk.self
            cardBase(gc, fill: Theme.Palette.Card.face.uiColor, stroke: ink.outline.uiColor, lineWidth: 12)  // ~6 units show
            // the light-blue inner border (sprite: a 1 px line 3 px in)
            gc.addPath(roundRectPath(CGRect(x: 25, y: 25, width: cardPixelWidth - 50, height: cardPixelHeight - 50), 7))
            gc.setLineWidth(6.5)
            gc.setStrokeColor(ink.frame.uiColor.cgColor)
            gc.strokePath()

            // the centre panel (sprite x 21..43, y 16..48), its flourishes and the dollar
            gc.saveGState()
            gc.scaleBy(x: jokerSprite.sx, y: jokerSprite.sy)
            gc.translateBy(x: -jokerSprite.x, y: -jokerSprite.y)
            gc.addPath(roundRectPath(CGRect(x: 21, y: 16, width: 22, height: 32), 0.6))
            gc.setFillColor(ink.frame.uiColor.cgColor)
            gc.fillPath()
            for (sx, sy) in [(1, 1), (-1, 1), (1, -1), (-1, -1)] as [(CGFloat, CGFloat)] {
                gc.saveGState()
                gc.translateBy(x: sx > 0 ? 21 : 43, y: sy > 0 ? 16 : 48)
                gc.scaleBy(x: sx, y: sy)
                jokerFlourish(gc, ink.flourish.uiColor, 0.95)
                gc.restoreGState()
            }
            jokerDollar(gc, ink.glyph.uiColor, 1)
            gc.restoreGState()

            // the corner index on a white patch the inner border passes behind
            let hi = card.rank == .hi
            let word = hi ? "HI" : "LO"
            let place = jokerWordInk(word)
            gc.setFillColor(ink.wordPatch.uiColor.cgColor)
            gc.fill(place.ink.insetBy(dx: -jokerWordPad, dy: -jokerWordPad))
            let attrs: [NSAttributedString.Key: Any] = [
                .font: jokerWordFont,
                .foregroundColor: (hi ? Theme.CardInk.red : Theme.CardInk.black).uiColor,
            ]
            (word as NSString).draw(at: place.drawAt, withAttributes: attrs)
        }
    }

    // MARK: - Card Back

    /// The back (owner 2026-11-13): the web's classic single-ink LATTICE in its red ink
    /// (cardFaces.js drawBack / backPanel / backLattice, Theme.CardBack), the same after a half
    /// turn: a cream card with the faces' grey edge, a white margin, an ink panel with a beaded
    /// band and a thin inner rule, a double-line diamond trellis with dots and lozenges at its
    /// crossings, and a harlequin lozenge medallion.
    ///
    /// Small sizes hint themselves as the web's do: `k` is the bitmap's pixels per canvas unit
    /// (the draw renders the back at its on-screen size, `cardBackImage(width:)`, so k is the
    /// screen's); the lattice pitch doubles (same tone) until a cell is >= 5.5 px, the sub-pixel
    /// ink split and dots drop out, every structural rule stays >= ~1 px, the medallion's moat
    /// stays wide, and at the smallest sizes the medallion is one bold paper diamond.
    private static let backMargin: CGFloat = 16        // the paper margin round the ink panel
    private static let backBand: CGFloat = 15          // the border band inside the panel
    private static let backField: CGFloat = 16 + 15 + 3.5  // the lattice field's inset
    private static let backBeadPitch: CGFloat = 9

    private static func renderCardBack(pixelSize: CGSize) -> UIImage {
        renderCard(pixelSize: pixelSize) { ctx in
            let k = pixelSize.width / cardPixelWidth
            let gc = ctx.cgContext
            gc.saveGState()
            backPanel(gc, k: k)
            backLattice(gc, k: k)
            gc.restoreGState()
        }
    }

    /// The rounded rect `d` units inside the card, corner radius r.
    private static func backInset(_ d: CGFloat, _ r: CGFloat) -> CGPath {
        roundRectPath(CGRect(x: d, y: d, width: cardPixelWidth - 2 * d, height: cardPixelHeight - 2 * d), r)
    }

    private static func addLozenge(_ p: CGMutablePath, _ x: CGFloat, _ y: CGFloat, _ a: CGFloat, _ b: CGFloat) {
        p.move(to: CGPoint(x: x, y: y - b))
        p.addLine(to: CGPoint(x: x + a, y: y))
        p.addLine(to: CGPoint(x: x, y: y + b))
        p.addLine(to: CGPoint(x: x - a, y: y))
        p.closeSubpath()
    }

    private static func addDot(_ p: CGMutablePath, _ x: CGFloat, _ y: CGFloat, _ r: CGFloat) {
        p.addEllipse(in: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r))
    }

    /// How much of a repeat of `period` units survives at k px per unit (0 = average it away).
    private static func backDetail(_ period: CGFloat, _ k: CGFloat) -> CGFloat {
        max(0, min(1, (period * k - 3) / 4))
    }

    /// The band's bead centres on the rect `d` units in, about `pitch` apart, `cornerGap` clear of the corners.
    static func backBandPoints(_ d: CGFloat, pitch: CGFloat, cornerGap: CGFloat) -> [CGPoint] {
        let W = cardPixelWidth, H = cardPixelHeight
        var pts: [CGPoint] = []
        func side(_ x0: CGFloat, _ y0: CGFloat, _ x1: CGFloat, _ y1: CGFloat) {
            let full = hypot(x1 - x0, y1 - y0)
            let len = full - 2 * cornerGap
            let n = max(1, Int((len / pitch).rounded()))
            for i in 0...n {
                let t = (cornerGap + CGFloat(i) * len / CGFloat(n)) / full
                pts.append(CGPoint(x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t))
            }
        }
        side(d, d, W - d, d); side(d, H - d, W - d, H - d)
        side(d, d, d, H - d); side(W - d, d, W - d, H - d)
        return pts
    }

    /// The card, its margin, the ink panel, its beaded band and inner rule (backPanel).
    private static func backPanel(_ gc: CGContext, k: CGFloat) {
        let ink = Theme.CardBack.ink.uiColor.cgColor, paper = Theme.CardBack.paper.uiColor.cgColor
        let W = cardPixelWidth, H = cardPixelHeight, R = cornerRadius, M = backMargin
        func minW(_ u: CGFloat) -> CGFloat { max(u, 0.9 / k) }  // a structural rule never under ~1 px
        cardBase(gc, fill: Theme.CardBack.paper.uiColor, stroke: Theme.CardBack.edge.uiColor, lineWidth: 3)
        gc.addPath(backInset(M, R - M + 1))
        gc.setFillColor(ink)
        gc.fillPath()
        gc.setStrokeColor(paper)
        gc.setFillColor(paper)
        let a = backDetail(backBeadPitch, k)
        gc.setAlpha(max(a, 0.35))
        gc.setLineWidth(1.4)
        gc.addPath(backInset(M + 3, R - M - 2))
        gc.strokePath()
        gc.setAlpha(1)
        gc.setLineWidth(minW(1.6))
        gc.addPath(backInset(M + backBand, 4))
        gc.strokePath()
        let c = M + 3 + (backBand - 3) / 2
        gc.setAlpha(0.45 + 0.55 * a)
        let beads = CGMutablePath()
        for pt in backBandPoints(c, pitch: backBeadPitch, cornerGap: 6) { addDot(beads, pt.x, pt.y, 1.9) }
        gc.addPath(beads)
        gc.fillPath()
        gc.setAlpha(1)
        let corners = CGMutablePath()
        for (x, y) in [(c, c), (W - c, c), (c, H - c), (W - c, H - c)] { addLozenge(corners, x, y, 4, 4) }
        gc.addPath(corners)
        gc.fillPath()
    }

    /// Smallest power-of-two multiple of `pitch` (up to `cap`) whose repeat is at least `minPx` px.
    static func backHint(_ pitch: CGFloat, _ k: CGFloat, minPx: CGFloat, cap: CGFloat) -> CGFloat {
        var f: CGFloat = 1
        while pitch * f * k < minPx && f < cap { f *= 2 }
        return f
    }

    /// The trellis (clipped to the field) and the medallion (backLattice).
    private static func backLattice(_ gc: CGContext, k: CGFloat) {
        let ink = Theme.CardBack.ink.uiColor.cgColor, paper = Theme.CardBack.paper.uiColor.cgColor
        let W = cardPixelWidth, H = cardPixelHeight, F = backField
        let cx = W / 2, cy = H / 2
        // cells sized so the field's edges run through rows of crossings: 10 half-cells
        // across each half of the field, 12 down each half
        let DX = (W - 2 * F) / 10, DY = (H - 2 * F) / 12
        let f = backHint(DX, k, minPx: 5.5, cap: 4)
        let dx = DX * f, dy = DY * f
        let ext = Int((16 / f).rounded(.up))
        let fine = 1.2 * f * k >= 0.5  // the double line's ink split and the dots still resolve
        func minW(_ u: CGFloat) -> CGFloat { max(u, 0.9 / k) }
        gc.saveGState()
        gc.addPath(backInset(F, 3))
        gc.clip()
        let lines = CGMutablePath()
        let e = CGFloat(ext)
        for n in -ext..<ext {
            let c = CGFloat(n) + 0.5
            lines.move(to: CGPoint(x: cx + dx * (c + e), y: cy - dy * e)); lines.addLine(to: CGPoint(x: cx + dx * (c - e), y: cy + dy * e))
            lines.move(to: CGPoint(x: cx + dx * (c - e), y: cy - dy * e)); lines.addLine(to: CGPoint(x: cx + dx * (c + e), y: cy + dy * e))
        }
        gc.setLineCap(.butt)
        gc.setLineJoin(.miter)
        gc.setStrokeColor(paper)
        if fine {
            gc.addPath(lines); gc.setLineWidth(3.8 * f); gc.strokePath()
            gc.addPath(lines); gc.setLineWidth(1.2 * f); gc.setStrokeColor(ink); gc.strokePath()
            let marks = CGMutablePath()
            for i in -ext...ext {
                for j in (-2 * ext)...(2 * ext) {
                    let odd = abs(j % 2) == 1
                    let y = cy + dy * CGFloat(j) / 2
                    let xd = cx + dx * (CGFloat(i) + (odd ? 0.5 : 0))
                    let xn = cx + dx * (CGFloat(i) + (odd ? 0 : 0.5))
                    if abs(y - cy) > H / 2 - F - 4 { continue }  // none cut in half by the field's edge
                    if abs(xd - cx) < W / 2 - F - 4 { addDot(marks, xd, y, 1.5 * f) }
                    if abs(xn - cx) < W / 2 - F - 4 { addLozenge(marks, xn, y, 2.6 * f, 3.4 * f) }
                }
            }
            gc.addPath(marks)
            gc.setFillColor(paper)
            gc.fillPath()
        } else {
            // one line carrying the double line's paper (same tone), no dots
            gc.addPath(lines); gc.setLineWidth(2.4 * f); gc.strokePath()
        }
        gc.restoreGState()
        // the medallion: a lozenge 3 cells across in an ink moat, a paper rule, an inner rule,
        // four paper lozenges (one bold diamond when too small)
        let mx = 1.5 * DX, my = 1.5 * DY
        let moat = max(3, 1.4 / k)
        let moatPath = CGMutablePath()
        addLozenge(moatPath, cx, cy, mx + moat, my + moat * DY / DX)
        gc.addPath(moatPath)
        gc.setFillColor(ink)
        gc.fillPath()
        gc.setStrokeColor(paper)
        gc.setFillColor(paper)
        let rule = CGMutablePath()
        addLozenge(rule, cx, cy, mx, my)
        gc.addPath(rule)
        gc.setLineWidth(minW(2.2))
        gc.strokePath()
        if 1.1 * k >= 0.4 {
            let inner = CGMutablePath()
            addLozenge(inner, cx, cy, mx - 4.8, my - 4.8 * DY / DX)
            gc.addPath(inner)
            gc.setLineWidth(1.1)
            gc.strokePath()
        }
        let pips = CGMutablePath()
        if 0.32 * DX * k >= 1.6 {
            for (ox, oy) in [(0, -1), (1, 0), (0, 1), (-1, 0)] as [(CGFloat, CGFloat)] {
                addLozenge(pips, cx + ox * DX / 2, cy + oy * DY / 2, 0.32 * DX, 0.32 * DY)
            }
        } else {
            addLozenge(pips, cx, cy, 0.62 * DX, 0.62 * DY)
        }
        gc.addPath(pips)
        gc.fillPath()
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

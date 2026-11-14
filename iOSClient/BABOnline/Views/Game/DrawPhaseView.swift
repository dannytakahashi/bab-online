import SwiftUI

/// Interactive draw-for-deal phase — replaces the SpriteKit auto-draw.
/// The user taps the deck to draw; the four drawn cards flip face up as they
/// arrive, then the teams are announced.
///
/// The cards are the table's own art (CardTextureGenerator's bitmaps, at most the
/// hand card's 100 x 145 pt so they sample 1:1); the players are shown as the
/// seats show them (an avatar circle with the name under it). Timings are the
/// ones SHIPPED_IOS_FLOORS was measured against (server/game/pacing.js): slot i
/// flips after i * 0.3 + 0.1 s for 0.4 s, the teams fade in 0.8 s after
/// teamsAnnounced (0.5 s) and the overlay fades out at 3.8 s.
struct DrawPhaseView: View {
    @EnvironmentObject var gameState: GameState
    @State private var tapped = false
    @State private var flippedSlots: Set<Int> = []
    @State private var showTeams = false
    @State private var teamsOpacity: Double = 0
    @State private var dismissing = false
    @State private var pulseOpacity: Double = 1.0
    /// DrawLayoutProbe's frames (DEBUG builds only record any).
    @State private var probeFrames: [String: CGRect] = [:]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The results row instead of the deck: after my tap, when I had already drawn
    /// before this view appeared (a rejoin or a relaunch mid-draw), or for a spectator
    /// (who never draws: the server ignores a spectator's `draw`, so the deck is not theirs).
    private var showsResults: Bool { tapped || gameState.hasDrawn || gameState.isSpectator }

    var body: some View {
        GeometryReader { geo in
            let m = DrawMetrics(width: geo.size.width)
            ZStack {
                Theme.scrim
                    .ignoresSafeArea()

                ScrollView(.vertical) {
                    VStack(spacing: Theme.Space.s8) {
                        header
                        if showsResults {
                            resultsRow(m)
                        } else {
                            deckView(m)
                        }
                    }
                    .padding(.horizontal, m.gutter)
                    .padding(.vertical, Theme.Space.s6)
                    .frame(maxWidth: .infinity, minHeight: geo.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)

                if showTeams {
                    teamsOverlayView
                }
                #if DEBUG
                if UIFixture.isActive {
                    DrawLayoutProbeView(check: DrawLayoutProbe.check(probeFrames, container: CGRect(origin: .zero, size: geo.size)))
                }
                #endif
            }
            .onPreferenceChange(DrawLayoutProbe.Frames.self) { frames in
                probeFrames = frames
                #if DEBUG
                DrawLayoutProbe.record(frames, container: geo.frame(in: .global))
                #endif
            }
        }
        // the reader always takes the offered size, so a part that does not fit shows as outside it
        .coordinateSpace(name: DrawLayoutProbe.space)
        // the draw is table chrome: its own cap, past which the slots' names stop growing too
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
        .opacity(dismissing ? 0 : 1)
        .onAppear { flipArrived(gameState.drawResults.count) }
        .onChange(of: gameState.drawResults.count) { _, newCount in
            // Flip all new results (handles batched arrivals from bots)
            flipArrived(newCount)
        }
        .onChange(of: gameState.teamsAnnounced != nil, initial: true) { _, hasTeams in
            guard hasTeams else { return }
            // Show teams overlay after a brief pause
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                withAnimation(.easeInOut(duration: 0.5)) {
                    showTeams = true
                    teamsOpacity = 1
                }
            }
            // Auto-dismiss after 3 seconds
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.8) {
                #if DEBUG
                if UIFixture.holdsTeams { return }  // the draw-teams fixture keeps them up for its screenshots
                #endif
                withAnimation(.easeInOut(duration: 0.4)) {
                    dismissing = true
                }
            }
        }
    }

    private func flipArrived(_ count: Int) {
        for index in 0..<count where !flippedSlots.contains(index) {
            let delay = Double(index) * 0.3 + 0.1
            withAnimation(.easeOut(duration: 0.4).delay(delay)) {
                _ = flippedSlots.insert(index)
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: Theme.Space.s2) {
            Text("Draw for Deal")
                .themeFont(Theme.TypeScale.xxl, weight: Theme.Weight.bold, design: .rounded, relativeTo: .title)
                .foregroundStyle(Theme.textPrimary)
                .accessibilityAddTraits(.isHeader)
                .drawProbe("title")
            Text("The two highest cards are partners; the highest deals.")
                .themeFont(Theme.TypeScale.sm, relativeTo: .subheadline)
                .foregroundStyle(Theme.textSecondary)
                .drawProbe("rules")
        }
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: 480)
    }

    // MARK: - Deck

    private func deckView(_ m: DrawMetrics) -> some View {
        VStack(spacing: Theme.Space.s5) {
            Button(action: handleTap) {
                ZStack {
                    // three backs, each a little up and to the right: a deck
                    ForEach(0..<3, id: \.self) { i in
                        CardArtImage(image: CardTextureGenerator.cardBackImage(width: m.card.width), size: m.card)
                            .offset(x: CGFloat(i) * 2, y: CGFloat(-i) * 2)
                    }
                }
                .padding(.trailing, 4)
                .padding(.top, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(gameState.hasDrawn)
            .accessibilityLabel("Draw a card")
            .drawProbe("deck")

            Text("Tap to Draw")
                .themeFont(Theme.TypeScale.lg, weight: Theme.Weight.semibold, relativeTo: .title3)
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .opacity(pulseOpacity)
                .accessibilityHidden(true)  // the deck button says it
                .drawProbe("prompt")
                .onAppear {
                    guard !reduceMotion else { return }  // Reduce Motion: the prompt holds still
                    withAnimation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true)) {
                        pulseOpacity = 0.4
                    }
                }
        }
    }

    // MARK: - Draw Results

    private func resultsRow(_ m: DrawMetrics) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(0..<4, id: \.self) { index in
                drawSlot(index: index, m)
                    .frame(width: m.slotWidth)
            }
        }
    }

    private func drawSlot(index: Int, _ m: DrawMetrics) -> some View {
        let result = index < gameState.drawResults.count ? gameState.drawResults[index] : nil
        let isLocal = result != nil && result?.username == gameState.username
        // the card from DrawResult (the server sends it in playerDrew), else drawnCard for mine
        let card = result.flatMap { $0.card ?? (isLocal ? gameState.drawnCard : nil) }
        let faceUp = result != nil && flippedSlots.contains(index)

        return VStack(spacing: 0) {
            DrawAvatar(name: result?.username, pictureKey: result.flatMap { pictureKey(for: $0.username) }, isLocal: isLocal)
                .drawProbe("avatar.\(index)")
            // The name row is one unscaled line tall in every slot (a hidden "Ag" at the
            // name's font sets it, the name sits over it): a long name that shrinks to
            // nameMinScale also gets a shorter line, which would lift its card above the others.
            Text(verbatim: "Ag")
                .themeFont(Theme.TypeScale.sm, weight: Theme.Weight.semibold, relativeTo: .subheadline)
                .lineLimit(1)
                .dynamicTypeSize(...DrawMetrics.nameTypeCap)
                .hidden()
                // at most the card plus s3 (s3 / 2 past each side): an iPad slot's 24 pt gap would
                // otherwise let a long name run 8 pt past its card; on a phone the slot's s1
                // padding is the tighter limit (card + 4), so phones are unchanged
                .frame(maxWidth: m.card.width + Theme.Space.s3)
                .overlay {
                    Text(result?.username ?? "Waiting")
                        .themeFont(Theme.TypeScale.sm, weight: Theme.Weight.semibold, relativeTo: .subheadline)
                        .foregroundStyle(result == nil ? Theme.textDim : isLocal ? Theme.primary : Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .minimumScaleFactor(DrawMetrics.nameMinScale)
                        .dynamicTypeSize(...DrawMetrics.nameTypeCap)  // a fixed-width slot, like a seat's name
                        .background(alignment: .topLeading) { idealNameProbe(result?.username, index) }
                        .drawProbe("name.\(index)")
                }
                .padding(.horizontal, Theme.Space.s1)
                .padding(.top, Theme.Space.s2)
            Group {
                if result != nil {
                    FlipCard(angle: faceUp ? 180 : 0, face: card.map(CardTextureGenerator.image(for:)),
                             back: CardTextureGenerator.cardBackImage(width: m.card.width), size: m.card, flat: reduceMotion)
                } else {
                    RoundedRectangle(cornerRadius: m.cornerRadius)
                        .strokeBorder(Theme.inputBorder, style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
                        .background(RoundedRectangle(cornerRadius: m.cornerRadius).fill(Theme.surface.opacity(0.4)))
                        .frame(width: m.card.width, height: m.card.height)
                }
            }
            .drawProbe("card.\(index)")
            .padding(.top, DrawMetrics.nameToCard)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(result.map { isLocal ? "\($0.username), you" : $0.username } ?? "Waiting for a player to draw")
        .accessibilityValue(faceUp ? (card?.displayName ?? "") : "")
        .accessibilityIdentifier("draw.slot.\(index)")
    }

    /// DEBUG: the name at its full width (a hidden copy), so DrawLayoutProbe can tell a
    /// short name that was cut off; only for names of up to 8 characters (longer ones may
    /// end in "…", as a seat's does).
    @ViewBuilder
    private func idealNameProbe(_ name: String?, _ index: Int) -> some View {
        #if DEBUG
        if let name, name.count <= 8 {
            Text(name)
                .themeFont(Theme.TypeScale.sm, weight: Theme.Weight.semibold, relativeTo: .subheadline)
                .fixedSize()
                .dynamicTypeSize(...DrawMetrics.nameTypeCap)  // as the name itself (a background is outside its cap)
                .hidden()
                .drawProbe("nameIdeal.\(index)")
        }
        #endif
    }

    /// The seat's picture once the players are seated (positionUpdate comes before the teams).
    private func pictureKey(for username: String) -> String? {
        guard let seat = gameState.players.seats.values.first(where: { $0.username == username }) else { return nil }
        return seat.avatarUrl ?? seat.pic.string
    }

    // MARK: - Teams Overlay

    private var teamsOverlayView: some View {
        ZStack {
            Theme.scrim
                .ignoresSafeArea()

            if let teams = gameState.teamsAnnounced {
                // side by side where the names fit, else one team above the other
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .center, spacing: Theme.Space.s5) {
                        teamColumn(1, teams.team1)
                        versus
                        teamColumn(2, teams.team2)
                    }
                    VStack(alignment: .leading, spacing: Theme.Space.s4) {
                        teamColumn(1, teams.team1, wraps: true)
                        versus
                            .frame(maxWidth: .infinity)
                        teamColumn(2, teams.team2, wraps: true)
                    }
                    .frame(maxWidth: 360)
                }
                .padding(Theme.Space.s6)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.lg)
                        .fill(Theme.surface)
                        .elevation(Theme.Elevation.e3)
                )
                .padding(.horizontal, Theme.Space.s4)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("draw.teams")
                .drawProbe("teams")
            }
        }
        .opacity(teamsOpacity)
    }

    private var versus: some View {
        Text("vs")
            .themeFont(Theme.TypeScale.md, weight: Theme.Weight.medium)
            .foregroundStyle(Theme.textDim)
    }

    /// A team's label and players; `wraps`: a long name may take two lines (the stacked layout).
    private func teamColumn(_ team: Int, _ names: [String], wraps: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s3) {
            Text("Team \(team)")
                .themeFont(Theme.TypeScale.lg, weight: Theme.Weight.bold, design: .rounded, relativeTo: .title3)
                .foregroundStyle(Theme.team(team))
            ForEach(names, id: \.self) { name in
                HStack(spacing: Theme.Space.s2) {
                    DrawAvatar(name: name, pictureKey: pictureKey(for: name), isLocal: name == gameState.username)
                    Text(name)
                        .themeFont(Theme.TypeScale.md, weight: Theme.Weight.semibold, relativeTo: .body)
                        .foregroundStyle(name == gameState.username ? Theme.primary : Theme.textPrimary)
                        .lineLimit(wraps ? 2 : 1)
                        .fixedSize(horizontal: !wraps, vertical: true)
                }
            }
        }
        .fixedSize(horizontal: !wraps, vertical: true)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Actions

    private func handleTap() {
        guard !gameState.hasDrawn, !gameState.isSpectator else { return }
        tapped = true
        GameEmitter.draw(cardIndex: Int.random(in: 0..<54))
    }
}

// MARK: - Metrics

/// The draw's geometry for a window width: four slots across, each card at most
/// the hand card (TableLayout.maxCardPoints, the size CardTextureGenerator renders
/// for, so a card never samples up), the Theme spacing between them.
struct DrawMetrics: Equatable {
    /// From a name to its card (Theme.Space.s3; the 1.1 view had s2).
    static let nameToCard = Theme.Space.s3
    /// The slots' names stop growing here (a seat's name does not scale at all)...
    static let nameTypeCap = DynamicTypeSize.xxLarge
    /// ...and may shrink this far before a long one ends in "…".
    static let nameMinScale: CGFloat = 0.8
    let gutter: CGFloat
    /// One slot: the card plus the gap to the next.
    let slotWidth: CGFloat
    let card: CGSize

    init(width: CGFloat) {
        let maxCard = TableLayout.maxCardPoints
        gutter = Theme.Space.s4
        let gap = width < 600 ? Theme.Space.s3 : Theme.Space.s6
        slotWidth = min(maxCard.width + gap, ((width - 2 * gutter) / 4).rounded(.down))
        let w = max(slotWidth - gap, 1)
        card = CGSize(width: w, height: (w * maxCard.height / maxCard.width).rounded())
    }

    /// The art's corner radius (24 of its 300 units) at this size.
    var cornerRadius: CGFloat { card.width * 24 / 300 }
}

// MARK: - Card art

/// A card bitmap from CardTextureGenerator at `size` (its pixels sample 1:1 at
/// the hand card's size), with the table's raised-card shadow.
private struct CardArtImage: View {
    let image: UIImage
    let size: CGSize

    var body: some View {
        Image(uiImage: image)
            .resizable()
            .interpolation(.high)
            .antialiased(true)
            .frame(width: size.width, height: size.height)
            .elevation(Theme.Elevation.e2)
    }
}

/// A card that turns over around its vertical axis: the back up to 90 degrees,
/// then the face (`flat`, Reduce Motion: no turn, the face replaces the back half way).
private struct FlipCard: View, Animatable {
    var angle: Double
    let face: UIImage?
    let back: UIImage
    let size: CGSize
    let flat: Bool

    var animatableData: Double {
        get { angle }
        set { angle = newValue }
    }

    var body: some View {
        let showsFace = angle >= 90
        CardArtImage(image: showsFace ? (face ?? back) : back, size: size)
            .rotation3DEffect(.degrees(flat ? 0 : showsFace ? angle - 180 : angle), axis: (x: 0, y: 1, z: 0), perspective: 0.4)
    }
}

/// A player as the table's seats show one (OpponentHandNode): a circle in
/// surface.s2 with a line.strong ring and the bold initial, or the seat's picture
/// once the players are seated; mine has a primary ring. Its size is geometry, like
/// the seat's (not type).
private struct DrawAvatar: View {
    let name: String?
    let pictureKey: String?
    let isLocal: Bool
    @State private var image: UIImage?
    private let diameter = Theme.Space.s8

    var body: some View {
        Group {
            if let name {
                ZStack {
                    Circle().fill(Theme.surfaceLight)
                    if let image {
                        Image(uiImage: image).resizable().scaledToFill()
                    } else {
                        Text(String(name.prefix(1)).uppercased())
                            .font(.system(size: diameter * 0.45, weight: .bold))  // the seat's radius * 0.9
                            .foregroundStyle(Theme.textPrimary)
                    }
                }
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(isLocal ? Theme.primary : Theme.inputBorder, lineWidth: isLocal ? 2 : 1.5))
                .task(id: pictureKey) { image = await AvatarImageCache.image(for: pictureKey) }
            } else {
                Circle()
                    .strokeBorder(Theme.inputBorder, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
            }
        }
        .frame(width: diameter, height: diameter)
        .accessibilityHidden(true)
    }
}

// MARK: - Layout probe (DEBUG)

/// What the draw's layout tests read (DEBUG builds): the frames of the title,
/// rules line, deck, prompt, every slot's avatar / name / card and the teams
/// panel in the overlay's space, and `check`: "ok", or what is wrong (a name
/// closer than Theme.Space.s3 to its card, a short name cut off, the cards not on
/// one line, anything outside the overlay's safe area, two parts overlapping).
/// Release builds record nothing.
enum DrawLayoutProbe {
    static let space = "draw"

    struct Frames: PreferenceKey {
        static let defaultValue: [String: CGRect] = [:]
        static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
            value.merge(nextValue()) { $1 }
        }
    }

    static func check(_ frames: [String: CGRect], container: CGRect) -> String {
        var bad: [String] = []
        let inside = container.insetBy(dx: -0.5, dy: -0.5)
        for (key, f) in frames.sorted(by: { $0.key < $1.key }) where !inside.contains(f) {
            bad.append("\(key) outside \(f.integral)")
        }
        for i in 0..<4 {
            guard let name = frames["name.\(i)"], let card = frames["card.\(i)"] else { continue }
            let gap = card.minY - name.maxY
            if gap < Theme.Space.s3 - 0.01 { bad.append("name.\(i) \(gap) pt from its card") }
            // a short name shown in full (at worst shrunk to nameMinScale), not cut off
            if let ideal = frames["nameIdeal.\(i)"], ideal.width * DrawMetrics.nameMinScale > name.width + 0.5 {
                bad.append("name.\(i) cut off (\(Int(name.width)) of \(Int(ideal.width)) pt)")
            }
        }
        // the row's cards share one top edge, whatever their names do
        let cards = (0..<4).compactMap { i in frames["card.\(i)"].map { (i, $0) } }
        if let first = cards.first {
            for (i, card) in cards.dropFirst() where abs(card.minY - first.1.minY) > 0.5 {
                bad.append("card.\(i) top \(card.minY) not level with card.\(first.0) \(first.1.minY)")
            }
        }
        let blocks = ["title", "rules", "deck", "prompt"] + (0..<4).flatMap { ["avatar.\($0)", "name.\($0)", "card.\($0)"] }
        let present = blocks.compactMap { k in frames[k].map { (k, $0.insetBy(dx: 0.5, dy: 0.5)) } }
        for (a, ra) in present.enumerated() {
            for rb in present[(a + 1)...] where ra.1.intersects(rb.1) {
                bad.append("\(ra.0) overlaps \(rb.0)")
            }
        }
        return bad.isEmpty ? "ok" : bad.joined(separator: "; ")
    }

    #if DEBUG
    /// The latest frames and container (unit tests read these; main thread only).
    /// `lastContainer` is in window coordinates; the frames are relative to its origin.
    static var lastFrames: [String: CGRect] = [:]
    static var lastContainer: CGRect = .zero
    static func record(_ frames: [String: CGRect], container: CGRect) {
        lastFrames = frames
        lastContainer = container
    }

    /// `check` on the latest record.
    static var lastCheck: String { check(lastFrames, container: CGRect(origin: .zero, size: lastContainer.size)) }
    #endif
}

extension View {
    /// Records this view's frame for DrawLayoutProbe (DEBUG only).
    func drawProbe(_ key: String) -> some View {
        #if DEBUG
        background(GeometryReader { p in
            Color.clear.preference(key: DrawLayoutProbe.Frames.self, value: [key: p.frame(in: .named(DrawLayoutProbe.space))])
        })
        #else
        self
        #endif
    }
}

#if DEBUG
/// The "draw.layoutCheck" probe for XCUITest (fixture mode), 1x1 and nearly transparent.
private struct DrawLayoutProbeView: View {
    let check: String

    var body: some View {
        Rectangle()
            .fill(Color.black)
            .frame(width: 1, height: 1)
            .opacity(0.01)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .allowsHitTesting(false)
            .accessibilityElement()
            .accessibilityLabel("draw.layoutCheck")
            .accessibilityIdentifier("draw.layoutCheck")
            .accessibilityValue(check)
    }
}
#endif

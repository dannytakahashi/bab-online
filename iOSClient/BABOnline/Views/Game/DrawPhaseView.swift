import SwiftUI

/// Interactive draw-for-deal phase — replaces the SpriteKit auto-draw.
/// User taps a deck to draw; all 4 player cards are revealed with flip animations.
struct DrawPhaseView: View {
    @EnvironmentObject var gameState: GameState
    @State private var tapped = false
    @State private var flippedSlots: Set<Int> = []
    @State private var showTeams = false
    @State private var teamsOpacity: Double = 0
    @State private var dismissing = false
    @State private var pulseOpacity: Double = 1.0

    var body: some View {
        ZStack {
            // Dark overlay
            Color.black.opacity(0.7)
                .ignoresSafeArea()

            VStack(spacing: 24) {
                // Title
                Text("Draw for Deal")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .padding(.top, 60)

                Spacer()

                if !tapped {
                    // Deck to tap
                    deckView
                } else {
                    // Draw results grid
                    drawResultsView
                }

                Spacer()
            }

            // Teams overlay
            if showTeams {
                teamsOverlayView
            }
        }
        .opacity(dismissing ? 0 : 1)
        .onChange(of: gameState.drawResults.count) { _, newCount in
            // Flip all new results (handles batched arrivals from bots)
            for index in 0..<newCount where !flippedSlots.contains(index) {
                let delay = Double(index) * 0.3 + 0.1
                withAnimation(.easeOut(duration: 0.4).delay(delay)) {
                    _ = flippedSlots.insert(index)
                }
            }
        }
        .onChange(of: gameState.teamsAnnouncedData != nil) { _, hasTeams in
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
                withAnimation(.easeInOut(duration: 0.4)) {
                    dismissing = true
                }
            }
        }
    }

    // MARK: - Deck View

    private var deckView: some View {
        VStack(spacing: 16) {
            // Stacked card backs
            Button(action: handleTap) {
                ZStack {
                    // Offset cards for depth
                    ForEach(0..<3, id: \.self) { i in
                        cardBackImage
                            .offset(x: CGFloat(i) * 3, y: CGFloat(-i) * 3)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(gameState.hasDrawn)

            // Prompt
            Text("Tap to Draw")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Color.Theme.textSecondary)
                .opacity(pulseOpacity)
                .onAppear {
                    withAnimation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true)) {
                        pulseOpacity = 0.4
                    }
                }
        }
    }

    // MARK: - Draw Results

    private var drawResultsView: some View {
        HStack(spacing: 12) {
            ForEach(0..<4, id: \.self) { index in
                drawSlot(index: index)
            }
        }
        .padding(.horizontal, 16)
    }

    private func drawSlot(index: Int) -> some View {
        let hasResult = index < gameState.drawResults.count
        let result = hasResult ? gameState.drawResults[index] : nil
        let isFlipped = flippedSlots.contains(index)
        let isLocal = result?.username == gameState.username

        return VStack(spacing: 8) {
            // Username
            Text(result?.username ?? "...")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(isLocal ? Color.Theme.primary : .white)
                .lineLimit(1)

            // Card
            if hasResult && isFlipped {
                cardFaceView(for: result!)
            } else {
                cardBackImage
            }
        }
        .opacity(hasResult ? 1 : 0.3)
    }

    // MARK: - Card Views

    private var cardWidth: CGFloat { 70 }
    private var cardHeight: CGFloat { 101.5 }

    private var cardBackImage: some View {
        CardBackShape()
            .frame(width: cardWidth, height: cardHeight)
    }

    private func cardFaceView(for result: DrawResult) -> some View {
        // Use card from DrawResult (server sends it in playerDrew), fall back to drawnCard for local
        let card = result.card ?? (result.username == gameState.username ? gameState.drawnCard : nil)
        return CardFaceShape(card: card)
            .frame(width: cardWidth, height: cardHeight)
    }

    // MARK: - Teams Overlay

    private var teamsOverlayView: some View {
        ZStack {
            Color.black.opacity(0.8)
                .ignoresSafeArea()

            VStack(spacing: 20) {
                if let data = gameState.teamsAnnouncedData {
                    let team1 = data["team1"] as? [String] ?? []
                    let team2 = data["team2"] as? [String] ?? []

                    Text("Team 1")
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(Color.Theme.teamColor)

                    Text(team1.joined(separator: " & "))
                        .font(.system(size: 20))
                        .foregroundStyle(.white)

                    Text("vs")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(Color.Theme.textDim)
                        .padding(.vertical, 4)

                    Text("Team 2")
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(Color.Theme.oppColor)

                    Text(team2.joined(separator: " & "))
                        .font(.system(size: 20))
                        .foregroundStyle(.white)
                }
            }
        }
        .opacity(teamsOpacity)
    }

    // MARK: - Actions

    private func handleTap() {
        guard !gameState.hasDrawn else { return }
        tapped = true
        GameEmitter.draw(cardIndex: Int.random(in: 0..<54))
    }
}

// MARK: - Card Back Shape

/// A SwiftUI rendition of the card back design.
private struct CardBackShape: View {
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(red: 0.1, green: 0.3, blue: 0.15))

            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(Color(red: 0.2, green: 0.5, blue: 0.25), lineWidth: 2)

            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(Color(red: 0.15, green: 0.4, blue: 0.2), lineWidth: 1)
                .padding(6)

            // Center diamond
            Diamond()
                .fill(Color(red: 0.25, green: 0.55, blue: 0.3))
                .frame(width: 20, height: 28)

            Diamond()
                .stroke(Color(red: 0.3, green: 0.65, blue: 0.35), lineWidth: 1)
                .frame(width: 20, height: 28)
        }
    }
}

/// A SwiftUI rendition of a card face.
private struct CardFaceShape: View {
    let card: Card?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.white)

            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(Color(white: 0.7), lineWidth: 1)

            if let card = card {
                VStack(spacing: 0) {
                    // Top-left rank + suit
                    HStack {
                        VStack(spacing: -2) {
                            Text(rankString(card.rank))
                                .font(.system(size: 14, weight: .bold))
                            Text(suitSymbol(card.suit))
                                .font(.system(size: 12))
                        }
                        .foregroundStyle(suitColor(card.suit))
                        .padding(.leading, 4)
                        .padding(.top, 4)
                        Spacer()
                    }

                    Spacer()

                    // Center suit
                    Text(card.isJoker ? "\u{2605}" : suitSymbol(card.suit))
                        .font(.system(size: 32))
                        .foregroundStyle(card.isJoker ? .purple : suitColor(card.suit))

                    Spacer()

                    // Bottom-right
                    HStack {
                        Spacer()
                        VStack(spacing: -2) {
                            Text(suitSymbol(card.suit))
                                .font(.system(size: 12))
                            Text(rankString(card.rank))
                                .font(.system(size: 14, weight: .bold))
                        }
                        .foregroundStyle(suitColor(card.suit))
                        .rotationEffect(.degrees(180))
                        .padding(.trailing, 4)
                        .padding(.bottom, 4)
                    }
                }
            } else {
                // Unknown card — show question mark
                Text("?")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(Color(white: 0.6))
            }
        }
    }

    private func suitColor(_ suit: Suit) -> Color {
        switch suit {
        case .hearts, .diamonds: return Color(red: 0.85, green: 0.1, blue: 0.1)
        case .spades, .clubs: return Color(red: 0.1, green: 0.1, blue: 0.1)
        case .joker: return .purple
        }
    }

    private func suitSymbol(_ suit: Suit) -> String {
        switch suit {
        case .spades: return "\u{2660}"
        case .hearts: return "\u{2665}"
        case .diamonds: return "\u{2666}"
        case .clubs: return "\u{2663}"
        case .joker: return "\u{2605}"
        }
    }

    private func rankString(_ rank: Rank) -> String {
        switch rank {
        case .ace: return "A"
        case .king: return "K"
        case .queen: return "Q"
        case .jack: return "J"
        case .hi: return "HI"
        case .lo: return "LO"
        default: return rank.rawValue
        }
    }
}

/// Simple diamond shape.
private struct Diamond: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let mid = CGPoint(x: rect.midX, y: rect.midY)
        path.move(to: CGPoint(x: mid.x, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: mid.y))
        path.addLine(to: CGPoint(x: mid.x, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: mid.y))
        path.closeSubpath()
        return path
    }
}

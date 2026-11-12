import SwiftUI
import UIKit

/// Semantic roles over the generated design tokens (Generated/Theme.swift, from
/// client/tokens/tokens.json; roadmap item 29). Views and SpriteKit nodes use these
/// roles, never a literal color, font size or a one-off spacing: change tokens.json
/// and run `npm run tokens`. Every text-on-surface pair a role is used for is a
/// tokens.json `contrast` pair (WCAG AA), checked by tokens.test.js and ThemeTests.
extension Theme {
    // MARK: Surfaces (the web's night card room)

    /// Screen background (sign-in, main room, lobbies).
    static let background = Palette.Surface.s0.color
    /// Panels, rows, sheets, the score bar.
    static let surface = Palette.Surface.s1.color
    /// Raised rows and idle chips on a panel.
    static let surfaceLight = Palette.Surface.s2.color
    /// Hovered rows, disabled and secondary buttons.
    static let surfaceRaised = Palette.Surface.s3.color
    /// The table felt.
    static let felt = Palette.Felt.base.color
    /// The modal dimmer (game end, draw, results).
    static let scrim = Palette.scrim.color

    // MARK: Text

    static let textPrimary = Palette.Text.primary.color
    static let textSecondary = Palette.Text.secondary.color
    static let textDim = Palette.Text.dim.color
    /// Text on a light fill (the chat bubble, a warning button).
    static let textOnLight = Palette.Text.onLight.color

    // MARK: Brand and status

    static let primary = Palette.Primary.base.color
    static let success = Palette.success.color
    static let warning = Palette.warning.color
    static let gold = Palette.gold.color
    /// Error and "defeat" text.
    static let error = Palette.Danger.text.color
    /// A destructive / "cancel ready" fill (text.primary on it).
    static let danger = Palette.Danger.solid.color

    // MARK: Lines and inputs

    static let inputBackground = Palette.Surface.s0.color
    static let inputBorder = Palette.Line.strong.color
    static let divider = Palette.Line.subtle.color

    // MARK: Buttons (fill and its text, a contrast pair each)

    /// The primary button (the web's kit Button): primary.base under text.onPrimary.
    static let buttonBackground = Palette.Primary.base.color
    static let buttonForeground = Palette.Text.onPrimary.color
    static let buttonDisabled = Palette.Surface.s3.color
    static let buttonDisabledForeground = Palette.Text.dim.color
    /// The secondary button (the web's kit secondary): surface.s3, a strong edge, text.primary.
    static let buttonSecondary = Palette.Surface.s3.color
    static let buttonSecondaryForeground = Palette.Text.primary.color
    static let buttonSecondaryBorder = Palette.Line.strong.color
    /// The text on a danger fill.
    static let dangerForeground = Palette.Text.primary.color
    /// The text on a warning fill.
    static let warningForeground = Palette.Text.onLight.color

    // MARK: Medals (tournament standings, leaderboard)

    static let medalGold = Palette.gold.color
    static let medalSilver = Palette.Medal.silver.color
    static let medalBronze = Palette.Medal.bronze.color

    /// 1st, 2nd, 3rd in medal colors, anything else nil.
    static func medal(rank: Int) -> Color? {
        switch rank {
        case 1: return medalGold
        case 2: return medalSilver
        case 3: return medalBronze
        default: return nil
        }
    }

    // MARK: Teams (absolute, as on the web: team 1 = seats 1 and 3 = team A)

    static let teamA = Palette.Team.a.color
    static let teamB = Palette.Team.b.color

    /// Team 1 is A, team 2 is B.
    static func team(_ teamNumber: Int) -> Color { teamNumber == 2 ? teamB : teamA }

    /// The team color of a seat (1...4).
    static func team(forPosition position: Int) -> Color { team(Positions.getTeamNumber(position)) }

    // MARK: Cards (the drawn faces of CardTextureGenerator and the draw phase)

    enum CardInk {
        static let red = Palette.Card.red
        static let black = Palette.Card.black
        static let joker = Palette.Card.joker
    }

    /// Suit glyphs on a dark surface (trump in the score bar): hearts and diamonds in danger.text.
    static func suitOnDark(_ suit: Suit) -> Color {
        switch suit {
        case .hearts, .diamonds: return Palette.Danger.text.color
        case .spades, .clubs: return Palette.Text.primary.color
        case .joker: return Palette.gold.color
        }
    }

    // MARK: SpriteKit (UIColor)

    enum SK {
        /// The scene behind the felt and the felt itself.
        static let sceneBackground = Palette.Felt.edge.uiColor
        static let felt = Palette.Felt.base.uiColor
        /// Seat avatar circle and its edge.
        static let avatarFill = Palette.Surface.s2.uiColor
        static let avatarStroke = Palette.Line.strong.uiColor
        static let label = Palette.Text.primary.uiColor
        /// The turn ring (gold, as the web's) and the speaking ring (success).
        static let turnGlow = Palette.gold.opacity(0.5).uiColor
        static let speakingFill = Palette.success.opacity(0.4).uiColor
        static let speakingStroke = Palette.success.opacity(0.7).uiColor
        /// The bid bubble: the seat plate glass (surface.s2@0.86) with a team-neutral edge.
        static let bidBubbleFill = Palette.Surface.s2.opacity(0.86).uiColor
        static let bidBubbleStroke = Palette.Primary.base.uiColor
        /// Chat bubbles: a seat's is light (text.onLight on text.primary), a spectator's success-tinted.
        static let chatFill = Palette.Text.primary.opacity(0.92).uiColor
        static let chatText = Palette.Text.onLight.uiColor
        static let spectatorChatFill = Palette.Felt.light.opacity(0.95).uiColor
        static let spectatorChatText = Palette.Text.primary.uiColor
        static let teamA = Palette.Team.a.uiColor
        static let teamB = Palette.Team.b.uiColor
        /// Seat pips (the web's .hud-pips): the box (surface.s0@0.85), an empty slot's edge
        /// (text.primary@0.55), a won slot in the seat's team color, past the bid gold, and a
        /// bore seat's outline in the bore chip's red (danger.solid).
        static let pipBox = Palette.Surface.s0.opacity(0.85).uiColor
        static let pipEmpty = Palette.Text.primary.opacity(0.55).uiColor
        static let pipOver = Palette.gold.uiColor
        static let pipBore = Palette.Danger.solid.uiColor
        /// The trick history's bid border (the web's TrickManager piles): danger.text until the
        /// team has its bid total, then success; an unwon bid slot is surface.s3.
        static let pileSafe = Palette.success.uiColor
        static let pileDanger = Palette.Danger.text.uiColor
        static let pileSlot = Palette.Surface.s3.opacity(0.9).uiColor

        static func team(_ teamNumber: Int) -> UIColor { teamNumber == 2 ? teamB : teamA }

        /// A font for SKLabelNode.fontName by weight. SpriteKit loads fonts by name and the
        /// system font has no public one (its ".SFUI" name falls back to Times), so this is
        /// the first family of tokens.json font.ui that UIKit knows by name: Helvetica Neue.
        static func fontName(_ weight: UIFont.Weight) -> String { fontNames[weight] ?? resolveFontName(weight) }

        private static let fontNames: [UIFont.Weight: String] = Dictionary(
            uniqueKeysWithValues: [UIFont.Weight.regular, .medium, .semibold, .bold].map { ($0, resolveFontName($0)) })

        private static func resolveFontName(_ weight: UIFont.Weight) -> String {
            let suffix = weight >= .bold ? "-Bold" : weight >= .medium ? "-Medium" : ""
            for family in Theme.fontStack where !UIFont.fontNames(forFamilyName: family).isEmpty {
                let name = family.replacingOccurrences(of: " ", with: "") + suffix
                if UIFont(name: name, size: 12) != nil { return name }
            }
            return weight >= .medium ? "HelveticaNeue-Bold" : "HelveticaNeue"
        }
    }

    // MARK: Type

    /// A token type size as a system font that follows Dynamic Type (scaled relative to `style`).
    static func font(_ size: CGFloat, weight: Font.Weight = Weight.regular, design: Font.Design = .default,
                     relativeTo style: Font.TextStyle = .body) -> Font {
        let scaled = UIFontMetrics(forTextStyle: style.uiKit).scaledValue(for: size)
        return .system(size: scaled, weight: weight, design: design)
    }
}

extension View {
    /// A tokens.json elevation (e1...e3) as SwiftUI shadows (CSS blur is about twice SwiftUI's radius).
    func elevation(_ layers: [Theme.ShadowLayer]) -> some View {
        layers.reduce(AnyView(self)) { view, l in
            AnyView(view.shadow(color: l.color.color, radius: l.blur / 2, x: l.x, y: l.y))
        }
    }

    /// The secondary button look (fill, edge, text) at a radius.
    func secondaryButtonStyle(radius: CGFloat = Theme.Radius.sm) -> some View {
        foregroundColor(Theme.buttonSecondaryForeground)
            .background(Theme.buttonSecondary)
            .overlay(RoundedRectangle(cornerRadius: radius).stroke(Theme.buttonSecondaryBorder, lineWidth: 1))
            .cornerRadius(radius)
    }

    /// A token type size that re-scales live with Dynamic Type (@ScaledMetric).
    func themeFont(_ size: CGFloat, weight: Font.Weight = Theme.Weight.regular, design: Font.Design = .default,
                   relativeTo style: Font.TextStyle = .body) -> some View {
        modifier(ThemeFontModifier(size: size, weight: weight, design: design, style: style))
    }
}

private struct ThemeFontModifier: ViewModifier {
    @ScaledMetric private var size: CGFloat
    let weight: Font.Weight
    let design: Font.Design

    init(size: CGFloat, weight: Font.Weight, design: Font.Design, style: Font.TextStyle) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
        self.weight = weight
        self.design = design
    }

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight, design: design))
    }
}

private extension Font.TextStyle {
    var uiKit: UIFont.TextStyle {
        switch self {
        case .largeTitle: return .largeTitle
        case .title: return .title1
        case .title2: return .title2
        case .title3: return .title3
        case .headline: return .headline
        case .subheadline: return .subheadline
        case .callout: return .callout
        case .footnote: return .footnote
        case .caption: return .caption1
        case .caption2: return .caption2
        default: return .body
        }
    }
}

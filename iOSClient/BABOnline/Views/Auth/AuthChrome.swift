import SwiftUI

/// The web's sign-in / register look (client/src/ui/screens/SignIn.js, Register.js;
/// styles/screens.css "Sign in / register"), natively: the night card room behind
/// (`AuthVignette`), the logo with its glow and the Minecraft-style phrase (`AuthLogo`),
/// an elevated kit panel (`AuthCard`), labelled 16 pt fields (`AuthField`), 44 pt kit
/// buttons (`AuthButtonStyle`) and the "New user?" rule (`AuthDivider`). The boot splash
/// (SplashView) ends on the same vignette, so the hand-off to these screens only
/// changes what stands on it.

// MARK: - Phrases

/// The phrases by the logo: the web's `SPLASH_PHRASES` (SignIn.js), in its order. Kept in
/// sync by `AuthSplashTests.testPhrasesMatchTheWeb`, which reads the web file from the checkout.
enum SplashPhrases {
    static let all: [String] = [
        "he sends a boy!",
        "i got my bid...",
        "out of boolats!",
        "heartless!",
        "this one is mandatory.",
        "i bid on that one.",
        "you need to get my one.",
        "surely...",
        "no guts, no glory!",
        "the locusts descend!",
        "eat fast, kick ass!",
        "5...what's trump?",
        "this is a man's game!",
        "you should be dealing already!",
        "i did it frank's way, that bastard!",
        "alls we gotta do...",
        "coulda bored!",
    ]

    /// One at random, as the web picks one per sign-in screen.
    static func random() -> String {
        #if DEBUG
        if let i = UIFixture.phraseIndex, all.indices.contains(i) { return all[i] }
        #endif
        return all.randomElement() ?? ""
    }
}

// MARK: - Background

/// The page behind the auth card and the end of the boot splash: the table's lit felt
/// under the lamp, falling off to the room's dark (the web's `.auth-vignette`:
/// radial-gradient(ellipse 62% 58% at 50% 36%, ...)). No animation; decorative.
struct AuthVignette: View {
    var body: some View {
        GeometryReader { g in
            // the CSS ellipse's radii are 62% of the width and 58% of the height: a unit
            // circle gradient stretched to them
            let rx = max(g.size.width * 0.62, 1), ry = max(g.size.height * 0.58, 1)
            ZStack {
                Theme.Auth.room
                RadialGradient(stops: Theme.Auth.vignetteStops, center: .center, startRadius: 0, endRadius: rx)
                    .frame(width: rx * 2, height: rx * 2)
                    .scaleEffect(x: 1, y: ry / rx)
                    .position(x: g.size.width / 2, y: g.size.height * 0.36)
            }
            .frame(width: g.size.width, height: g.size.height)
            .clipped()
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }
}

// MARK: - Logo

/// The logo (Misc.xcassets `logo`, the web's assets/logo.png) with the web's glow, so its
/// black lettering keeps an edge on the dark room. VoiceOver reads "BAB Online".
struct AuthLogoImage: View {
    let width: CGFloat

    /// assets/logo.png is 723 x 337.
    static let aspect: CGFloat = 723.0 / 337.0

    var body: some View {
        Image("logo")
            .resizable()
            .interpolation(.high)
            .aspectRatio(Self.aspect, contentMode: .fit)
            .frame(width: width)
            .shadow(color: Theme.Auth.logoGlow, radius: 3)
            .accessibilityLabel("BAB Online")
            .accessibilityAddTraits(.isImage)
    }

    /// The logo's width on a screen of `size`: about 70% of a phone's width (the web's 26 vw
    /// is a desktop size), at most 340 pt (an iPad), and a short landscape height keeps it
    /// to about a third of the screen so the form stays near.
    static func width(for size: CGSize) -> CGFloat {
        max(160, min(size.width * 0.72, 340, size.height * 0.62))
    }
}

/// The logo with the phrase, which plays in once (none under Reduce Motion), as the web's
/// `.auth-logo-wrap` + `.auth-splash`. The phrase is decorative (hidden from VoiceOver).
struct AuthLogo: View {
    let width: CGFloat
    /// The screen's width, so a long phrase is kept on screen.
    let screenWidth: CGFloat
    var phrase: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// True while the boot splash stands over this screen (ContentView): the phrase waits
    /// for the hand-off, so it plays in where it can be seen.
    @Environment(\.bootSplashShowing) private var splashShowing
    @State private var phraseIn = false

    var body: some View {
        AuthLogoImage(width: width)
            .accessibilityIdentifier("auth.logo")
            .overlay(alignment: .topLeading) {
                if let phrase { phraseView(phrase) }
            }
            // where the boot splash puts its logo, so its last frame is this screen's logo
            // (measured only while the splash stands over this screen)
            .background {
                if splashShowing {
                    GeometryReader { g in
                        Color.clear.preference(key: AuthLogoFrameKey.self, value: g.frame(in: .global))
                    }
                }
            }
    }

    private func phraseView(_ text: String) -> some View {
        let height = width / AuthLogoImage.aspect
        // centred under the jokers' corner, rotated -15 degrees as the web's; never wider
        // than the room to the screen's edges (a long phrase shrinks, it is never cut)
        let cx = width * 0.78, cy = height * 0.84
        let logoLeft = (screenWidth - width) / 2
        let room = min(logoLeft + cx, screenWidth - logoLeft - cx) - Theme.Space.s3
        let maxWidth = max(80, room * 2 / 0.97)
        let size = max(Theme.TypeScale.sm - 1, width * 0.054)
        return Text(text)
            .font(.system(size: size, weight: Theme.Weight.bold).italic())
            .foregroundStyle(Theme.Auth.phrase)
            .shadow(color: Theme.Auth.phraseShadow, radius: 2, y: 2)
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            .frame(width: maxWidth)
            .rotationEffect(.degrees(-15))
            .scaleEffect(phraseIn || reduceMotion ? 1 : 0.85)
            .opacity(phraseIn || reduceMotion ? 1 : 0)
            .position(x: cx, y: cy)
            .frame(width: width, height: height, alignment: .topLeading)
            .accessibilityHidden(true)
            .allowsHitTesting(false)
            .onAppear { if !splashShowing { playPhrase() } }
            .onChange(of: splashShowing) { _, showing in if !showing { playPhrase() } }
    }

    private func playPhrase() {
        guard !reduceMotion, !phraseIn else { return }
        withAnimation(Theme.Motion.emphasizedAnimation(Theme.Motion.slow).delay(AuthTiming.phraseDelay)) {
            phraseIn = true
        }
    }
}

enum AuthTiming {
    /// The phrase plays in once the boot splash has mostly cleared (or the screen change has).
    static let phraseDelay: TimeInterval = 0.2
}

/// The sign-in / register logo's frame in global coordinates, for the boot splash
/// (ContentView passes it to SplashView's `logoTarget`). nil where no auth logo is drawn.
struct AuthLogoFrameKey: PreferenceKey {
    static let defaultValue: CGRect? = nil
    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) {
        value = nextValue() ?? value
    }
}

private struct BootSplashShowingKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// True while the boot splash stands over the screen (ContentView sets it).
    var bootSplashShowing: Bool {
        get { self[BootSplashShowingKey.self] }
        set { self[BootSplashShowingKey.self] = newValue }
    }
}

extension Theme.Motion {
    /// The tokens' emphasized curve (motion.emphasized, the web's --ease-emphasized).
    static func emphasizedAnimation(_ duration: TimeInterval) -> Animation {
        .timingCurve(emphasized[0], emphasized[1], emphasized[2], emphasized[3], duration: duration)
    }
}

// MARK: - Card

/// The web's `.auth-card`: a kit panel (surface.s1@0.92, line.subtle edge, radius lg,
/// elevation 3), 24 pt padding, 12 pt between rows, 360 pt wide (wider at accessibility
/// type sizes, so the fields keep their words).
struct AuthCard<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    /// The boot splash ends on this screen without its card (ContentView), so the card is
    /// what the hand-off brings in.
    @Environment(\.bootSplashShowing) private var splashShowing
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: Theme.Space.s3) { content }
            .padding(Theme.Space.s6)
            .frame(maxWidth: typeSize.isAccessibilitySize ? 520 : 360)
            .background {
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .fill(Theme.Auth.cardFill)
                    .elevation(Theme.Elevation.e3)
            }
            .overlay {
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .stroke(Theme.Auth.cardEdge, lineWidth: 1)
            }
            .opacity(splashShowing ? 0 : 1)
            .animation(.easeOut(duration: SplashTimeline.handOff), value: splashShowing)
    }
}

// MARK: - Fields

/// A labelled kit input (the web's `authField`): the label above in text.secondary 14 pt
/// medium, the input at least 44 pt tall, 16 pt text, surface.s0, a line.strong edge that
/// turns team.a while focused. The input carries the label as its accessibility label
/// (SwiftUI does not expose a TextField's title to VoiceOver when it has a prompt), so
/// VoiceOver reads it once, the visible label being hidden from it; the identifier is the
/// label too, which the live UI tests find the fields by.
struct AuthField<Focus: Hashable>: View {
    let label: String
    @Binding var text: String
    var secure = false
    let contentType: PlatformTextContentType
    let focus: FocusState<Focus?>.Binding
    let field: Focus

    private var isFocused: Bool { focus.wrappedValue == field }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s1) {
            Text(label)
                .themeFont(Theme.TypeScale.sm, weight: Theme.Weight.medium, relativeTo: .subheadline)
                .foregroundStyle(Theme.Auth.fieldLabel)
                .accessibilityHidden(true)
            input
                .themeFont(Theme.TypeScale.md, relativeTo: .body)
                .foregroundStyle(Theme.textPrimary)
                .tint(Theme.Auth.fieldFocus)
                .textContentType(contentType)
                .focused(focus, equals: field)
                .padding(.horizontal, Theme.Space.s3)
                .padding(.vertical, Theme.Space.s2)
                .frame(minHeight: Theme.hitTarget)
                .background(Theme.Auth.fieldFill, in: RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                        .stroke(isFocused ? Theme.Auth.fieldFocus : Theme.Auth.fieldEdge, lineWidth: 1)
                }
                .accessibilityLabel(Text(label))
                .accessibilityIdentifier(label)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var input: some View {
        if secure {
            SecureField(label, text: $text, prompt: Text(""))
        } else {
            TextField(label, text: $text, prompt: Text(""))
                .noAutocapitalization()
                .autocorrectionDisabled()
        }
    }
}

// MARK: - Buttons

/// The web's kit buttons on the auth card: full width, at least 44 pt, radius md, 16 pt
/// semibold; primary (primary.base under text.onPrimary), secondary (surface.s3, a
/// line.strong edge, text.primary) and ghost (text.secondary, 14 pt). Pressed at 97%, as
/// `.kit-btn`; disabled at 45%, except the primary, whose fill alone dims (to 70%).
struct AuthButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, ghost }
    let kind: Kind

    func makeBody(configuration: Configuration) -> some View {
        AuthButtonBody(kind: kind, label: configuration.label, pressed: configuration.isPressed)
    }
}

private struct AuthButtonBody<Label: View>: View {
    let kind: AuthButtonStyle.Kind
    let label: Label
    let pressed: Bool
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        label
            .themeFont(kind == .ghost ? Theme.TypeScale.sm : Theme.TypeScale.md, weight: Theme.Weight.semibold,
                       relativeTo: kind == .ghost ? .subheadline : .body)
            .multilineTextAlignment(.center)
            .foregroundStyle(foreground)
            .padding(.horizontal, kind == .ghost ? Theme.Space.s3 : Theme.Space.s5)
            .padding(.vertical, Theme.Space.s2)
            .frame(maxWidth: .infinity, minHeight: Theme.hitTarget)
            .background(background, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
            .overlay {
                if kind == .secondary {
                    RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                        .stroke(Theme.buttonSecondaryBorder, lineWidth: 1)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
            .opacity(isEnabled || kind == .primary ? 1 : Self.disabledOpacity)
            .scaleEffect(pressed && isEnabled ? 0.97 : 1)
            .animation(.easeOut(duration: Theme.Motion.fast), value: pressed)
    }

    private var foreground: Color {
        switch kind {
        case .primary: return Theme.buttonForeground
        case .secondary: return Theme.buttonSecondaryForeground
        case .ghost: return Theme.textSecondary
        }
    }

    /// The kit's disabled secondary / ghost button (`.kit-btn:disabled`).
    static var disabledOpacity: Double { 0.45 }
    /// A disabled primary keeps reading as the main action (the web's Sign In is never
    /// dimmed: it toasts on empty fields): only its fill dims, to 70%, and the label stays
    /// text.onPrimary at full strength (4.8:1 on that fill over the card; 8.3:1 enabled).
    static var disabledPrimaryFill: Double { 0.7 }

    private var background: Color {
        switch kind {
        case .primary: return isEnabled ? Theme.buttonBackground : Theme.buttonBackground.opacity(Self.disabledPrimaryFill)
        case .secondary: return Theme.buttonSecondary
        case .ghost: return .clear
        }
    }
}

// MARK: - Divider

/// The web's `.auth-divider`: a line.strong rule either side of a dim 12 pt caption.
struct AuthDivider: View {
    let text: String

    var body: some View {
        HStack(spacing: Theme.Space.s3) {
            rule
            Text(text)
                .themeFont(Theme.TypeScale.xs, relativeTo: .caption)
                .foregroundStyle(Theme.Auth.dividerText)
                .fixedSize()
            rule
        }
        .padding(.vertical, Theme.Space.s1)
    }

    private var rule: some View {
        Rectangle().fill(Theme.Auth.dividerLine).frame(height: 1).accessibilityHidden(true)
    }
}

// MARK: - Screen

/// The scrolling page the two auth screens share: the vignette, then the logo and the card
/// centred, scrolling on short heights (the keyboard, landscape) with the keyboard
/// dismissed by a drag.
struct AuthScreen<Card: View>: View {
    var phrase: String?
    @ViewBuilder let card: Card

    var body: some View {
        ZStack {
            AuthVignette()
            GeometryReader { g in
                ScrollView {
                    VStack(spacing: Theme.Space.s4) {
                        Spacer(minLength: Theme.Space.s4)
                        AuthLogo(width: AuthLogoImage.width(for: g.size), screenWidth: g.size.width, phrase: phrase)
                            .padding(.bottom, phrase == nil ? 0 : Theme.Space.s3)  // the phrase hangs under the logo
                        // its ideal height: the page grows and scrolls rather than squeezing a line
                        card.fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: Theme.Space.s4)
                    }
                    .padding(.horizontal, Theme.Space.s4)
                    .frame(maxWidth: .infinity, minHeight: g.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
                .scrollDismissesKeyboard(.interactively)
            }
        }
    }
}

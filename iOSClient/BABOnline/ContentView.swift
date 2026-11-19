import SwiftUI

/// Root navigation switch — replaces screens like the web client.
struct ContentView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var socketService: SocketService
    @EnvironmentObject var mainRoomState: MainRoomState
    @EnvironmentObject var lobbyState: LobbyState
    @EnvironmentObject var tournamentState: TournamentState
    @EnvironmentObject var gameState: GameState
    @Environment(\.horizontalSizeClass) private var hSizeClass
    @Environment(\.verticalSizeClass) private var vSizeClass
    @State private var showSplash = true
    /// Where the sign-in's logo stands (global), for the splash's last frame.
    @State private var splashLogoTarget: CGRect?
    /// When the splash logo's last glide to a new target ends (the hand-off waits for it).
    @State private var logoGlideEnds: Date?
    /// The screen is shown (opaque, in the accessibility tree): from the splash's hand-off.
    @State private var contentShown = false
    /// The one "the server restarted" message after a reconnect (RestartNotice).
    @ObservedObject private var restart = RestartNotices.shared

    /// Card faces render off the main thread from the game / tournament lobby on (or a
    /// rejoin straight into the game), so the first deal finds them cached (once per process).
    static func prewarmCards(for screen: AppState.Screen) {
        switch screen {
        case .gameLobby, .tournamentLobby, .game: CardTextureGenerator.prewarm()
        case .signIn, .register, .mainRoom: break
        }
    }

    /// The screens laid out under the boot splash: the auth screens, whose logo the splash
    /// ends on (they have no side effects on appearing beyond the Keychain pre-fill). Others
    /// (the main room joins it, a game starts voice) appear at the hand-off, as before.
    /// The splash logo's glide to a moved sign-in logo.
    static let logoGlide: TimeInterval = 0.25
    /// At least one frame (at 30 Hz) between the splash's final frame and the swap.
    static let swapDelay: TimeInterval = 0.034

    static func drawsUnderSplash(_ screen: AppState.Screen) -> Bool {
        screen == .signIn || screen == .register
    }

    var body: some View {
        ZStack {
            // the sign-in / register is laid out under the splash from launch (hidden from
            // VoiceOver and the UI tests until the hand-off), so the splash can put its logo on
            // that screen's logo; any other screen comes in at the hand-off, as before
            if !showSplash || Self.drawsUnderSplash(appState.screen) {
                ZStack {
                    Group {
                        switch appState.screen {
                        case .signIn:
                            SignInView()
                                .accessibilityElement(children: .contain).accessibilityIdentifier("screen.signIn")
                        case .register:
                            RegisterView()
                                .accessibilityElement(children: .contain).accessibilityIdentifier("screen.register")
                        case .mainRoom:
                            MainRoomView()
                                .accessibilityElement(children: .contain).accessibilityIdentifier("screen.mainRoom")
                        case .gameLobby:
                            GameLobbyView()
                                .accessibilityElement(children: .contain).accessibilityIdentifier("screen.gameLobby")
                        case .tournamentLobby:
                            TournamentLobbyView()
                                .accessibilityElement(children: .contain).accessibilityIdentifier("screen.tournamentLobby")
                        case .game:
                            GameContainerView()
                        }
                    }

                    if authState.isAuthenticated || authState.restoreRetrying {
                        ConnectionStatusToast()
                            // comes in with the sign-in's card at the hand-off, never in one frame
                            .opacity(showSplash ? 0 : 1)
                            .animation(.easeOut(duration: SplashTimeline.handOff), value: showSplash)
                    } else {
                        // signed out (the sign-in, register): the toasts alone, no connection pill
                        // (those screens say "Connecting to server..." themselves), so a
                        // forceLogout's "You were signed out..." shows there
                        ServerErrorToast()
                            .opacity(showSplash ? 0 : 1)
                            .animation(.easeOut(duration: SplashTimeline.handOff), value: showSplash)
                    }
                }
                // nothing under the splash reaches VoiceOver or the UI tests: transparent until the
                // hand-off (`accessibilityHidden` alone leaves the text fields and the scroll view
                // in the tree), then shown at once at the hand-off (no dip)
                .opacity(contentShown ? 1 : 0)
                .animation(nil, value: contentShown)
                .accessibilityHidden(!contentShown)
                .environment(\.bootSplashShowing, showSplash)
                .zIndex(0)
                .transition(.identity)
            }
            if showSplash {
                // over the next screen, which is drawn under it as it fades
                SplashView(logoTarget: splashLogoTarget, onFinished: {
                    var now = Transaction()
                    now.disablesAnimations = true
                    if Self.drawsUnderSplash(appState.screen) {
                        // the splash's last frame is this screen without its card: swapped in one
                        // frame, then only the card fades in (AuthCard, \.bootSplashShowing). A
                        // cross-fade of the two near-identical full screens dimmed the whole frame
                        // ~0.25 s in recorded launches (review 2026-11-17), even with this one opaque
                        // the swap waits one frame (the splash first draws its final frame, which a
                        // hitch could have skipped) and any logo glide still under way
                        let glide = logoGlideEnds.map { $0.timeIntervalSinceNow } ?? 0
                        DispatchQueue.main.asyncAfter(deadline: .now() + max(Self.swapDelay, glide)) {
                            withTransaction(now) { contentShown = true }
                            showSplash = false
                        }
                    } else {
                        // a restored session's screen appears at the hand-off, under the fading splash
                        withTransaction(now) { contentShown = true }
                        withAnimation(.easeInOut(duration: SplashTimeline.handOff)) { showSplash = false }
                    }
                })
                .zIndex(1)
                .transition(.opacity)
            }
        }
        // the sign-in logo's frame (AuthLogoFrameKey, reported only while the splash shows);
        // the last one is kept if that screen goes, so the splash's logo never jumps
        .onPreferenceChange(AuthLogoFrameKey.self) { frame in
            guard let frame, frame != splashLogoTarget else { return }
            // the first frame at once; a later one (the connecting line going away moves the
            // sign-in's logo ~16 pt) glides there, so the splash's logo and hand never jump
            if splashLogoTarget == nil || !showSplash {
                splashLogoTarget = frame
            } else {
                logoGlideEnds = Date().addingTimeInterval(Self.logoGlide)
                withAnimation(.easeInOut(duration: Self.logoGlide)) { splashLogoTarget = frame }
            }
        }
        #if DEBUG
        .overlay {
            if UIFixture.isActive {
                FixtureWindowProbe().ignoresSafeArea(.keyboard)
                FixtureProbes()
            }
        }
        #endif
        // the one-time passwordReset notice after a sign-in or restore (AccountRules.swift)
        .alert("Password reset", isPresented: Binding(get: { authState.accountNotice != nil && !showSplash },
                                                       set: { if !$0 { authState.accountNotice = nil } })) {
            Button("OK", role: .cancel) { authState.accountNotice = nil }
        } message: {
            Text(authState.accountNotice ?? "")
        }
        // a standard alert: VoiceOver moves to it and reads it
        .alert("Server restarted", isPresented: Binding(get: { restart.message != nil && !showSplash },
                                                         set: { if !$0 { restart.message = nil } })) {
            Button("OK", role: .cancel) { restart.message = nil }
        } message: {
            Text(restart.message ?? "")
        }
        .preferredColorScheme(.dark)
        // the orientation mask follows the window scene's size classes (Duo fold / unfold)
        .onChange(of: hSizeClass) { OrientationLock.refresh() }
        .onChange(of: vSizeClass) { OrientationLock.refresh() }
        // drafts survive a rotation, not their context (sign-out, leaving a lobby or a game)
        .onChange(of: appState.screen) { old, new in
            ChatDrafts.screenChanged(from: old, to: new, mainRoom: mainRoomState, lobby: lobbyState,
                                     tournament: tournamentState, game: gameState)
            Self.prewarmCards(for: new)
            // the admin panel closes off the main room and when the flag drops (as the web's);
            // not observed here: the panel's every change would redraw the whole app
            if new != .mainRoom { AdminState.shared.close() }
        }
        .onChange(of: authState.isAdmin) { _, isAdmin in
            if !isAdmin { AdminState.shared.close() }
        }
        .animation(.easeInOut(duration: 0.3), value: appState.screen)
        .onAppear {
            Self.prewarmCards(for: appState.screen)
            // the splash ends itself (SplashView's onFinished, 1.32 s; 0.9 s under Reduce Motion)
            #if DEBUG
            if UIFixture.isActive && !UIFixture.showsSplash {
                var now = Transaction()
                now.disablesAnimations = true  // the card is opaque from the first frame
                withTransaction(now) { showSplash = false; contentShown = true }
            }
            #endif
        }
    }
}

// Make Screen equatable for animation
extension AppState.Screen: Equatable {}

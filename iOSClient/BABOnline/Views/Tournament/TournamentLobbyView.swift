import SwiftUI

/// The tournament lobby. Where the system shows the vertical bar (the iPhone
/// Duo), Leave is the leading toolbar item in that column (VerticalBarHost);
/// the title and the Ready / Begin / Cancel buttons stay in the content.
struct TournamentLobbyView: View {
    var body: some View {
        VerticalBarHost { TournamentLobbyScreen(bar: $0) }
    }
}

private struct TournamentLobbyScreen: View {
    let bar: VerticalBarContext

    @EnvironmentObject var appState: AppState
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var tournamentState: TournamentState
    @Environment(\.horizontalSizeClass) private var hSizeClass
    /// Bumped by every hinge change so the fold is read again at the same size.
    @State private var hingeTick = 0

    var body: some View {
        ZStack {
            Color.Theme.background.ignoresSafeArea()

            // measures the room above the keyboard for the compact layout (draws
            // nothing; compact only: in the wide layout this extra layer changed
            // a few pixels of the status bar and the home indicator)
            if hSizeClass != .regular {
                Color.clear
                    .allowsHitTesting(false)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { visibleHeight = $0 }
            }

            // Two branches on purpose (their children differ); the chat draft
            // lives in TournamentState, so a size-class change keeps it.
            // Compact ignores the keyboard (it lays the keyboard out itself).
            GeometryReader { geo in
                let _ = hingeTick  // re-read the fold after a hinge change
                if hSizeClass == .regular {
                    // Regular width (iPad, the open Duo): side by side, as the main room.
                    // The left column ignores the keyboard (only the chat column makes
                    // room for it), so typing never moves the players or the buttons.
                    // In book pose the left column ends at the hinge, which divides them.
                    let hinge = FoldReader.bookHinge(geo)
                    HStack(spacing: 0) {
                        leftPanel
                            .frame(width: hinge?.lowerBound ?? geo.size.width * 0.55)
                            .ignoresSafeArea(.keyboard, edges: .bottom)
                        if let hinge {
                            Color.clear.frame(width: hinge.upperBound - hinge.lowerBound)
                        } else {
                            Divider().background(Color.Theme.inputBorder)
                        }
                        rightPanel
                            .frame(maxWidth: .infinity)
                    }
                } else {
                    compactLayout(height: geo.size.height)
                }
            }
            .modifier(HingeTick(tick: $hingeTick))
            .ignoresSafeArea(.keyboard, edges: hSizeClass == .regular ? [] : .bottom)

            // Results overlay
            if tournamentState.phase == "complete" {
                TournamentResultsView()
            }
        }
        .onTapGesture {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
        .verticalBarChrome(bar, showsBarControls: bar.usesVerticalBar)
        .toolbar {
            if bar.usesVerticalBar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: leaveTournament) {
                        Label("Leave", systemImage: "chevron.left")
                    }
                    // the results overlay covers the header's Leave too; it has its own way out
                    .disabled(tournamentState.phase == "complete")
                }
            }
        }
    }

    // MARK: - Wide Layout (regular width)

    /// The header (Leave, title, round) and the buttons stay pinned; the player
    /// list takes the height between them and scrolls when it is longer.
    private var leftPanel: some View {
        VStack(spacing: 0) {
            headerBar
            ScrollView {
                TournamentPlayerListView()
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: .infinity, alignment: .top)
            bottomButtons
        }
    }

    /// The chat's minimum in the right column; the scoreboard and the active
    /// tables above it scroll inside the rest when they are taller.
    private static let chatMinHeight: CGFloat = 240

    /// The scoreboard (once there are scores) and the active tables (while a
    /// round is in play), else nothing: the chat then takes the whole column.
    private var hasStandings: Bool {
        !tournamentState.scoreboard.isEmpty
            || (tournamentState.phase == "round_active" && tournamentState.activeGames.contains { $0.status == "active" })
    }

    /// The scoreboard and the active tables on top, sized to their content (they
    /// scroll when that leaves the chat less than its minimum, e.g. with the
    /// keyboard up); the chat fills the rest of the column.
    private var rightPanel: some View {
        CappedAboveChat(showsTop: hasStandings, chatMin: { _ in Self.chatMinHeight }) {
            VStack(spacing: 12) {
                TournamentScoreboardView()
                TournamentActiveGamesView()
            }
            .padding(.vertical, 12)
        } chat: {
            TournamentChatView(showsTitle: true)
        }
    }

    // MARK: - Compact Layout (phones, the closed Duo)

    /// Compact: the chat keeps 55% of the height between the header and the
    /// buttons, at most 220 pt (closed Duo, iPhone 17 / 17e portrait: 220 pt;
    /// a short window, e.g. 250 pt between them: 137, the players ~113), so
    /// neither part collapses.
    private static func compactChatMin(_ height: CGFloat) -> CGFloat { min(220, height * 0.55) }
    /// Below this height between the header and pinned buttons (a short compact
    /// window, accessibility text sizes with the host's three buttons) the
    /// buttons scroll with the players instead, so the chat field keeps its room.
    private static let compactMinMiddle: CGFloat = 200
    /// Measured: the height above the keyboard (the screen's keyboard-aware
    /// safe area), the header's and the buttons' heights.
    @State private var visibleHeight: CGFloat = 0
    @State private var headerHeight: CGFloat = 0
    @State private var buttonsHeight: CGFloat = 0

    /// Header, then the players, scoreboard and active tables (sized to their
    /// content, scrolling once that would leave the chat less than its minimum),
    /// then the chat filling the rest with its field always on screen, then the
    /// buttons. `height` ignores the keyboard: with the keyboard up the chat
    /// ends at the keyboard's top (the top part shrinks) and the keyboard
    /// covers the buttons, as in Messages.
    private func compactLayout(height: CGFloat) -> some View {
        // pinned until measured, so the first frame does not move them
        let pinned = headerHeight == 0 || height - headerHeight - buttonsHeight >= Self.compactMinMiddle
        let keyboard = visibleHeight > 0 ? max(0, height - visibleHeight) : 0
        return VStack(spacing: 0) {
            headerBar
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { headerHeight = $0 }
            CappedAboveChat(chatMin: Self.compactChatMin) {
                VStack(spacing: 16) {
                    TournamentPlayerListView()
                    TournamentScoreboardView()
                    TournamentActiveGamesView()
                    if !pinned { measuredButtons }
                }
                .padding(.bottom, 8)
            } chat: {
                TournamentChatView()
            }
            .padding(.bottom, max(0, keyboard - (pinned ? buttonsHeight : 0)))
            if pinned { measuredButtons }
        }
    }

    private var measuredButtons: some View {
        bottomButtons
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { buttonsHeight = $0 }
    }

    // MARK: - Header

    private var headerBar: some View {
        VStack(spacing: 0) {
            HStack {
                // in the vertical bar Leave is a toolbar item and the title leads
                if !bar.usesVerticalBar {
                    Button(action: leaveTournament) {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.left")
                            Text("Leave")
                        }
                        .foregroundColor(Color.Theme.textSecondary)
                    }

                    Spacer()
                }

                VStack(alignment: bar.usesVerticalBar ? .leading : .center, spacing: 2) {
                    HStack(spacing: 6) {
                        Image(systemName: "trophy.fill")
                            .foregroundColor(Color.Theme.warning)
                        Text(tournamentState.name.isEmpty ? "Tournament" : tournamentState.name)
                            .font(.headline)
                            .foregroundColor(Color.Theme.warning)
                    }
                    Text(roundIndicator)
                        .font(.caption)
                        .foregroundColor(Color.Theme.textSecondary)
                }

                Spacer()

                Text("\(tournamentState.players.count) players")
                    .font(.caption)
                    .foregroundColor(Color.Theme.textSecondary)
            }
            .padding()

            Divider().background(Color.Theme.inputBorder, ignoresSafeAreaEdges: .vertical)
        }
    }

    private var roundIndicator: String {
        switch tournamentState.phase {
        case "lobby": return "Waiting to start"
        case "round_active": return "Round \(tournamentState.currentRound) of \(tournamentState.totalRounds)"
        case "between_rounds": return "Round \(tournamentState.currentRound) complete"
        case "complete": return "Tournament complete"
        default: return ""
        }
    }

    // MARK: - Bottom Buttons

    private var isCreator: Bool {
        authState.username == tournamentState.creatorUsername
    }

    private var allReady: Bool {
        // Disconnected members sit out rounds and never ready up — they must
        // not gate the Begin button (the server ignores them too)
        let connected = tournamentState.players.filter { $0.connected }
        return !connected.isEmpty && connected.allSatisfy { $0.isReady }
    }

    private var bottomButtons: some View {
        VStack(spacing: 8) {
            if tournamentState.phase == "lobby" || tournamentState.phase == "between_rounds" {
                // Ready / Unready (spectators can't ready up)
                if !tournamentState.isSpectator {
                    Button(action: toggleReady) {
                        Text(tournamentState.isReady ? "Unready" : "Ready")
                            .font(.title3.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(tournamentState.isReady ? Color.Theme.oppColor : Color.Theme.buttonBackground)
                            .foregroundColor(.white)
                            .cornerRadius(10)
                    }
                }

                // Begin button (creator only)
                if isCreator {
                    let label = tournamentState.phase == "lobby" ? "Begin Tournament" : "Begin Next Round"
                    Button(action: beginRound) {
                        Text(label)
                            .font(.title3.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(allReady ? Color.Theme.warning : Color.Theme.buttonDisabled)
                            .foregroundColor(.white)
                            .cornerRadius(10)
                    }
                    .disabled(!allReady)
                }
            }

            // Cancel Tournament button (creator only, visible in all phases)
            if isCreator {
                Button(action: cancelTournament) {
                    Text("Cancel Tournament")
                        .font(.subheadline.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color(red: 0.6, green: 0.1, blue: 0.1))
                        .foregroundColor(.white)
                        .cornerRadius(10)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    // MARK: - Actions

    private func toggleReady() {
        tournamentState.isReady.toggle()
        if tournamentState.isReady {
            TournamentEmitter.tournamentReady()
        } else {
            TournamentEmitter.tournamentUnready()
        }
        HapticManager.mediumImpact()
    }

    private func beginRound() {
        if tournamentState.phase == "lobby" {
            TournamentEmitter.beginTournament()
        } else {
            TournamentEmitter.beginNextRound()
        }
    }

    private func leaveTournament() {
        TournamentEmitter.leaveTournament()
    }

    private func cancelTournament() {
        TournamentEmitter.cancelTournament()
    }
}

/// Content above a chat that fills the rest of the height (the wide lobby's
/// right column, the compact lobby between its header and buttons): the top
/// part takes its natural height, capped so the chat keeps `chatMin` of the
/// region's height, and scrolls inside that cap when it is taller.
private struct CappedAboveChat<Top: View, Chat: View>: View {
    var showsTop = true
    /// The chat's minimum for the region's height.
    let chatMin: (CGFloat) -> CGFloat
    @ViewBuilder let top: Top
    @ViewBuilder let chat: Chat

    @State private var height: CGFloat = 0
    @State private var topHeight: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            if showsTop {
                ScrollView {
                    top
                        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { topHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: min(topHeight, max(0, height - chatMin(height))))
            }
            chat
                .frame(maxHeight: .infinity)
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { height = $0 }
    }
}

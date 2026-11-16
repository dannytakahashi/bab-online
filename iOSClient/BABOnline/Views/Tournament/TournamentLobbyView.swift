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
    @ObservedObject private var socketService = SocketService.shared

    /// Ready, Begin and Cancel wait for the session and for the restore's joinTournament
    /// (`TournamentState.rejoiningTournamentId`: this socket is not a member until it is
    /// answered). Leave never waits (during the re-entry it is `TournamentRejoin.abandon`).
    private var canSendTournamentActions: Bool {
        socketService.canSendMainRoomActions && tournamentState.rejoiningTournamentId == nil
    }

    /// The old socket's flag means nothing while the re-entry waits: it comes back as a new
    /// member, not ready (tournamentJoined then sets the server's flag).
    private var showsReady: Bool {
        tournamentState.isReady && tournamentState.rejoiningTournamentId == nil
    }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

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
                            Divider().background(Theme.inputBorder)
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
            VStack(spacing: Theme.Space.s3) {
                TournamentScoreboardView()
                TournamentActiveGamesView()
            }
            .padding(.vertical, Theme.Space.s3)
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
                VStack(spacing: Theme.Space.s4) {
                    TournamentPlayerListView()
                    TournamentScoreboardView()
                    TournamentActiveGamesView()
                    if !pinned { measuredButtons }
                }
                .padding(.bottom, Theme.Space.s2)
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
                        HStack(spacing: Theme.Space.s1) {
                            Image(systemName: "chevron.left")
                                .accessibilityHidden(true)
                            Text("Leave")
                        }
                        .foregroundColor(Theme.textSecondary)
                    }

                    Spacer()
                }

                VStack(alignment: bar.usesVerticalBar ? .leading : .center, spacing: 2) {
                    HStack(spacing: 6) {
                        Image(systemName: "trophy.fill")
                            .foregroundColor(Theme.warning)
                            .accessibilityHidden(true)
                        Text(tournamentState.name.isEmpty ? "Tournament" : tournamentState.name)
                            .font(.headline)
                            .foregroundColor(Theme.warning)
                    }
                    Text(roundIndicator)
                        .font(.caption)
                        .foregroundColor(Theme.textSecondary)
                }

                Spacer()

                Text("\(tournamentState.players.count) players")
                    .font(.caption)
                    .foregroundColor(Theme.textSecondary)
            }
            .padding()

            Divider().background(Theme.inputBorder, ignoresSafeAreaEdges: .vertical)
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

    /// Every connected member ready, or between rounds past the ready deadline (Begin then
    /// starts with the ready members: `TournamentBegin`, the web's canBegin).
    private var canBegin: Bool {
        TournamentBegin.canBegin(phase: tournamentState.phase, deadlinePassed: tournamentState.readyDeadlinePassed,
                                 players: tournamentState.players)
    }

    private var bottomButtons: some View {
        VStack(spacing: Theme.Space.s2) {
            if tournamentState.phase == "lobby" || tournamentState.phase == "between_rounds" {
                // Ready / Unready (spectators can't ready up)
                if !tournamentState.isSpectator {
                    Button(action: toggleReady) {
                        Text(showsReady ? "Unready" : "Ready")
                            .font(.title3.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(showsReady ? Theme.danger : Theme.buttonBackground)
                            .foregroundColor(showsReady ? Theme.dangerForeground : Theme.buttonForeground)
                            .cornerRadius(Theme.Radius.md)
                    }
                    .disabled(!canSendTournamentActions)
                    .opacity(canSendTournamentActions ? 1 : 0.5)  // custom fills do not dim by themselves
                }

                // Begin button (creator only)
                if isCreator {
                    let label = TournamentBegin.label(phase: tournamentState.phase,
                                                      deadlinePassed: tournamentState.readyDeadlinePassed,
                                                      players: tournamentState.players)
                    Button(action: beginRound) {
                        Text(label)
                            .font(.title3.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(canBegin ? Theme.warning : Theme.buttonDisabled)
                            .foregroundColor(canBegin ? Theme.warningForeground : Theme.buttonDisabledForeground)
                            .cornerRadius(Theme.Radius.md)
                    }
                    .disabled(!canBegin || !canSendTournamentActions)
                    .opacity(canSendTournamentActions ? 1 : 0.5)
                    .accessibilityIdentifier("tournament.begin")
                }
            }

            // Cancel Tournament button (creator only, visible in all phases)
            if isCreator {
                Button(action: cancelTournament) {
                    Text("Cancel Tournament")
                        .font(.subheadline.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Theme.Space.s3)
                        .background(Theme.danger)
                        .foregroundColor(Theme.dangerForeground)
                        .cornerRadius(Theme.Radius.md)
                }
                .disabled(!canSendTournamentActions)
                .opacity(canSendTournamentActions ? 1 : 0.5)
            }
        }
        .padding(.horizontal, Theme.Space.s3)
        .padding(.vertical, Theme.Space.s2)
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
        // the re-entry unanswered: out at once (its leaveTournament is answered either way)
        if tournamentState.rejoiningTournamentId != nil {
            TournamentRejoin.abandon(tournamentState: tournamentState, appState: appState)
            return
        }
        TournamentEmitter.leaveTournament()
    }

    private func cancelTournament() {
        TournamentEmitter.cancelTournament()
    }
}

/// Content above a chat that fills the rest of the height (the wide lobby's
/// right column, the compact lobby between its header and buttons): the top
/// part takes its natural height, capped so the chat keeps `chatMin` of the
/// region's height, and scrolls inside that cap when it is taller. While more
/// of it is below the cap (8 players on a phone or the closed Duo), its last
/// visible row fades out toward the chat instead of being cut off hard, and the
/// scroll indicator flashes when it appears, so the list reads as scrollable.
struct CappedAboveChat<Top: View, Chat: View>: View {
    var showsTop = true
    /// The chat's minimum for the region's height.
    let chatMin: (CGFloat) -> CGFloat
    @ViewBuilder let top: Top
    @ViewBuilder let chat: Chat

    @State private var height: CGFloat = 0
    @State private var topHeight: CGFloat = 0
    @State private var moreBelow = false

    /// The fade's height over the cut-off row.
    static var fadeHeight: CGFloat { 32 }

    /// More content below the visible part (half a point of slack).
    static func hasMoreBelow(contentHeight: CGFloat, visibleMaxY: CGFloat) -> Bool {
        contentHeight - visibleMaxY > 0.5
    }

    var body: some View {
        VStack(spacing: 0) {
            if showsTop {
                ScrollView {
                    top
                        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { topHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                .scrollIndicatorsFlash(onAppear: true)
                .modifier(MoreBelowReader(moreBelow: $moreBelow))
                .mask {
                    VStack(spacing: 0) {
                        Color.black
                        LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .top, endPoint: .bottom)
                            .frame(height: moreBelow ? Self.fadeHeight : 0)
                    }
                }
                .frame(height: min(topHeight, max(0, height - chatMin(height))))
            }
            chat
                .frame(maxHeight: .infinity)
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { height = $0 }
    }
}

/// Whether a scroll view has more content below what it shows (iOS 18 and later; iOS 17 keeps the hard edge).
private struct MoreBelowReader: ViewModifier {
    @Binding var moreBelow: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { g in
                CappedAboveChat<EmptyView, EmptyView>.hasMoreBelow(contentHeight: g.contentSize.height + g.contentInsets.bottom,
                                                                   visibleMaxY: g.visibleRect.maxY)
            } action: { _, more in
                if more != moreBelow { moreBelow = more }
            }
        } else {
            content
        }
    }
}

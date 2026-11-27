import SwiftUI

/// The tournament lobby (owner 2026-11-26 layout): the header (title, round line, the host's
/// Rounds picker in the lobby phase, the mic and Leave (the host's "…" menu with Leave / Cancel
/// Tournament), the players and standings, the chat, then ONE action slot at the bottom
/// (TournamentLobbySlot: Ready / Unready, or the host's Begin). Where the system shows the vertical
/// bar (the iPhone Duo), Leave / the "…" menu (or the complete phase's Main Room) is the leading
/// toolbar item in that column (VerticalBarHost).
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
    @Environment(\.dynamicTypeSize) private var typeSize
    /// Bumped by every hinge change so the fold is read again at the same size.
    @State private var hingeTick = 0
    @ObservedObject private var socketService = SocketService.shared
    @ObservedObject private var voiceManager = VoiceChatManager.shared
    @State private var showVoicePanel = false
    /// Cut for a buck's screen state (iOS 1.2.7 (41)): one for both halves of a tabletop layout.
    @StateObject private var cutModel = CutScreenModel()
    /// The compact cut's chat drawer, and how many lines it had when last closed.
    @State private var showsCutChat = false
    @State private var cutChatSeen = 0
    #if os(iOS)
    /// Leave / Cancel Tournament / Stop Watching's confirmation (a UIKit alert: LeaveAlertPresenter
    /// says why), and the choice it confirms while it is up.
    @State private var confirmAlert = LeaveAlertPresenter()
    #endif
    @State private var confirming: TournamentLobbyMenu.Item?

    /// Cut for a buck is on and this app has its state (phase 'cut', the cap sent).
    private var showsCut: Bool { tournamentState.isCutPhase && tournamentState.cut != nil }
    /// The tournament is over: the final results in the lobby itself, with the chat and voice.
    private var showsFinal: Bool { tournamentState.phase == "complete" }

    /// The header's mic: voice is on (iOS 1.2.6, the tournament room; fixture mode: `-uiVoice
    /// YES`), as the game lobby's header mic.
    private var showsMic: Bool {
        #if DEBUG
        voiceManager.isActive || UIFixture.showsVoiceButton
        #else
        voiceManager.isActive
        #endif
    }

    /// The server announced another member in the tournament room (no voice alone;
    /// TournamentVoice).
    private var voiceCompany: TournamentVoice.LobbyWord {
        TournamentVoice.lobbyWord(voiceManager, me: authState.username)
    }

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
                if showsCut, let fold = Self.tabletopFold(geo) {
                    cutTabletop(fold: fold, height: geo.size.height)
                } else if hSizeClass == .regular {
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
        }
        .onTapGesture {
            Keyboard.dismiss()
        }
        .verticalBarChrome(bar, showsBarControls: bar.usesVerticalBar)
        .toolbar {
            if bar.usesVerticalBar {
                ToolbarItem(placement: .barLeading) {
                    if showsFinal {
                        Button(action: returnToMainRoom) {
                            Label("Main Room", systemImage: "chevron.left")
                        }
                    } else if menuEntry != .none {
                        entryPoint
                    }
                }
            }
        }
        // Tournament-room voice (iOS 1.2.6, TournamentVoice): a member wants it here (lobby,
        // between rounds, a round I sit out or whose table finished, the results); it runs,
        // muted at the start, while another member is in the room
        .onChange(of: TournamentVoice.wantsVoice(tournamentState), initial: true) { _, wants in
            if wants { VoiceChatManager.shared.ensureStarted() }
        }
        .onChange(of: voiceCompany, initial: true) { _, word in
            VoiceChatManager.shared.setCompany(word.company, from: .tournament)
        }
        // the open confirmation follows the lobby: its choice gone -> dropped, its consequence
        // changed -> new words in place
        .onChange(of: confirmContext) { _, context in confirmContextChanged(context) }
        .onDisappear {
            dropConfirm()
            TournamentVoice.lobbyGone(screen: appState.screen,
                                      watching: SocketService.shared.gameState?.isSpectator ?? false,
                                      voice: .shared)
        }
        .sheet(isPresented: $showVoicePanel) {
            VoicePanelSheet()
                .presentationDetents([.medium])
        }
        .sheet(isPresented: $showsCutChat, onDismiss: { cutChatSeen = tournamentState.messages.count }) {
            TournamentChatView(showsTitle: true)
                .presentationDetents([.medium, .large])
                .presentationBackground(Theme.background)
        }
        // Cut for a buck: the screen's own state follows the cut's (verdicts, sounds, the intro)
        .onAppear(perform: attachCut)
        .onChange(of: tournamentState.cut) { old, new in cutModel.update(old: old, new: new) }
        .onChange(of: tournamentState.isSpectator) { _, _ in configureCut() }
        .onChange(of: showsCut) { _, on in if !on { showsCutChat = false } }
        #if DEBUG
        .onAppear { if UIFixture.showsVoicePanel { showVoicePanel = true } }
        #endif
    }

    // MARK: - Wide Layout (regular width)

    /// The header (Leave, title, round) and the buttons stay pinned; the player
    /// list takes the height between them and scrolls when it is longer.
    private var leftPanel: some View {
        VStack(spacing: 0) {
            headerBar
            if showsCut {
                CutForABuckView(model: cutModel)
                    .frame(maxHeight: .infinity)
            } else if showsFinal {
                ScrollView {
                    TournamentFinalView().padding(.vertical, Theme.Space.s3)
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxHeight: .infinity, alignment: .top)
                finalButtons
            } else {
                ScrollView {
                    TournamentPlayerListView()
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxHeight: .infinity, alignment: .top)
                bottomButtons
            }
        }
    }

    /// The chat's minimum in the right column; the scoreboard and the active
    /// tables above it scroll inside the rest when they are taller.
    private static let chatMinHeight: CGFloat = 240

    /// The scoreboard (once there are scores), the pairings (once a round is planned) and the
    /// active tables (while a round is in play), else nothing: the chat then takes the whole column.
    private var hasStandings: Bool {
        // the cut and the final results show their own standings on the left
        !showsCut && !showsFinal && (!tournamentState.scoreboard.isEmpty
            || TournamentPairingRules.hasPairings(tournamentState.pairings)
            || (tournamentState.phase == "round_active" && tournamentState.activeGames.contains { $0.status == "active" }))
    }

    /// The scoreboard and the active tables on top, sized to their content (they
    /// scroll when that leaves the chat less than its minimum, e.g. with the
    /// keyboard up); the chat fills the rest of the column.
    private var rightPanel: some View {
        CappedAboveChat(showsTop: hasStandings, chatMin: { _ in Self.chatMinHeight }) {
            VStack(spacing: Theme.Space.s3) {
                TournamentScoreboardView()
                TournamentPairingsView()
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
    /// window, accessibility text sizes with the header's Rounds picker) the
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
    ///
    /// At the accessibility sizes only the header's controls row stays fixed; the title, round
    /// line, count and the host's Rounds picker scroll at the top of the players (review of PR
    /// #430: at AX5 on an iPhone 17 the header took about half the screen, so the short-space
    /// rule unpinned Begin / Ready, which then scrolled in a strip one row tall).
    private func compactLayout(height: CGFloat) -> some View {
        // pinned until measured, so the first frame does not move them
        let pinned = headerHeight == 0 || height - headerHeight - buttonsHeight >= Self.compactMinMiddle
        let keyboard = visibleHeight > 0 ? max(0, height - visibleHeight) : 0
        let detailsScroll = typeSize.isAccessibilitySize
        if showsCut { return AnyView(compactCut) }
        if showsFinal { return AnyView(compactFinal(keyboard: keyboard)) }
        return AnyView(VStack(spacing: 0) {
            header(scrollsDetails: detailsScroll)
                // never squeezed under its content (a wrapped round line and the voice-full
                // notice at AX5 ran over the divider): the players and chat give the room
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { headerHeight = $0 }
                .zIndex(1)  // the voice panel tip hangs over what follows
            CappedAboveChat(chatMin: Self.compactChatMin) {
                VStack(spacing: Theme.Space.s4) {
                    if detailsScroll { headerDetails }
                    TournamentPlayerListView()
                    TournamentScoreboardView()
                    TournamentPairingsView()
                    TournamentActiveGamesView()
                    if !pinned { measuredButtons }
                }
                .padding(.bottom, Theme.Space.s2)
            } chat: {
                TournamentChatView()
            }
            .padding(.bottom, max(0, keyboard - (pinned ? buttonsHeight : 0)))
            if pinned { measuredButtons }
        })
    }

    // MARK: - Cut for a buck and the final results (iOS 1.2.7 (41))

    /// A compact cut: the stage takes the screen; the chat is a drawer ("Chat (3)").
    private var compactCut: some View {
        VStack(spacing: 0) {
            headerBar
            CutForABuckView(model: cutModel)
                .frame(maxHeight: .infinity)
            chatDrawerButton
        }
    }

    private var chatDrawerButton: some View {
        let unread = max(0, tournamentState.messages.count - cutChatSeen)
        return Button {
            showsCutChat = true
        } label: {
            HStack {
                Image(systemName: "bubble.left.and.bubble.right.fill").accessibilityHidden(true)
                Text(unread > 0 ? "Chat (\(unread))" : "Chat")
            }
            .font(.subheadline.bold())
            .dynamicTypeSize(...DynamicTypeSize.accessibility1)
            .frame(maxWidth: .infinity, minHeight: Theme.hitTarget)
            .background(Theme.surface)
            .foregroundColor(Theme.textPrimary)
            .cornerRadius(Theme.Radius.md)
        }
        .padding(.horizontal, Theme.Space.s3)
        .padding(.vertical, Theme.Space.s2)
        .accessibilityIdentifier("cut.chat")
    }

    /// The Duo laid flat (tabletop): the ring above the fold; the status, a full-width Draw a card
    /// and the chat below it.
    private func cutTabletop(fold: CGRect, height: CGFloat) -> some View {
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                headerBar
                CutForABuckView(model: cutModel, part: .stage)
                    .frame(maxHeight: .infinity)
            }
            .frame(height: fold.minY)
            Color.clear.frame(height: fold.height)
            VStack(spacing: 0) {
                CutForABuckView(model: cutModel, part: .controls)
                    .fixedSize(horizontal: false, vertical: true)
                TournamentChatView()
            }
            .frame(maxHeight: .infinity)
        }
    }

    /// A horizontal fold that leaves the ring at least 260 pt (the Duo in tabletop pose).
    static func tabletopFold(_ geo: GeometryProxy) -> CGRect? {
        guard let d = FoldReader.division(geo), d.width > d.height, d.minY >= 260, geo.size.height - d.maxY >= 160 else { return nil }
        return d
    }

    /// Compact final results: the card above the chat, Return to Main Room pinned under them.
    private func compactFinal(keyboard: CGFloat) -> some View {
        VStack(spacing: 0) {
            headerBar
            CappedAboveChat(chatMin: Self.compactChatMin) {
                TournamentFinalView().padding(.vertical, Theme.Space.s3)
            } chat: {
                TournamentChatView()
            }
            .padding(.bottom, max(0, keyboard - buttonsHeight))
            finalButtons
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { buttonsHeight = $0 }
        }
    }

    private var finalButtons: some View {
        VStack(spacing: Theme.Space.s1) {
            Button(action: returnToMainRoom) {
                Text("Return to Main Room")
                    .font(.body.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Theme.buttonBackground)
                    .foregroundColor(Theme.buttonForeground)
                    .cornerRadius(Theme.Radius.md)
            }
            .accessibilityIdentifier("results.return")
            Text(CutCopy.lobbyOpenNote)
                .font(.caption)
                .foregroundColor(Theme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, Theme.Space.s3)
        .padding(.vertical, Theme.Space.s2)
    }

    private func configureCut() {
        let spectator = tournamentState.isSpectator
        cutModel.me = spectator ? nil : authState.username
        cutModel.spectator = spectator
        cutModel.send = { round, slot in TournamentEmitter.cutForABuckDraw(round: round, slot: slot) }
        cutModel.play = { kind in SoundPlayer.shared.play(kind) }
        cutModel.announce = { text, urgent in
            if urgent { A11y.announceUrgent(text) } else { A11y.announce(text) }
        }
        cutModel.haptic = { kind in
            #if os(iOS)
            switch kind {
            case .light: HapticManager.lightImpact()
            case .warning: HapticManager.warning()
            case .success: HapticManager.success()
            }
            #endif
        }
        #if DEBUG
        UIFixture.configureCut(cutModel, tournament: tournamentState)
        #endif
    }

    private func attachCut() {
        configureCut()
        cutChatSeen = tournamentState.messages.count
        cutModel.attach(tournamentState.cut)
    }

    private var measuredButtons: some View {
        bottomButtons
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { buttonsHeight = $0 }
    }

    // MARK: - Header

    /// The header: the title with the round line, the member count, while voice runs the mic
    /// (iOS 1.2.6), and Leave / Stop Watching or the host's "…" menu (in the complete phase the back
    /// control "Main Room" leads instead); under them the host's Rounds picker in the lobby phase.
    /// At the accessibility text sizes (AX1 to AX5) one row left the title a letter wide on a
    /// phone, so the controls take a row of their own and the title, the round line and the count
    /// wrap under them. In the vertical bar Leave / the menu / Main Room is a toolbar item.
    private var headerBar: some View { header() }

    /// The host's Rounds picker shows (the lobby phase only).
    private var showsRoundsPicker: Bool {
        TournamentRounds.showsPicker(phase: tournamentState.phase, isCreator: isCreator,
                                     isSpectator: tournamentState.isSpectator)
    }

    private var roundsPicker: some View {
        TournamentRoundsPicker(enabled: canSendTournamentActions)
    }

    /// `scrollsDetails`: the compact layout at the accessibility sizes keeps only the controls row
    /// (the mic and "…") fixed; the title, the round line, the count and the host's Rounds picker
    /// scroll at the top of the players instead (`headerDetails`, compactLayout).
    private func header(scrollsDetails: Bool = false) -> some View {
        let controlsOnly = scrollsDetails
        let hasControls = showsHeaderBack || showsMic || (!bar.usesVerticalBar && menuEntry != .none)
        return VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: Theme.Space.s2) {
                Group {
                    if controlsOnly {
                        if hasControls { accessibilityControlsRow }
                    } else if typeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: Theme.Space.s2) {
                            accessibilityControlsRow
                            titleBlock(alignment: .leading)
                            countText
                        }
                    } else {
                        HStack {
                            // Main Room (complete phase only), the count, the mic and the menu keep
                            // their size and the title gives way (one line, shrunk, then cut)
                            if showsHeaderBack {
                                mainRoomButton.lineLimit(1).fixedSize()
                                Spacer(minLength: Theme.Space.s2)
                            }
                            titleBlock(alignment: showsHeaderBack ? .center : .leading, oneLine: true)
                            Spacer(minLength: Theme.Space.s2)
                            countText.lineLimit(1).fixedSize()
                            headerMic
                            headerEntry(withText: false)
                        }
                    }
                }
                // the mic coming and going never changes the header's height
                .frame(minHeight: controlsOnly && !hasControls ? 0 : Theme.hitTarget)
                // the host's round count, 1 to 5, before the tournament begins (TournamentRounds):
                // under "Waiting to start · N rounds"; everyone else reads the count in that line
                if !controlsOnly && showsRoundsPicker {
                    roundsPicker
                }
            }
            .padding(controlsOnly && !hasControls ? 0 : Theme.Space.s4)
            // the voice panel tip, once (VoicePanelTip): just under the header, off its mic
            .overlay(alignment: .bottom) {
                VoicePanelTipToast()
                    .alignmentGuide(.bottom) { $0[.top] }
            }
            .zIndex(1)

            Divider().background(Theme.inputBorder, ignoresSafeAreaEdges: .vertical)
        }
        .zIndex(1)  // the tip hangs over the player list
    }

    /// The accessibility sizes' controls row: Main Room (complete phase), the mic and Leave / Stop
    /// Watching with its words (the one-row header has its icon alone), or the host's "…".
    private var accessibilityControlsRow: some View {
        HStack {
            if showsHeaderBack { mainRoomButton.lineLimit(1).fixedSize() }
            Spacer()
            headerMic
            headerEntry(withText: true)
        }
    }

    /// What `header(scrollsDetails: true)` leaves out, at the top of the scrolling players.
    private var headerDetails: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s2) {
            titleBlock(alignment: .leading)
            countText
            if showsRoundsPicker { roundsPicker.padding(.top, Theme.Space.s2) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.Space.s4)
        .padding(.top, Theme.Space.s3)
    }

    /// The complete phase's back control in the content (the vertical bar has its own).
    private var showsHeaderBack: Bool { showsFinal && !bar.usesVerticalBar }

    private var mainRoomButton: some View {
        Button(action: returnToMainRoom) {
            HStack(spacing: Theme.Space.s1) {
                Image(systemName: "chevron.left")
                    .accessibilityHidden(true)
                Text("Main Room")
            }
            .foregroundColor(Theme.textSecondary)
        }
    }

    // MARK: - Leave / Cancel Tournament / Stop Watching

    /// One choice: its own button; two (the host outside the cut): the "…" menu.
    private var menuEntry: TournamentLobbyMenu.Entry {
        TournamentLobbyMenu.entry(phase: tournamentState.phase, isCreator: isCreator,
                                  isSpectator: tournamentState.isSpectator)
    }

    /// In the content header (the vertical bar has it as a toolbar item). `withText`: the
    /// accessibility sizes' controls row shows the button's words beside its icon; the one-row
    /// header the icon alone (the words would crowd the title). The "…" is an icon in both.
    @ViewBuilder
    private func headerEntry(withText: Bool) -> some View {
        if !bar.usesVerticalBar && menuEntry != .none {
            Group {
                if withText, case .button = menuEntry {
                    // one line, as Main Room beside it (review of PR #437: at AX5 "Stop Watching"
                    // wrapped to two and doubled the row); the Large Content Viewer and VoiceOver
                    // keep the whole words
                    entryPoint.labelStyle(.titleAndIcon).lineLimit(1).minimumScaleFactor(0.5)
                } else {
                    entryPoint.labelStyle(.iconOnly)
                }
            }
            .font(.title3)
            .foregroundColor(Theme.textSecondary)
            .frame(minWidth: Theme.hitTarget, minHeight: Theme.hitTarget)
            .contentShape(Rectangle())
        }
    }

    /// Leave / Cancel Tournament / Stop Watching in ONE level (owner 2026-11-26 on the open Duo, "it
    /// shouldn't be a menu within a menu within a menu"): a member's Leave and a spectator's Stop
    /// Watching (and the host's Leave during the cut) are a plain button, the host's two choices a
    /// "…" menu of plain items; each opens a centred alert with the consequence, a destructive
    /// button and a keep button (`ask`). Never an anchored confirmationDialog: it showed as a
    /// popover pointing at the chat (owner 2026-11-26, "the same fix you did for game selection").
    /// The menu is rebuilt (`.id`) when its choices change (a host hand-off, the cut, the results).
    /// Cancel waits for the session and the re-entry like the slot; Leave never waits (during the
    /// re-entry it is TournamentRejoin.abandon).
    @ViewBuilder
    private var entryPoint: some View {
        switch menuEntry {
        case .none:
            EmptyView()
        case .button(let item):
            Button {
                ask(item)
            } label: {
                // a Label, so the Large Content Viewer has the words at the accessibility sizes
                Label(TournamentLobbyMenu.buttonTitle(item), systemImage: TournamentLobbyMenu.icon(item))
            }
            .accessibilityLabel(TournamentLobbyMenu.title(item))
            .accessibilityHint(TournamentLobbyMenu.hint(menuEntry) ?? "")
            .accessibilityIdentifier(TournamentLobbyMenu.identifier(menuEntry) ?? "")
        case .menu(let items):
            Menu {
                ForEach(items, id: \.self) { item in
                    Button(role: .destructive) {
                        ask(item)
                    } label: {
                        // words alone (review of PR #437, as #430 did): with the icon "Cancel
                        // Tournament…" broke over two lines at the default size on the open and
                        // closed Duo and the iPhone 18 Pro; the trailing ellipsis says it asks first
                        Text(TournamentLobbyMenu.menuTitle(item))
                    }
                    .disabled(item == .cancel && !canSendTournamentActions)
                    .accessibilityIdentifier(TournamentLobbyMenu.menuIdentifier(item))
                }
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
            .id(items)
            .accessibilityLabel("More")
            .accessibilityHint(TournamentLobbyMenu.hint(menuEntry) ?? "")
            .accessibilityIdentifier(TournamentLobbyMenu.identifier(menuEntry) ?? "")
        }
    }

    /// What the open confirmation depends on.
    private var confirmContext: TournamentLobbyMenu.Context {
        TournamentLobbyMenu.Context(tournament: tournamentState, me: authState.username, canSend: canSendTournamentActions)
    }

    private func confirmMessage(_ item: TournamentLobbyMenu.Item) -> String {
        TournamentLobbyMenu.confirmMessage(item, phase: tournamentState.phase, isCreator: isCreator,
                                           othersConnected: othersConnected, othersPresent: othersPresent)
    }

    /// Opens the alert for `item` on the next main-actor turn, so the menu's own dismissal is not
    /// in flight when UIKit presents it (the presenter also skips a controller being dismissed).
    private func ask(_ item: TournamentLobbyMenu.Item) {
        DispatchQueue.main.async {
            #if os(iOS)
            // an alert that went some other way than its buttons or a discard (a refused present,
            // a dismissal from outside) never locks the entry point (review of PR #437)
            if !confirmAlert.isPresented { dropConfirm() }
            #endif
            guard confirming == nil,
                  TournamentLobbyMenu.stillOffers(item, phase: tournamentState.phase, isCreator: isCreator,
                                                  isSpectator: tournamentState.isSpectator) else { return }
            #if os(iOS)
            let words = LeaveAlertPresenter.Words(
                title: TournamentLobbyMenu.confirmTitle(item), message: confirmMessage(item),
                confirm: TournamentLobbyMenu.confirmButton(item), keep: TournamentLobbyMenu.keepButton(item),
                confirmIdentifier: TournamentLobbyMenu.confirmIdentifier, keepIdentifier: TournamentLobbyMenu.keepIdentifier)
            let shown = confirmAlert.present(words) { answer in
                confirming = nil
                if answer == .confirm { perform(item) }
            }
            if shown {
                confirming = item
                // Cancel's confirm waits for the session and the re-entry, as its menu item does
                confirmAlert.setConfirmEnabled(TournamentLobbyMenu.confirmEnabled(item, canSend: canSendTournamentActions))
            }
            #if DEBUG
            if shown { UIFixture.tournamentConfirmPresented() }
            #endif
            #else
            // the macOS app brings its own confirmation with its platform (no macOS target yet)
            perform(item)
            #endif
        }
    }

    /// The lobby changed under the open alert.
    private func confirmContextChanged(_ context: TournamentLobbyMenu.Context) {
        guard let item = confirming else { return }
        #if os(iOS)
        guard confirmAlert.isPresented else { dropConfirm(); return }  // it went some other way
        switch TournamentLobbyMenu.change(open: item, showing: confirmAlert.message, in: context) {
        case .none: break
        case .message(let words): confirmAlert.update(message: words)
        case .discard: dropConfirm(); return
        }
        // the session or the re-entry dropped under Cancel's alert: its confirm waits (in place)
        confirmAlert.setConfirmEnabled(TournamentLobbyMenu.confirmEnabled(item, canSend: context.canSend))
        #endif
    }

    /// The open alert goes with no answer (its choice is gone, or the lobby is).
    private func dropConfirm() {
        #if os(iOS)
        confirmAlert.discard()
        #endif
        confirming = nil
    }

    /// Connected members besides me (a host alone closes the tournament by leaving).
    private var othersConnected: Int {
        tournamentState.players.filter { $0.connected && $0.username != authState.username }.count
    }

    /// Every member besides me, connected or not (a lobby restored after a deploy holds its
    /// disconnected members, so leaving it does not close it).
    private var othersPresent: Int {
        tournamentState.players.filter { $0.username != authState.username }.count
    }

    /// `oneLine`: the one-row header's title stays on one line (shrunk to 0.8, then cut at its
    /// end) rather than wrapping ("ana's / Tournament" beside "Main Room" on an iPhone 18 Pro);
    /// the accessibility sizes' own row lets it wrap.
    private func titleBlock(alignment: HorizontalAlignment, oneLine: Bool = false) -> some View {
        VStack(alignment: alignment, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: "trophy.fill")
                    .foregroundColor(Theme.warning)
                    .accessibilityHidden(true)
                Text(tournamentState.name.isEmpty ? "Tournament" : tournamentState.name)
                    .font(.headline)
                    .foregroundColor(Theme.warning)
                    .lineLimit(oneLine ? 1 : nil)
                    .minimumScaleFactor(oneLine ? 0.8 : 1)
                    .truncationMode(.tail)
                    .accessibilityIdentifier("tournament.title")
            }
            Text(roundIndicator)
                .font(.caption)
                .foregroundColor(Theme.textSecondary)
                // wraps rather than cutting the host's count ("Waiting to start · 4…" at AX5)
                .multilineTextAlignment(alignment == .leading ? .leading : .center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("tournament.roundLine")
            voiceFullNote
        }
    }

    /// The over-cap notice (iOS 1.2.7; s2c tournamentVoiceStatus, TournamentVoice.fullNote): this
    /// member waits in line for the tournament's full voice room, under the round line (the web's
    /// spot beside the round indicator); gone once let in or off the screen.
    @ViewBuilder
    private var voiceFullNote: some View {
        if let cap = tournamentState.voiceFullCap {
            HStack(spacing: Theme.Space.s1) {
                Image(systemName: "mic.slash")
                    .accessibilityHidden(true)
                Text(TournamentVoice.fullNote(cap: cap))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(.caption)
            .foregroundColor(Theme.textSecondary)
            .accessibilityElement(children: .combine)
            .accessibilityHint(TournamentVoice.fullHint)
            .accessibilityIdentifier("tournament.voiceFull")
        }
    }

    private var countText: some View {
        Text(TournamentLobbySlot.Copy.players(tournamentState.players.count))
            .font(.caption)
            .foregroundColor(Theme.textSecondary)
    }

    /// The game lobby's header mic (LobbyHeaderView): a tap mutes / unmutes, touch and hold
    /// opens the voice panel.
    @ViewBuilder
    private var headerMic: some View {
        if showsMic {
            VoiceMuteButton(onLongPress: { showVoicePanel = true })
                .scaleEffect(0.8)
                .accessibilityIdentifier("tournament.mic")
        }
    }

    /// "Waiting to start · 3 rounds", "Round 2 of 3", "Round 2 of 3 complete" (TournamentRounds,
    /// the web's roundLine: the host's count, 1 to 5).
    private var roundIndicator: String {
        if tournamentState.phase == CutForABuck.phase { return CutCopy.title }
        return TournamentRounds.roundLine(phase: tournamentState.phase, currentRound: tournamentState.currentRound,
                                          totalRounds: tournamentState.totalRounds)
    }

    // MARK: - Bottom Buttons

    private var isCreator: Bool {
        authState.username == tournamentState.creatorUsername
    }

    /// The one action slot (TournamentLobbySlot): nil in a round, the cut, the results and for a
    /// spectator.
    private var slot: TournamentLobbySlot? {
        TournamentLobbySlot.of(phase: tournamentState.phase, isCreator: isCreator,
                               isSpectator: tournamentState.isSpectator, isReady: showsReady,
                               deadlinePassed: tournamentState.readyDeadlinePassed,
                               players: tournamentState.players, me: authState.username,
                               host: tournamentState.creatorUsername)
    }

    /// The bottom: one full-width button (Ready, Unready, or the host's Begin with a small
    /// Ready / Unready under it) and a caption saying what it waits for. Nothing (zero height,
    /// still measured) where there is no slot.
    @ViewBuilder
    private var bottomButtons: some View {
        if let slot {
            VStack(spacing: Theme.Space.s1) {
                primaryButton(slot.primary)
                if let toggle = slot.toggle {
                    Button(action: toggleReady) {
                        Text(toggle == .ready ? TournamentLobbySlot.Copy.markReady : TournamentLobbySlot.Copy.markNotReady)
                            .font(.subheadline.bold())
                            .foregroundColor(Theme.primary)
                            .frame(minWidth: Theme.hitTarget * 2, minHeight: Theme.hitTarget)
                            .contentShape(Rectangle())
                    }
                    .disabled(!canSendTournamentActions)
                    .opacity(canSendTournamentActions ? 1 : 0.5)
                    .accessibilityHint(toggle == .ready ? "Marks you ready for the round" : "Marks you not ready")
                    .accessibilityIdentifier("tournament.readyToggle")
                }
                if let caption = slot.caption {
                    Text(caption)
                        .font(.caption)
                        // capped (review of PR #430): at AX5 on the closed Duo three lines of it
                        // left the players' region room for the title only, once Ready was tapped
                        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                        .foregroundColor(Theme.textSecondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("tournament.slotCaption")
                }
            }
            .padding(.horizontal, Theme.Space.s3)
            .padding(.vertical, Theme.Space.s2)
            .animation(A11y.reduceMotion ? nil : .easeInOut(duration: 0.2), value: slot)
        } else {
            Color.clear.frame(height: 0)
        }
    }

    @ViewBuilder
    private func primaryButton(_ primary: TournamentLobbySlot.Primary) -> some View {
        switch primary {
        case .ready:
            slotButton(TournamentLobbySlot.Copy.ready, fill: Theme.buttonBackground, text: Theme.buttonForeground,
                       action: toggleReady)
                .accessibilityHint("Marks you ready for the round")
                .accessibilityIdentifier("tournament.ready")
        case .unready:
            slotButton(TournamentLobbySlot.Copy.unready, fill: Theme.surface, text: Theme.textPrimary, edge: true,
                       action: toggleReady)
                .accessibilityHint("Marks you not ready")
                .accessibilityIdentifier("tournament.ready")
        case .begin(let label):
            slotButton(label, fill: Theme.warning, text: Theme.warningForeground, action: beginRound)
                .accessibilityIdentifier("tournament.begin")
        }
    }

    /// Full width, grows with the text size (wraps, never cut).
    private func slotButton(_ title: String, fill: Color, text: Color, edge: Bool = false,
                            action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.title3.bold())
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: Theme.hitTarget)
                .padding(.vertical, 10)
                .background(fill)
                .foregroundColor(text)
                .cornerRadius(Theme.Radius.md)
                .overlay {
                    if edge {
                        RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.inputBorder, lineWidth: 1)
                    }
                }
        }
        .disabled(!canSendTournamentActions)
        .opacity(canSendTournamentActions ? 1 : 0.5)  // custom fills do not dim by themselves
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

    private func returnToMainRoom() {
        tournamentState.reset()
        appState.screen = .mainRoom
        LobbyEmitter.joinMainRoom()
    }

    private func cancelTournament() {
        TournamentEmitter.cancelTournament()
    }

    /// Leave / Cancel Tournament / Stop Watching, confirmed in its alert.
    private func perform(_ item: TournamentLobbyMenu.Item) {
        // the backstop: the role or the phase changed under the open alert (its choice no longer
        // offered); Cancel re-checks the session at the confirm
        guard TournamentLobbyMenu.stillOffers(item, phase: tournamentState.phase, isCreator: isCreator,
                                              isSpectator: tournamentState.isSpectator) else { return }
        switch item {
        case .cancel:
            guard canSendTournamentActions, isCreator, !tournamentState.isCutPhase, !showsFinal else { return }
            cancelTournament()
        case .leave, .stopWatching:
            leaveTournament()
        }
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

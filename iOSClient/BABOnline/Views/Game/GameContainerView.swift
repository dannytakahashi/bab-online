import SwiftUI
import SpriteKit

/// The game screen. Where the system shows the vertical bar (the iPhone Duo's
/// side column with the status bar: closed, open in landscape, book pose),
/// Leave and the game log toggle are standard toolbar items that the system
/// lays out in that column (iOS 27.1 SDK); everywhere else they are the table's
/// own corner buttons and no navigation bar is shown.
struct GameContainerView: View {
    var body: some View {
        VerticalBarHost { bar in
            GameScreen(usesVerticalBar: bar.usesVerticalBar, windowTopInset: bar.windowTopInset)
        }
    }
}

/// The Exit icon, mirrored so its arrow points left (out of the game).
enum ExitIcon {
    static let symbolName = "rectangle.portrait.and.arrow.right"

    /// For the vertical bar's Exit (iOS 27.1). The bar draws a toolbar item's
    /// symbol itself, ignoring SwiftUI transforms and a symbol image's mirrored
    /// orientation, so the mirrored symbol is drawn into a template bitmap at the
    /// bar's own symbol size, measured against its unmirrored Exit on the iPhone Duo
    /// (iOS 27.2): body text style, large scale, medium weight (bold with Bold
    /// Text), growing with Dynamic Type up to xxLarge.
    static func barImage(dynamicTypeSize: DynamicTypeSize = .large, legibilityWeight: LegibilityWeight? = nil) -> UIImage {
        let bold = legibilityWeight == .bold
        let traits = UITraitCollection { t in
            t.preferredContentSizeCategory = UIContentSizeCategory(min(dynamicTypeSize, .xxLarge))
            t.legibilityWeight = bold ? .bold : .regular
        }
        let configuration = UIImage.SymbolConfiguration(textStyle: .body, scale: .large)
            .applying(UIImage.SymbolConfiguration(weight: bold ? .bold : .medium))
            .withTraitCollection(traits)
        guard let symbol = UIImage(systemName: symbolName, withConfiguration: configuration) else { return UIImage() }
        let mirrored = UIGraphicsImageRenderer(size: symbol.size).image { context in
            context.cgContext.translateBy(x: symbol.size.width, y: 0)
            context.cgContext.scaleBy(x: -1, y: 1)
            symbol.draw(at: .zero)
        }
        return mirrored.withRenderingMode(.alwaysTemplate)
    }
}

/// Hosts the SpriteKit game scene with SwiftUI overlay panels.
///
/// Item 25: the table pane measures its chrome (safe-area insets, ScoreBar
/// height, the Leave / Log buttons, the bottom pill) into `TableChrome`, the
/// scene lays itself out from it (TableLayout), and the bid panel and the
/// HSI / voice accessory are placed from the same layout.
///
/// All of the screen's state lives here, inside the navigation container: the
/// container hosts its root in its own controller, and state owned outside it
/// stopped reaching the table's measurements after the root's first (zero-size)
/// layout pass.
private struct GameScreen: View {
    /// The system shows the vertical bar: Leave / Log are toolbar items there.
    let usesVerticalBar: Bool
    /// The window's top safe-area inset, measured outside the navigation
    /// container; nil without one (before iOS 27.1).
    let windowTopInset: CGFloat?

    @EnvironmentObject var gameState: GameState
    @EnvironmentObject var appState: AppState
    /// Read only in onDisappear, so not observed (LobbyStateLink).
    @Environment(\.lobbyStateLink) private var lobbyLink
    @EnvironmentObject var actions: ActionCoordinator

    @State private var scene: GameSKScene = {
        let s = GameSKScene()
        s.scaleMode = .resizeFill
        return s
    }()

    @State private var showGameLog = false
    /// The tip card's frame in a short column's scroll view (AssistLayout.scrollSpace), and its
    /// pinned title row's height: the row stays at the column's top while the tip is scrolled up.
    @State private var assistTipFrame: CGRect?
    @State private var pinnedTipHeight: CGFloat = 0
    @State private var showVoicePanel = false
    /// The Leave confirmation (a UIKit alert: LeaveAlertPresenter says why).
    @State private var leaveAlert = LeaveAlertPresenter()
    /// When the Leave alert opens and reopens (LeaveAlertFlow).
    @State private var leaveFlow = LeaveAlertFlow()
    @ObservedObject private var voiceManager = VoiceChatManager.shared

    /// Everything but the size TableLayout needs, measured below. Each input
    /// is its own @State and `chrome` is derived from them: several onChange
    /// handlers fire in one update pass, and read-modify-writes of one shared
    /// struct lost fields (a rejoin laid the table out with no corner buttons).
    @State private var paneSafeArea = TableInsets.zero
    @State private var paneOcclusions: [CGRect] = []
    @State private var paneFoldRect: CGRect? = nil
    @State private var scoreBarHeight: CGFloat = 0
    @State private var cornerSize: CGSize = .zero
    @State private var pillHeight: CGFloat = 0

    // Item 27-4: the fold and the docked log
    @Environment(\.horizontalSizeClass) private var hSizeClass
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverOn
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.verticalSizeClass) private var vSizeClass
    // the vertical bar's Exit image follows the bar's symbol size and weight (ExitIcon)
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.legibilityWeight) private var legibilityWeight
    /// Bumped by every hinge change so the fold is read again at the same size.
    @State private var hingeTick = 0
    @State private var dock = Dock.none
    /// Inner landscape: the Log button hides / shows the docked panel.
    @State private var logCollapsed = false

    /// Where the game log goes: the drawer (`none`), a side panel in the open
    /// Duo's landscape (`side`, on the right), or the right page in book pose (`book`, from the hinge).
    enum Dock: Equatable {
        case none, side
        case book(hinge: CGRect)
    }

    private var isPureSpectator: Bool {
        gameState.isSpectator && !gameState.isLazy
    }

    /// The bid overlay: my bid turn, and kept (disabled) while my bid is in flight.
    private var showsBidOverlay: Bool {
        guard !gameState.isReadOnly else { return false }
        switch gameState.myTurn {
        case .choosing(.bid), .submitted(.bid, _): return true
        default: return false
        }
    }

    private var showsTable: Bool { gameState.table.phase.showsTable }
    private var inGame: Bool { gameState.phase == .draw || showsTable }
    /// The table is under the draw, game-end or unreadable overlay, or the log drawer covers the
    /// tip's spot: the voice panel tip waits (VoicePanelTip.cover).
    private var tipCovered: Bool {
        gameState.phase == .draw || (gameState.phase == .ended && gameState.gameEndData != nil)
            || gameState.table.snapshotTrouble != .none || showGameLog
    }
    private var showsPill: Bool { gameState.isSpectator || gameState.isLazy }
    /// The spectator pill's own Exit: only off the table (no corner / bar Leave) and with no game-end modal.
    private var pillShowsExit: Bool { !inGame && gameState.gameEndData == nil }

    /// Leave / Log as toolbar items in the vertical bar instead of the corner buttons.
    private var showsBarControls: Bool { usesVerticalBar && inGame }

    var body: some View {
        gameContent
            // the table keeps the window's own top inset (VerticalBarHost)
            .verticalBarChrome(VerticalBarContext(usesVerticalBar: usesVerticalBar, windowTopInset: windowTopInset),
                               showsBarControls: showsBarControls)
            .toolbar {
                if showsBarControls {
                    ToolbarItem(placement: .topBarLeading) { leaveBarButton }
                    if showsLogButton {
                        ToolbarItem(placement: .topBarTrailing) { logBarButton }
                    }
                    if askInBar {
                        ToolbarItem(placement: .topBarTrailing) { askBarButton }
                    }
                    if tutorialInBar {
                        ToolbarItem(placement: .topBarTrailing) { tutorialBarToggle }
                    }
                }
            }
            #if DEBUG
            .onChange(of: tutorialInBar, initial: true) { _, inBar in
                if UIFixture.isActive { TableDebugProbe.shared.tutorialInBar = inBar }
            }
            .onChange(of: askInBar ? (gameState.showsAssistAsk ? 2 : 1) : 0, initial: true) { _, state in
                if UIFixture.isActive { TableDebugProbe.shared.assistAskInBar = state == 0 ? nil : state == 2 }
            }
            #endif
    }

    private var gameContent: some View {
        ZStack {
            GeometryReader { outer in
                let _ = hingeTick  // re-read the regions after a hinge change
                let mode = dockMode(outer)
                // The table pane is always the first child and the docked panel an
                // optional one after it (on the right, like the drawer, the iPad
                // and the web client), so the table pane (and its SpriteView)
                // keeps its identity in every pose
                HStack(spacing: 0) {
                    tablePane
                        .frame(width: tablePaneWidth(mode))
                    if showsDocked(mode) {
                        if case .book(let hinge) = mode {
                            Color.black.frame(width: hinge.width).ignoresSafeArea()  // the scene never spans the hinge
                        } else {
                            Separator(vertical: true)
                        }
                        GameLogPanel(style: .docked)
                            .frame(width: dockWidth(mode))
                            // only up and down: the side insets are the Duo's vertical bar (the
                            // status column and the Leave / Log items), which shows the felt
                            .background(Theme.surface.ignoresSafeArea(edges: .vertical))
                    }
                }
                .onChange(of: mode, initial: true) { _, m in
                    dock = m
                    if m != .none { showGameLog = false }
                }
                .onChange(of: paneFold(mode, outer), initial: true) { _, fold in
                    if paneFoldRect != fold { paneFoldRect = fold }
                    #if DEBUG
                    if let d = FoldReader.division(outer) { print("[Regions] division \(d) (proxy-local) -> dock \(mode) tabletop \(fold.map { "\($0)" } ?? "-")") }
                    #endif
                }
            }
            .modifier(HingeTick(tick: $hingeTick))
            // the felt behind everything: what the vertical bar shows beside the docked log
            .background(Theme.Palette.Felt.edge.color.ignoresSafeArea())

            // Draw phase overlay
            if gameState.phase == .draw {
                DrawPhaseView()
                    .transition(.opacity)
            }

            // Game end modal
            if gameState.phase == .ended, gameState.gameEndData != nil {
                GameEndView()
                    .transition(.opacity)
            }

            // A snapshot this build cannot show: over everything, never a silent frozen table
            if gameState.table.snapshotTrouble != .none {
                UnreadableTableView(trouble: gameState.table.snapshotTrouble, onLeave: leaveUnreadableTable)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: showsBidOverlay)
        .animation(.easeInOut(duration: 0.3), value: gameState.phase)
        // the voice panel tip waits while an overlay covers the table (the spectator pill's
        // headphones are mounted under the draw and game-end scrims) or the log drawer its spot
        .onChange(of: tipCovered, initial: true) { _, covered in VoicePanelTip.shared.cover(.table, covered) }
        // a refused bid or play: why, in the app's toast (non-blocking; SocketService.serverError
        // announces every new toast to VoiceOver)
        .onChange(of: gameState.notice) { _, notice in
            guard let notice else { return }
            SocketService.shared.serverError = ServerErrorNotice(message: notice.text, kind: notice.info ? .info : .error)
        }
        .onChange(of: gameState.leaveOutcome) { _, outcome in
            runLeave(leaveFlow.changed(outcome: outcome, check: gameState.players.leaveCheck))
        }
        .onChange(of: gameState.players.leaveCheck) { _, check in
            runLeave(leaveFlow.changed(outcome: gameState.leaveOutcome, check: check))
        }
        .onAppear {
            scene.configure(gameState: gameState, actions: actions)
            // 21.14: a seat talks in every game (lobby, queue, tournament, rejoin); idempotent
            if !gameState.isSpectator { VoiceChatManager.shared.ensureStarted() }
        }
        .onDisappear {
            VoiceChatManager.shared.clearCompany(from: .table)
            // a SwiftUI alert went with the view; this UIKit one is dropped, and Leave starts over
            leaveAlert.discard()
            leaveFlow = LeaveAlertFlow()
            VoicePanelTip.shared.cover(.table, false)
            if gameState.players.leaveCheck != .idle { gameState.apply(.local(.leaveClosed)) }
            scene.cleanupAll()
            // play again (1.2.2 (12)): off to the lobby this game's end returned me to, voice
            // carries on (the server kept those calls); any other way off the table ends it
            LobbyReturn.tableGone(lobbyState: lobbyLink.state, appState: appState, voice: .shared)
        }
        // no voice alone (owner 2026-11-19): who is here, for the voice gate (a child of its own,
        // so the lobby kept behind the results is observed without rebuilding the table)
        .background {
            if let lobby = lobbyLink.state {
                TableVoiceCompany(lobby: lobby)
            } else {
                TableVoiceCompany(lobby: nil)
            }
        }
        .sheet(isPresented: $showVoicePanel) {
            VoicePanelSheet(watching: Set(gameState.watching.spectators.map(\.username)),
                            forceListenOnly: fixtureSpectatorVoice == "denied")
                .presentationDetents([.medium])
        }
        // a tapped seat avatar opens that player's profile (GameSKScene+SeatTap; iOS 1.2.2)
        .playerProfileHost(seatTaps: true)
    }

    // MARK: - Fold and dock (27-4)

    private func dockMode(_ p: GeometryProxy) -> Dock {
        guard showsTable || gameState.phase == .draw else { return .none }
        if let div = FoldReader.division(p), div.height > div.width, div.minX > 0, div.maxX < p.size.width {
            // the right page holds the log only when both pages are wide enough (a readable log,
            // a table that needs no fallback); otherwise the table spans both pages and
            // TableLayout keeps its cluster and seats off the hinge
            let tablePage = div.minX + p.safeAreaInsets.leading
            let logPage = p.size.width - div.maxX
            return logPage >= 240 && tablePage >= 375 ? .book(hinge: div) : .none
        }
        let i = p.safeAreaInsets
        let w = p.size.width + i.leading + i.trailing, h = p.size.height + i.top + i.bottom
        if UIDevice.current.userInterfaceIdiom == .phone, hSizeClass == .regular, vSizeClass == .regular,
           w > h, w - 320 >= 560 {
            return .side
        }
        return .none
    }

    private func showsDocked(_ mode: Dock) -> Bool {
        switch mode {
        case .none: return false
        case .side: return !logCollapsed
        case .book: return true
        }
    }

    /// The side panel is 320 wide; in book pose the log takes the rest of the right page.
    private func dockWidth(_ mode: Dock) -> CGFloat? {
        if case .book = mode { return nil }
        return 320
    }

    /// In book pose the table pane is the left page, up to the hinge; otherwise it is flexible.
    private func tablePaneWidth(_ mode: Dock) -> CGFloat? {
        if case .book(let hinge) = mode { return max(0, hinge.minX) }
        return nil
    }

    /// The fold TableLayout sees in the table pane: undocked, the division as it is
    /// (tabletop: table above, hand below; book: cluster on the wider page); beside the
    /// inner-landscape side panel, a horizontal (tabletop) division only, which spans
    /// the pane (only its y matters); in book dock none (the scene never spans the hinge).
    private func paneFold(_ mode: Dock, _ p: GeometryProxy) -> CGRect? {
        switch mode {
        case .none:
            return sceneFold(p)
        case .side:
            guard let f = sceneFold(p), f.width > f.height else { return nil }
            let i = p.safeAreaInsets
            let fullWidth = p.size.width + i.leading + i.trailing
            return CGRect(x: -fullWidth / 2, y: f.minY, width: fullWidth, height: f.height)
        case .book:
            return nil
        }
    }

    /// The division in the scene's coordinates of the full window.
    private func sceneFold(_ p: GeometryProxy) -> CGRect? {
        guard let div = FoldReader.division(p) else { return nil }
        let i = p.safeAreaInsets
        let full = CGSize(width: p.size.width + i.leading + i.trailing, height: p.size.height + i.top + i.bottom)
        return FoldReader.toScene(div, in: full, insets: i)
    }

    // MARK: - Panes

    /// The table and what floats over it. Only the table layer ignores the
    /// keyboard: the log drawer's chat field keeps keyboard avoidance.
    private var tablePane: some View {
        ZStack {
            // every pass hands the scene its chrome (applied on the next main-queue turn): the
            // onChange below misses changes that land in one burst (presence-mixed's table kept
            // the score bar's first, wrapped 109.5 pt and a 109 pt banner while SwiftUI drew a
            // 71 pt bar and a 123.5 pt banner, so the banner found no spot and covered the partner)
            let _ = scene.takeChrome(chrome)
            tableLayer
                .ignoresSafeArea(.keyboard)

            // the voice panel tip, once (VoicePanelTip): at the top as the other toasts, clear
            // of my seat's row (the mic), my hand and the bid panel
            VStack(spacing: 0) {
                VoicePanelTipToast()
                    .padding(.top, Theme.Space.s2)
                Spacer(minLength: 0)
            }

            // Game log panel
            if showGameLog {
                GameLogView(isShowing: $showGameLog)
                    .transition(.motion(.move(edge: .trailing), reduceMotion: reduceMotion))
            }
        }
    }

    @State private var bannerHeight: CGFloat = 0

    /// Disconnect banner: below the partner's seat where the table has room
    /// (TableLayout.disconnectBanner), else below the corner buttons. Placed from the pane's
    /// layout for this pass (the pane's size and chrome, the banner's own height included: a
    /// banner taller than the zoom's reserve steps a zoomed table down), so it never waits for
    /// the scene to take the new chrome.
    @ViewBuilder
    private func disconnectBanner(_ L: TableLayout, safeTop: CGFloat) -> some View {
        if gameState.showsPresenceBanner {
            VStack {
                DisconnectBannerView()
                    .frame(maxWidth: TableLayout.disconnectBannerMaxWidth)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { bannerHeight = $0 }
                    .padding(.top, bannerTop(L, safeTop: safeTop))
                Spacer()
            }
        }
    }

    /// The banner's top inset in the safe area: the layout's spot off the avatars, else under the corner buttons.
    private func bannerTop(_ L: TableLayout, safeTop: CGFloat) -> CGFloat {
        guard showsTable else { return 0 }
        // the banner's measured points in scene units (a zoomed table's are larger than points)
        if let r = L.disconnectBanner(height: bannerHeight / L.zoom, spectating: !gameState.table.viewer.holdsSeat) {
            return max(0, L.window(r).minY - safeTop)
        }
        return chrome.topBar + 8 + chrome.cornerButton.height + 8
    }

    /// One GeometryReader measures the pane: its size plus the safe-area
    /// insets is the scene size (the SpriteView ignores the safe area).
    ///
    /// Nothing is measured before the pane has a size: a navigation container's
    /// root is first laid out at zero size, where the ScoreBar wraps to 120-170 pt
    /// and the insets are 0, and those reports could land after the real ones.
    private var tableLayer: some View {
        GeometryReader { proxy in
            let ins = proxy.safeAreaInsets
            let full = CGSize(width: proxy.size.width + ins.leading + ins.trailing, height: proxy.size.height + ins.top + ins.bottom)
            let layout = TableLayout(size: full, chrome: chrome)
            // NavigationStack lays its root out once at 0 x 0 first: measure nothing until the
            // pane has a size. The pane must never pass through 0 x 0 later (it would rebuild the
            // SpriteView and re-run didMove); no dock or fold width reaches 0 today.
            if proxy.size.width > 0 && proxy.size.height > 0 {
            ZStack {
                // The scene and the layout-placed overlays share the full pane's
                // coordinates (an overlay of the safe-area-ignoring SpriteView, so
                // the full-size layer never resizes this ZStack)
                SpriteView(scene: scene)
                    .overlay(alignment: .topLeading) { layoutOverlays(layout, full: full) }
                    .ignoresSafeArea()

                // Score bar pinned to the top of the safe area
                VStack(spacing: 0) {
                    if showsTable {
                        ScoreBarView()
                            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { scoreBarHeight = $0 }
                    }
                    Spacer()
                }

                if inGame && !usesVerticalBar { cornerButtons(layout) }

                pills

                disconnectBanner(layout, safeTop: ins.top)
            }
            .onChange(of: TableInsets(top: ins.top, left: ins.leading, bottom: ins.bottom, right: ins.trailing), initial: true) { _, new in
                paneSafeArea = new
            }
            .onChange(of: FoldReader.occlusions(proxy), initial: true) { _, rects in
                // system UI over the app (25-4 step 6): joins the corner obstacles in TableLayout
                paneOcclusions = rects.map { FoldReader.toScene($0, in: full, insets: ins) }
                #if DEBUG
                print("[Regions] occlusions \(rects) (proxy-local) pane \(full) insets \(ins)")
                #endif
            }
            }
        }
        .onChange(of: chrome, initial: true) { _, new in
            scene.chrome = new
            #if DEBUG
            if UIFixture.isActive { TableDebugProbe.shared.chrome = new }
            #endif
        }
    }

    /// The bid panel and my seat's row (HSI / voice), placed from the layout in the full pane's coordinates.
    private func layoutOverlays(_ layout: TableLayout, full: CGSize) -> some View {
                ZStack(alignment: .topLeading) {
                    Color.clear.allowsHitTesting(false)
                    if showsBidOverlay {
                        // bottom at layout.bidBand.minY, centered on the band (replaces padding 200)
                        VStack(spacing: 0) {
                            Spacer(minLength: 0)
                            BidOverlayView(zoom: layout.zoom, onClockFrame: { bidClockFrame = $0 }, onAskFrame: { bidAskFrame = $0 },
                                           askInBar: showsBarControls)
                                .frame(maxWidth: layout.window(layout.bidBand).width)
                            Color.clear.frame(height: max(0, layout.bidPanelBottomInset))
                        }
                        .frame(width: full.width, height: full.height)
                        .offset(x: layout.window(layout.bidBand).midX - full.width / 2)
                        .transition(.motion(.move(edge: .bottom).combined(with: .opacity), reduceMotion: reduceMotion))
                    }
                    if showsTable {
                        pipsAccessibility(layout)
                    }
                    // my seat's row (my pips are the scene's; HSI and voice here); on my bid turn
                    // the panel covers its spot and shows HSI itself (BidOverlayView)
                    if showsTable && !showsBidOverlay {
                        seatRow(layout)
                    }
                    // hidden under my bid panel's turn, as my seat's row (the panel may span its spot)
                    if showsTable && !showsBidOverlay && gameState.watching.count > 0 {
                        spectatorBadge(layout)
                    }
                    // /help: the lightbulb at my hand's right end on my play turn (on my bid turn
                    // it is on the bid panel's corner: BidOverlayView), and my answer's card
                    if showsTable && !showsBidOverlay && gameState.showsAssistAsk && !showsBarControls {
                        assistAsk(layout)
                    }
                    // my answer's card, and the tutorial's tips and chip above it (one column)
                    if showsTable && showsAssistColumn {
                        assistColumn(layout, full: full)
                    }
                }
                .frame(width: full.width, height: full.height, alignment: .topLeading)
                .coordinateSpace(name: BidClockPill.paneSpace)
                #if DEBUG
                .onChange(of: bidClockKeeps(layout), initial: true) { _, keeps in
                    guard UIFixture.isActive else { return }
                    TableDebugProbe.shared.tableKeeps = keeps
                    TableDebugProbe.shared.tableFold = layout.foldIgnored ? nil : layout.chrome.fold.map(layout.window)
                }
                #endif
    }

    #if DEBUG
    /// The table the bidder's countdown keeps off (fixture probe "table.bidClock"), in the pane's points.
    private func bidClockKeeps(_ layout: TableLayout) -> [String: CGRect] {
        var out: [String: CGRect] = [:]
        let model = TableRenderModel(gameState.state)
        let fans = layout.fans(spectating: model.hand == nil) ?? [:]
        for o in model.opponents {
            out["seat\(o.position)"] = layout.window(layout.seatFootprint(o.rel))
            out["bubble\(o.position)"] = layout.window(TableLayout.rect(layout.bubbleAnchor(o.rel), TableLayout.bubbleSize))
            if let fan = fans[o.rel] { out["fan\(o.position)"] = layout.window(fan) }
        }
        return out
    }
    #endif

    /// The table's chrome, derived from the measured inputs (0 when hidden).
    private var chrome: TableChrome {
        TableChrome(safeArea: paneSafeArea,
                    topBar: showsTable ? scoreBarHeight : 0,
                    cornerButton: inGame && !usesVerticalBar ? cornerSize : .zero,
                    bottomBar: showsPill && pillHeight > 0 ? pillHeight + 12 : 0,
                    fold: paneFoldRect,
                    occlusions: paneOcclusions,
                    // a zoomed table steps down while a banner taller than its reserve shows (TableLayout.zoom)
                    banner: showsTable && gameState.showsPresenceBanner ? bannerHeight : 0)
    }

    // MARK: - Corner buttons

    private func cornerButtons(_ layout: TableLayout) -> some View {
        VStack {
            HStack(alignment: .top) {
                // Leave/exit game button (always on screen during play — Guideline 4; in the
                // Duo's vertical bar the system may fold it into the bar's overflow menu)
                Button(action: handleLeaveTapped) {
                    HStack(spacing: Theme.Space.s1) {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                            .accessibilityHidden(true)  // the button reads "Exit game"
                            .scaleEffect(x: -1, y: 1)    // mirrored: the arrow points left, out of the game
                        Text("Exit")
                    }
                    .font(.caption.bold())
                    .foregroundColor(Theme.textSecondary)
                    .padding(.horizontal, Theme.Space.s3)
                    .padding(.vertical, 10)
                    .background(Theme.surface.opacity(0.8))
                    .clipShape(Capsule())
                }
                .accessibilityIdentifier("leave")
                // not the symbol's "Portrait Rectangle With A Right Arrow, Leave"
                .accessibilityLabel(leaveLabel)
                .dynamicTypeSize(...DynamicTypeSize.xxLarge)
                .accessibilityShowsLargeContentViewer()  // text stops growing at xxLarge
                .onGeometryChange(for: CGSize.self, of: { $0.size }) { leaveSize = $0 }
                .padding(.leading, 12 + layout.paneOccludedLeft)  // clear of a full-height system strip

                Spacer()

                // Game log toggle button: the drawer, or the docked panel in inner landscape
                // (hidden in book pose: the log is the right page)
                if showsLogButton {
                Button(action: toggleLog) {
                    Image(systemName: logIsOpen ? "xmark.circle.fill" : "text.bubble.fill")
                        .font(.title2)
                        .foregroundColor(Theme.textSecondary)
                        .padding(Theme.Space.s3)
                        .background(Theme.surface.opacity(0.8))
                        .clipShape(Circle())
                        .overlay(alignment: .topTrailing) {
                            if !logIsOpen && gameState.unreadChatCount > 0 {
                                Text("\(gameState.unreadChatCount)")
                                    .font(.caption2.bold())
                                    .dynamicTypeSize(...DynamicTypeSize.xLarge)
                                    .foregroundStyle(Theme.dangerForeground)
                                    .frame(minWidth: 18, minHeight: 18)
                                    .background(Theme.danger)
                                    .clipShape(Circle())
                                    .offset(x: 4, y: -4)
                            }
                        }
                }
                .accessibilityIdentifier("log")
                .accessibilityLabel("Game log")
                .dynamicTypeSize(...DynamicTypeSize.xxLarge)
                .accessibilityShowsLargeContentViewer()
                .onGeometryChange(for: CGSize.self, of: { $0.size }) { logSize = $0 }
                .padding(.trailing, 12 + layout.paneOccludedRight)
                }
            }
            .padding(.top, showsTable ? chrome.topBar + 8 : 80)
            Spacer()
        }
        // the buttons take their table spot at once when the deal ends the draw: carried by the
        // phase change's 0.3 s animation they faded in about 60 pt low (over the right seat's
        // card backs) and slid up, though no layout pass ever placed them there (live,
        // 2026-11-16; TableChromeAnimationTests)
        .animation(nil, value: showsTable)
        .animation(nil, value: chrome.topBar)
        .onChange(of: CGSize(width: max(leaveSize.width, logSize.width), height: max(leaveSize.height, logSize.height)), initial: true) { _, s in
            cornerSize = s
        }
    }

    // MARK: - Leave / Log in the vertical bar (iOS 27.1)

    private var leaveBarButton: some View {
        Button(action: handleLeaveTapped) {
            Label {
                Text("Exit")
            } icon: {
                // The vertical bar draws the image itself and drops SwiftUI transforms
                // (a scale-effect mirror still pointed right): the mirror is in the image.
                Image(uiImage: ExitIcon.barImage(dynamicTypeSize: dynamicTypeSize, legibilityWeight: legibilityWeight))
                    .accessibilityHidden(true)
            }
        }
        .disabled(gameState.phase == .draw)  // as the corner button under the draw overlay
        .accessibilityIdentifier("leave")
        .accessibilityLabel(leaveLabel)
    }

    /// "Exit game" at a seat and for a pure spectator alike (owner, 2026-11-12: one word for both; the button shows Exit).
    private var leaveLabel: String { "Exit game" }

    /// The unread count is the standard toolbar badge. The vertical bar (seen with
    /// the iOS 27.2 SDK) draws a badge only when it builds the item, not when the
    /// count changes, so the item's identity follows the count. With VoiceOver on
    /// the item keeps its identity (a rebuild would drop VoiceOver focus on every
    /// chat line) and the count is spoken as the button's value instead.
    private var logBarButton: some View {
        let unread = logIsOpen ? 0 : gameState.unreadChatCount
        return Button(action: toggleLog) {
            Label("Game log", systemImage: logIsOpen ? "xmark.circle.fill" : "text.bubble.fill")
        }
        .disabled(gameState.phase == .draw)
        .accessibilityIdentifier("log")
        .accessibilityValue(unread > 0 ? "\(unread) unread" : "")
        .badge(unread)
        .id(voiceOverOn ? 0 : unread)
    }

    /// The tutorial's switch is a vertical bar item under the log's (owner 2026-11-20: the
    /// iPhone Duo's column is short, and the chip took a row of it above the bid panel);
    /// elsewhere it is the "Tutorial on" chip at the column's foot.
    private var tutorialInBar: Bool { showsBarControls && gameState.showsTutorialChip }
    private var showsColumnChip: Bool { gameState.showsTutorialChip && !showsBarControls }

    /// /help's lightbulb as a bar item (owner 2026-11-20, with the tutorial's switch): there for
    /// the whole game, so the bar does not rebuild every turn, and enabled only on my turn with no
    /// answer up or on its way (`showsAssistAsk`, the felt's lightbulb rule); the felt and the bid
    /// panel then show none.
    private var askInBar: Bool { showsBarControls && gameState.showsAssistBarItem }

    private var askBarButton: some View {
        Button(action: askHelp) {
            Label(AssistRules.askLabel, systemImage: "lightbulb.fill")
        }
        .tint(Theme.gold)  // the felt lightbulb's gold
        .disabled(!gameState.showsAssistAsk || gameState.phase == .draw)
        .accessibilityLabel(AssistRules.askLabel)
        .accessibilityHint("Sends /help. Only you see the answer; the table sees that you asked.")
        .accessibilityIdentifier("assist.ask")
    }

    /// The chip's switch as a bar item: a button-style toggle (the bar draws it selected while
    /// on); switching it off sends /tutorial off, and the item goes with the server's answer.
    private var tutorialBarToggle: some View {
        let on = !gameState.tutorialOffSent
        return Toggle(isOn: Binding(get: { on }, set: { if !$0 { tutorialOff() } })) {
            Label(TutorialRules.chipText, systemImage: "graduationcap.fill")
        }
        .toggleStyle(.button)
        .tint(Theme.primary)  // the chip's switch green, not the system blue
        .disabled(!on)
        // the bar keeps a label but drops the value and the toggle trait: the state is in the
        // label, the chip's own words ("Tutorial on")
        .accessibilityLabel(TutorialRules.chipText)
        .accessibilityHint(TutorialRules.chipHint)
        .accessibilityAddTraits(.isToggle)
        .accessibilityIdentifier("tutorial.chip")
    }

    /// The Log button is hidden in book pose: the log is the right page.
    private var showsLogButton: Bool {
        if case .book = dock { return false }
        return true
    }

    /// The drawer, or the docked panel in inner landscape.
    private func toggleLog() {
        withAnimation {
            if dock == .side {
                logCollapsed.toggle()
            } else {
                showGameLog.toggle()
                if showGameLog {
                    gameState.apply(.local(.chatRead))
                }
            }
        }
    }

    private var logIsOpen: Bool {
        switch dock {
        case .none: return showGameLog
        case .side: return !logCollapsed
        case .book: return true
        }
    }

    @State private var leaveSize: CGSize = .zero
    /// My bid clock's pill on the bid panel's edge, in the pane, as last laid out (nil: never
    /// shown): the /help card stays above it while my clock runs (`myBidClockRuns`).
    @State private var bidClockFrame: CGRect?
    /// The lightbulb on the bid panel's corner, in the pane, as last laid out: the tutorial's
    /// tips and chip keep above it while it shows (the /help card never shows with it).
    @State private var bidAskFrame: CGRect?

    /// My seat's bid clock runs (BidOverlayView.myClock: a seat holder's own clock).
    private var myBidClockRuns: Bool {
        gameState.bidCountdown?.position == gameState.position && gameState.table.viewer.role == .seat
    }
    @State private var logSize: CGSize = .zero

    // MARK: - My seat's row: my pips (the scene's), HSI, voice (layout.seatRow)

    /// HSI and the voice button at their slots of my seat's row (TableLayout+SeatRow.swift):
    /// side by side after my pips (`.row`) or beside the column of my pips over HSI
    /// (`.compact`), the button following HSI; each at its own slot in `.narrow` / `.stacked`.
    @ViewBuilder
    private func seatRow(_ layout: TableLayout) -> some View {
        let row = layout.seatRow
        let hsi = gameState.myHSIReading
        // a pure spectator's row is the watched seat's: its voice button is the pill's (1.2.2 (12))
        #if DEBUG
        let voice = (voiceManager.isActive || UIFixture.showsVoiceButton) && !isPureSpectator
        #else
        let voice = voiceManager.isActive && !isPureSpectator
        #endif
        if row.voiceFollowsHSI {
            if hsi != nil || voice {
                let rect = layout.window(row.hsi.union(row.voice))
                let compact = row.mode == .compact
                // the slots are scene units: a zoomed table's are `zoom` points each
                HStack(alignment: compact ? .bottom : .center,
                       spacing: (compact ? TableLayout.seatRowColumnSpacing : TableLayout.seatRowSpacing) * layout.zoom) {
                    // the button keeps its slot whatever HSI reads, or with none
                    SeatRowHSISlot(reading: hsi, zoom: layout.zoom)
                    if voice { VoiceMuteButton(onLongPress: { showVoicePanel = true }, size: TableLayout.voiceButtonSize * layout.zoom) }
                }
                .frame(width: rect.width, height: rect.height, alignment: compact ? .bottomLeading : .leading)
                .offset(x: rect.minX, y: rect.minY)
            }
        } else {
            if let hsi {
                let rect = layout.window(row.hsi)
                HSIBadge(reading: hsi)
                    .frame(width: rect.width, height: rect.height, alignment: .leading)
                    .offset(x: rect.minX, y: rect.minY)
            }
            if voice {
                let rect = layout.window(row.voice)
                VoiceMuteButton(onLongPress: { showVoicePanel = true }, size: TableLayout.voiceButtonSize * layout.zoom)
                    .frame(width: rect.width, height: rect.height)
                    .offset(x: rect.minX, y: rect.minY)
            }
        }
    }

    // MARK: - Trick pips for VoiceOver (the scene draws them; SeatPips)

    /// One element per seat whose bid counts, over the seat (or, mine, over my pips' box in my seat's row): "Ann: 2 of 3 tricks",
    /// "Your tricks: Team 7 of 10, bore", "Bo: Bid 0, no tricks". Taps go through to the table.
    @ViewBuilder
    private func pipsAccessibility(_ layout: TableLayout) -> some View {
        let model = TableRenderModel(gameState.state)
        ForEach(model.opponents, id: \.position) { o in
            if let p = model.spokenPips[o.position] {
                let rect = layout.window(layout.seatFootprint(o.rel))
                Color.clear
                    .frame(width: rect.width, height: rect.height)
                    .accessibilityElement()
                    .accessibilityLabel("\(o.name): \(p.accessibilityLabel)")
                    .accessibilityIdentifier("pips.\(o.position)")
                    .allowsHitTesting(false)
                    .offset(x: rect.minX, y: rect.minY)
            }
        }
        // the card backs ("kim: 5 cards") and the dealer marker, drawn by the scene
        if let fans = layout.fans(spectating: model.hand == nil) {
            ForEach(model.opponents, id: \.position) { o in
                if let box = fans[o.rel], o.cards > 0 {
                    let rect = layout.window(box)
                    Color.clear
                        .frame(width: rect.width, height: rect.height)
                        .accessibilityElement()
                        .accessibilityLabel("\(o.name): \(o.cards) \(o.cards == 1 ? "card" : "cards")")
                        .accessibilityIdentifier("fan.\(o.position)")
                        .allowsHitTesting(false)
                        .offset(x: rect.minX, y: rect.minY)
                }
            }
        }
        if let dealer = model.dealer {
            let seat = model.opponents.first { $0.position == dealer }
            if seat != nil || model.iDeal {
                let rect = layout.window(seat.map { layout.dealerChip($0.rel) } ?? layout.myDealerChip(handCount: model.hand?.cards.count ?? 0))
                Color.clear
                    .frame(width: rect.width, height: rect.height)
                    .accessibilityElement()
                    .accessibilityLabel(seat.map { "Dealer: \($0.name)" } ?? "You are the dealer")
                    .accessibilityIdentifier("dealer")
                    .accessibilityValue("\(dealer)")
                    .allowsHitTesting(false)
                    .offset(x: rect.minX, y: rect.minY)
            }
        }
        if let mine = model.mySpokenPips {
            let rect = layout.window(layout.myPips)
            Color.clear
                .frame(width: rect.width, height: rect.height)
                .accessibilityElement()
                .accessibilityLabel("Your tricks: \(mine.accessibilityLabel)")
                .accessibilityIdentifier("pips.mine")
                .allowsHitTesting(false)
                .offset(x: rect.minX, y: rect.minY)
        }
    }

    // MARK: - /help (AssistCardView): above my hand, or above the bid panel while I bid

    /// My hand's box in the pane's points (AssistLayout.handBox).
    private func handBox(_ layout: TableLayout) -> CGRect {
        AssistLayout.handBox(layout, count: gameState.myCards.count)
    }

    /// What the lightbulb keeps clear of on my play turn: my seat's row as it draws now (my
    /// pips' pill, HSI, the voice button: the same conditions as `seatRow` and the scene), the
    /// spectator badge while it shows, and the rest of the table (AssistAskLayout.swift).
    private func assistAskKeeps(_ layout: TableLayout) -> AssistLayout.AskKeeps {
        #if DEBUG
        let voice = (voiceManager.isActive || UIFixture.showsVoiceButton) && !isPureSpectator
        #else
        let voice = voiceManager.isActive && !isPureSpectator
        #endif
        let badge = gameState.watching.count > 0
            ? layout.window(layout.spectatorBadge(spectating: !gameState.table.viewer.holdsSeat)) : nil
        return AssistLayout.askKeeps(layout, handCount: gameState.myCards.count,
                                     pipSlots: TableRenderModel(gameState.state).myPips?.slots ?? 0,
                                     hsi: gameState.myHSIReading != nil, voice: voice, spectatorBadge: badge)
    }

    /// The lightbulb: its right edge at my hand's right end, just above the lifted cards, or, when
    /// that is on my seat's row (a short hand, or the voice button), one spot left of the row for
    /// as long as the row is in the way (AssistLayout.askFrame / askLane).
    private func assistAsk(_ layout: TableLayout) -> some View {
        let keeps = assistAskKeeps(layout)
        let f = AssistLayout.askFrame(keeps)
        return AssistAskButton(size: AssistLayout.askSize, action: askHelp)
            .frame(width: f.width, height: f.height)
            .offset(x: f.minX, y: f.minY)
            .transition(.opacity)
            #if DEBUG
            .onChange(of: f, initial: true) { _, r in
                if UIFixture.isActive { TableDebugProbe.shared.assistAsk = (r, AssistLayout.askProblems(r, keeps), Array(keeps.drawn.keys) + Array(keeps.taps.keys)) }
            }
            .onDisappear { if UIFixture.isActive && !gameState.showsAssistAsk { TableDebugProbe.shared.assistAsk = nil } }
            #endif
    }

    private func askHelp() {
        #if DEBUG
        let connected = SocketService.shared.isConnected || UIFixture.isActive
        #else
        let connected = SocketService.shared.isConnected
        #endif
        if actions.askHelp(connected: connected) { HapticManager.selection() }
    }

    /// The lightbulb's frame on my play turn (at my hand's right end, just above the lifted cards).
    private func assistAskFrame(_ layout: TableLayout) -> CGRect {
        let box = handBox(layout)
        let size = AssistLayout.askSize
        let hit = max(size, Theme.hitTarget)
        return CGRect(x: max(0, box.maxX - hit + (hit - size) / 2), y: max(0, box.minY - hit + (hit - size) / 2 - 2),
                      width: hit, height: hit)
    }

    /// Exit and the game log's button under the score bar (cornerButtons), in the pane's
    /// points: the column's box starts below them where it spans them (a phone's width).
    private func cornerRects(_ layout: TableLayout, full: CGSize) -> [CGRect] {
        guard inGame && !usesVerticalBar, cornerSize != .zero else { return [] }
        let y = paneSafeArea.top + chrome.topBar + 8
        let lead = CGRect(x: paneSafeArea.left + 12 + layout.paneOccludedLeft, y: y, width: cornerSize.width, height: cornerSize.height)
        let trail = CGRect(x: full.width - paneSafeArea.right - 12 - layout.paneOccludedRight - cornerSize.width, y: y,
                           width: cornerSize.width, height: cornerSize.height)
        return [lead, trail]
    }

    /// The other seats' parts the column keeps clear of (AssistLayout.Keeps.seats / .sides), in
    /// the pane's points: each one's avatar and name, its bid bubble's spot and the dealer
    /// button; the seat across (the partner's, for a spectator seat 1's opposite) or the two
    /// side seats.
    private func otherSeats(_ layout: TableLayout, sides: Bool) -> [String: CGRect] {
        let model = TableRenderModel(gameState.state)
        var out: [String: CGRect] = [:]
        for o in model.opponents where (o.rel == .left || o.rel == .right) == sides {
            out["seat\(o.position)"] = layout.window(layout.seatFootprint(o.rel))
            out["bubble\(o.position)"] = layout.window(layout.bubbleRect(o.rel))
            if model.dealer == o.position { out["dealer\(o.position)"] = layout.window(layout.dealerChip(o.rel)) }
        }
        return out
    }

    /// Something of the column is up: my answer, a tutorial tip or its welcome, the tutorial's chip.
    private var showsAssistColumn: Bool {
        gameState.assistHint != nil || gameState.tutorialTip != nil || gameState.tutorialWelcome != nil
            || showsColumnChip
    }

    /// The column: the welcome, a rule tip, my answer's card, then the "Tutorial on" chip at its
    /// leading foot, centred on my hand, its bottom just above the lifted cards and my seat's
    /// row (HSI, the voice button, my pips), or above the bid panel and its countdown while it
    /// shows, and above the lightbulb while that shows (the tutorial's tips and chip may be up
    /// with it); in a tabletop pose it stays below the fold with them; scrolls inside when the
    /// room up to the score bar (or the fold) is short.
    private func assistColumn(_ layout: TableLayout, full: CGSize) -> some View {
        let box = handBox(layout)
        let bidding = showsBidOverlay
        let ask: CGRect? = gameState.showsAssistAsk && !showsBarControls ? (bidding ? bidAskFrame : assistAskFrame(layout)) : nil
        let keeps = AssistLayout.Keeps(
            anchor: bidding ? layout.window(layout.bidBand).minY : box.minY,
            clock: bidding && myBidClockRuns ? bidClockFrame : nil,
            seatRow: bidding ? nil : layout.window(layout.seatRow.content),
            fold: layout.foldIgnored ? nil : layout.chrome.fold.map(layout.window),
            ask: ask,
            corners: cornerRects(layout, full: full),
            seats: otherSeats(layout, sides: false),
            sides: otherSeats(layout, sides: true))
        let f = AssistLayout.frame(paneWidth: full.width, handMidX: box.midX, handWidth: box.width,
                                   top: paneSafeArea.top + scoreBarHeight + Theme.Space.s2, keeps: keeps,
                                   safeLeft: paneSafeArea.left, safeRight: paneSafeArea.right,
                                   foot: showsColumnChip ? Theme.hitTarget + AssistLayout.gap : 0)
        let hasCards = gameState.tutorialWelcome != nil || gameState.tutorialTip != nil || gameState.assistHint != nil
        // the chip stays at the column's foot; only the cards scroll when the room is short (the
        // column is bottom-aligned in its box, so a short column's scroll view has all its room)
        return VStack(alignment: .leading, spacing: AssistLayout.gap) {
            if hasCards {
                ViewThatFits(in: .vertical) {
                    assistCards(inScroll: false)
                    // short of room (a phone or the iPhone Duo open: a tip and the advice are
                    // taller than the room above the bid panel and below the other seats): the
                    // advice's chip and headline in sight at the foot, the tip above scrolled up
                    // as far as needed (its row is in the log), its title and × pinned at the top
                    ScrollViewReader { proxy in
                        ScrollView { assistCards(inScroll: true) }
                            .coordinateSpace(name: AssistLayout.scrollSpace)
                            .overlay(alignment: .top) { pinnedTipHead }
                            .scrollBounceBehavior(.basedOnSize)
                            .onAppear { showAdviceHead(proxy) }
                            .onChange(of: gameState.assistHint) { _, _ in showAdviceHead(proxy) }
                            .onChange(of: gameState.tutorialTip) { _, _ in showAdviceHead(proxy) }
                            .onChange(of: gameState.tutorialWelcome) { _, _ in showAdviceHead(proxy) }
                    }
                }
                #if DEBUG
                .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(BidClockPill.paneSpace)) }) { r in
                    if UIFixture.isActive { TableDebugProbe.shared.assistFrame = r }
                }
                // only once the cards are gone: a removed copy's onDisappear may come after a new one's frame
                .onDisappear {
                    if UIFixture.isActive && gameState.assistHint == nil && gameState.tutorialTip == nil && gameState.tutorialWelcome == nil {
                        TableDebugProbe.shared.assistFrame = nil
                    }
                }
                #endif
            }
            if showsColumnChip {
                TutorialChipView(switchingOff: gameState.tutorialOffSent, action: tutorialOff)
                    #if DEBUG
                    .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(BidClockPill.paneSpace)) }) { r in
                        if UIFixture.isActive { TableDebugProbe.shared.tutorialChipFrame = r }
                    }
                    .onDisappear { if UIFixture.isActive && !showsColumnChip { TableDebugProbe.shared.tutorialChipFrame = nil } }
                    #endif
            }
        }
        #if DEBUG
        .onChange(of: keeps.probe, initial: true) { _, k in
            if UIFixture.isActive { TableDebugProbe.shared.assistKeeps = k }
        }
        .onChange(of: keeps.seatProbe, initial: true) { _, k in
            if UIFixture.isActive { TableDebugProbe.shared.assistSeats = k }
        }
        #endif
        .frame(width: f.width, height: f.height, alignment: .bottomLeading)
        .offset(x: f.minX, y: f.minY)
        .animation(.easeInOut(duration: 0.2), value: gameState.tutorialTip)
        .transition(.opacity)
    }

    /// The column's cards: the tip up (the welcome, else a rule tip: one at a time), then my
    /// answer. `inScroll`: the short column's copy, whose tip reports its frame in the scroll
    /// view (`pinnedTipHead`).
    private func assistCards(inScroll: Bool) -> some View {
        VStack(alignment: .leading, spacing: AssistLayout.gap) {
            if let welcome = gameState.tutorialWelcome {
                TutorialTipView(tip: welcome, onClose: tutorialClose, onKeep: tutorialKeep, onTurnOff: tutorialOff)
                    .background { if inScroll { tipFrameReporter } }
                    .transition(.opacity)
            }
            if let tip = gameState.tutorialTip {
                TutorialTipView(tip: tip, onClose: tutorialTipClose)
                    .background { if inScroll { tipFrameReporter } }
                    .transition(.opacity)
            }
            if let hint = gameState.assistHint {
                AssistCardView(hint: hint, tutorialOn: gameState.tutorialOn, onClose: { gameState.apply(.local(.assistDismissed)) })
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var tipFrameReporter: some View {
        Color.clear
            .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(AssistLayout.scrollSpace)) }) { r in
                assistTipFrame = r
            }
    }

    private func tutorialTipClose() { gameState.apply(.local(.tutorialTipDismissed)) }

    /// The tip's title row and × pinned at the short column's top while the tip's top is
    /// scrolled out of sight (the web's sticky .assist-tip__top): drawn over the tip's text on
    /// the card's fill, pushed up with the tip's foot as that leaves (the advice never under it).
    /// The welcome's Keep and Turn off come into the row (identifiers "tip.pinned…").
    private var tipHeadPinned: Bool {
        guard gameState.tutorialWelcome ?? gameState.tutorialTip != nil, let f = assistTipFrame else { return false }
        return f.minY < -0.5 && f.maxY > 0
    }

    @ViewBuilder private var pinnedTipHead: some View {
        if let tip = gameState.tutorialWelcome ?? gameState.tutorialTip, let f = assistTipFrame, tipHeadPinned {
            let welcome = TutorialRules.isWelcome(tip)
            TutorialTipHead(tip: tip, onClose: welcome ? tutorialClose : tutorialTipClose,
                            onKeep: tutorialKeep, onTurnOff: tutorialOff, pinned: true)
                .padding(.horizontal, Theme.Space.s3)
                .padding(.vertical, Theme.Space.s1)
                .background(
                    UnevenRoundedRectangle(topLeadingRadius: Theme.Radius.md, topTrailingRadius: Theme.Radius.md, style: .continuous)
                        .fill(Theme.surface)
                )
                .overlay(
                    UnevenRoundedRectangle(topLeadingRadius: Theme.Radius.md, topTrailingRadius: Theme.Radius.md, style: .continuous)
                        .strokeBorder(Theme.inputBorder, lineWidth: 1)
                )
                .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("tip.pinned")
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { pinnedTipHeight = $0 }
                // pushed up as the tip's foot comes up past it
                .offset(y: min(0, f.maxY - pinnedTipHeight))
                #if DEBUG
                .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(BidClockPill.paneSpace)) }) { r in
                    if UIFixture.isActive { TableDebugProbe.shared.tutorialPinFrame = r }
                }
                .onDisappear { if UIFixture.isActive { TableDebugProbe.shared.tutorialPinFrame = nil } }
                #endif
        }
    }

    /// Scroll the short column so the advice's headline (and its chip above it) is in sight; a
    /// scroll that would go past the top stops there, so a column whose headline shows already
    /// stays as it is.
    private func showAdviceHead(_ proxy: ScrollViewProxy) {
        guard gameState.assistHint != nil else { return }
        DispatchQueue.main.async { proxy.scrollTo(AssistLayout.adviceHeadId, anchor: .bottom) }
    }

    private var isConnectedForTutorial: Bool {
        #if DEBUG
        SocketService.shared.isConnected || UIFixture.isActive
        #else
        SocketService.shared.isConnected
        #endif
    }

    /// The welcome's Keep button: /tutorial keep.
    private func tutorialKeep() {
        actions.tutorialKeep(connected: isConnectedForTutorial)
    }

    /// The welcome's close button (×): /tutorial close.
    private func tutorialClose() {
        actions.tutorialClose(connected: isConnectedForTutorial)
    }

    /// The chip's switch or the welcome's Turn off: /tutorial off.
    private func tutorialOff() {
        if actions.tutorialOff(connected: isConnectedForTutorial) { HapticManager.selection() }
    }

    // MARK: - Spectator badge (layout.spectatorBadge: by HSI / voice, a spectator's in the corner)

    private func spectatorBadge(_ layout: TableLayout) -> some View {
        let rect = layout.window(layout.spectatorBadge(spectating: !gameState.table.viewer.holdsSeat))
        return SpectatorBadgeView(watching: gameState.watching, myUsername: gameState.username)
            .frame(width: rect.width, height: rect.height, alignment: .trailing)
            .offset(x: rect.minX, y: rect.minY)
    }

    // MARK: - Spectator / lazy pill (bottom)

    /// `-uiSpectatorVoice muted|denied|full` (fixture mode never starts voice).
    private var fixtureSpectatorVoice: String? {
        #if DEBUG
        return UIFixture.spectatorVoice
        #else
        return nil
        #endif
    }

    /// A pure spectator in the game's voice room (voiceSettings role spectator, voice on).
    private var showsSpectatorVoice: Bool {
        fixtureSpectatorVoice == "muted" || fixtureSpectatorVoice == "denied"
            || (voiceManager.isActive && voiceManager.settings?.role == .spectator)
    }

    /// "Spectating", "Spectating (listening only)" once the mic was refused, or why there is
    /// no voice: full.
    private var spectatingText: String {
        if fixtureSpectatorVoice == "full" || voiceManager.settings?.role == VoiceSettings.Role.none {
            return "Spectating \u{2022} \(VoiceCopy.voiceFull)"
        }
        if showsSpectatorVoice && (fixtureSpectatorVoice == "denied" || voiceManager.isListenOnly) {
            return "Spectating (listening only)"
        }
        return "Spectating"
    }

    @ViewBuilder
    private var pills: some View {
        if gameState.isSpectator && !gameState.isLazy {
            VStack {
                Spacer()
                HStack(spacing: 10) {
                    // a casual game's spectator voice (1.2.2 (12)): the mic button beside the pill
                    // (muted at the start, a tap unmutes; headphones once the mic was refused; a
                    // long press opens the panel)
                    if showsSpectatorVoice {
                        VoiceMuteButton(onLongPress: { showVoicePanel = true }, size: Theme.hitTarget,
                                        forceListenOnly: fixtureSpectatorVoice == "denied")
                    }
                    // the web's spectating indicator: team.a on the panel surface
                    Text(spectatingText)
                        .font(.caption.bold())
                        .foregroundColor(Theme.teamA)
                    // one Exit: the corner / vertical-bar Leave reads "Exit" during play and
                    // the game-end modal has its own Return; the pill keeps one only when neither shows
                    if pillShowsExit {
                        Button(action: { ChatEmitter.sendMessage("/leave") }) {
                            Text("Exit")
                                .font(.caption.bold())
                                .padding(.horizontal, Theme.Space.s3)
                                .padding(.vertical, Theme.Space.s1)
                                .secondaryButtonStyle()
                        }
                    }
                }
                .padding(.horizontal, Theme.Space.s4)
                .padding(.vertical, Theme.Space.s2)
                .background(Theme.surface.opacity(0.95))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).stroke(Theme.teamA, lineWidth: 1))
                .cornerRadius(Theme.Radius.md)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { pillHeight = $0 }
                .padding(.bottom, Theme.Space.s3)
            }
        } else if gameState.isLazy {
            VStack {
                Spacer()
                Text("Spectating \u{2014} type /active to take back control")
                    .font(.caption.bold())
                    .foregroundColor(Theme.success)
                    .padding(.horizontal, Theme.Space.s4)
                    .padding(.vertical, Theme.Space.s2)
                    .background(Theme.surface.opacity(0.95))
                    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).stroke(Theme.success, lineWidth: 1))
                    .cornerRadius(Theme.Radius.md)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { pillHeight = $0 }
                    .padding(.bottom, Theme.Space.s3)
            }
        }
    }

    private func handleLeaveTapped() {
        if isPureSpectator {
            // Spectators just exit — nothing to confirm
            ChatEmitter.sendMessage("/leave")
        } else {
            gameState.apply(.local(.leaveAsked))
            runLeave(leaveFlow.tapped(check: gameState.players.leaveCheck))
        }
    }

    /// Leave from UnreadableTableView. Confirmed like any Leave, with the hedged message (the
    /// exact outcome reads seats this table may not have); a pure spectator just exits. The
    /// server's leftGame navigates as for any Leave; if none comes (the server no longer has
    /// us in a game) and no snapshot or reset has landed since, the app leaves on its own.
    private func leaveUnreadableTable() {
        let leave = {
            let resets = gameState.sceneResets
            ChatEmitter.sendMessage("/leave")
            DispatchQueue.main.asyncAfter(deadline: .now() + UnreadableTableLeave.fallback) {
                guard appState.screen == .game, gameState.sceneResets == resets else { return }
                GameSocketHandler.leaveTable(gameState: gameState, appState: appState, tournamentId: gameState.tournamentId)
            }
        }
        if isPureSpectator { return leave() }
        // an alert already up (a Leave opened before the trouble) sits above this view and asks the same
        leaveAlert.present(message: UnreadableTableLeave.message(inTournament: gameState.tournamentId != nil)) { answer in
            if answer == .leave { leave() }
        }
    }

    /// Carries out a LeaveAlertFlow step.
    private func runLeave(_ step: LeaveAlertFlow.Step) {
        switch step {
        case .none:
            break
        case .present:
            guard !leaveAlert.isUp else { return }
            let outcome = gameState.leaveOutcome
            leaveFlow.presented(outcome)
            // the server's outcome: a bot keeps my seat, or (no other owner) the game ends;
            // hedged until Leave's snapshot settles owners who may have left unannounced
            let shown = leaveAlert.present(message: outcome.alertMessage) { answer in
                if answer == .leave { ChatEmitter.sendMessage("/leave") }
                leaveAlertGone()
            }
            guard shown else { leaveAlertGone(); return }
            #if DEBUG
            UIFixture.leaveAlertPresented(gameState)
            #endif
        case .wait(let n):
            DispatchQueue.main.asyncAfter(deadline: .now() + LeaveAlertFlow.timeout) { runLeave(leaveFlow.timedOut(wait: n)) }
        case .close:
            // reopens from UIKit's dismissal completion, never over the closing alert
            leaveAlert.close { leaveAlertGone() }
        }
    }

    /// The Leave alert is gone (a button, or the flow's close finished): reopen, or end Leave.
    private func leaveAlertGone() {
        let (next, ends) = leaveFlow.dismissed(check: gameState.players.leaveCheck)
        if ends { gameState.apply(.local(.leaveClosed)) }
        runLeave(next)
    }
}

/// Where the /help card goes (pure, pane points): centred on my hand, at most `maxWidth` wide
/// (and never under `minWidth` while the pane allows), kept 16 pt off the pane's safe sides; its
/// box runs from `top` (under the score bar) down to just above what it keeps clear of
/// (`Keeps`), the card at the box's bottom.
enum AssistLayout {
    static let maxWidth: CGFloat = 380
    static let minWidth: CGFloat = 240
    static let gap: CGFloat = 6
    /// The advice's headline (AssistCardView): where a short column scrolls to, so the advice's
    /// chip and headline are always in sight, with the tip above it (bottom first: its Keep /
    /// Turn off) as far as the room goes.
    static let adviceHeadId = "assistAdviceHead"
    /// The short column's scroll view (where its tip reports its frame: the pinned title row).
    static let scrollSpace = "assistScroll"
    static let askSize: CGFloat = 36
    /// The least box worth lifting the card into to clear my seat's row (a headline and a line;
    /// the card scrolls inside): with less room it keeps the hand's anchor.
    static let minRoom: CGFloat = 96
    /// The least room a cap below the side seats leaves the cards (a tip's title and a few
    /// lines, the advice's chip and headline): with less (a phone in portrait) the column may
    /// cover them rather than hide the tip.
    static let sideRoom: CGFloat = 160

    /// What the card keeps clear of, in the pane's points.
    struct Keeps: Equatable {
        /// The top of my lifted hand, or of the bid panel's band while I bid.
        var anchor: CGFloat
        /// My bid clock's pill on the bid panel's edge (it hangs above the band).
        var clock: CGRect?
        /// My seat's row (HSI, the voice button, my pips), just above my hand on my play turn.
        var seatRow: CGRect?
        /// The fold (none when the layout ignored it): in a tabletop pose the card stays in
        /// the lower half, with the hand and the bid panel.
        var fold: CGRect?
        /// The lightbulb while it shows (only with the tutorial's tips or chip: the /help card
        /// hides it): under the column's span, the column's bottom goes above it.
        var ask: CGRect? = nil
        /// Exit and the game log's button under the score bar: where the column spans one, its
        /// box starts below it (the buttons stay in reach and readable).
        var corners: [CGRect] = []
        /// The seat across the table (the partner): its avatar and name ("seat<n>"), bid bubble
        /// ("bubble<n>") and dealer button ("dealer<n>"). Where the column spans one, its box
        /// starts below it while that leaves the cards `minRoom` (the web's assistRoomTop): the
        /// tips and the advice never cover the partner's avatar or bid.
        var seats: [String: CGRect] = [:]
        /// The side seats' parts (same keys). Where the column crosses one, it narrows to the
        /// room between them (at least `minWidth`), else its box starts below them while that
        /// leaves the cards `sideRoom`; else (a phone in portrait: the side seats are level with
        /// the only room above the bid panel) it may cover them, as the room for a tip and the
        /// advice comes first.
        var sides: [String: CGRect] = [:]

        /// Every other seat's part, the side seats' as "side.<key>" (the probe's "seats=").
        var seatProbe: [String: CGRect] {
            var out = seats
            for (k, v) in sides { out["side." + k] = v }
            return out
        }

        /// For the fixture probe "table.assist" (the card's frame against these; the other
        /// seats are its "seats=" part).
        var probe: [String: CGRect] {
            var out: [String: CGRect] = [:]
            if let clock { out["bidClock"] = clock }
            if let seatRow { out["seatRow"] = seatRow }
            if let fold { out["fold"] = fold }
            if let ask { out["ask"] = ask }
            return out
        }
    }

    /// `foot`: what the column holds under its cards (the "Tutorial on" chip and its gap), so a
    /// seat's cap leaves the cards themselves `minRoom`.
    static func frame(paneWidth: CGFloat, handMidX: CGFloat, handWidth: CGFloat, top: CGFloat, keeps: Keeps,
                      safeLeft: CGFloat = 0, safeRight: CGFloat = 0, foot: CGFloat = 0) -> CGRect {
        var top = top
        var bottom = keeps.anchor
        if let c = keeps.clock { bottom = min(bottom, c.minY) }
        // a tabletop fold (wider than tall) above the anchor: the box starts under it
        if let f = keeps.fold, f.width > f.height, f.maxY <= bottom { top = max(top, f.maxY + gap) }
        let lo = safeLeft + Theme.Space.s4, hi = paneWidth - safeRight - Theme.Space.s4
        let room = max(0, hi - lo)
        var width = min(room, min(maxWidth, max(minWidth, handWidth)))
        var x = min(max(handMidX - width / 2, lo), hi - width)
        for c in keeps.corners where c.minX < x + width && c.maxX > x && c.maxY > top && c.maxY + gap < bottom {
            top = c.maxY + gap
        }
        // my seat's row under the card's span (not one above the box, beside the trick cards
        // in a tabletop pose): the card's bottom goes above it while that leaves room
        if let r = keeps.seatRow, r.minX < x + width, r.maxX > x, r.maxY > top, r.minY < bottom,
           r.minY - gap - top >= minRoom {
            bottom = r.minY
        }
        // the lightbulb under the column's span (my play turn's at my hand's right end, my bid
        // turn's on the bid panel's corner): above it, as the countdown
        if let a = keeps.ask, a.minX < x + width, a.maxX > x, a.minY < bottom { bottom = min(bottom, a.minY) }
        // the seat across (the partner's avatar above the bid panel or my hand) under the
        // column's span: its top goes below it, while that leaves the cards minRoom
        func crosses(_ s: CGRect) -> Bool { s.minX < x + width && s.maxX > x && s.minY < bottom && s.maxY > top }
        for s in keeps.seats.values where crosses(s) {
            let below = s.maxY + gap
            if below > top, bottom - gap - foot - below >= minRoom { top = below }
        }
        // the side seats beside the box: between them where that leaves minWidth (the iPhone
        // Duo open above my hand), else below them where that leaves sideRoom
        let level = keeps.sides.values.filter { $0.maxY > top && $0.minY < bottom }
        if level.contains(where: crosses) {
            var l = lo, r = hi
            for s in level {
                if s.maxX <= handMidX { l = max(l, s.maxX + gap) } else if s.minX >= handMidX { r = min(r, s.minX - gap) }
            }
            if r - l >= minWidth {
                width = min(width, r - l)
                x = min(max(handMidX - width / 2, l), r - width)
            }
        }
        // below every side seat's part it crosses (all of them, or none: a cap below one part
        // that leaves another under the cards clears nothing)
        let crossing = keeps.sides.values.filter(crosses)
        if let lowest = crossing.map(\.maxY).max(), bottom - gap - foot - (lowest + gap) >= sideRoom {
            top = max(top, lowest + gap)
        }
        let height = max(0, bottom - gap - top)
        return CGRect(x: x, y: top, width: width, height: height)
    }
}

/// HSI's slot in my seat's row (TableLayout.hsiSize wide, the badge leading-aligned in it), so
/// the voice button after it (`.row`, `.compact`) never moves with the text's width; with no
/// reading the slot stays empty.
struct SeatRowHSISlot: View {
    let reading: HSIBadge.Reading?
    /// The table's zoom: the slot is hsiSize.width scene units (the badge's type stays Dynamic Type).
    var zoom: CGFloat = 1

    var body: some View {
        if let reading {
            HSIBadge(reading: reading).frame(width: TableLayout.hsiSize.width * zoom, alignment: .leading)
        } else {
            Color.clear.frame(width: TableLayout.hsiSize.width * zoom, height: 1).accessibilityHidden(true)
        }
    }
}

/// "HSI 119.2", 11 pt monospaced, in my seat's row beside the voice button (TableLayout.hsiSize
/// is its largest): the web's HSI box (on the seat-plate glass). `.panel` is the same text
/// inside the bid panel (no box: the panel is the surface, and a box there would read as one
/// more button). The value reads red (weak) through yellow to green (strong), HSIScale.color;
/// a live deal's "HSI --" (`.pending`, until HSIScale.revealDelay after it) is text.secondary,
/// as wide as a three-digit value so nothing moves when the value comes. VoiceOver reads
/// "Hand strength index 119.2" ("Hand strength index pending").
struct HSIBadge: View {
    enum Style { case table, panel }
    /// The value, or `.pending` while a live deal holds it (GameState.myHSIReading).
    enum Reading: Equatable {
        case pending
        case value(Double)
    }
    let reading: Reading
    var style: Style = .table

    init(reading: Reading, style: Style = .table) {
        self.reading = reading
        self.style = style
    }

    init(value: Double, style: Style = .table) {
        self.init(reading: .value(value), style: style)
    }

    /// "HSI 119.2".
    static func text(_ value: Double) -> String { "HSI \(String(format: "%.1f", value))" }
    /// "HSI --": a live deal's, until its value shows (the web's "HSI: --").
    static let pendingText = "HSI --"
    /// The pending badge's width: a three-digit value's (the commonest; monospaced digits).
    static let pendingWidthTemplate = "HSI 000.0"
    /// "Hand strength index 119.2" (VoiceOver: "HSI" is not a word).
    static func spoken(_ value: Double) -> String { "Hand strength index \(String(format: "%.1f", value))" }
    static let pendingSpoken = "Hand strength index pending"

    static func text(_ reading: Reading) -> String {
        switch reading {
        case .pending: return pendingText
        case .value(let v): return text(v)
        }
    }

    static func spoken(_ reading: Reading) -> String {
        switch reading {
        case .pending: return pendingSpoken
        case .value(let v): return spoken(v)
        }
    }

    /// The text's colour: HSIScale's for a value, text.secondary for "HSI --".
    static func color(_ reading: Reading) -> ThemeColor {
        switch reading {
        case .pending: return Theme.Palette.Text.secondary
        case .value(let v): return HSIScale.color(v)
        }
    }

    var body: some View {
        label
            .font(.caption2.monospaced())
            .dynamicTypeSize(...DynamicTypeSize.large)  // the row's HSI slot (and the panel's row) is sized for 11 pt
            .foregroundColor(Self.color(reading).color)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(style == .table ? Theme.Palette.Surface.s2.opacity(0.86).color : Color.clear)
            .cornerRadius(Theme.Radius.sm)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .stroke(style == .table ? Theme.inputBorder : Color.clear, lineWidth: 1)
            )
            .fixedSize()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Self.spoken(reading))
            .accessibilityIdentifier(style == .table ? "hsi" : "bidOverlay.hsi")
    }

    @ViewBuilder
    private var label: some View {
        switch reading {
        case .value(let v):
            Text(Self.text(v))
        case .pending:
            Text(Self.pendingWidthTemplate).hidden()
                .overlay(alignment: .leading) { Text(Self.pendingText) }
        }
    }
}

/// Tells the voice gate who is at the table (VoiceCompany.tableScreen): seat owners not gone,
/// spectators (only at a casual game this socket got voiceSettings for: a tournament table's
/// watchers never join voice), and on a play-again score screen the reopened lobby's members.
/// Draws nothing.
private struct TableVoiceCompany: View {
    @EnvironmentObject var gameState: GameState
    @ObservedObject private var voice = VoiceChatManager.shared
    let lobby: LobbyState?

    var body: some View {
        let spectators = VoiceCompany.spectatorsInVoice(gameId: gameState.gameId, casualVoiceGameId: voice.casualVoiceGameId)
        if let lobby {
            Observed(lobby: lobby, gameState: gameState, spectators: spectators)
        } else {
            report(VoiceCompany.table(gameState.players, me: me, spectators: spectators))
        }
    }

    private var me: String? { gameState.username ?? SocketService.shared.authState?.username }

    private func report(_ company: Bool?) -> some View {
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .onChange(of: company, initial: true) { _, c in VoiceChatManager.shared.setCompany(c, from: .table) }
    }

    private struct Observed: View {
        @ObservedObject var lobby: LobbyState
        @ObservedObject var gameState: GameState
        let spectators: Bool

        var body: some View {
            let me = gameState.username ?? SocketService.shared.authState?.username
            let company = VoiceCompany.tableScreen(gameState.players, gameId: gameState.gameId,
                                                   returnFromGameId: lobby.returnFromGameId, lobbyId: lobby.lobbyId,
                                                   lobbyPlayers: lobby.players, me: me, spectators: spectators)
            Color.clear
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
                .onChange(of: company, initial: true) { _, c in VoiceChatManager.shared.setCompany(c, from: .table) }
        }
    }
}

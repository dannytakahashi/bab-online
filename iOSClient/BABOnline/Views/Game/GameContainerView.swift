import SwiftUI
import SpriteKit

/// The game screen. Where the system shows the vertical bar (the iPhone Duo's
/// side column with the status bar: closed, open in landscape, book pose),
/// Leave and the game log toggle are standard toolbar items that the system
/// lays out in that column (iOS 27.1 SDK); everywhere else they are the table's
/// own corner buttons and no navigation bar is shown.
struct GameContainerView: View {
    var body: some View {
        if #available(iOS 27.1, *) {
            VerticalBarGameHost()
        } else {
            GameScreen(usesVerticalBar: false, windowTopInset: nil)
        }
    }
}

/// A navigation container for the toolbar items, which go into the vertical bar.
/// It wraps the game on every iOS 27.1 device (the bar is hidden where no
/// vertical bar is used), so a fold or unfold never rebuilds the game screen.
/// `toolbarVerticalEdge` is nil where the system never places a vertical bar
/// (other phones, the iPad, the open Duo in portrait).
@available(iOS 27.1, *)
private struct VerticalBarGameHost: View {
    @Environment(\.toolbarVerticalEdge) private var verticalEdge
    @State private var windowTopInset: CGFloat = 0

    var body: some View {
        NavigationStack {
            GameScreen(usesVerticalBar: verticalEdge != nil, windowTopInset: windowTopInset)
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.safeAreaInsets.top }) { windowTopInset = $0 }
        #if DEBUG
        .onChange(of: verticalEdge, initial: true) { _, edge in
            print("[Regions] vertical bar \(edge.map { "\($0)" } ?? "none")")
            if UIFixture.isActive { TableDebugProbe.shared.verticalBar = edge.map { "\($0)" } ?? "-" }
        }
        #endif
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
    @EnvironmentObject var actions: ActionCoordinator

    @State private var scene: GameSKScene = {
        let s = GameSKScene()
        s.scaleMode = .resizeFill
        return s
    }()

    @State private var showGameLog = false
    @State private var showVoicePanel = false
    @State private var showLeaveConfirm = false
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
    @Environment(\.verticalSizeClass) private var vSizeClass
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
    private var showsPill: Bool { gameState.isSpectator || gameState.isLazy }

    /// Leave / Log as toolbar items in the vertical bar instead of the corner buttons.
    private var showsBarControls: Bool { usesVerticalBar && inGame }

    var body: some View {
        gameContent
            // The table keeps the window's own top inset: with the vertical bar the
            // navigation bar has no height but UIKit still places it 24 pt down, and
            // the content's top safe area would end there; without it the bar is
            // hidden, but it takes its full height for the first pass after launch
            .safeAreaPadding(.top, windowTopInset ?? 0)
            .ignoresSafeArea(.container, edges: windowTopInset == nil ? [] : .top)
            .toolbar {
                if showsBarControls {
                    ToolbarItem(placement: .topBarLeading) { leaveBarButton }
                    if showsLogButton {
                        ToolbarItem(placement: .topBarTrailing) { logBarButton }
                    }
                }
            }
            .toolbar(showsBarControls ? .automatic : .hidden, for: .navigationBar)
            .toolbarBackground(.hidden, for: .navigationBar)
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
                            .background(Color.Theme.surface.ignoresSafeArea())
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
        }
        .animation(.easeInOut(duration: 0.3), value: showsBidOverlay)
        .animation(.easeInOut(duration: 0.3), value: gameState.phase)
        .alert("Leave game?", isPresented: $showLeaveConfirm) {
            Button("Leave Game", role: .destructive) {
                ChatEmitter.sendMessage("/leave")
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A bot will finish your hand for you.")
        }
        .onAppear {
            scene.configure(gameState: gameState, actions: actions)
            // 21.14: a seat talks in every game (lobby, queue, tournament, rejoin); idempotent
            if !gameState.isSpectator { VoiceChatManager.shared.ensureStarted() }
        }
        .onDisappear {
            scene.cleanupAll()
            VoiceChatManager.shared.shutdown()
        }
        .sheet(isPresented: $showVoicePanel) {
            VoicePanelSheet()
                .presentationDetents([.medium])
        }
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
            tableLayer
                .ignoresSafeArea(.keyboard)

            // Game log panel
            if showGameLog {
                GameLogView(isShowing: $showGameLog)
                    .transition(.move(edge: .trailing))
            }

            // Disconnect banner (below the corner buttons)
            if !gameState.disconnectedPlayers.isEmpty {
                VStack {
                    DisconnectBannerView()
                        .frame(maxWidth: 420)
                        .padding(.top, showsTable ? chrome.topBar + 8 + chrome.cornerButton.height + 8 : 0)
                    Spacer()
                }
            }
        }
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

    /// The bid panel and HSI / voice, placed from the layout in the full pane's coordinates.
    private func layoutOverlays(_ layout: TableLayout, full: CGSize) -> some View {
                ZStack(alignment: .topLeading) {
                    Color.clear.allowsHitTesting(false)
                    if showsBidOverlay {
                        // bottom at layout.bidBand.minY, centered on the band (replaces padding 200)
                        VStack(spacing: 0) {
                            Spacer(minLength: 0)
                            BidOverlayView()
                                .frame(maxWidth: layout.bidBand.width)
                            Color.clear.frame(height: max(0, layout.bidPanelBottomInset))
                        }
                        .frame(width: full.width, height: full.height)
                        .offset(x: layout.window(layout.bidBand).midX - full.width / 2)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                    if showsTable && !showsBidOverlay {
                        accessory(layout)
                    }
                }
                .frame(width: full.width, height: full.height, alignment: .topLeading)
    }

    /// The table's chrome, derived from the measured inputs (0 when hidden).
    private var chrome: TableChrome {
        TableChrome(safeArea: paneSafeArea,
                    topBar: showsTable ? scoreBarHeight : 0,
                    cornerButton: inGame && !usesVerticalBar ? cornerSize : .zero,
                    bottomBar: showsPill && pillHeight > 0 ? pillHeight + 12 : 0,
                    fold: paneFoldRect,
                    occlusions: paneOcclusions)
    }

    // MARK: - Corner buttons

    private func cornerButtons(_ layout: TableLayout) -> some View {
        VStack {
            HStack(alignment: .top) {
                // Leave/exit game button (always on screen during play — Guideline 4; in the
                // Duo's vertical bar the system may fold it into the bar's overflow menu)
                Button(action: handleLeaveTapped) {
                    HStack(spacing: 4) {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                        Text(isPureSpectator ? "Exit" : "Leave")
                    }
                    .font(.caption.bold())
                    .foregroundColor(Color.Theme.textSecondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Color.Theme.surface.opacity(0.8))
                    .clipShape(Capsule())
                }
                .accessibilityIdentifier("leave")
                .dynamicTypeSize(...DynamicTypeSize.xxLarge)
                .accessibilityShowsLargeContentViewer()  // text stops growing at xxLarge
                .onGeometryChange(for: CGSize.self, of: { $0.size }) { leaveSize = $0 }
                .padding(.leading, 12 + layout.occludedLeft)  // clear of a full-height system strip

                Spacer()

                // Game log toggle button: the drawer, or the docked panel in inner landscape
                // (hidden in book pose: the log is the right page)
                if showsLogButton {
                Button(action: toggleLog) {
                    Image(systemName: logIsOpen ? "xmark.circle.fill" : "text.bubble.fill")
                        .font(.title2)
                        .foregroundColor(Color.Theme.textSecondary)
                        .padding(12)
                        .background(Color.Theme.surface.opacity(0.8))
                        .clipShape(Circle())
                        .overlay(alignment: .topTrailing) {
                            if !logIsOpen && gameState.unreadChatCount > 0 {
                                Text("\(gameState.unreadChatCount)")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundStyle(.white)
                                    .frame(minWidth: 18, minHeight: 18)
                                    .background(Color.Theme.error)
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
                .padding(.trailing, 12 + layout.occludedRight)
                }
            }
            .padding(.top, showsTable ? chrome.topBar + 8 : 80)
            Spacer()
        }
        .onChange(of: CGSize(width: max(leaveSize.width, logSize.width), height: max(leaveSize.height, logSize.height)), initial: true) { _, s in
            cornerSize = s
        }
    }

    // MARK: - Leave / Log in the vertical bar (iOS 27.1)

    private var leaveBarButton: some View {
        Button(action: handleLeaveTapped) {
            Label(isPureSpectator ? "Exit" : "Leave", systemImage: "rectangle.portrait.and.arrow.right")
        }
        .disabled(gameState.phase == .draw)  // as the corner button under the draw overlay
        .accessibilityIdentifier("leave")
    }

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
    @State private var logSize: CGSize = .zero

    // MARK: - HSI + voice (layout.accessory, right of my trick slot)

    @ViewBuilder
    private func accessory(_ layout: TableLayout) -> some View {
        let rect = layout.window(layout.accessory)
        let hsi: Double? = gameState.isSpectator ? nil : gameState.position.flatMap { gameState.hsiValues[$0] }
        let voice = voiceManager.isActive
        if hsi != nil || voice {
            Group {
                if layout.accessoryStacked {
                    VStack(alignment: .leading, spacing: 6) { accessoryItems(hsi: hsi, voice: voice) }
                } else {
                    HStack(spacing: 6) { accessoryItems(hsi: hsi, voice: voice) }
                }
            }
            .frame(width: rect.width, height: rect.height, alignment: .bottomLeading)
            .offset(x: rect.minX, y: rect.minY)
        }
    }

    @ViewBuilder
    private func accessoryItems(hsi: Double?, voice: Bool) -> some View {
        if let hsi {
            HSIBadge(value: hsi)
        }
        if voice {
            VoiceMuteButton(onLongPress: { showVoicePanel = true })
        }
    }

    // MARK: - Spectator / lazy pill (bottom)

    @ViewBuilder
    private var pills: some View {
        if gameState.isSpectator && !gameState.isLazy {
            VStack {
                Spacer()
                HStack(spacing: 10) {
                    Text("Spectating")
                        .font(.caption.bold())
                        .foregroundColor(.white)
                    Button(action: { ChatEmitter.sendMessage("/leave") }) {
                        Text("Exit")
                            .font(.caption.bold())
                            .foregroundColor(Color(red: 0.376, green: 0.647, blue: 0.98))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(Color.white)
                            .cornerRadius(6)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(Color(red: 0.376, green: 0.647, blue: 0.98).opacity(0.9))
                .cornerRadius(8)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { pillHeight = $0 }
                .padding(.bottom, 12)
            }
        } else if gameState.isLazy {
            VStack {
                Spacer()
                Text("Spectating \u{2014} type /active to take back control")
                    .font(.caption.bold())
                    .foregroundColor(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(Color.green.opacity(0.8))
                    .cornerRadius(8)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { pillHeight = $0 }
                    .padding(.bottom, 12)
            }
        }
    }

    private func handleLeaveTapped() {
        if isPureSpectator {
            // Spectators just exit — nothing to confirm
            ChatEmitter.sendMessage("/leave")
        } else {
            showLeaveConfirm = true
        }
    }
}

/// "HSI 119.2", 11 pt monospaced (fits the layout's accessory rect beside the voice button).
struct HSIBadge: View {
    let value: Double

    var body: some View {
        Text("HSI \(String(format: "%.1f", value))")
            .font(.system(size: 11, design: .monospaced))
            .foregroundColor(Color(white: 0.67))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(Color.black.opacity(0.7))
            .cornerRadius(4)
            .overlay(
                RoundedRectangle(cornerRadius: 4)
                    .stroke(Color(white: 0.4), lineWidth: 1)
            )
            .fixedSize()
    }
}

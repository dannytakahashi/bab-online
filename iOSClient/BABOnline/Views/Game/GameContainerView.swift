import SwiftUI
import SpriteKit

/// Hosts the SpriteKit game scene with SwiftUI overlay panels.
///
/// Item 25: the table pane measures its chrome (safe-area insets, ScoreBar
/// height, the Leave / Log buttons, the bottom pill) into `TableChrome`, the
/// scene lays itself out from it (TableLayout), and the bid panel and the
/// HSI / voice accessory are placed from the same layout.
struct GameContainerView: View {
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

    /// Everything but the size TableLayout needs, measured below.
    @State private var chrome = TableChrome()
    @State private var scoreBarHeight: CGFloat = 0
    @State private var cornerSize: CGSize = .zero
    @State private var pillHeight: CGFloat = 0

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

    var body: some View {
        ZStack {
            HStack(spacing: 0) {
                tablePane
            }

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
    private var tableLayer: some View {
        GeometryReader { proxy in
            let ins = proxy.safeAreaInsets
            let full = CGSize(width: proxy.size.width + ins.leading + ins.trailing, height: proxy.size.height + ins.top + ins.bottom)
            let layout = TableLayout(size: full, chrome: chrome)
            ZStack {
                SpriteView(scene: scene)
                    .ignoresSafeArea()

                // Score bar pinned to the top of the safe area
                VStack(spacing: 0) {
                    if showsTable {
                        ScoreBarView()
                            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { scoreBarHeight = $0 }
                    }
                    Spacer()
                }

                if inGame { cornerButtons }

                // Layout-placed overlays, in the full pane's coordinates
                ZStack(alignment: .topLeading) {
                    Color.clear
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
                .frame(width: full.width, height: full.height)
                .ignoresSafeArea()

                pills
            }
            .onChange(of: TableInsets(top: ins.top, left: ins.leading, bottom: ins.bottom, right: ins.trailing), initial: true) { _, new in
                chrome.safeArea = new
            }
            .onChange(of: FoldReader.occlusions(proxy), initial: true) { _, rects in
                // system UI over the app (25-4 step 6): joins the corner obstacles in TableLayout
                chrome.occlusions = rects.map { FoldReader.toScene($0, in: full, insets: ins) }
                #if DEBUG
                print("[Regions] occlusions \(rects) (proxy-local) pane \(full) insets \(ins)")
                #endif
            }
        }
        .onChange(of: measuredChrome, initial: true) { _, new in
            if chrome.topBar != new.topBar { chrome.topBar = new.topBar }
            if chrome.cornerButton != new.cornerButton { chrome.cornerButton = new.cornerButton }
            if chrome.bottomBar != new.bottomBar { chrome.bottomBar = new.bottomBar }
        }
        .onChange(of: chrome, initial: true) { _, new in scene.chrome = new }
    }

    /// The measured parts of the chrome (0 when hidden).
    private var measuredChrome: TableChrome {
        TableChrome(topBar: showsTable ? scoreBarHeight : 0,
                    cornerButton: inGame ? cornerSize : .zero,
                    bottomBar: showsPill && pillHeight > 0 ? pillHeight + 12 : 0)
    }

    // MARK: - Corner buttons

    private var cornerButtons: some View {
        VStack {
            HStack(alignment: .top) {
                // Leave/exit game button (always visible during play — Guideline 4)
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
                .onGeometryChange(for: CGSize.self, of: { $0.size }) { leaveSize = $0 }
                .padding(.leading, 12)

                Spacer()

                // Game log toggle button
                Button(action: {
                    withAnimation {
                        showGameLog.toggle()
                        if showGameLog {
                            gameState.apply(.local(.chatRead))
                        }
                    }
                }) {
                    Image(systemName: showGameLog ? "xmark.circle.fill" : "text.bubble.fill")
                        .font(.title2)
                        .foregroundColor(Color.Theme.textSecondary)
                        .padding(12)
                        .background(Color.Theme.surface.opacity(0.8))
                        .clipShape(Circle())
                        .overlay(alignment: .topTrailing) {
                            if !showGameLog && gameState.unreadChatCount > 0 {
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
                .dynamicTypeSize(...DynamicTypeSize.xxLarge)
                .onGeometryChange(for: CGSize.self, of: { $0.size }) { logSize = $0 }
                .padding(.trailing, 12)
            }
            .padding(.top, showsTable ? chrome.topBar + 8 : 80)
            Spacer()
        }
        .onChange(of: CGSize(width: max(leaveSize.width, logSize.width), height: max(leaveSize.height, logSize.height)), initial: true) { _, s in
            cornerSize = s
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

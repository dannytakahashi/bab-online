import SwiftUI

/// The game lobby. Where the system shows the vertical bar (the iPhone Duo),
/// Leave is the leading toolbar item in that column (VerticalBarHost); the
/// title, the count and the Ready button stay in the content.
struct GameLobbyView: View {
    var body: some View {
        VerticalBarHost { GameLobbyScreen(bar: $0) }
    }
}

private struct GameLobbyScreen: View {
    let bar: VerticalBarContext

    @EnvironmentObject var appState: AppState
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var lobbyState: LobbyState

    @State private var isReady = false
    @State private var showVoicePanel = false
    /// Measured heights of the fixed parts: the lobby scrolls when they plus a 120 pt chat do not fit.
    @State private var topHeight: CGFloat = 0
    @State private var readyHeight: CGFloat = 0
    /// The header row's height: the wide chat column's title row matches it.
    @State private var headerHeight: CGFloat = 0
    /// The height above the keyboard (the screen's keyboard-aware safe area).
    @State private var visibleHeight: CGFloat = 0
    @Environment(\.horizontalSizeClass) private var hSizeClass
    @ObservedObject private var voiceManager = VoiceChatManager.shared

    var body: some View {
        ZStack {
            Color.Theme.background.ignoresSafeArea()

            // measures the room above the keyboard (draws nothing)
            Color.clear
                .allowsHitTesting(false)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { visibleHeight = $0 }

            // One always-present ScrollView and one AnyLayout (stable identity: the
            // keyboard or a size-class change never swaps views, so the chat field
            // keeps its focus and draft). Compact (phones, the closed Duo): stacked,
            // 560 pt readable width; the content fills the height, and scrolls once
            // the fixed parts plus a 120 pt chat do not fit. Regular width (iPad, the
            // open Duo), as the main room: the players and Ready in the left 55%, the
            // chat filling the right column. There the layout ignores the keyboard
            // and only the chat column makes room for it, so the left column stays put.
            GeometryReader { g in
            let wide = hSizeClass == .regular
            let layout = wide ? AnyLayout(LobbySplitLayout()) : AnyLayout(VStackLayout(spacing: 0))
            let keyboard = wide ? max(0, g.size.height - visibleHeight) : 0
            ScrollView {
            layout {
                VStack(spacing: 0) {
                // Header
                HStack {
                    // in the vertical bar Leave is a toolbar item and the title leads
                    if !bar.usesVerticalBar {
                        Button(action: leaveLobby) {
                            HStack(spacing: 4) {
                                Image(systemName: "chevron.left")
                                Text("Leave")
                            }
                            .foregroundColor(Color.Theme.textSecondary)
                        }

                        Spacer()
                    }

                    Text(lobbyState.lobbyName.isEmpty ? "Game Lobby" : lobbyState.lobbyName)
                        .font(.headline)
                        .foregroundColor(Color.Theme.textPrimary)

                    Spacer()

                    HStack(spacing: 12) {
                        if voiceManager.isActive {
                            VoiceMuteButton(onLongPress: {
                                showVoicePanel = true
                            })
                            .scaleEffect(0.8)
                        }

                        Text("\(lobbyState.playerCount)/4")
                            .foregroundColor(Color.Theme.textSecondary)
                    }
                }
                .padding()
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { headerHeight = $0 }

                Divider().background(Color.Theme.inputBorder, ignoresSafeAreaEdges: .vertical)

                // Player slots
                VStack(spacing: 12) {
                    ForEach(0..<4, id: \.self) { index in
                        if index < lobbyState.players.count {
                            LobbyPlayerRow(player: lobbyState.players[index],
                                           isCurrentUser: lobbyState.players[index].username == authState.username)
                        } else {
                            emptySlot(index: index)
                        }
                    }
                }
                .padding()
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("lobby.players")

                // Bot button
                if lobbyState.playerCount < 4 {
                    Button(action: addRandomBot) {
                        Label("Add Bot", systemImage: "cpu")
                            .font(.callout)
                            .foregroundColor(Color.Theme.textSecondary)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                            .background(Color.Theme.surface)
                            .cornerRadius(8)
                    }
                    .padding(.bottom, 8)
                }
                }
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { topHeight = $0 }

                // Chat - takes remaining space (wide: the right column, under a title
                // row as tall as the header, beside a 1 pt rule)
                LobbyChatView(titleHeight: wide ? headerHeight : nil)
                    .padding(.bottom, keyboard)
                    .frame(minHeight: 120, maxHeight: .infinity)
                    .overlay(alignment: .leading) {
                        if wide { Separator(vertical: true) }
                    }

                // Ready button
                Button(action: toggleReady) {
                    Text(isReady ? "Unready" : "Ready")
                        .font(.title3.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(isReady ? Color.Theme.oppColor : Color.Theme.buttonBackground)
                        .foregroundColor(.white)
                        .cornerRadius(10)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 4)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { readyHeight = $0 }
            }
            .frame(maxWidth: wide ? .infinity : 560)
            .frame(maxWidth: .infinity)
            .frame(height: max(g.size.height, topHeight + (wide ? 0 : 120) + readyHeight))
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
            }
            .ignoresSafeArea(.keyboard, edges: hSizeClass == .regular ? .bottom : [])
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Color.clear.frame(height: 0)
            }
            .onTapGesture {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            }
        }
        .verticalBarChrome(bar, showsBarControls: bar.usesVerticalBar)
        .toolbar {
            if bar.usesVerticalBar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: leaveLobby) {
                        Label("Leave", systemImage: "chevron.left")
                    }
                }
            }
        }
        .onAppear {
            startVoice()
        }
        .sheet(isPresented: $showVoicePanel) {
            VoicePanelSheet()
                .presentationDetents([.medium])
        }
        .onDisappear {
            // Only shut down voice if we're not transitioning to game
            // (game screen takes over voice lifecycle)
            if appState.screen != .game {
                VoiceChatManager.shared.shutdown()
            }
        }
    }

    private func startVoice() {
        Task {
            do {
                try await VoiceChatManager.shared.initialize()
            } catch {
                print("[Lobby] Voice init failed: \(error.localizedDescription)")
            }
        }
    }

    private func addRandomBot() {
        let personalities = ["mary", "sharon", "danny", "mike", "zach"]
        LobbyEmitter.addBot(personality: personalities.randomElement()!)
    }

    private func emptySlot(index: Int) -> some View {
        HStack {
            Circle()
                .fill(Color.Theme.surfaceLight)
                .frame(width: 40, height: 40)
                .overlay(Image(systemName: "person.fill").foregroundColor(Color.Theme.textDim))

            Text("Waiting for player...")
                .foregroundColor(Color.Theme.textDim)
                .italic()

            Spacer()
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(Color.Theme.surface)
        .cornerRadius(10)
    }

    private func toggleReady() {
        isReady.toggle()
        if isReady {
            print("[Lobby] Emitting playerReady")
            LobbyEmitter.playerReady()
        } else {
            print("[Lobby] Emitting playerUnready")
            LobbyEmitter.playerUnready()
        }
        HapticManager.mediumImpact()
    }

    private func leaveLobby() {
        LobbyEmitter.leaveLobby()
        lobbyState.reset()
        isReady = false
    }
}

/// The game lobby's wide layout for its three parts (top, chat, Ready), the
/// stacked one's partner in an AnyLayout: the top part and Ready (at the bottom)
/// share the left column, the chat fills the right column's full height.
private struct LobbySplitLayout: Layout {
    /// The left column's share of the width (the main room's lobby browser's).
    var leftFraction: CGFloat = 0.55

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 3 else { return }
        let left = (bounds.width * leftFraction).rounded()
        let top = subviews[0], chat = subviews[1], ready = subviews[2]
        let topHeight = top.sizeThatFits(ProposedViewSize(width: left, height: nil)).height
        top.place(at: bounds.origin, proposal: ProposedViewSize(width: left, height: topHeight))
        let readyHeight = ready.sizeThatFits(ProposedViewSize(width: left, height: nil)).height
        ready.place(at: CGPoint(x: bounds.minX, y: bounds.maxY - readyHeight),
                    proposal: ProposedViewSize(width: left, height: readyHeight))
        chat.place(at: CGPoint(x: bounds.minX + left, y: bounds.minY),
                   proposal: ProposedViewSize(width: bounds.width - left, height: bounds.height))
    }
}

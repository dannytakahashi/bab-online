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
    /// Bots whose removeBot went out and whose row the server's list still shows.
    @State private var removing: Set<String> = []
    @State private var showVoicePanel = false
    /// Measured heights of the fixed parts: the lobby scrolls when they plus a 120 pt chat do not fit.
    @State private var topHeight: CGFloat = 0
    @State private var readyHeight: CGFloat = 0
    /// The header row's height: the wide chat column's title row matches it.
    @State private var headerHeight: CGFloat = 0
    /// The height above the keyboard (the screen's keyboard-aware safe area).
    @State private var visibleHeight: CGFloat = 0
    /// Bumped by every hinge change so the fold is read again at the same size.
    @State private var hingeTick = 0
    @Environment(\.horizontalSizeClass) private var hSizeClass
    @ObservedObject private var voiceManager = VoiceChatManager.shared
    @ObservedObject private var socketService = SocketService.shared

    /// Ready, Add Bot and removing a bot wait for the session (after a reconnect this socket
    /// is not in the lobby until the restore's joinLobby has gone out and been answered,
    /// `LobbyState.rejoiningLobbyId`) and for a foreground probe. Leave never waits (during
    /// the re-entry it goes through `LobbyRejoin.abandon`); the chat's Send waits for the
    /// re-entry too (LobbyChatView).
    private var canSendLobbyActions: Bool {
        socketService.canSendMainRoomActions && lobbyState.rejoiningLobbyId == nil
    }

    /// "Spectators can talk" sent by the host, until the server's playerReadyUpdate echoes it.
    @State private var talkPending: Bool?

    /// The header's mic button: voice is on (fixture mode: `-uiVoice YES`).
    private var showsMic: Bool {
        #if DEBUG
        voiceManager.isActive || UIFixture.showsVoiceButton
        #else
        voiceManager.isActive
        #endif
    }

    /// The table filled without me: Ready would be refused, I will watch the game.
    private var watchesOnly: Bool { !isReady && lobbyState.tableFullWithout(authState.username) }

    /// Family lobbies (1.2.3): the host's "Spectators can talk" switch, a read-only line for
    /// everyone else, and what it means for those who do not get a seat.
    private var voiceSection: some View {
        let isHost = lobbyState.isHost(authState.username)
        let on = talkPending ?? lobbyState.spectatorsCanTalk
        return VStack(alignment: .leading, spacing: Theme.Space.s2) {
            Text("Voice")
                .font(.caption.bold())
                .foregroundColor(Theme.textSecondary)
                .accessibilityAddTraits(.isHeader)
            if isHost {
                Toggle(isOn: Binding(get: { on }, set: setSpectatorsCanTalk)) {
                    Text(VoiceCopy.switchLabel)
                        .foregroundColor(Theme.textPrimary)
                }
                .tint(Theme.success)
                .disabled(talkPending != nil || !canSendLobbyActions)
                .accessibilityIdentifier("lobby.spectatorsCanTalk")
            } else {
                Text("\(VoiceCopy.switchLabel): \(on ? "On" : "Off")")
                    .foregroundColor(Theme.textPrimary)
                    .accessibilityIdentifier("lobby.spectatorsCanTalk.readOnly")
            }
            Text(on ? VoiceCopy.lobbyHintOn : VoiceCopy.lobbyHintOff)
                .font(.caption)
                .foregroundColor(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("lobby.voiceHint")
        }
        .padding(.horizontal, Theme.Space.s4)
        .padding(.vertical, Theme.Space.s3)
        .background(Theme.surface)
        .cornerRadius(Theme.Radius.md)
        .padding(.horizontal)
        .padding(.bottom, Theme.Space.s2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lobby.voice")
    }

    /// Play again (1.2.3): "Don't wait for <name>" sent, until the server's list answers (or 5 s).
    @State private var releasing: Set<String> = []

    /// The host (or anyone present while the host is held) may give up a returning row or an
    /// expected player's place.
    private var mayRelease: Bool { lobbyState.canRelease(authState.username) }

    /// The last game's older-app players whose place is saved (no row): "Not back yet", and
    /// for the host "Don't wait".
    private var expectedSection: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s2) {
            Text(PlayAgainCopy.expected)
                .font(.caption.bold())
                .foregroundColor(Theme.textSecondary)
                .accessibilityAddTraits(.isHeader)
            ForEach(lobbyState.expected, id: \.self) { name in
                HStack(spacing: Theme.Space.s3) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name)
                            .font(.body.bold())
                            .foregroundColor(Theme.textPrimary)
                        Text(PlayAgainCopy.notBackYet)
                            .font(.caption2)
                            .foregroundColor(Theme.textSecondary)
                            .italic()
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("lobby.expected.\(name)")
                    Spacer()
                    if mayRelease {
                        DontWaitButton(username: name, isReleasing: releasing.contains(name) || !canSendLobbyActions) {
                            releaseHold(name)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(Theme.surface)
        .cornerRadius(Theme.Radius.md)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lobby.expected")
    }

    private func releaseHold(_ username: String) {
        guard !releasing.contains(username) else { return }
        releasing.insert(username)
        LobbyEmitter.releaseLobbyHold(username: username)
        HapticManager.lightImpact()
        // a refusal changes no list: let the control work again
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { releasing.remove(username) }
    }

    private func setSpectatorsCanTalk(_ value: Bool) {
        guard value != lobbyState.spectatorsCanTalk || talkPending != nil else { return }
        talkPending = value
        LobbyEmitter.setSpectatorsCanTalk(value)
        HapticManager.lightImpact()
        // a refusal changes nothing: let the switch work again
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { if talkPending == value { talkPending = nil } }
    }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

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
            // In book pose the left column ends at the hinge and the chat starts after it.
            GeometryReader { g in
            let _ = hingeTick  // re-read the fold after a hinge change
            let wide = hSizeClass == .regular
            let hinge = wide ? FoldReader.bookHinge(g) : nil
            let layout = wide ? AnyLayout(LobbySplitLayout(hinge: hinge)) : AnyLayout(VStackLayout(spacing: 0))
            let keyboard = wide ? max(0, g.size.height - visibleHeight) : 0
            ScrollView {
            layout {
                VStack(spacing: 0) {
                // Header (LobbyHeaderView: one row, the count under the title, or wrapped;
                // in the vertical bar Leave is a toolbar item and the title leads)
                LobbyHeaderView(title: lobbyState.lobbyName.isEmpty ? "Game Lobby" : lobbyState.lobbyName,
                                count: LobbyCount(lobbyState),
                                showsLeave: !bar.usesVerticalBar,
                                showsMic: showsMic,
                                leave: leaveLobby,
                                openVoicePanel: { showVoicePanel = true })
                .padding()
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { headerHeight = $0 }

                Divider().background(Theme.inputBorder, ignoresSafeAreaEdges: .vertical)

                // Player slots: every member (up to 8 in a family lobby), then the table's
                // empty seats while fewer than 4 are in
                VStack(spacing: Theme.Space.s3) {
                    ForEach(lobbyState.players) { player in
                        LobbyPlayerRow(player: player,
                                       isCurrentUser: player.username == authState.username,
                                       onRemove: { removeBot(player) },
                                       isRemoving: removing.contains(player.id) || !canSendLobbyActions,
                                       isReconnecting: lobbyState.isReconnecting(player),
                                       isHost: !player.isBot && lobbyState.isHost(player.username),
                                       status: LobbySeatStatus.of(player, in: lobbyState.players),
                                       onRelease: mayRelease ? { releaseHold(player.username) } : nil,
                                       isReleasing: releasing.contains(player.username) || !canSendLobbyActions)
                    }
                    // (a place saved for the last game's expected players is not empty)
                    ForEach(lobbyState.players.count..<max(lobbyState.players.count, 4 - lobbyState.expected.count), id: \.self) { index in
                        emptySlot(index: index)
                    }
                    if !lobbyState.expected.isEmpty { expectedSection }
                }
                .padding()
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("lobby.players")

                if lobbyState.hasSettings { voiceSection }

                // Bot button (not over a place saved for the last game's players: play again)
                if lobbyState.canAddBot {
                    Button(action: addRandomBot) {
                        Label("Add Bot", systemImage: "cpu")
                            .font(.callout)
                            .foregroundColor(Theme.textSecondary)
                            .padding(.horizontal, Theme.Space.s4)
                            .padding(.vertical, Theme.Space.s2)
                            .background(Theme.surface)
                            .cornerRadius(Theme.Radius.md)
                    }
                    .disabled(!canSendLobbyActions)
                    .opacity(canSendLobbyActions ? 1 : 0.5)
                    .padding(.bottom, Theme.Space.s2)
                }
                }
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { topHeight = $0 }

                // Chat - takes remaining space (wide: the right column, under a title
                // row as tall as the header, beside a 1 pt rule)
                LobbyChatView(titleHeight: wide ? headerHeight : nil)
                    .padding(.bottom, keyboard)
                    .frame(minHeight: 120, maxHeight: .infinity)
                    .overlay(alignment: .leading) {
                        if wide && hinge == nil { Separator(vertical: true) }  // the hinge divides a book fold
                    }

                // Ready button ("Table full — you'll watch" once 4 others hold the table)
                Button(action: toggleReady) {
                    Text(watchesOnly ? VoiceCopy.tableFull : isReady ? "Unready" : "Ready")
                        .font(watchesOnly ? .headline : .title3.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Theme.Space.s4)
                        .background(watchesOnly ? Theme.buttonDisabled : isReady ? Theme.danger : Theme.buttonBackground)
                        .foregroundColor(watchesOnly ? Theme.buttonDisabledForeground : isReady ? Theme.dangerForeground : Theme.buttonForeground)
                        .cornerRadius(Theme.Radius.md)
                }
                .disabled(!canSendLobbyActions || watchesOnly)
                .opacity(canSendLobbyActions ? 1 : 0.5)
                .padding(.horizontal, Theme.Space.s3)
                .padding(.bottom, Theme.Space.s1)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { readyHeight = $0 }
            }
            .frame(maxWidth: wide ? .infinity : 560)
            .frame(maxWidth: .infinity)
            .frame(height: max(g.size.height, topHeight + (wide ? 0 : 120) + readyHeight))
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
            }
            .modifier(HingeTick(tick: $hingeTick))
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
            syncReady()
            #if DEBUG
            if UIFixture.showsVoicePanel { showVoicePanel = true }
            #endif
        }
        .onChange(of: lobbyState.spectatorsCanTalk) { _, _ in talkPending = nil }  // the echo
        .onChange(of: lobbyState.players) { _, _ in
            // every list the server sends answers the removals sent before it
            removing = []
            releasing = []
            syncReady()
        }
        .onChange(of: lobbyState.expected) { _, _ in releasing = [] }
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

    /// Any lobby member may remove a bot that is not ready (the web's rule, LobbyPlayer.canBeRemoved);
    /// the server answers every member with playerReadyUpdate, every ready flag cleared.
    private func removeBot(_ player: LobbyPlayer) {
        guard player.canBeRemoved, !removing.contains(player.id) else { return }
        removing.insert(player.id)
        LobbyEmitter.removeBot(botSocketId: player.id)
        HapticManager.lightImpact()
        // a refusal (serverError) changes no list: let the control work again
        let id = player.id
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { removing.remove(id) }
    }

    /// The Ready button follows my ready flag in the server's list, as the web's does: a bot
    /// removed or a player leaving clears every flag, so a ready player is not ready any more.
    private func syncReady() {
        if let ready = LobbyPlayer.readyFlag(of: authState.username, in: lobbyState.players) {
            isReady = ready
        }
    }

    private func emptySlot(index: Int) -> some View {
        HStack {
            Circle()
                .fill(Theme.surfaceLight)
                .frame(width: 40, height: 40)
                .overlay(Image(systemName: "person.fill").foregroundColor(Theme.textDim).accessibilityHidden(true))

            Text("Waiting for player...")
                .foregroundColor(Theme.textDim)
                .italic()

            Spacer()
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(Theme.surface)
        .cornerRadius(Theme.Radius.md)
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
        // the re-entry unanswered: this socket may not be in the lobby, and a refused
        // leaveLobby would strand the screen (LobbyRejoin)
        if lobbyState.rejoiningLobbyId != nil {
            LobbyRejoin.abandon(lobbyState: lobbyState, appState: appState)
            isReady = false
            return
        }
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
    /// A book fold's hinge (FoldReader.bookHinge, the same x as the bounds): the
    /// left column ends at it and the chat starts after it, so neither spans it.
    var hinge: ClosedRange<CGFloat>? = nil

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 3 else { return }
        let left = hinge?.lowerBound ?? (bounds.width * leftFraction).rounded()
        let chatX = hinge?.upperBound ?? left
        let top = subviews[0], chat = subviews[1], ready = subviews[2]
        let topHeight = top.sizeThatFits(ProposedViewSize(width: left, height: nil)).height
        top.place(at: bounds.origin, proposal: ProposedViewSize(width: left, height: topHeight))
        let readyHeight = ready.sizeThatFits(ProposedViewSize(width: left, height: nil)).height
        ready.place(at: CGPoint(x: bounds.minX, y: bounds.maxY - readyHeight),
                    proposal: ProposedViewSize(width: left, height: readyHeight))
        chat.place(at: CGPoint(x: bounds.minX + chatX, y: bounds.minY),
                   proposal: ProposedViewSize(width: bounds.width - chatX, height: bounds.height))
    }
}

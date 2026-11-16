import SwiftUI

/// The main room. Where the system shows the vertical bar (the iPhone Duo), the
/// header's controls are toolbar items in that column (VerticalBarHost) and the
/// lobby list starts at the top; everywhere else the header row is unchanged.
struct MainRoomView: View {
    var body: some View {
        VerticalBarHost { MainRoomScreen(bar: $0) }
    }
}

private struct MainRoomScreen: View {
    let bar: VerticalBarContext

    @EnvironmentObject var appState: AppState
    @EnvironmentObject var mainRoomState: MainRoomState
    @EnvironmentObject var tournamentState: TournamentState
    /// New Game / Tournament wait for the session: after a reconnect, a tap before the
    /// restore's answer made a lobby that the restore's joinMainRoom then left at once.
    @ObservedObject private var socketService = SocketService.shared
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var hSizeClass
    @State private var hingeTick = 0
    @State private var showLeaderboard = false
    @State private var showOnlineUsers = false
    @State private var showAccountSettings = false
    @State private var didEnterBackground = false

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            // Regular width (iPad, the open Duo): side by side; compact: stacked.
            // One AnyLayout keeps the children's identity (and the chat field's
            // focus and draft) across a size-class change.
            // In book pose the browser ends at the hinge (FoldReader.bookHinge), as the lobbies'
            // left column: a card's Join / Rejoin never sits under it.
            GeometryReader { geo in
                let _ = hingeTick  // re-read the fold after a hinge change
                let wide = hSizeClass == .regular
                let hinge = wide ? FoldReader.bookHinge(geo) : nil
                let layout = wide ? AnyLayout(HStackLayout(spacing: 0)) : AnyLayout(VStackLayout(spacing: 0))
                layout {
                    lobbyBrowserPanel
                        .frame(width: wide ? (hinge?.lowerBound ?? geo.size.width * 0.55) : nil)
                        .frame(maxHeight: wide ? .infinity : geo.size.height * 0.55)
                    Separator(vertical: wide)
                        .opacity(hinge == nil ? 1 : 0)
                        .padding(.horizontal, hinge.map { max(0, ($0.upperBound - $0.lowerBound) / 2 - 0.5) } ?? 0)
                    MainRoomChatView(showsOnlineCount: bar.usesVerticalBar)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .modifier(HingeTick(tick: $hingeTick))
        .verticalBarChrome(bar, showsBarControls: bar.usesVerticalBar)
        .toolbar {
            if bar.usesVerticalBar { barControls }
        }
        .onTapGesture {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
        .onAppear {
            LobbyEmitter.joinMainRoom()
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .background {
                didEnterBackground = true
            } else if newPhase == .active && didEnterBackground {
                // Re-join main room after a real background to re-establish the server-side
                // room subscription. Skipped for inactive -> active (Control Center, alerts),
                // where the socket and room subscription never went away.
                didEnterBackground = false
                LobbyEmitter.joinMainRoom()
            }
        }
        .sheet(isPresented: $showLeaderboard) {
            StatsView()
                .statsSheetSizing()
        }
        .sheet(isPresented: $showOnlineUsers) {
            OnlineUsersSheet(users: mainRoomState.onlineUsers)
        }
        .sheet(isPresented: $showAccountSettings) {
            AccountSettingsView()
        }
    }

    // MARK: - Lobby Browser

    private var lobbyBrowserPanel: some View {
        VStack(spacing: 0) {
            // Header: words when the whole row fits on one line, icons only
            // when it doesn't (the closed Duo, the open Duo's 55% panel, large
            // Dynamic Type). Measured, not size-class based, so no label ever
            // wraps mid-word. Icon-only labels keep their title for VoiceOver.
            // In the vertical bar the same controls are toolbar items.
            if !bar.usesVerticalBar {
                ViewThatFits(in: .horizontal) {
                    lobbyHeader(iconsOnly: false)
                    lobbyHeader(iconsOnly: true)
                }
                .padding()

                Divider().background(Theme.inputBorder, ignoresSafeAreaEdges: .vertical)
            }

            // Lobby list
            LobbyListView()
        }
    }

    private func createTournament() {
        TournamentRejoin.startFromMainRoom(tournamentState)
        TournamentEmitter.createTournament()
    }

    private func lobbyHeader(iconsOnly: Bool) -> some View {
        HStack(spacing: iconsOnly ? 4 : 8) {
            headerButton("New Game", icon: "suit.spade.fill", color: Theme.primary,
                         iconsOnly: iconsOnly) { LobbyEmitter.createLobby() }
                .disabled(!socketService.canSendMainRoomActions)
            headerButton("Tournament", icon: "trophy.fill", color: Theme.warning,
                         iconsOnly: iconsOnly) { createTournament() }
                .disabled(!socketService.canSendMainRoomActions)
            headerButton("Stats", icon: "chart.bar.fill", color: Theme.textSecondary,
                         iconsOnly: iconsOnly) { showLeaderboard = true }

            Spacer(minLength: 8)

            Button(action: { showOnlineUsers = true }) {
                Text("\(mainRoomState.onlineCount) online")
                    .font(.caption)
                    .lineLimit(1)
                    .fixedSize()
                    .foregroundColor(Theme.textSecondary)
            }

            Button(action: { showAccountSettings = true }) {
                Image(systemName: "gearshape.fill")
                    .font(.callout)
                    .foregroundColor(Theme.textSecondary)
                    .frame(minWidth: 32, minHeight: 32)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Account settings")
        }
    }

    // MARK: - Vertical bar (iOS 27.1)

    /// The header's controls as toolbar items: the actions on top, the online
    /// count and the account settings as the trailing group.
    @ToolbarContentBuilder
    private var barControls: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarLeading) {
            barButton("New Game", icon: "suit.spade.fill", color: Theme.primary) { LobbyEmitter.createLobby() }
                .disabled(!socketService.canSendMainRoomActions)
            barButton("Tournament", icon: "trophy.fill", color: Theme.warning) { createTournament() }
                .disabled(!socketService.canSendMainRoomActions)
            barButton("Stats", icon: "chart.bar.fill", color: Theme.textSecondary) { showLeaderboard = true }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            // The vertical bar lays out symbols only (a text or custom label lands outside
            // the column), and a badge reads as an alert: the count is in the chat header.
            Button(action: { showOnlineUsers = true }) {
                Label("\(mainRoomState.onlineCount) online", systemImage: "person.2.fill")
            }
            Button(action: { showAccountSettings = true }) {
                Label("Account settings", systemImage: "gearshape.fill")
            }
        }
    }

    private func barButton(_ title: String, icon: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
        }
        .tint(color)
    }

    private func headerButton(_ title: String, icon: String, color: Color, iconsOnly: Bool,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .labelStyle(HeaderLabelStyle(iconsOnly: iconsOnly))
                .font(.callout.bold())
                .foregroundColor(color)
                .lineLimit(1)
                .fixedSize()
                .frame(minWidth: iconsOnly ? 44 : nil, minHeight: 32)
                .contentShape(Rectangle())
        }
    }
}

/// Title + icon, or icon only (the title stays the accessibility label).
private struct HeaderLabelStyle: LabelStyle {
    let iconsOnly: Bool
    func makeBody(configuration: Configuration) -> some View {
        if iconsOnly {
            IconOnlyLabelStyle().makeBody(configuration: configuration)
        } else {
            TitleAndIconLabelStyle().makeBody(configuration: configuration)
        }
    }

}

private extension View {
    /// The Stats sheet as a page sheet on the iPad (iOS 18+): wide enough for the
    /// leaderboard's eight-column table; a phone's sheet is unchanged.
    @ViewBuilder
    func statsSheetSizing() -> some View {
        if #available(iOS 18.0, *) {
            presentationSizing(.page)
        } else {
            self
        }
    }
}

// MARK: - Online Users Sheet

private struct OnlineUsersSheet: View {
    let users: [String]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            List(users, id: \.self) { username in
                OnlineUserRow(username: username)
            }
            .listStyle(.plain)
            .background(Theme.background)
            .scrollContentBackground(.hidden)
            .navigationTitle("Online Players")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        // a name opens that player's profile (iOS 1.2.2; the web's search is not on iOS)
        .playerProfileHost()
    }
}

/// One online player: a button that opens their profile (my own name is just my name).
private struct OnlineUserRow: View {
    let username: String
    @EnvironmentObject var authState: AuthState
    @Environment(\.viewPlayerProfile) private var viewProfile

    var body: some View {
        if username == authState.username || viewProfile == nil {
            Text(username)
                .foregroundColor(Theme.textPrimary)
        } else {
            Button { viewProfile?(username) } label: {
                HStack {
                    Text(username)
                        .foregroundColor(Theme.textPrimary)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundColor(Theme.textDim)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows their profile")
            .accessibilityIdentifier("online.\(username)")
        }
    }
}

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
    /// `isAdmin` shows the Admin button (display only: the server checks every request).
    @EnvironmentObject var authState: AuthState
    /// New Game (a lobby or a tournament) waits for the session: after a reconnect, a tap before the
    /// restore's answer made a lobby that the restore's joinMainRoom then left at once.
    @ObservedObject private var socketService = SocketService.shared
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var hSizeClass
    @State private var hingeTick = 0
    @State private var showLeaderboard = false
    @State private var showOnlineUsers = false
    @State private var showAccountSettings = false
    @State private var didEnterBackground = false
    /// The admin panel (admins only): opened from the Account sheet once that sheet has closed.
    @ObservedObject private var admin = AdminState.shared
    @State private var openAdminAfterAccount = false

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
            Keyboard.dismiss()
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
        .sheet(isPresented: $showAccountSettings, onDismiss: {
            guard openAdminAfterAccount else { return }
            openAdminAfterAccount = false
            openAdmin()
        }) {
            AccountSettingsView(openAdmin: { openAdminAfterAccount = true })
        }
        .sheet(isPresented: $admin.isPresented, onDismiss: { admin.close() }) {
            AdminPanelView(admin: admin)
                .statsSheetSizing()
        }
    }

    /// Only on the main room and only with the flag (`AdminState.open` checks it): either
    /// can have gone while the Account sheet was closing (a forceLogout, a game starting).
    private func openAdmin() {
        guard appState.screen == .mainRoom else { return }
        admin.open()
    }

    // MARK: - Lobby Browser

    private var lobbyBrowserPanel: some View {
        VStack(spacing: 0) {
            // Header: New Game (the spade menu) and the trophy (the leaderboard and records):
            // words when the whole row fits on one line; else New Game keeps
            // its word and the trophy is an icon (phones, the open Duo's 55% panel: owner
            // 2026-11-16, a new player needs to see "New Game"); icons only as the last
            // resort (large Dynamic Type on a narrow screen). Measured, not size-class
            // based, so no label ever wraps mid-word. Icon-only labels keep their title
            // for VoiceOver. In the vertical bar the same controls are toolbar items.
            if !bar.usesVerticalBar {
                ViewThatFits(in: .horizontal) {
                    lobbyHeader(.words)
                    lobbyHeader(.newGameWord)
                    lobbyHeader(.icons)
                }
                .padding()

                Divider().background(Theme.inputBorder, ignoresSafeAreaEdges: .vertical)
            }

            // Lobby list
            LobbyListView()
        }
    }

    /// New Game's choices (owner 2026-11-26: a native menu on the control, replacing the
    /// confirmation dialog; then "we could fold tournament into the spade menu"): each one's name
    /// with its one line as the item's subtitle (a Button whose label is two Texts: title +
    /// subtitle, iOS 17+; `NewGameChoice`). "Back Alley Bridge" sends createLobby {} as before,
    /// "Get Your Bid" createLobby {mode: 'gyb'}, "Tournament" createTournament (what the trophy
    /// sent until then).
    @ViewBuilder
    private var newGameChoices: some View {
        ForEach(NewGameChoice.allCases) { choice in
            Button { start(choice) } label: {
                Text(choice.title)
                Text(choice.blurb)
            }
            .accessibilityIdentifier(choice.identifier)
        }
    }

    /// The choice was made: only while the main room may still send (the session gate).
    private func start(_ choice: NewGameChoice) {
        guard socketService.canSendMainRoomActions else { return }
        if let mode = choice.lobbyMode {
            LobbyEmitter.createLobby(mode: mode)
        } else {
            TournamentRejoin.startFromMainRoom(tournamentState)
            TournamentEmitter.createTournament()
        }
    }

    /// How much of the header's action row shows words.
    enum HeaderWords { case words, newGameWord, icons }

    private func lobbyHeader(_ words: HeaderWords) -> some View {
        let othersIconsOnly = words != .words
        return HStack(spacing: othersIconsOnly ? 4 : 8) {
            Menu {
                newGameChoices
            } label: {
                headerLabel(MainRoomControls.title(.newGame), icon: MainRoomControls.icon(.newGame),
                            color: Theme.primary, iconsOnly: words == .icons)
            }
            .menuIndicator(.hidden)
            .accessibilityHint(MainRoomControls.hint(.newGame))
            .disabled(!socketService.canSendMainRoomActions)
            // the trophy: the leaderboard and records (owner 2026-11-26; the Stats icon is gone)
            headerButton(MainRoomControls.title(.leaderboard), icon: MainRoomControls.icon(.leaderboard),
                         color: Theme.warning, iconsOnly: othersIconsOnly) { showLeaderboard = true }
                .accessibilityHint(MainRoomControls.hint(.leaderboard))
                .accessibilityIdentifier(MainRoomControls.identifier(.leaderboard) ?? "")

            Spacer(minLength: 8)

            Button(action: { showOnlineUsers = true }) {
                Text("\(mainRoomState.onlineCount) online")
                    .font(.caption)
                    .lineLimit(1)
                    .fixedSize()
                    .foregroundColor(Theme.textSecondary)
            }

            if authState.isAdmin {
                // admins only, as the web's main room header
                Button(action: openAdmin) {
                    Image(systemName: "shield.lefthalf.filled")
                        .font(.callout)
                        .foregroundColor(Theme.textSecondary)
                        .frame(minWidth: 32, minHeight: 32)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Admin")
                .accessibilityIdentifier("mainRoom.admin")
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
        ToolbarItemGroup(placement: .barLeading) {
            Menu {
                newGameChoices
            } label: {
                Label(MainRoomControls.title(.newGame), systemImage: MainRoomControls.icon(.newGame))
            }
            .tint(Theme.primary)
            .accessibilityHint(MainRoomControls.hint(.newGame))
            .disabled(!socketService.canSendMainRoomActions)
            barButton(MainRoomControls.title(.leaderboard), icon: MainRoomControls.icon(.leaderboard),
                      color: Theme.warning) { showLeaderboard = true }
                .accessibilityHint(MainRoomControls.hint(.leaderboard))
                .accessibilityIdentifier(MainRoomControls.identifier(.leaderboard) ?? "")
        }
        ToolbarItemGroup(placement: .barTrailing) {
            // The vertical bar lays out symbols only (a text or custom label lands outside
            // the column), and a badge reads as an alert: the count is in the chat header.
            Button(action: { showOnlineUsers = true }) {
                Label("\(mainRoomState.onlineCount) online", systemImage: "person.2.fill")
            }
            if authState.isAdmin {
                Button(action: openAdmin) {
                    Label("Admin", systemImage: "shield.lefthalf.filled")
                }
                .accessibilityIdentifier("mainRoom.admin")
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
            headerLabel(title, icon: icon, color: color, iconsOnly: iconsOnly)
        }
    }

    /// A header control's look (a Button's or New Game's Menu's label).
    private func headerLabel(_ title: String, icon: String, color: Color, iconsOnly: Bool) -> some View {
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
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .barTrailing) {
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

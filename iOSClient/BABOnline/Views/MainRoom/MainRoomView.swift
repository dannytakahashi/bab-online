import SwiftUI

struct MainRoomView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var mainRoomState: MainRoomState
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var hSizeClass
    @State private var showLeaderboard = false
    @State private var showOnlineUsers = false
    @State private var showAccountSettings = false
    @State private var didEnterBackground = false

    var body: some View {
        ZStack {
            Color.Theme.background.ignoresSafeArea()

            // Regular width (iPad, the open Duo): side by side; compact: stacked.
            // One AnyLayout keeps the children's identity (and the chat field's
            // focus and draft) across a size-class change.
            GeometryReader { geo in
                let wide = hSizeClass == .regular
                let layout = wide ? AnyLayout(HStackLayout(spacing: 0)) : AnyLayout(VStackLayout(spacing: 0))
                layout {
                    lobbyBrowserPanel
                        .frame(width: wide ? geo.size.width * 0.55 : nil)
                        .frame(maxHeight: wide ? .infinity : geo.size.height * 0.55)
                    Separator(vertical: wide)
                    MainRoomChatView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
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
            LeaderboardView()
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
            ViewThatFits(in: .horizontal) {
                lobbyHeader(iconsOnly: false)
                lobbyHeader(iconsOnly: true)
            }
            .padding()

            Divider().background(Color.Theme.inputBorder)

            // Lobby list
            LobbyListView()
        }
    }

    private func lobbyHeader(iconsOnly: Bool) -> some View {
        HStack(spacing: iconsOnly ? 4 : 8) {
            headerButton("New Game", icon: "suit.spade.fill", color: Color.Theme.primary,
                         iconsOnly: iconsOnly) { LobbyEmitter.createLobby() }
            headerButton("Tournament", icon: "trophy.fill", color: Color.Theme.warning,
                         iconsOnly: iconsOnly) { TournamentEmitter.createTournament() }
            headerButton("Stats", icon: "chart.bar.fill", color: Color.Theme.textSecondary,
                         iconsOnly: iconsOnly) { showLeaderboard = true }

            Spacer(minLength: 8)

            Button(action: { showOnlineUsers = true }) {
                Text("\(mainRoomState.onlineCount) online")
                    .font(.caption)
                    .lineLimit(1)
                    .fixedSize()
                    .foregroundColor(Color.Theme.textSecondary)
            }

            Button(action: { showAccountSettings = true }) {
                Image(systemName: "gearshape.fill")
                    .font(.callout)
                    .foregroundColor(Color.Theme.textSecondary)
                    .frame(minWidth: 32, minHeight: 32)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Account settings")
        }
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

// MARK: - Online Users Sheet

private struct OnlineUsersSheet: View {
    let users: [String]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            List(users, id: \.self) { username in
                Text(username)
                    .foregroundColor(Color.Theme.textPrimary)
            }
            .listStyle(.plain)
            .background(Color.Theme.background)
            .scrollContentBackground(.hidden)
            .navigationTitle("Online Players")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

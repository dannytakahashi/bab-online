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
            // Header
            HStack {
                Button(action: { LobbyEmitter.createLobby() }) {
                    Label("New Game", systemImage: "suit.spade.fill")
                        .font(.callout.bold())
                        .foregroundColor(Color.Theme.primary)
                }

                Button(action: { TournamentEmitter.createTournament() }) {
                    Label("Tournament", systemImage: "trophy.fill")
                        .font(.callout.bold())
                        .foregroundColor(Color.Theme.warning)
                }

                Button(action: { showLeaderboard = true }) {
                    Label("Stats", systemImage: "chart.bar.fill")
                        .font(.callout.bold())
                        .foregroundColor(Color.Theme.textSecondary)
                }

                Spacer()

                Button(action: { showOnlineUsers = true }) {
                    Text("\(mainRoomState.onlineCount) online")
                        .font(.caption)
                        .foregroundColor(Color.Theme.textSecondary)
                }

                Button(action: { showAccountSettings = true }) {
                    Image(systemName: "gearshape.fill")
                        .font(.callout)
                        .foregroundColor(Color.Theme.textSecondary)
                }
            }
            .padding()

            Divider().background(Color.Theme.inputBorder)

            // Lobby list
            LobbyListView()
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

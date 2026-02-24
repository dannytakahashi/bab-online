import SwiftUI

struct MainRoomView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var mainRoomState: MainRoomState
    @Environment(\.scenePhase) private var scenePhase
    @State private var showLeaderboard = false
    @State private var showOnlineUsers = false

    var body: some View {
        ZStack {
            Color.Theme.background.ignoresSafeArea()

            GeometryReader { geo in
                if geo.size.width > LayoutConstants.compactWidthThreshold {
                    // iPad: side-by-side
                    HStack(spacing: 0) {
                        lobbyBrowserPanel
                            .frame(width: geo.size.width * 0.55)
                        Divider().background(Color.Theme.inputBorder)
                        MainRoomChatView()
                            .frame(maxWidth: .infinity)
                    }
                } else {
                    // iPhone: tabs or stacked
                    VStack(spacing: 0) {
                        lobbyBrowserPanel
                            .frame(maxHeight: geo.size.height * 0.55)
                        Divider().background(Color.Theme.inputBorder)
                        MainRoomChatView()
                    }
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
            if newPhase == .active {
                // Re-join main room after foregrounding to re-establish the server-side
                // room subscription. Safe to call redundantly — server just re-adds to the room.
                LobbyEmitter.joinMainRoom()
            }
        }
        .sheet(isPresented: $showLeaderboard) {
            LeaderboardView()
        }
        .sheet(isPresented: $showOnlineUsers) {
            OnlineUsersSheet(users: mainRoomState.onlineUsers)
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

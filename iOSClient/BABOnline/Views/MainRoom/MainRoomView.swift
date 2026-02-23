import SwiftUI

struct MainRoomView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var mainRoomState: MainRoomState
    @Environment(\.scenePhase) private var scenePhase
    @State private var showLeaderboard = false

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
    }

    // MARK: - Lobby Browser

    private var lobbyBrowserPanel: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Game Lobbies")
                    .font(.title2.bold())
                    .foregroundColor(Color.Theme.textPrimary)

                Spacer()

                Text("\(mainRoomState.onlineCount) online")
                    .font(.caption)
                    .foregroundColor(Color.Theme.textSecondary)

                Button(action: { showLeaderboard = true }) {
                    Label("Stats", systemImage: "chart.bar.fill")
                        .font(.callout.bold())
                        .foregroundColor(Color.Theme.textSecondary)
                }

                Button(action: { TournamentEmitter.createTournament() }) {
                    Label("Tournament", systemImage: "trophy.fill")
                        .font(.callout.bold())
                        .foregroundColor(Color.Theme.warning)
                }

                Button(action: { LobbyEmitter.createLobby() }) {
                    Label("Game", systemImage: "suit.spade.fill")
                        .font(.callout.bold())
                        .foregroundColor(Color.Theme.primary)
                }
            }
            .padding()

            Divider().background(Color.Theme.inputBorder)

            // Lobby list
            LobbyListView()
        }
    }

}

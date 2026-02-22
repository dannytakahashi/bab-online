import SwiftUI

struct MainRoomView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var mainRoomState: MainRoomState

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
        .onAppear {
            LobbyEmitter.joinMainRoom()
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

                Button(action: { LobbyEmitter.createLobby() }) {
                    Label("Create", systemImage: "plus.circle.fill")
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

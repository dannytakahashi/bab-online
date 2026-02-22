import SwiftUI

struct LobbyListView: View {
    @EnvironmentObject var mainRoomState: MainRoomState

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 1) {
                if mainRoomState.lobbies.isEmpty && mainRoomState.inProgressGames.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "gamecontroller")
                            .font(.system(size: 40))
                            .foregroundColor(Color.Theme.textDim)
                        Text("No games available")
                            .foregroundColor(Color.Theme.textDim)
                        Text("Create one to get started!")
                            .font(.caption)
                            .foregroundColor(Color.Theme.textDim)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 60)
                } else {
                    // Waiting lobbies
                    ForEach(mainRoomState.lobbies) { lobby in
                        LobbyRowView(lobby: lobby, isInProgress: false)
                    }

                    // In-progress games
                    if !mainRoomState.inProgressGames.isEmpty {
                        Text("In Progress")
                            .font(.caption.bold())
                            .foregroundColor(Color.Theme.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal)
                            .padding(.top, 12)

                        ForEach(mainRoomState.inProgressGames) { game in
                            LobbyRowView(lobby: game, isInProgress: true)
                        }
                    }
                }
            }
        }
    }
}

struct LobbyRowView: View {
    let lobby: Lobby
    let isInProgress: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(lobby.name)
                    .font(.body.bold())
                    .foregroundColor(Color.Theme.textPrimary)

                Text("\(lobby.playerCount)/4 players")
                    .font(.caption)
                    .foregroundColor(Color.Theme.textSecondary)
            }

            Spacer()

            if isInProgress {
                Text("In Progress")
                    .font(.caption)
                    .foregroundColor(Color.Theme.warning)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.Theme.warning.opacity(0.15))
                    .cornerRadius(6)
            } else {
                Button(action: {
                    LobbyEmitter.joinLobby(lobbyId: lobby.id)
                }) {
                    Text("Join")
                        .font(.callout.bold())
                        .foregroundColor(.white)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 8)
                        .background(Color.Theme.buttonBackground)
                        .cornerRadius(8)
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 12)
        .background(Color.Theme.surface)
    }
}

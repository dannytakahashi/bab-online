import SwiftUI

struct GameLobbyView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var lobbyState: LobbyState

    @State private var isReady = false

    var body: some View {
        ZStack {
            Color.Theme.background.ignoresSafeArea()

            VStack(spacing: 0) {
                // Header
                HStack {
                    Button(action: leaveLobby) {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.left")
                            Text("Leave")
                        }
                        .foregroundColor(Color.Theme.textSecondary)
                    }

                    Spacer()

                    Text(lobbyState.lobbyName.isEmpty ? "Game Lobby" : lobbyState.lobbyName)
                        .font(.headline)
                        .foregroundColor(Color.Theme.textPrimary)

                    Spacer()

                    Text("\(lobbyState.playerCount)/4")
                        .foregroundColor(Color.Theme.textSecondary)
                }
                .padding()

                Divider().background(Color.Theme.inputBorder)

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

                // Chat - takes remaining space
                LobbyChatView()
                    .frame(minHeight: 120)

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
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Color.clear.frame(height: 0)
            }
            .onTapGesture {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
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

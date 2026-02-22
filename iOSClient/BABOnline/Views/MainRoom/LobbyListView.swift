import SwiftUI

struct LobbyListView: View {
    @EnvironmentObject var mainRoomState: MainRoomState

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 1) {
                if mainRoomState.lobbies.isEmpty && mainRoomState.inProgressGames.isEmpty && mainRoomState.tournaments.isEmpty {
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

                    // Tournaments
                    if !mainRoomState.tournaments.isEmpty {
                        Text("Tournaments")
                            .font(.caption.bold())
                            .foregroundColor(Color.Theme.warning)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal)
                            .padding(.top, 12)

                        ForEach(mainRoomState.tournaments) { tournament in
                            TournamentRowView(tournament: tournament)
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
                Button(action: {
                    LobbyEmitter.joinAsSpectator(gameId: lobby.id)
                }) {
                    Text("Spectate")
                        .font(.callout.bold())
                        .foregroundColor(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Color(red: 0.376, green: 0.647, blue: 0.98)) // #60a5fa
                        .cornerRadius(8)
                }
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

struct TournamentRowView: View {
    let tournament: TournamentSummary

    private var phaseDescription: String {
        switch tournament.phase {
        case "lobby": return "Waiting to start"
        case "round_active": return "Round \(tournament.currentRound) of \(tournament.totalRounds)"
        case "between_rounds": return "Between rounds (\(tournament.currentRound)/\(tournament.totalRounds))"
        case "complete": return "Complete"
        default: return tournament.phase
        }
    }

    private var canJoin: Bool {
        tournament.phase == "lobby" || tournament.phase == "between_rounds"
    }

    private var canSpectate: Bool {
        tournament.phase == "round_active"
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: "trophy.fill")
                        .font(.caption)
                        .foregroundColor(Color.Theme.warning)
                    Text(tournament.name)
                        .font(.body.bold())
                        .foregroundColor(Color.Theme.warning)
                }

                Text("\(tournament.playerCount) players \u{2022} \(phaseDescription)")
                    .font(.caption)
                    .foregroundColor(Color.Theme.textSecondary)
            }

            Spacer()

            if canJoin {
                Button(action: {
                    TournamentEmitter.joinTournament(tournamentId: tournament.id)
                }) {
                    Text("Join")
                        .font(.callout.bold())
                        .foregroundColor(.white)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 8)
                        .background(Color.Theme.buttonBackground)
                        .cornerRadius(8)
                }
            } else if canSpectate {
                Button(action: {
                    TournamentEmitter.spectateTournament(tournamentId: tournament.id)
                }) {
                    Text("Spectate")
                        .font(.callout.bold())
                        .foregroundColor(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Color(red: 0.376, green: 0.647, blue: 0.98))
                        .cornerRadius(8)
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 12)
        .background(Color.Theme.surface)
    }
}

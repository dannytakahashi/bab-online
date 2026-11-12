import SwiftUI

struct LobbyListView: View {
    @EnvironmentObject var mainRoomState: MainRoomState

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 1) {
                if mainRoomState.lobbies.isEmpty && mainRoomState.inProgressGames.isEmpty && mainRoomState.tournaments.isEmpty {
                    VStack(spacing: Theme.Space.s3) {
                        Image(systemName: "gamecontroller")
                            .font(.largeTitle)
                            .foregroundColor(Theme.textDim)
                            .accessibilityHidden(true)
                        Text("No games available")
                            .foregroundColor(Theme.textDim)
                        Text("Create one to get started!")
                            .font(.caption)
                            .foregroundColor(Theme.textDim)
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
                            .foregroundColor(Theme.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal)
                            .padding(.top, Theme.Space.s3)

                        ForEach(mainRoomState.inProgressGames) { game in
                            LobbyRowView(lobby: game, isInProgress: true)
                        }
                    }

                    // Tournaments
                    if !mainRoomState.tournaments.isEmpty {
                        Text("Tournaments")
                            .font(.caption.bold())
                            .foregroundColor(Theme.warning)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal)
                            .padding(.top, Theme.Space.s3)

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
            VStack(alignment: .leading, spacing: Theme.Space.s1) {
                Text(lobby.name)
                    .font(.body.bold())
                    .foregroundColor(Theme.textPrimary)

                Text("\(lobby.playerCount)/4 players")
                    .font(.caption)
                    .foregroundColor(Theme.textSecondary)
            }

            Spacer()

            if isInProgress {
                Button(action: {
                    LobbyEmitter.joinAsSpectator(gameId: lobby.id)
                }) {
                    Text("Spectate")
                        .font(.callout.bold())
                        .padding(.horizontal, Theme.Space.s4)
                        .padding(.vertical, Theme.Space.s2)
                        .secondaryButtonStyle()
                }
            } else if lobby.playerCount >= 4 {
                Text("Full")
                    .font(.callout.bold())
                    .foregroundColor(Theme.buttonDisabledForeground)
                    .padding(.horizontal, Theme.Space.s5)
                    .padding(.vertical, Theme.Space.s2)
                    .background(Theme.buttonDisabled)
                    .cornerRadius(Theme.Radius.sm)
            } else {
                Button(action: {
                    LobbyEmitter.joinLobby(lobbyId: lobby.id)
                }) {
                    Text("Join")
                        .font(.callout.bold())
                        .foregroundColor(Theme.buttonForeground)
                        .padding(.horizontal, Theme.Space.s5)
                        .padding(.vertical, Theme.Space.s2)
                        .background(Theme.buttonBackground)
                        .cornerRadius(Theme.Radius.sm)
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, Theme.Space.s3)
        .background(Theme.surface, ignoresSafeAreaEdges: .vertical)
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
        // New entrants can only join before the tournament starts; returning
        // members are re-attached automatically at sign-in
        tournament.phase == "lobby"
    }

    private var canSpectate: Bool {
        tournament.phase == "round_active" || tournament.phase == "between_rounds"
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: Theme.Space.s1) {
                HStack(spacing: 6) {
                    Image(systemName: "trophy.fill")
                        .font(.caption)
                        .foregroundColor(Theme.warning)
                        .accessibilityHidden(true)
                    Text(tournament.name)
                        .font(.body.bold())
                        .foregroundColor(Theme.warning)
                }

                Text("\(tournament.playerCount) players \u{2022} \(phaseDescription)")
                    .font(.caption)
                    .foregroundColor(Theme.textSecondary)
            }

            Spacer()

            if canJoin {
                Button(action: {
                    TournamentEmitter.joinTournament(tournamentId: tournament.id)
                }) {
                    Text("Join")
                        .font(.callout.bold())
                        .foregroundColor(Theme.buttonForeground)
                        .padding(.horizontal, Theme.Space.s5)
                        .padding(.vertical, Theme.Space.s2)
                        .background(Theme.buttonBackground)
                        .cornerRadius(Theme.Radius.sm)
                }
            } else if canSpectate {
                Button(action: {
                    TournamentEmitter.spectateTournament(tournamentId: tournament.id)
                }) {
                    Text("Spectate")
                        .font(.callout.bold())
                        .padding(.horizontal, Theme.Space.s4)
                        .padding(.vertical, Theme.Space.s2)
                        .secondaryButtonStyle()
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, Theme.Space.s3)
        .background(Theme.surface, ignoresSafeAreaEdges: .vertical)
    }
}

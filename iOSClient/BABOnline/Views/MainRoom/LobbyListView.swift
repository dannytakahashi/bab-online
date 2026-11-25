import SwiftUI

struct LobbyListView: View {
    @EnvironmentObject var mainRoomState: MainRoomState
    @ObservedObject private var socketService = SocketService.shared

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 1) {
                if mainRoomState.lobbies.isEmpty && mainRoomState.inProgressGames.isEmpty && mainRoomState.tournaments.isEmpty {
                    VStack(spacing: Theme.Space.s3) {
                        // the four suits, as on the app icon (owner: something card
                        // related, not a game controller)
                        HStack(spacing: Theme.Space.s2) {
                            ForEach([(Suit.spades, "spade"), (.hearts, "heart"), (.diamonds, "diamond"), (.clubs, "club")], id: \.1) { suit, symbol in
                                Image(systemName: "suit.\(symbol).fill")
                                    .foregroundColor(Theme.suitOnDark(suit))
                            }
                        }
                        .font(.title)
                        .opacity(0.8)
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
            // Join / Spectate wait for the session and a foreground probe (SocketService.canSendMainRoomActions); the list still scrolls
            .disabled(!socketService.canSendMainRoomActions)
        }
    }
}

/// A main-room card: a waiting lobby (name, n/4 or n/8, the members' names, Join / Rejoin / Full) or
/// a game in progress (the teams, "Hand N", each team's score in its color, "N watching",
/// Spectate), as the web's MainRoom.js cards.
struct LobbyRowView: View {
    let lobby: Lobby
    let isInProgress: Bool
    @EnvironmentObject var authState: AuthState

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: Theme.Space.s1) {
                Text(lobby.name)
                    .font(.body.bold())
                    .foregroundColor(Theme.textPrimary)

                if isInProgress, let progress = lobby.progress {
                    progressLines(progress)
                } else {
                    // "n/8" for a family lobby (memberCount / capacity, 1.2.2 (12)), else "n/4"
                    Text("\(lobby.countText) players")
                        .font(.caption)
                        .foregroundColor(Theme.textSecondary)

                    if !isInProgress, !lobby.players.isEmpty {
                        Text(lobby.memberNames)
                            .font(.caption)
                            .foregroundColor(Theme.textSecondary)
                            .lineLimit(2)
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .modifier(SpokenLabel(text: spokenProgress))
            .accessibilityIdentifier("lobbyCard.\(lobby.id)")

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
            } else {
                switch lobby.action(for: authState.username) {
                case .full:
                    Text("Full")
                        .font(.callout.bold())
                        .foregroundColor(Theme.buttonDisabledForeground)
                        .padding(.horizontal, Theme.Space.s5)
                        .padding(.vertical, Theme.Space.s2)
                        .background(Theme.buttonDisabled)
                        .cornerRadius(Theme.Radius.sm)
                case .join, .rejoin:
                    // Rejoin: a full lobby that still holds my seat; joinLobby moves the
                    // seat to this socket (the server answers lobbyCreated)
                    let rejoin = lobby.action(for: authState.username) == .rejoin
                    Button(action: {
                        LobbyEmitter.joinLobby(lobbyId: lobby.id)
                    }) {
                        Text(rejoin ? "Rejoin" : "Join")
                            .font(.callout.bold())
                            .foregroundColor(Theme.buttonForeground)
                            .padding(.horizontal, rejoin ? Theme.Space.s4 : Theme.Space.s5)
                            .padding(.vertical, Theme.Space.s2)
                            .background(Theme.buttonBackground)
                            .cornerRadius(Theme.Radius.sm)
                    }
                    .accessibilityIdentifier(rejoin ? "lobby.rejoin" : "lobby.join")
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, Theme.Space.s3)
        .background(Theme.surface, ignoresSafeAreaEdges: .vertical)
    }

    /// VoiceOver for an in-progress card: the names, then the hand, scores and watchers in
    /// words ("a and c 120", not "a/c: 120 | ..."); nil keeps the combined visible texts.
    private var spokenProgress: String? {
        guard isInProgress, let spoken = lobby.progress?.spokenSummary, !spoken.isEmpty else { return nil }
        return "\(lobby.name). \(spoken)"
    }

    /// "Hand 5 • 2 watching", then "a/c: 120 | b/d: 85" in the team colors.
    @ViewBuilder
    private func progressLines(_ progress: GameProgress) -> some View {
        let head = [progress.handText, progress.watchingText].compactMap { $0 }
        if !head.isEmpty {
            Text(head.joined(separator: " \u{2022} "))
                .font(.caption)
                .foregroundColor(Theme.textSecondary)
        }
        if let team1 = progress.teamText(1), let team2 = progress.teamText(2) {
            Text("\(Text(team1).foregroundColor(Theme.teamA)) | \(Text(team2).foregroundColor(Theme.teamB))")
                .font(.caption)
                .foregroundColor(Theme.textSecondary)
                .lineLimit(2)
        }
    }
}

struct TournamentRowView: View {
    let tournament: TournamentSummary
    @EnvironmentObject var tournamentState: TournamentState

    private var phaseDescription: String {
        // Cut for a buck (additive `cut: true`; the phase reads round_active for everyone)
        if tournament.cut { return CutCopy.mainRoomCard }
        switch tournament.phase {
        case "lobby": return "Waiting to start"
        case "round_active": return "Round \(tournament.currentRound) of \(tournament.totalRounds)"
        case "between_rounds": return "Between rounds (\(tournament.currentRound)/\(tournament.totalRounds))"
        case "cut": return CutCopy.mainRoomCard
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
                    TournamentRejoin.startFromMainRoom(tournamentState)
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
                    TournamentRejoin.startFromMainRoom(tournamentState)
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

/// Replaces an element's VoiceOver label when there is one to say; nil leaves it alone.
private struct SpokenLabel: ViewModifier {
    let text: String?

    func body(content: Content) -> some View {
        if let text { content.accessibilityLabel(text) } else { content }
    }
}

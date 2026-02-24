import SwiftUI

struct TournamentLobbyView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var tournamentState: TournamentState

    var body: some View {
        ZStack {
            Color.Theme.background.ignoresSafeArea()

            GeometryReader { geo in
                if geo.size.width > LayoutConstants.compactWidthThreshold {
                    // iPad: side-by-side
                    HStack(spacing: 0) {
                        leftPanel
                            .frame(width: geo.size.width * 0.55)
                        Divider().background(Color.Theme.inputBorder)
                        rightPanel
                            .frame(maxWidth: .infinity)
                    }
                } else {
                    // iPhone: stacked
                    VStack(spacing: 0) {
                        headerBar
                        ScrollView {
                            VStack(spacing: 16) {
                                TournamentPlayerListView()
                                TournamentScoreboardView()
                                TournamentActiveGamesView()
                                TournamentChatView()
                                    .frame(minHeight: 200)
                            }
                            .padding(.bottom, 8)
                        }
                        bottomButtons
                    }
                }
            }

            // Results overlay
            if tournamentState.phase == "complete" {
                TournamentResultsView()
            }
        }
        .onTapGesture {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
    }

    // MARK: - iPad Layout

    private var leftPanel: some View {
        VStack(spacing: 0) {
            headerBar
            TournamentPlayerListView()
            TournamentChatView()
            bottomButtons
        }
    }

    private var rightPanel: some View {
        VStack(spacing: 0) {
            TournamentScoreboardView()
            TournamentActiveGamesView()
            Spacer()
        }
    }

    // MARK: - Header

    private var headerBar: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: leaveTournament) {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                        Text("Leave")
                    }
                    .foregroundColor(Color.Theme.textSecondary)
                }

                Spacer()

                VStack(spacing: 2) {
                    HStack(spacing: 6) {
                        Image(systemName: "trophy.fill")
                            .foregroundColor(Color.Theme.warning)
                        Text(tournamentState.name.isEmpty ? "Tournament" : tournamentState.name)
                            .font(.headline)
                            .foregroundColor(Color.Theme.warning)
                    }
                    Text(roundIndicator)
                        .font(.caption)
                        .foregroundColor(Color.Theme.textSecondary)
                }

                Spacer()

                Text("\(tournamentState.players.count) players")
                    .font(.caption)
                    .foregroundColor(Color.Theme.textSecondary)
            }
            .padding()

            Divider().background(Color.Theme.inputBorder)
        }
    }

    private var roundIndicator: String {
        switch tournamentState.phase {
        case "lobby": return "Waiting to start"
        case "round_active": return "Round \(tournamentState.currentRound) of \(tournamentState.totalRounds)"
        case "between_rounds": return "Round \(tournamentState.currentRound) complete"
        case "complete": return "Tournament complete"
        default: return ""
        }
    }

    // MARK: - Bottom Buttons

    private var isCreator: Bool {
        authState.username == tournamentState.creatorUsername
    }

    private var allReady: Bool {
        !tournamentState.players.isEmpty && tournamentState.players.allSatisfy { $0.isReady }
    }

    private var bottomButtons: some View {
        VStack(spacing: 8) {
            if tournamentState.phase == "lobby" || tournamentState.phase == "between_rounds" {
                // Ready / Unready
                Button(action: toggleReady) {
                    Text(tournamentState.isReady ? "Unready" : "Ready")
                        .font(.title3.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(tournamentState.isReady ? Color.Theme.oppColor : Color.Theme.buttonBackground)
                        .foregroundColor(.white)
                        .cornerRadius(10)
                }

                // Begin button (creator only)
                if isCreator {
                    let label = tournamentState.phase == "lobby" ? "Begin Tournament" : "Begin Next Round"
                    Button(action: beginRound) {
                        Text(label)
                            .font(.title3.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(allReady ? Color.Theme.warning : Color.Theme.buttonDisabled)
                            .foregroundColor(.white)
                            .cornerRadius(10)
                    }
                    .disabled(!allReady)
                }
            }

            // Cancel Tournament button (creator only, visible in all phases)
            if isCreator {
                Button(action: cancelTournament) {
                    Text("Cancel Tournament")
                        .font(.subheadline.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color(red: 0.6, green: 0.1, blue: 0.1))
                        .foregroundColor(.white)
                        .cornerRadius(10)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    // MARK: - Actions

    private func toggleReady() {
        tournamentState.isReady.toggle()
        if tournamentState.isReady {
            TournamentEmitter.tournamentReady()
        } else {
            TournamentEmitter.tournamentUnready()
        }
        HapticManager.mediumImpact()
    }

    private func beginRound() {
        if tournamentState.phase == "lobby" {
            TournamentEmitter.beginTournament()
        } else {
            TournamentEmitter.beginNextRound()
        }
    }

    private func leaveTournament() {
        TournamentEmitter.leaveTournament()
    }

    private func cancelTournament() {
        TournamentEmitter.cancelTournament()
    }
}

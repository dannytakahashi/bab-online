import SwiftUI

/// The tournament lobby. Where the system shows the vertical bar (the iPhone
/// Duo), Leave is the leading toolbar item in that column (VerticalBarHost);
/// the title and the Ready / Begin / Cancel buttons stay in the content.
struct TournamentLobbyView: View {
    var body: some View {
        VerticalBarHost { TournamentLobbyScreen(bar: $0) }
    }
}

private struct TournamentLobbyScreen: View {
    let bar: VerticalBarContext

    @EnvironmentObject var appState: AppState
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var tournamentState: TournamentState
    @Environment(\.horizontalSizeClass) private var hSizeClass

    var body: some View {
        ZStack {
            Color.Theme.background.ignoresSafeArea()

            // Two branches on purpose (their children differ); the chat draft
            // lives in TournamentState, so a size-class change keeps it.
            GeometryReader { geo in
                if hSizeClass == .regular {
                    // iPad: side-by-side
                    HStack(spacing: 0) {
                        leftPanel(height: geo.size.height)
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
        .verticalBarChrome(bar, showsBarControls: bar.usesVerticalBar)
        .toolbar {
            if bar.usesVerticalBar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: leaveTournament) {
                        Label("Leave", systemImage: "chevron.left")
                    }
                    // the results overlay covers the header's Leave too; it has its own way out
                    .disabled(tournamentState.phase == "complete")
                }
            }
        }
    }

    // MARK: - iPad Layout

    /// The header (Leave, title, round) and the buttons stay pinned; the player
    /// list takes its natural height and scrolls only when the chat would get
    /// less than its minimum (short windows), so the chat fills the rest.
    private func leftPanel(height: CGFloat) -> some View {
        let listCap = max(96, height - headerHeight - buttonsHeight - Self.chatMinHeight)
        return VStack(spacing: 0) {
            headerBar
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { headerHeight = $0 }
            ScrollView {
                TournamentPlayerListView()
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { playerListHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(playerListHeight, listCap))
            TournamentChatView()
                .frame(minHeight: Self.chatMinHeight)
            bottomButtons
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { buttonsHeight = $0 }
        }
    }

    private static let chatMinHeight: CGFloat = 160
    @State private var headerHeight: CGFloat = 0
    @State private var buttonsHeight: CGFloat = 0
    @State private var playerListHeight: CGFloat = 0

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
                // in the vertical bar Leave is a toolbar item and the title leads
                if !bar.usesVerticalBar {
                    Button(action: leaveTournament) {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.left")
                            Text("Leave")
                        }
                        .foregroundColor(Color.Theme.textSecondary)
                    }

                    Spacer()
                }

                VStack(alignment: bar.usesVerticalBar ? .leading : .center, spacing: 2) {
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

            Divider().background(Color.Theme.inputBorder, ignoresSafeAreaEdges: .vertical)
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
        // Disconnected members sit out rounds and never ready up — they must
        // not gate the Begin button (the server ignores them too)
        let connected = tournamentState.players.filter { $0.connected }
        return !connected.isEmpty && connected.allSatisfy { $0.isReady }
    }

    private var bottomButtons: some View {
        VStack(spacing: 8) {
            if tournamentState.phase == "lobby" || tournamentState.phase == "between_rounds" {
                // Ready / Unready (spectators can't ready up)
                if !tournamentState.isSpectator {
                    Button(action: toggleReady) {
                        Text(tournamentState.isReady ? "Unready" : "Ready")
                            .font(.title3.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(tournamentState.isReady ? Color.Theme.oppColor : Color.Theme.buttonBackground)
                            .foregroundColor(.white)
                            .cornerRadius(10)
                    }
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

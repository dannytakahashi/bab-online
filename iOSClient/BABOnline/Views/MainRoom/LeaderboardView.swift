import SwiftUI

struct LeaderboardView: View {
    @EnvironmentObject var leaderboardState: LeaderboardState

    enum SortField: String, CaseIterable {
        case winRate = "Win %"
        case pointsPerGame = "Pts/G"
        case bidsPerGame = "Bids/G"
        case tricksPerBid = "T/Bid"
        case setRate = "Set %"
        case drag = "Drag"
        case avgHSI = "HSI"
        case gamesPlayed = "Games"
    }

    @State private var selectedSort: SortField = .winRate

    private var sortedEntries: [LeaderboardEntry] {
        leaderboardState.entries.sorted { a, b in
            switch selectedSort {
            case .winRate:       return a.winRate > b.winRate
            case .pointsPerGame: return a.pointsPerGame > b.pointsPerGame
            case .bidsPerGame:   return a.bidsPerGame > b.bidsPerGame
            case .tricksPerBid:  return a.tricksPerBid > b.tricksPerBid
            case .setRate:       return a.setRate > b.setRate
            case .drag:          return a.drag > b.drag
            case .avgHSI:        return a.avgHSI > b.avgHSI
            case .gamesPlayed:   return a.gamesPlayed > b.gamesPlayed
            }
        }
    }

    var body: some View {
        NavigationView {
            ZStack {
                Color.Theme.background.ignoresSafeArea()

                VStack(spacing: 0) {
                    // Sort buttons
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(SortField.allCases, id: \.self) { field in
                                Button(action: { selectedSort = field }) {
                                    Text(field.rawValue)
                                        .font(.caption.bold())
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 6)
                                        .background(selectedSort == field ? Color.Theme.primary : Color.Theme.surface)
                                        .foregroundColor(selectedSort == field ? .white : Color.Theme.textSecondary)
                                        .cornerRadius(16)
                                }
                            }
                        }
                        .padding(.horizontal)
                        .padding(.vertical, 8)
                    }

                    Divider().background(Color.Theme.inputBorder)

                    if leaderboardState.isLoading {
                        Spacer()
                        ProgressView()
                            .tint(Color.Theme.textSecondary)
                        Spacer()
                    } else if let error = leaderboardState.error {
                        Spacer()
                        Text(error)
                            .foregroundColor(Color.Theme.error)
                            .font(.callout)
                        Spacer()
                    } else if sortedEntries.isEmpty {
                        Spacer()
                        Text("No players yet")
                            .foregroundColor(Color.Theme.textSecondary)
                            .font(.callout)
                        Spacer()
                    } else {
                        List {
                            ForEach(Array(sortedEntries.enumerated()), id: \.element.id) { index, entry in
                                leaderboardRow(rank: index + 1, entry: entry)
                                    .listRowBackground(Color.Theme.background)
                            }
                        }
                        .listStyle(.plain)
                    }
                }
            }
            .navigationTitle("Leaderboard")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear {
            leaderboardState.isLoading = true
            LeaderboardEmitter.getLeaderboard()
        }
    }

    private func leaderboardRow(rank: Int, entry: LeaderboardEntry) -> some View {
        HStack(spacing: 12) {
            // Rank
            Text("#\(rank)")
                .font(.callout.bold())
                .foregroundColor(rankColor(rank))
                .frame(width: 36, alignment: .leading)

            // Username
            Text(entry.username)
                .font(.callout.bold())
                .foregroundColor(Color.Theme.textPrimary)
                .lineLimit(1)

            Spacer()

            // Primary stat
            VStack(alignment: .trailing, spacing: 2) {
                Text(formattedStat(entry))
                    .font(.callout.bold())
                    .foregroundColor(Color.Theme.primary)
                Text("\(entry.gamesPlayed) games")
                    .font(.caption2)
                    .foregroundColor(Color.Theme.textSecondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func formattedStat(_ entry: LeaderboardEntry) -> String {
        switch selectedSort {
        case .winRate:       return String(format: "%.1f%%", entry.winRate)
        case .pointsPerGame: return String(format: "%.1f", entry.pointsPerGame)
        case .bidsPerGame:   return String(format: "%.1f", entry.bidsPerGame)
        case .tricksPerBid:  return String(format: "%.2f", entry.tricksPerBid)
        case .setRate:       return String(format: "%.1f%%", entry.setRate)
        case .drag:          return String(format: "%.1f", entry.drag)
        case .avgHSI:        return String(format: "%.1f", entry.avgHSI)
        case .gamesPlayed:   return "\(entry.gamesPlayed)"
        }
    }

    private func rankColor(_ rank: Int) -> Color {
        switch rank {
        case 1: return Color.Theme.warning
        case 2: return Color.Theme.textSecondary
        case 3: return Color(red: 0.8, green: 0.5, blue: 0.2)
        default: return Color.Theme.textSecondary
        }
    }
}

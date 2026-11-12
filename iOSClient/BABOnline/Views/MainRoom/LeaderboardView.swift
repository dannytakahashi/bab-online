import SwiftUI

struct LeaderboardView: View {
    @EnvironmentObject var leaderboardState: LeaderboardState
    @Environment(\.dismiss) private var dismiss

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
                Theme.background.ignoresSafeArea()

                VStack(spacing: 0) {
                    // Sort buttons
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Theme.Space.s2) {
                            ForEach(SortField.allCases, id: \.self) { field in
                                Button(action: { selectedSort = field }) {
                                    Text(field.rawValue)
                                        .font(.caption.bold())
                                        .padding(.horizontal, Theme.Space.s3)
                                        .padding(.vertical, 6)
                                        .background(selectedSort == field ? Theme.primary : Theme.surface)
                                        .foregroundColor(selectedSort == field ? Theme.buttonForeground : Theme.textSecondary)
                                        .cornerRadius(Theme.Radius.lg)
                                }
                            }
                        }
                        .padding(.horizontal)
                        .padding(.vertical, Theme.Space.s2)
                    }

                    Divider().background(Theme.inputBorder)

                    if leaderboardState.isLoading {
                        Spacer()
                        ProgressView()
                            .tint(Theme.textSecondary)
                        Spacer()
                    } else if let error = leaderboardState.error {
                        Spacer()
                        Text(error)
                            .foregroundColor(Theme.error)
                            .font(.callout)
                        Spacer()
                    } else if sortedEntries.isEmpty {
                        Spacer()
                        Text("No players yet")
                            .foregroundColor(Theme.textSecondary)
                            .font(.callout)
                        Spacer()
                    } else {
                        List {
                            ForEach(Array(sortedEntries.enumerated()), id: \.element.id) { index, entry in
                                leaderboardRow(rank: LeaderboardEntry.rank(at: index, in: sortedEntries), entry: entry)
                                    .listRowBackground(Theme.background)
                            }
                        }
                        .listStyle(.plain)
                    }
                }
            }
            .navigationTitle("Leaderboard")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear {
            leaderboardState.isLoading = true
            LeaderboardEmitter.getLeaderboard()
        }
    }

    private func leaderboardRow(rank: Int?, entry: LeaderboardEntry) -> some View {
        HStack(spacing: Theme.Space.s3) {
            // Rank
            Text(rank.map { "#\($0)" } ?? "\u{2014}")
                .font(.callout.bold())
                .foregroundColor(rank.map { rankColor($0) } ?? Theme.textSecondary)
                .frame(width: 36, alignment: .leading)

            // Username
            Text(entry.isPopulation ? "Population" : entry.username)
                .font(.callout.bold())
                .foregroundColor(Theme.textPrimary)
                .lineLimit(1)

            Spacer()

            // Primary stat
            VStack(alignment: .trailing, spacing: 2) {
                Text(formattedStat(entry))
                    .font(.callout.bold())
                    .foregroundColor(Theme.primary)
                Text("\(entry.gamesPlayed) games")
                    .font(.caption2)
                    .foregroundColor(Theme.textSecondary)
            }
        }
        .padding(.vertical, Theme.Space.s1)
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
        return Theme.medal(rank: rank) ?? Theme.textSecondary
    }
}

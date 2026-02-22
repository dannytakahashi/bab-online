import SwiftUI

struct TournamentScoreboardView: View {
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var tournamentState: TournamentState

    var body: some View {
        if tournamentState.scoreboard.isEmpty {
            EmptyView()
        } else {
            VStack(spacing: 0) {
                HStack {
                    Text("Scoreboard")
                        .font(.caption.bold())
                        .foregroundColor(Color.Theme.textSecondary)
                    Spacer()
                }
                .padding(.horizontal)
                .padding(.top, 12)
                .padding(.bottom, 4)

                // Header row
                HStack(spacing: 0) {
                    Text("Player")
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ForEach(1...tournamentState.totalRounds, id: \.self) { round in
                        Text("R\(round)")
                            .frame(width: 40)
                    }
                    Text("Total")
                        .frame(width: 50)
                        .bold()
                }
                .font(.caption)
                .foregroundColor(Color.Theme.textDim)
                .padding(.horizontal)
                .padding(.vertical, 4)

                // Score rows
                ForEach(Array(tournamentState.scoreboard.enumerated()), id: \.element.id) { index, entry in
                    let isCurrentUser = entry.username == authState.username
                    HStack(spacing: 0) {
                        HStack(spacing: 6) {
                            if tournamentState.phase == "complete" {
                                rankBadge(index: index)
                            }
                            Text(entry.username)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)

                        ForEach(0..<tournamentState.totalRounds, id: \.self) { round in
                            if round < entry.roundScores.count {
                                Text("\(entry.roundScores[round])")
                                    .frame(width: 40)
                            } else {
                                Text("-")
                                    .frame(width: 40)
                                    .foregroundColor(Color.Theme.textDim)
                            }
                        }

                        Text("\(entry.totalScore)")
                            .frame(width: 50)
                            .bold()
                    }
                    .font(.caption)
                    .foregroundColor(isCurrentUser ? Color.Theme.primary : Color.Theme.textPrimary)
                    .padding(.horizontal)
                    .padding(.vertical, 6)
                    .background(isCurrentUser ? Color.Theme.primary.opacity(0.1) : Color.clear)
                }
            }
            .background(Color.Theme.surface)
            .cornerRadius(10)
            .padding(.horizontal)
        }
    }

    @ViewBuilder
    private func rankBadge(index: Int) -> some View {
        switch index {
        case 0:
            Image(systemName: "medal.fill")
                .foregroundColor(Color(red: 1.0, green: 0.84, blue: 0.0))  // gold
                .font(.caption2)
        case 1:
            Image(systemName: "medal.fill")
                .foregroundColor(Color(white: 0.75))  // silver
                .font(.caption2)
        case 2:
            Image(systemName: "medal.fill")
                .foregroundColor(Color(red: 0.8, green: 0.5, blue: 0.2))  // bronze
                .font(.caption2)
        default:
            EmptyView()
        }
    }
}

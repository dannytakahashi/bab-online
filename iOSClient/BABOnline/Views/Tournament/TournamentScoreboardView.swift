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
                        .foregroundColor(Theme.textSecondary)
                    Spacer()
                }
                .padding(.horizontal)
                .padding(.top, Theme.Space.s3)
                .padding(.bottom, Theme.Space.s1)

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
                .foregroundColor(Theme.textDim)
                .padding(.horizontal)
                .padding(.vertical, Theme.Space.s1)

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
                                    .foregroundColor(Theme.textDim)
                            }
                        }

                        Text("\(entry.totalScore)")
                            .frame(width: 50)
                            .bold()
                    }
                    .font(.caption)
                    .foregroundColor(isCurrentUser ? Theme.primary : Theme.textPrimary)
                    .padding(.horizontal)
                    .padding(.vertical, 6)
                    .background(isCurrentUser ? Theme.primary.opacity(0.1) : Color.clear)
                }
            }
            .background(Theme.surface)
            .cornerRadius(Theme.Radius.md)
            .padding(.horizontal)
        }
    }

    @ViewBuilder
    private func rankBadge(index: Int) -> some View {
        switch index {
        case 0:
            Image(systemName: "medal.fill")
                .foregroundColor(Theme.medalGold)
                .font(.caption2)
        case 1:
            Image(systemName: "medal.fill")
                .foregroundColor(Theme.medalSilver)
                .font(.caption2)
        case 2:
            Image(systemName: "medal.fill")
                .foregroundColor(Theme.medalBronze)
                .font(.caption2)
        default:
            EmptyView()
        }
    }
}

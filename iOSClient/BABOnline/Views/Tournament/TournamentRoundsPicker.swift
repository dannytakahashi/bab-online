import SwiftUI

/// The host's "Rounds 1 2 3 4 5" control (owner 2026-11-25; iOS 1.2.7 (41); the web's
/// RoundsPicker.js), in the lobby header under "Waiting to start · N rounds" (owner 2026-11-26;
/// it was above Begin) in the lobby phase only (`TournamentRounds.showsPicker`:
/// it follows host hand-offs like Begin and Cancel and goes once the tournament begins). A
/// segmented control at the standard text sizes; at the accessibility sizes, where five
/// segments and the label leave each a letter wide, a menu reading "Rounds: 4". A pick shows at
/// once (the web does the same) and sends setTournamentRounds; the server's
/// tournamentSettingsUpdated then confirms it to everyone (a refusal comes as a toast, and the
/// next tournament state corrects the count). Disabled while the tournament's actions wait
/// (the session, a re-entry).
struct TournamentRoundsPicker: View {
    @EnvironmentObject var tournamentState: TournamentState
    @Environment(\.dynamicTypeSize) private var typeSize
    let enabled: Bool

    private var selection: Binding<Int> {
        Binding(get: { tournamentState.totalRounds }, set: { pick($0) })
    }

    private func pick(_ n: Int) {
        guard TournamentRounds.isCount(n), n != tournamentState.totalRounds else { return }
        tournamentState.totalRounds = n
        TournamentEmitter.setTournamentRounds(n)
        HapticManager.selection()
    }

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                Menu {
                    Picker("Rounds", selection: selection) {
                        ForEach(TournamentRounds.counts, id: \.self) { n in
                            Text(TournamentRounds.label(n)).tag(n)
                        }
                    }
                } label: {
                    HStack {
                        Text("Rounds: \(tournamentState.totalRounds)")
                            .font(.headline)
                        Spacer(minLength: Theme.Space.s2)
                        Image(systemName: "chevron.up.chevron.down")
                            .accessibilityHidden(true)
                    }
                    .foregroundColor(Theme.textPrimary)
                    .padding(.horizontal, Theme.Space.s3)
                    .frame(maxWidth: .infinity, minHeight: Theme.hitTarget)
                    .background(Theme.surface)
                    .cornerRadius(Theme.Radius.md)
                }
                .accessibilityLabel("Rounds")
                .accessibilityValue(TournamentRounds.label(tournamentState.totalRounds))
                .accessibilityHint("Choose how many rounds the tournament plays")
                .accessibilityIdentifier("tournament.rounds")
            } else {
                HStack(spacing: Theme.Space.s3) {
                    Text("Rounds")
                        .font(.subheadline.bold())
                        .foregroundColor(Theme.textSecondary)
                        .accessibilityHidden(true)
                    Picker("Rounds", selection: selection) {
                        ForEach(TournamentRounds.counts, id: \.self) { n in
                            Text("\(n)")
                                .accessibilityLabel(TournamentRounds.label(n))
                                .tag(n)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityLabel("Rounds")
                    .accessibilityIdentifier("tournament.rounds")
                }
            }
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.5)
    }
}

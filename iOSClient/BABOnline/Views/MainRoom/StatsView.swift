import SwiftUI

/// The main room's Stats sheet: the web's Leaderboard and Records pages as two tabs of one
/// sheet (a segmented control under the title), over a second segmented control for the games
/// counted (Humans / Bots / All, `StatsScope`: one choice for both tabs, saved on disk). Each
/// tab asks the server when it appears and when the scope changes, keeps its last good data on
/// screen while a refresh runs or after one fails, and refreshes on a pull. The close button is
/// the system's (a symbol, so it also sits in the Duo's vertical bar when the system puts the
/// sheet's toolbar there).
struct StatsView: View {
    @EnvironmentObject var leaderboardState: LeaderboardState
    @EnvironmentObject var recordsState: RecordsState
    @Environment(\.dismiss) private var dismiss

    /// The scope both tabs show (each state keeps its own copy for its requests).
    private var scope: Binding<StatsScope> {
        Binding(get: { leaderboardState.scope }, set: { s in
            leaderboardState.select(s)
            recordsState.select(s)
        })
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VStack(spacing: Theme.Space.s2) {
                    Picker("Stats", selection: $leaderboardState.tab) {
                        ForEach(StatsTab.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("stats.tabs")

                    Picker("Games", selection: scope) {
                        ForEach(StatsScope.allCases) { s in
                            Text(s.title).accessibilityLabel(s.spokenTitle).tag(s)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("stats.scope")
                }
                .padding(.horizontal)
                .padding(.vertical, Theme.Space.s2)
                .frame(maxWidth: 480)

                Divider().background(Theme.divider)

                Group {
                    switch leaderboardState.tab {
                    case .leaderboard: LeaderboardView()
                    case .records: RecordsView()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Stats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } }
            }
        }
        .sensoryFeedback(.selection, trigger: leaderboardState.tab)
        .sensoryFeedback(.selection, trigger: leaderboardState.scope)
    }
}

extension StatsScope {
    /// Under an empty Bots or All page: the server counts games with bots from its update on.
    static let botsFromNowNote = "Games with bots count from this update on."
}

/// The system close button (an xmark) where the SDK has it, else "Done".
private struct CloseButton: View {
    let action: () -> Void

    var body: some View {
        if #available(iOS 26.0, *) {
            Button(role: .close, action: action)
                .accessibilityIdentifier("stats.close")
        } else {
            Button("Done", action: action)
                .accessibilityIdentifier("stats.close")
        }
    }
}

// MARK: - Shared states

/// Waiting for the first answer.
struct StatsLoadingView: View {
    let label: String

    var body: some View {
        VStack(spacing: Theme.Space.s3) {
            ProgressView()
                .controlSize(.large)
                .tint(Theme.textSecondary)
            Text(label)
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("stats.loading")
    }
}

/// A full-page message: nothing yet, or nothing to show (a symbol, a title, a line, an action).
struct StatsMessageView: View {
    let symbol: String
    let title: String
    let message: String
    var actionTitle: String?
    var action: (() -> Void)?
    var identifier: String

    var body: some View {
        VStack(spacing: Theme.Space.s3) {
            Image(systemName: symbol)
                .font(.largeTitle)
                .foregroundStyle(Theme.textDim)
                .accessibilityHidden(true)
            Text(title)
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.center)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
            if let actionTitle, let action {
                Button(action: action) {
                    Text(actionTitle)
                        .font(.body.weight(.semibold))
                        .padding(.horizontal, Theme.Space.s5)
                        .padding(.vertical, Theme.Space.s2)
                        .frame(minHeight: 44)
                        .background(Theme.buttonBackground)
                        .foregroundStyle(Theme.buttonForeground)
                        .clipShape(Capsule())
                }
                .padding(.top, Theme.Space.s2)
            }
        }
        .padding(Theme.Space.s6)
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

extension StatsMessageView {
    /// The first request failed (no data to keep showing).
    static func failure(_ f: StatsFailure, what: String, retry: @escaping () -> Void) -> StatsMessageView {
        f.isRateLimited
            ? StatsMessageView(symbol: "hourglass", title: "Too Many Requests", message: "Please wait a moment, then try again.",
                               actionTitle: "Try Again", action: retry, identifier: "stats.rateLimited")
            : StatsMessageView(symbol: "exclamationmark.triangle", title: "Couldn't Load \(what)", message: f.message,
                               actionTitle: "Try Again", action: retry, identifier: "stats.error")
    }
}

/// A refresh failed while older data stays on screen: one line above it, with a retry.
struct StatsRefreshBanner: View {
    let failure: StatsFailure
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s2) {
            Image(systemName: failure.isRateLimited ? "hourglass" : "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.warning)
                .accessibilityHidden(true)
            Text(failure.isRateLimited ? "Too many requests. Showing the last update." : "Couldn't refresh: \(failure.message)")
                .font(.footnote)
                .foregroundStyle(Theme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Retry", action: retry)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.primary)
                .frame(minHeight: 44)
        }
        .padding(.horizontal, Theme.Space.s3)
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("stats.refreshError")
    }
}

import SwiftUI
import Combine

/// Another player's profile (the web's showPlayerProfilePage): the picture and name, Report
/// and Block / Unblock, and the same statistics as my own, for the games the Stats sheet
/// counts, then the badges they have earned. Opened from a chat line's long-press menu
/// ("View Profile"), a seat's avatar at the table and the online list (`playerProfileHost`).
/// A name with no account (a bot's) says so.
struct PlayerProfileView: View {
    /// The name asked for.
    let username: String

    @EnvironmentObject var profileState: ProfileState
    @EnvironmentObject var safetyState: SafetyState
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var leaderboardState: LeaderboardState
    @EnvironmentObject var recordsState: RecordsState
    @Environment(\.dismiss) private var dismiss

    @State private var reportTarget: String?
    @State private var confirmsBlock = false
    @State private var sheetId = UUID()

    /// The open profile, once this sheet asked for it.
    private var viewed: ProfileState.Viewed? {
        profileState.viewed.flatMap { $0.requested == username ? $0 : nil }
    }

    private var name: String { viewed?.displayName ?? username }

    /// One choice for the Stats sheet and both profiles, saved on disk (StatsScope).
    private var scope: Binding<StatsScope> {
        Binding(get: { leaderboardState.scope }, set: { s in
            leaderboardState.select(s)
            recordsState.select(s)
            profileState.requestViewed(scope: s)
        })
    }

    private var load: ProfileStatsLoad { viewed?.loads[leaderboardState.scope] ?? ProfileStatsLoad(isLoading: true) }

    /// The server knows no such account (a bot seat's name, a deleted or renamed account).
    private var notFound: Bool {
        viewed?.username == nil && load.failure?.message == ProfileState.playerNotFound
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Theme.Space.s4) {
                    hero
                    if notFound {
                        StatsMessageView(symbol: "person.slash", title: "No Profile",
                                         message: username.hasPrefix("🤖") ? "Bots don't have a profile." : "This player has no profile.",
                                         identifier: "profile.notFound")
                    } else {
                        if viewed?.username != nil && name != authState.username { safetyRow }
                        ProfileStatsSection(load: load, scope: scope) { profileState.requestViewed(scope: leaderboardState.scope) }
                            .padding(Theme.Space.s4)
                            .background(Theme.surface)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
                        // their earned badges, below the statistics as on the web (once a reply said them)
                        if let badges = viewed?.badges {
                            ProfileBadgesSection(badges: badges)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(Theme.Space.s4)
                                .background(Theme.surface)
                                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
                        }
                    }
                }
                .padding(Theme.Space.s4)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle(name)
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { SheetCloseButton(identifier: "profile.close") { dismiss() } }
            }
        }
        .accessibilityIdentifier("playerProfile")
        .onAppear {
            ProfileSheets.shared.opened(sheetId)
            profileState.view(username, scope: leaderboardState.scope)
        }
        .onDisappear {
            ProfileSheets.shared.closed(sheetId)
            profileState.closeViewed(username)
        }
        // the report prompt and the report / block feedback, presented from this sheet (the
        // surface under it cannot present while the sheet is up)
        .modifier(SafetyAlertsModifier(reportTarget: $reportTarget, reportContext: "player profile", insideProfile: true))
        .alert("Block \(name)?", isPresented: $confirmsBlock) {
            Button("Cancel", role: .cancel) {}
            Button("Block", role: .destructive) { SafetyEmitter.blockUser(username: name) }
        } message: {
            Text("You will no longer see their chat messages. You can unblock them from their profile or from Account settings.")
        }
    }

    private var hero: some View {
        VStack(spacing: Theme.Space.s3) {
            ProfileAvatarView(pictureKey: viewed?.pictureKey, placeholder: String(name.prefix(1)).uppercased())
                .frame(width: 112, height: 112)
                .accessibilityLabel("\(name)'s profile picture")
                .accessibilityAddTraits(.isImage)
            Text(name)
                .font(.title2.bold())
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("profile.name")
        }
        .frame(maxWidth: .infinity)
        .padding(Theme.Space.s4)
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }

    /// Report | Block (side by side; stacked where they do not fit, e.g. the largest text sizes).
    private var safetyRow: some View {
        let blocked = safetyState.isBlocked(name)
        let layout = ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Space.s3) { safetyButtons(blocked) }
            VStack(spacing: Theme.Space.s2) { safetyButtons(blocked) }
        }
        return layout
    }

    @ViewBuilder
    private func safetyButtons(_ blocked: Bool) -> some View {
        safetyButton("Report", symbol: "exclamationmark.bubble", tone: Theme.warning, id: "profile.report") {
            reportTarget = name
        }
        safetyButton(blocked ? "Unblock" : "Block", symbol: blocked ? "hand.raised.slash" : "hand.raised",
                     tone: blocked ? Theme.textPrimary : Theme.error, id: "profile.block") {
            if blocked { SafetyEmitter.unblockUser(username: name) } else { confirmsBlock = true }
        }
    }

    private func safetyButton(_ title: String, symbol: String, tone: Color, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.body.weight(.semibold))
                .lineLimit(1)
                .padding(.horizontal, Theme.Space.s4)
                .frame(maxWidth: .infinity, minHeight: Theme.hitTarget)
                .foregroundStyle(tone)
                .background(Theme.buttonSecondary)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).stroke(Theme.buttonSecondaryBorder, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }
}

// MARK: - Opening a profile

/// A player whose profile sheet is up.
struct ProfileTarget: Identifiable, Equatable {
    let username: String
    var id: String { username }
}

private struct ViewPlayerProfileKey: EnvironmentKey {
    static let defaultValue: ((String) -> Void)? = nil
}

extension EnvironmentValues {
    /// Opens a player's profile on the nearest `playerProfileHost`; nil where there is none.
    var viewPlayerProfile: ((String) -> Void)? {
        get { self[ViewPlayerProfileKey.self] }
        set { self[ViewPlayerProfileKey.self] = newValue }
    }
}

/// Whether a player profile sheet is up, for the alert hosts under it (SafetyAlertsModifier).
/// Each sheet is counted by its own id, and a change of screen (the game ends, a sign-out, a
/// forced logout: the sheet's presenter goes away, perhaps without its onDisappear) forgets
/// them all, so a sheet that never said it closed cannot hold the alerts back for good.
final class ProfileSheets: ObservableObject {
    static let shared = ProfileSheets()
    @Published private(set) var open: Set<UUID> = []
    var isUp: Bool { !open.isEmpty }

    func opened(_ id: UUID) { open.insert(id) }
    func closed(_ id: UUID) { open.remove(id) }
    /// The screen changed: no sheet of the old screen is up any more.
    func screenChanged() { if !open.isEmpty { open = [] } }
}

/// A tap on a seat's avatar at the table (GameSKScene+SeatTap), for the table's profile host.
enum SeatTaps {
    static let subject = PassthroughSubject<String, Never>()
}

/// Presents PlayerProfileView as a sheet for the views inside it (`viewPlayerProfile`), and,
/// at the table, for a tapped seat avatar.
struct PlayerProfileHost: ViewModifier {
    var seatTaps = false
    @State private var target: ProfileTarget?

    func body(content: Content) -> some View {
        content
            .environment(\.viewPlayerProfile, { name in
                guard !name.isEmpty else { return }
                target = ProfileTarget(username: name)
            })
            .onReceive(SeatTaps.subject) { name in
                if seatTaps, target == nil, !name.isEmpty { target = ProfileTarget(username: name) }
            }
            .sheet(item: $target) { t in
                PlayerProfileView(username: t.username)
            }
    }
}

extension View {
    /// Hosts the player profile sheet for this surface (`seatTaps`: the table's seat avatars too).
    func playerProfileHost(seatTaps: Bool = false) -> some View {
        modifier(PlayerProfileHost(seatTaps: seatTaps))
    }
}

import SwiftUI

/// The main room's Players sheet (owner 2026-11-27: the web's Players page on iOS), opened by
/// the header's "N online" and the vertical bar's people item. A search field at the top
/// (PlayerSearchState: search as you type, as the web's PlayerSearchPage); with nothing typed
/// it lists who is online, as the old Online Players sheet did. A row opens that player's
/// profile (`playerProfileHost`); my own name is just my name (my profile is in Account).
struct PlayersSheet: View {
    @EnvironmentObject var mainRoomState: MainRoomState
    @EnvironmentObject var authState: AuthState
    @ObservedObject private var search = PlayerSearchState.shared
    @Environment(\.dismiss) private var dismiss

    static let prompt = "Type a username..."

    private var text: Binding<String> {
        Binding(get: { search.text }, set: { search.setText($0) })
    }

    var body: some View {
        NavigationStack {
            List {
                content
            }
            .listStyle(.plain)
            .background(Theme.background)
            .scrollContentBackground(.hidden)
            .accessibilityIdentifier("players.list")
            .searchable(text: text, placement: .navigationBarDrawer(displayMode: .always), prompt: Self.prompt)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .onSubmit(of: .search) { search.submit() }
            .navigationTitle("Players")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .barTrailing) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("players.done")
                }
            }
        }
        .accessibilityIdentifier("players.sheet")
        .onDisappear { search.reset() }
        // a row opens that player's profile (iOS 1.2.2)
        .playerProfileHost()
    }

    @ViewBuilder
    private var content: some View {
        switch search.phase {
        case .idle:
            let rows = PlayerSearchState.onlineRows(mainRoomState.onlineUsers, me: authState.username)
            Section {
                ForEach(rows) { PlayerRow(row: $0) }
            } header: {
                Text("Online now \u{00B7} \(rows.count)")
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("players.onlineHeader")
            }
        case .searching:
            if search.showsProgress {
                HStack(spacing: Theme.Space.s2) {
                    ProgressView()
                    Text("Searching\u{2026}")
                        .foregroundStyle(Theme.textSecondary)
                }
                .listRowBackground(Color.clear)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("players.searching")
            }
        case .results(let results):
            if results.isEmpty {
                quietLine("No players found", id: "players.noResults")
            } else {
                Section {
                    ForEach(PlayerSearchState.resultRows(results, online: mainRoomState.onlineUsers, me: authState.username)) {
                        PlayerRow(row: $0)
                    }
                }
            }
        case .unavailable(let line):
            quietLine(line, id: "players.unavailable")
        }
    }

    private func quietLine(_ text: String, id: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(Theme.textSecondary)
            .listRowBackground(Color.clear)
            .accessibilityIdentifier(id)
    }
}

/// One player: avatar (search results), name and a small online dot; a button that opens their
/// profile, except my own name.
private struct PlayerRow: View {
    let row: PlayerSearchState.Row
    @Environment(\.viewPlayerProfile) private var viewProfile
    @ScaledMetric(relativeTo: .body) private var avatar: CGFloat = 32
    @ScaledMetric(relativeTo: .body) private var dot: CGFloat = 8

    var body: some View {
        if row.isMe || viewProfile == nil {
            label(chevron: false)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(row.spokenLabel)
        } else {
            Button { viewProfile?(row.username) } label: {
                label(chevron: true)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(row.spokenLabel)
            .accessibilityHint("Opens their profile")
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier(row.pictureKey == nil ? "online.\(row.username)" : "players.result.\(row.username)")
        }
    }

    private func label(chevron: Bool) -> some View {
        HStack(spacing: Theme.Space.s3) {
            if let key = row.pictureKey {
                AvatarImageView(pictureKey: key, name: row.username)
                    .frame(width: avatar, height: avatar)
            }
            Text(row.username)
                .foregroundColor(Theme.textPrimary)
                .lineLimit(2)
            if row.isOnline && row.pictureKey != nil {
                // the online dot (the online list itself needs none)
                Circle()
                    .fill(Theme.success)
                    .frame(width: dot, height: dot)
            }
            Spacer(minLength: 0)
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundColor(Theme.textDim)
            }
        }
        .frame(minHeight: 44)
    }
}

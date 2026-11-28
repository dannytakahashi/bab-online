import SwiftUI

/// The main room's Players sheet (owner 2026-11-27: the web's Players page on iOS), opened by
/// the header's "N online" and the vertical bar's people item. A search field at the top
/// (PlayerSearchState: search as you type, as the web's PlayerSearchPage); with nothing typed
/// it lists who is online, as the old Online Players sheet did, each row with its picture
/// (PlayerSearchState's player cards; the initial until a card is known). A row opens that
/// player's profile (`playerProfileHost`); my own name is just my name (my profile is in Account).
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
            #if DEBUG
            .overlay(alignment: .topLeading) {
                PlayerCardsProbe.Dots(pictures: PlayerSearchState.onlineRows(mainRoomState.onlineUsers, me: authState.username, cards: search.cards)
                    .map { "\($0.username):\($0.pictureKey ?? "-")" }.joined(separator: ","))
            }
            #endif
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
        // the online list's pictures: every listed card on open, a joiner's after the pause
        .onAppear { search.sheetOpened(online: mainRoomState.onlineUsers) }
        .onChange(of: mainRoomState.onlineUsers) { _, online in search.onlineChanged(online) }
        // a reconnect while the sheet is up: the names whose answer never came are asked again
        // (a publisher, not an observed SocketService, so its other changes never redraw the list)
        .onReceive(SocketService.shared.$isSessionReady.removeDuplicates().dropFirst()) { ready in
            if ready { search.sessionRestored() }
        }
        .onDisappear { search.reset() }
        // a row opens that player's profile (iOS 1.2.2)
        .playerProfileHost()
    }

    @ViewBuilder
    private var content: some View {
        switch search.phase {
        case .idle:
            let rows = PlayerSearchState.onlineRows(mainRoomState.onlineUsers, me: authState.username, cards: search.cards)
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
                .listRowSeparator(.hidden)
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
            // a quiet line, not an empty table cell
            .listRowSeparator(.hidden)
            .accessibilityIdentifier(id)
    }
}

/// One player: avatar, name and (a search result) a small online dot; a button that opens their
/// profile, except my own name, which is marked "You" (as the web's Players page). An online
/// row is laid out as a result row, its avatar the name's initial until the player's card is
/// known (the same size, so nothing moves when the picture comes). At accessibility sizes the
/// avatar goes above the name, so a long name has the row's width and is never cut.
private struct PlayerRow: View {
    let row: PlayerSearchState.Row
    @Environment(\.viewPlayerProfile) private var viewProfile
    @Environment(\.dynamicTypeSize) private var typeSize
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
            .accessibilityIdentifier(row.inOnlineList ? "online.\(row.username)" : "players.result.\(row.username)")
        }
    }

    private func label(chevron: Bool) -> some View {
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Theme.Space.s2) {
                    HStack(spacing: Theme.Space.s3) {
                        avatarView
                        onlineDot
                        Spacer(minLength: 0)
                        chevronView(chevron)
                    }
                    name
                }
            } else {
                HStack(spacing: Theme.Space.s3) {
                    avatarView
                    name
                    onlineDot
                    Spacer(minLength: 0)
                    chevronView(chevron)
                }
            }
        }
        .frame(minHeight: 44)
    }

    /// The search results' avatar; on an online row with no card yet, its initial (AvatarImageView
    /// with no key), which the picture replaces in place.
    private var avatarView: some View {
        AvatarImageView(pictureKey: row.pictureKey, name: row.username)
            .frame(width: avatar, height: avatar)
    }

    /// The name (whole at accessibility sizes), and "You" on my own row.
    private var name: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s2) {
            Text(row.username)
                .foregroundColor(Theme.textPrimary)
                .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
            if row.isMe {
                Text("You")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize()
            }
        }
    }

    /// The online dot on a result (the online list itself needs none).
    @ViewBuilder
    private var onlineDot: some View {
        if row.isOnline && !row.inOnlineList {
            Circle()
                .fill(Theme.success)
                .frame(width: dot, height: dot)
        }
    }

    @ViewBuilder
    private func chevronView(_ shown: Bool) -> some View {
        if shown {
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundColor(Theme.textDim)
        }
    }
}

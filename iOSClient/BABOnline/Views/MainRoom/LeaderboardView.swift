import SwiftUI

/// The Stats sheet's Leaderboard tab: the web LeaderboardPage's rows, columns, formats and
/// sort (LeaderboardColumn / LeaderboardSort), with avatars. Where the eight columns fit
/// (the iPad, at most xxxLarge type) it is the web's table with sortable headers and a
/// header pinned on scroll; elsewhere (phones, the Duo, large type) a list whose rows show
/// the sorted stat and expand to all eight, sorted from a menu. Rows on surface.s1, the
/// population row on surface.s2 (the web's .lb-row--population), medal ranks 1-3.
struct LeaderboardView: View {
    @EnvironmentObject var state: LeaderboardState
    @EnvironmentObject var authState: AuthState
    @Environment(\.dynamicTypeSize) private var typeSize
    /// The sort and the expanded rows live on the state, so a tab switch (which rebuilds this
    /// view) keeps them for the session, like the tab itself.
    private var sort: LeaderboardSort { state.sort }

    @ScaledMetric(relativeTo: .subheadline) private var statWidth: CGFloat = 66
    @ScaledMetric(relativeTo: .subheadline) private var rankWidth: CGFloat = 32
    @ScaledMetric(relativeTo: .subheadline) private var playerMinWidth: CGFloat = 130

    /// The table's narrowest width: rank, player, the eight columns, the row padding.
    private var tableMinWidth: CGFloat {
        rankWidth + playerMinWidth + statWidth * CGFloat(LeaderboardColumn.allCases.count) + Theme.Space.s4 * 2 + Theme.Space.s2 * 2
    }

    /// A stat column's width in the table: the extra room beyond a 240 pt player column is
    /// shared by the eight columns, up to 1.5 times their minimum.
    private func columnWidth(_ width: CGFloat) -> CGFloat {
        let fixed = rankWidth + max(playerMinWidth, 240) + Theme.Space.s4 * 2 + Theme.Space.s2 * 2
        let share = (width - fixed) / CGFloat(LeaderboardColumn.allCases.count)
        return min(max(statWidth, share), statWidth * 1.5)
    }

    var body: some View {
        GeometryReader { geo in
            content(table: geo.size.width >= tableMinWidth && typeSize <= .xxxLarge, column: columnWidth(geo.size.width))
        }
        .onAppear { state.request() }
        .sensoryFeedback(.selection, trigger: state.sort)
    }

    @ViewBuilder
    private func content(table: Bool, column: CGFloat) -> some View {
        switch state.load.display {
        case .loading:
            StatsLoadingView(label: "Loading leaderboard")
        case .failed(let f):
            refreshable {
                StatsMessageView.failure(f, what: "Leaderboard") { state.request() }
            }
        case .content:
            if state.entries.isEmpty {
                refreshable {
                    StatsMessageView(symbol: "chart.bar", title: "No Players Yet",
                                     message: "No players have completed games yet.", identifier: "stats.empty")
                }
            } else {
                rows(table: table, column: column)
            }
        }
    }

    /// A pull-to-refresh scroll view the size of the page around a message.
    private func refreshable<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        let page = content()
        return GeometryReader { geo in
            ScrollView {
                page.frame(minHeight: geo.size.height)
            }
            .refreshable { await state.refresh() }
        }
    }

    private func rows(table: Bool, column: CGFloat) -> some View {
        let sorted = sort.sorted(state.entries)
        return ScrollView {
            LazyVStack(spacing: 0, pinnedViews: pinsHeader(table: table) ? [.sectionHeaders] : []) {
                Section {
                    if let failure = state.load.failure, !state.load.isLoading {
                        StatsRefreshBanner(failure: failure) { state.request() }
                            .padding(.horizontal, Theme.Space.s4)
                            .padding(.vertical, Theme.Space.s2)
                    }
                    VStack(spacing: 0) {
                        ForEach(Array(sorted.enumerated()), id: \.element.id) { index, entry in
                            let rank = LeaderboardEntry.rank(at: index, in: sorted)
                            Group {
                                if table {
                                    tableRow(entry, rank: rank, column: column)
                                } else {
                                    listRow(entry, rank: rank)
                                }
                            }
                            .background(entry.isPopulation ? Theme.surfaceLight : Theme.surface)
                            if index < sorted.count - 1 { Divider().background(Theme.divider) }
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).stroke(Theme.divider, lineWidth: 1))
                    .padding(.horizontal, Theme.Space.s4)
                    .padding(.bottom, Theme.Space.s6)
                } header: {
                    Group {
                        if table { tableHeader(column: column) } else { sortBar }
                    }
                    .background(Theme.background)
                }
            }
            .padding(.top, Theme.Space.s2)
        }
        .refreshable { await state.refresh() }
        .accessibilityIdentifier("leaderboard.list")
    }

    /// The table's headers and the sort bar stay on top while the rows scroll, except at
    /// accessibility sizes, where the bar is a tenth of a phone screen: it scrolls away there.
    private func pinsHeader(table: Bool) -> Bool {
        table || !typeSize.isAccessibilitySize
    }

    private func isMe(_ e: LeaderboardEntry) -> Bool {
        !e.isPopulation && !authState.username.isEmpty && e.username == authState.username
    }

    // MARK: - Table (regular width)

    private func tableHeader(column width: CGFloat) -> some View {
        HStack(spacing: 0) {
            // the web's header row: every label in caps ("# PLAYER GAMES WIN % ...")
            Text("#")
                .frame(width: rankWidth)
                .accessibilityHidden(true)
            Text("Player".uppercased())
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityHidden(true)
            ForEach(LeaderboardColumn.allCases) { column in
                headerButton(column)
                    .frame(width: width)
            }
        }
        .font(.caption.weight(.bold))
        .foregroundStyle(Theme.textSecondary)
        // inside its s4 inset (below) the row's own s2, so each label sits over its column
        .padding(.horizontal, Theme.Space.s2)
        .frame(minHeight: 44)
        .background(Theme.surface)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.inputBorder).frame(height: 2) }
        .padding(.horizontal, Theme.Space.s4)
    }

    private func headerButton(_ column: LeaderboardColumn) -> some View {
        let active = sort.column == column
        return Button {
            state.sort.select(column)
        } label: {
            HStack(spacing: 2) {
                Text(column.title.uppercased())
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.8)
                if active {
                    Image(systemName: sort.ascending ? "chevron.up" : "chevron.down")
                        .font(.caption2.weight(.bold))
                }
            }
            .foregroundStyle(active ? Theme.primary : Theme.textSecondary)
            .padding(.horizontal, 2)
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(column.spokenTitle)
        .accessibilityValue(active ? (sort.ascending ? "Sorted ascending" : "Sorted descending") : "")
        .accessibilityHint(active ? "Reverses the order" : "Sorts by this column")
        .accessibilityAddTraits(active ? [.isSelected] : [])
        .accessibilityIdentifier("leaderboard.sort.\(column.rawValue)")
    }

    private func tableRow(_ e: LeaderboardEntry, rank: Int?, column width: CGFloat) -> some View {
        HStack(spacing: 0) {
            RankLabel(rank: rank)
                .frame(width: rankWidth)
            PlayerLabel(entry: e, isMe: isMe(e))
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(LeaderboardColumn.allCases) { column in
                Text(column.format(e))
                    .font(.subheadline.weight(e.isPopulation || sort.column == column ? .bold : .regular))
                    .monospacedDigit()
                    .foregroundStyle(sort.column == column && !e.isPopulation ? Theme.primary : Theme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .frame(width: width)
            }
        }
        .padding(.horizontal, Theme.Space.s2)
        .padding(.vertical, Theme.Space.s2)
        .frame(minHeight: 44)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spokenName(e, rank: rank))
        .accessibilityValue(LeaderboardColumn.allCases.map { "\($0.spokenTitle) \($0.format(e))" }.joined(separator: ", "))
        .accessibilityIdentifier("leaderboard.row.\(e.isPopulation ? "population" : e.username)")
    }

    // MARK: - List (compact width, large type)

    private var sortBar: some View {
        HStack(spacing: Theme.Space.s2) {
            Text("Sort by")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
            Menu {
                ForEach(LeaderboardColumn.allCases) { column in
                    Button {
                        state.sort.select(column)
                    } label: {
                        if sort.column == column {
                            Label(column.title, systemImage: sort.ascending ? "arrow.up" : "arrow.down")
                        } else {
                            Text(column.title)
                        }
                    }
                }
            } label: {
                HStack(spacing: Theme.Space.s1) {
                    Text(sort.column.title)
                        .font(.subheadline.weight(.semibold))
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption.weight(.semibold))
                        .accessibilityHidden(true)
                }
                .foregroundStyle(Theme.primary)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Sort by")
            .accessibilityValue(sort.column.spokenTitle)
            .accessibilityIdentifier("leaderboard.sortMenu")

            Spacer(minLength: 0)

            Button {
                state.sort.ascending.toggle()
            } label: {
                Image(systemName: sort.ascending ? "arrow.up" : "arrow.down")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.primary)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Sort order")
            .accessibilityValue(sort.ascending ? "Ascending" : "Descending")
            .accessibilityHint("Reverses the order")
            .accessibilityIdentifier("leaderboard.sortOrder")
        }
        .padding(.horizontal, Theme.Space.s4)
        .padding(.bottom, Theme.Space.s2)
    }

    private func listRow(_ e: LeaderboardEntry, rank: Int?) -> some View {
        let open = state.expanded.contains(e.id)
        let column = sort.column
        // a second stat under the name: games, or the win rate when sorted by games
        let second: LeaderboardColumn = column == .gamesPlayed ? .winRate : .gamesPlayed
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: Theme.Motion.base)) {
                    if open { state.expanded.remove(e.id) } else { state.expanded.insert(e.id) }
                }
            } label: {
                Group {
                    if typeSize.isAccessibilitySize {
                        // accessibility sizes: the stats under the name, never squeezed beside it
                        VStack(alignment: .leading, spacing: Theme.Space.s1) {
                            HStack(spacing: Theme.Space.s3) {
                                RankLabel(rank: rank)
                                PlayerLabel(entry: e, isMe: isMe(e), lineLimit: 2)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                chevron(open)
                            }
                            Text("\(column.title) \(column.format(e))")
                                .font(.headline)
                                .foregroundStyle(e.isPopulation ? Theme.textPrimary : Theme.primary)
                            Text("\(second.title) \(second.format(e))")
                                .font(.subheadline)
                                .foregroundStyle(e.isPopulation ? Theme.textSecondary : Theme.textDim)
                        }
                    } else {
                        HStack(spacing: Theme.Space.s3) {
                            RankLabel(rank: rank)
                                .frame(minWidth: rankWidth * 0.8)
                            VStack(alignment: .leading, spacing: 2) {
                                PlayerLabel(entry: e, isMe: isMe(e))
                                Text("\(second.title) \(second.format(e))")
                                    .font(.caption)
                                    .foregroundStyle(e.isPopulation ? Theme.textSecondary : Theme.textDim)
                                    .padding(.leading, avatarIndent)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(column.format(e))
                                    .font(.headline)
                                    .monospacedDigit()
                                    .foregroundStyle(e.isPopulation ? Theme.textPrimary : Theme.primary)
                                Text(column.title)
                                    .font(.caption2)
                                    .foregroundStyle(e.isPopulation ? Theme.textSecondary : Theme.textDim)
                            }
                            chevron(open)
                        }
                    }
                }
                .padding(.horizontal, Theme.Space.s3)
                .padding(.vertical, Theme.Space.s2)
                .frame(minHeight: 52)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spokenName(e, rank: rank))
            .accessibilityValue("\(column.spokenTitle) \(column.format(e)), \(second.spokenTitle) \(second.format(e))")
            .accessibilityHint(open ? "Hides the other stats" : "Shows all stats")
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("leaderboard.row.\(e.isPopulation ? "population" : e.username)")

            if open {
                StatGrid(entry: e, sorted: column)
                    .padding(.horizontal, Theme.Space.s3)
                    .padding(.bottom, Theme.Space.s3)
                    .transition(.opacity)
            }
        }
    }

    @ScaledMetric(relativeTo: .subheadline) private var avatarIndent: CGFloat = 28 + 8

    private func chevron(_ open: Bool) -> some View {
        Image(systemName: "chevron.down")
            .font(.caption.weight(.semibold))
            .foregroundStyle(Theme.textSecondary)
            .rotationEffect(.degrees(open ? 180 : 0))
            .accessibilityHidden(true)
    }

    private func spokenName(_ e: LeaderboardEntry, rank: Int?) -> String {
        if e.isPopulation { return "Population average" }
        let r = rank.map { "Rank \($0), " } ?? ""
        return r + e.username + (isMe(e) ? ", you" : "")
    }
}

/// Every column of one row (the expanded list row): the web's labels, the sorted one in primary.
private struct StatGrid: View {
    let entry: LeaderboardEntry
    let sorted: LeaderboardColumn
    @ScaledMetric(relativeTo: .subheadline) private var cellWidth: CGFloat = 76

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: cellWidth), spacing: Theme.Space.s2)], spacing: Theme.Space.s2) {
            ForEach(LeaderboardColumn.allCases) { c in
                VStack(spacing: 2) {
                    Text(c.format(entry))
                        .font(.subheadline.weight(.bold))
                        .monospacedDigit()
                        // primary on surface.s2 is a contrast pair; the population's cells are s3
                        .foregroundStyle(c == sorted && !entry.isPopulation ? Theme.primary : Theme.textPrimary)
                    Text(c.title)
                        .font(.caption2)
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Space.s2)
                .background(entry.isPopulation ? Theme.surfaceRaised : Theme.surfaceLight)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(c.spokenTitle) \(c.format(entry))")
            }
        }
        .accessibilityIdentifier("leaderboard.details.\(entry.isPopulation ? "population" : entry.username)")
    }
}

/// "1", "2", "3" in medal colors, the rest secondary, "—" for the population row (unranked).
private struct RankLabel: View {
    let rank: Int?

    var body: some View {
        Text(rank.map(String.init) ?? "\u{2014}")
            .font(.subheadline.weight(.bold))
            .monospacedDigit()
            .foregroundStyle(rank.flatMap { Theme.medal(rank: $0) } ?? (rank == nil ? Theme.textDim : Theme.textSecondary))
            .lineLimit(1)
            .minimumScaleFactor(0.6)
    }
}

/// The avatar (the seats' loader: stock art or the `/avatar/` URL, else the initial) and the
/// name; the population row shows a group symbol and "Population" in bold.
private struct PlayerLabel: View {
    let entry: LeaderboardEntry
    let isMe: Bool
    var lineLimit = 1
    @ScaledMetric(relativeTo: .subheadline) private var avatar: CGFloat = 28

    var body: some View {
        HStack(spacing: Theme.Space.s2) {
            if entry.isPopulation {
                Circle()
                    .fill(Theme.surfaceRaised)
                    .overlay(Image(systemName: "person.3.fill").font(.system(size: avatar * 0.38)).foregroundStyle(Theme.textSecondary))
                    .frame(width: avatar, height: avatar)
            } else {
                AvatarImageView(pictureKey: entry.pictureKey, name: entry.username)
                    .frame(width: avatar, height: avatar)
                    .overlay(Circle().strokeBorder(isMe ? Theme.primary : Theme.inputBorder, lineWidth: isMe ? 2 : 1))
            }
            Text(entry.isPopulation ? "Population" : entry.username)
                .font(.subheadline.weight(entry.isPopulation || isMe ? .bold : .semibold))
                .foregroundStyle(isMe ? Theme.primary : Theme.textPrimary)
                .lineLimit(lineLimit)
                .truncationMode(.tail)
        }
        .accessibilityHidden(true)
    }
}

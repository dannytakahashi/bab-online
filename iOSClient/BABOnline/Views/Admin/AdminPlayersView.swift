import SwiftUI

/// Players: every account (the web's table as a list: the name with its state chips, then
/// created / last seen and games / bot games, or what a tombstone is), filtered as you type
/// and sorted by the web's columns. Each row's More menu holds its actions, the
/// destructive ones last; a tombstone offers only what applies to it.
struct AdminPlayersView: View {
    @ObservedObject var admin: AdminState
    @Environment(\.dynamicTypeSize) private var typeSize

    @State private var confirm: AdminPendingConfirm?
    @State private var typed: TypedPrompt?
    @State private var renaming: AdminPlayer?

    /// A typed confirmation for one row.
    private struct TypedPrompt: Identifiable {
        let player: AdminPlayer
        let spec: AdminTypedConfirm
        var id: String { player.username }
    }

    var body: some View {
        List {
            Section {
                filterRow
                sortRow
                if let roster = admin.roster {
                    if let cap = AdminCopy.capNote(roster) {
                        Text(cap)
                            .font(.footnote)
                            .foregroundStyle(Theme.warning)
                            .accessibilityIdentifier("admin.players.cap")
                    }
                    Text(AdminCopy.countLine(shown: admin.shownPlayers.count, roster: roster, query: admin.playerFilter))
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                        .accessibilityIdentifier("admin.players.count")
                }
            }
            .listRowBackground(Theme.surface)

            Section {
                if admin.roster == nil {
                    AdminPlaceholderRow(loading: admin.inFlight > 0, text: "No list yet. Pull down to load it.")
                } else if admin.shownPlayers.isEmpty {
                    Text(AdminCopy.emptyPlayers(query: admin.playerFilter))
                        .foregroundStyle(Theme.textDim)
                        .accessibilityIdentifier("admin.players.empty")
                } else {
                    ForEach(admin.shownPlayers) { row($0) }
                }
            }
            .listRowBackground(Theme.surface)
        }
        .adminListStyle()
        .refreshable { await admin.loadPlayers() }
        .adminConfirm($confirm)
        .sheet(item: $typed) { prompt in
            AdminTypedConfirmSheet(spec: prompt.spec) { await admin.submitDelete(prompt.player, typed: $0) }
        }
        .sheet(item: $renaming, onDismiss: { Task { await admin.renameSheetClosed() } }) { player in
            AdminRenameSheet(oldName: player.username) { newName, again in
                await admin.submitRename(player, newName: newName, confirm: again)
            }
        }
    }

    // MARK: Filter and sort

    private var filterRow: some View {
        HStack(spacing: Theme.Space.s2) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Theme.textDim)
                .accessibilityHidden(true)
            TextField("Part of a name", text: $admin.playerFilter)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(Theme.textPrimary)
                .accessibilityLabel("Filter by name")
                .accessibilityIdentifier("admin.players.filter")
            if !admin.playerFilter.isEmpty {
                Button { admin.playerFilter = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.textDim)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Clear the filter")
            }
        }
        .frame(minHeight: 36)
    }

    /// One row; at accessibility sizes two (the sorted column's name needs the width).
    @ViewBuilder
    private var sortRow: some View {
        if typeSize.isAccessibilitySize {
            sortMenu
            HStack(spacing: Theme.Space.s3) {
                sortOrder
                Spacer(minLength: 0)
                refresh
            }
            .tint(Theme.primary)
        } else {
            HStack(spacing: Theme.Space.s3) {
                sortMenu
                sortOrder
                Spacer(minLength: 0)
                refresh
            }
            .tint(Theme.primary)
        }
    }

    private var sortMenu: some View {
        Menu {
            ForEach(AdminPlayerColumn.allCases) { column in
                Button { admin.playerSort = admin.playerSort.choosing(column) } label: {
                    if admin.playerSort.column == column {
                        Label(column.label, systemImage: admin.playerSort.ascending ? "chevron.up" : "chevron.down")
                    } else {
                        Text(column.label)
                    }
                }
            }
        } label: {
            Label(typeSize.isAccessibilitySize ? admin.playerSort.column.label : "Sort: \(admin.playerSort.column.label)",
                  systemImage: "arrow.up.arrow.down")
                .font(.subheadline)
                .foregroundStyle(Theme.primary)
                .frame(minHeight: 36)
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Sort: \(admin.playerSort.column.label)")
        .accessibilityIdentifier("admin.players.sortMenu")
    }

    private var sortOrder: some View {
        Button { admin.playerSort.ascending.toggle() } label: {
            Image(systemName: admin.playerSort.ascending ? "arrow.up" : "arrow.down")
                .frame(minWidth: 36, minHeight: 36)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(admin.playerSort.ascending ? "Ascending" : "Descending")
        .accessibilityHint("Reverses the order")
        .accessibilityIdentifier("admin.players.sortOrder")
    }

    private var refresh: some View {
        Button("Refresh") { Task { await admin.loadPlayers() } }
            .buttonStyle(.borderless)
            .font(.subheadline)
            .lineLimit(1)
            .accessibilityIdentifier("admin.players.refresh")
    }

    // MARK: Rows

    private func row(_ p: AdminPlayer) -> some View {
        HStack(alignment: .center, spacing: Theme.Space.s2) {
            VStack(alignment: .leading, spacing: Theme.Space.s1) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Theme.Space.s2) { name(p); chips(p) }
                    VStack(alignment: .leading, spacing: Theme.Space.s1) {
                        name(p)
                        HStack(spacing: Theme.Space.s2) { chips(p) }
                    }
                }
                if let note = AdminCopy.tombstoneNote(p) {
                    Text("Created \(AdminDates.day(p.createdAt))")
                    Text(note).foregroundStyle(Theme.warning)
                } else {
                    Text("Created \(AdminDates.day(p.createdAt)) · Last seen \(AdminCopy.lastSeen(p))")
                    Text("Games \(p.gamesPlayed) · Bot games \(p.botGamesPlayed)")
                }
            }
            .font(.footnote)
            .foregroundStyle(Theme.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("admin.player.\(p.username)")

            Menu {
                menuItems(p)
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
                    .foregroundStyle(Theme.primary)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .menuOrder(.fixed)
            // a reset link is on its way: nothing else may take the place of its sheet
            .disabled(admin.makingLink)
            .accessibilityLabel("More actions: \(p.username)")
            .accessibilityIdentifier("admin.player.menu.\(p.username)")
        }
        .opacity(p.isTombstone ? 0.75 : 1)
    }

    private func name(_ p: AdminPlayer) -> some View {
        Text(p.username)
            .font(.body.weight(.semibold))
            .foregroundStyle(Theme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func chips(_ p: AdminPlayer) -> some View {
        if admin.isSelf(p.username) { AdminChip(text: "you") }
        if p.online { AdminChip(text: "online", tone: .success) }
        if p.isAdmin { AdminChip(text: "admin", tone: .gold) }
        if !p.isTombstone, p.renameUnfinished != nil { AdminChip(text: "rename unfinished", tone: .gold) }
    }

    @ViewBuilder
    private func menuItems(_ p: AdminPlayer) -> some View {
        if let kept = p.mergedInto {
            if !p.isHeldName {
                Button("Show \(kept)") { admin.showPlayer(kept) }
            }
            Button(p.isHeldName ? "Free name…" : "Delete…", role: .destructive) { askDelete(p) }
        } else {
            if let from = p.renameUnfinished {
                Button("Finish rename") {
                    confirm = AdminPendingConfirm(spec: AdminCopy.finishRenameConfirm(from: from, to: p.username)) {
                        await admin.finishRename(p)
                    }
                }
            }
            Button("Reset link") { Task { await admin.createResetLink(p.username) } }
            Button("Rename…") { if admin.canRename(p) { renaming = p } }
            if !p.isAdmin {
                Button("Make admin…") { askAdmin(p, make: true) }
            }
            Divider()
            Button("Sign out everywhere…", role: .destructive) {
                confirm = AdminPendingConfirm(spec: AdminCopy.signOutConfirm(p.username)) {
                    await admin.signOutEverywhere(p.username)
                }
            }
            if p.isAdmin {
                Button("Remove admin…", role: .destructive) { askAdmin(p, make: false) }
            }
            Button("Delete account…", role: .destructive) { askDelete(p) }
        }
    }

    private func askAdmin(_ p: AdminPlayer, make: Bool) {
        confirm = AdminPendingConfirm(spec: AdminCopy.adminConfirm(p.username, make: make, isSelf: admin.isSelf(p.username))) {
            await admin.setAdmin(p.username, make)
        }
    }

    private func askDelete(_ p: AdminPlayer) {
        if let spec = admin.deletePrompt(p) { typed = TypedPrompt(player: p, spec: spec) }
    }
}

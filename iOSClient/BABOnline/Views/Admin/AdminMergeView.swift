import SwiftUI

/// Merge: name the account to keep and the accounts to merge into it (or take a group from
/// Find look-alike names), preview the plan (the web preview's content as grouped rows:
/// each account with its stats and bot games, the stats and bot-game stats that change,
/// what is re-pointed, warnings), then type the kept name exactly to apply. The server
/// applies only the plan that was previewed (its hash); if the data changed since, or the
/// merge stopped partway, the preview is thrown away and its message says to preview again.
struct AdminMergeView: View {
    @ObservedObject var admin: AdminState
    @State private var confirmText = ""

    var body: some View {
        List {
            Section {
                AdminField(label: "Keep this account", placeholder: "e.g. Alan", text: $admin.mergeKeep, identifier: "admin.merge.keep")
                AdminField(label: "Merge these accounts into it (comma separated)", placeholder: "e.g. alan2, AlanB",
                           text: $admin.mergeSources, identifier: "admin.merge.sources")
                Button("Preview merge") { Task { await admin.previewMerge() } }
                    .font(.body.weight(.semibold))
                    .accessibilityIdentifier("admin.merge.preview")
                Button("Find look-alike names") { Task { await admin.findDuplicates() } }
                    .accessibilityIdentifier("admin.merge.findDuplicates")
            }
            .listRowBackground(Theme.surface)
            .tint(Theme.primary)
            // a merge on its way keeps the names it was previewed with
            .disabled(admin.applyingMerge)

            if let groups = admin.duplicates { duplicates(groups) }

            if let note = admin.planNote {
                Section {
                    Text(note)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("admin.merge.note")
                }
                .listRowBackground(Theme.surface)
            }
            if let plan = admin.plan { planSections(plan) }
            if let result = admin.mergeResult {
                Section("Merged") {
                    ForEach(AdminCopy.mergedLines(result), id: \.self) { AdminBullet(text: $0) }
                }
                .listRowBackground(Theme.surface)
                .accessibilityIdentifier("admin.merge.result")
            }
        }
        .adminListStyle()
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: admin.plan) { confirmText = "" }
    }

    // MARK: Look-alike names

    @ViewBuilder
    private func duplicates(_ groups: [[AdminDuplicate]]) -> some View {
        Section {
            if groups.isEmpty {
                Text(AdminCopy.noDuplicates)
                    .foregroundStyle(Theme.textDim)
                    .accessibilityIdentifier("admin.merge.noDuplicates")
            }
            ForEach(Array(groups.enumerated()), id: \.offset) { i, group in
                HStack(alignment: .center, spacing: Theme.Space.s2) {
                    Text(AdminCopy.duplicateLine(group))
                        .font(.subheadline)
                        .foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Use") { admin.use(group) }
                        .disabled(admin.applyingMerge)
                        .buttonStyle(.borderless)
                        .tint(Theme.primary)
                        .frame(minWidth: 44, minHeight: 36)
                        .accessibilityLabel("Use \(group.map(\.username).joined(separator: ", "))")
                        .accessibilityIdentifier("admin.merge.use.\(i)")
                }
            }
        } header: {
            Text("Look-alike names (most games first)").textCase(nil)
        }
        .listRowBackground(Theme.surface)
    }

    // MARK: The plan

    @ViewBuilder
    private func planSections(_ plan: AdminMergePlan) -> some View {
        if !plan.errors.isEmpty {
            Section {
                ForEach(plan.errors, id: \.self) { text in
                    Text(text)
                        .foregroundStyle(Theme.error)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } header: {
                Text(AdminCopy.planHeading(plan)).textCase(nil)
            }
            .listRowBackground(Theme.surface)
            .accessibilityIdentifier("admin.merge.errors")
        } else {
            Section {
                ForEach(plan.accounts) { account($0) }
            } header: {
                Text(AdminCopy.planHeading(plan)).textCase(nil)
                    .accessibilityIdentifier("admin.merge.planHeading")
            }
            .listRowBackground(Theme.surface)

            if !plan.statChanges.isEmpty {
                Section("Stats that change") {
                    ForEach(plan.statChanges) { Text(AdminCopy.statChange($0)).font(.subheadline).foregroundStyle(Theme.textPrimary) }
                }
                .listRowBackground(Theme.surface)
            }
            if !plan.botStatChanges.isEmpty {
                Section("Bot-game stats that change") {
                    ForEach(plan.botStatChanges) { Text(AdminCopy.statChange($0)).font(.subheadline).foregroundStyle(Theme.textPrimary) }
                }
                .listRowBackground(Theme.surface)
            }

            Section {
                ForEach(AdminCopy.planLines(plan), id: \.self) { AdminBullet(text: $0) }
                if !plan.gameRecords.isEmpty {
                    DisclosureGroup("Game records (\(plan.gameRecords.count))") {
                        ForEach(Array(plan.gameRecords.prefix(AdminCopy.gameRecordsShown).enumerated()), id: \.offset) { _, r in
                            detailLine(AdminCopy.gameRecordLine(r))
                        }
                        if plan.gameRecords.count > AdminCopy.gameRecordsShown {
                            detailLine("and \(plan.gameRecords.count - AdminCopy.gameRecordsShown) more")
                        }
                    }
                    .tint(Theme.primary)
                }
                if !plan.reports.isEmpty || !plan.otherUsersBlocks.isEmpty {
                    DisclosureGroup("Reports and block lists") {
                        ForEach(Array(plan.reports.enumerated()), id: \.offset) { _, r in detailLine(AdminCopy.reportLine(r)) }
                        ForEach(Array(plan.otherUsersBlocks.enumerated()), id: \.offset) { _, u in detailLine(AdminCopy.blocksLine(u)) }
                    }
                    .tint(Theme.primary)
                }
            }
            .listRowBackground(Theme.surface)

            if !plan.warnings.isEmpty {
                Section("Warnings") {
                    ForEach(plan.warnings, id: \.self) { text in
                        Text(text)
                            .font(.subheadline)
                            .foregroundStyle(Theme.warning)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .listRowBackground(Theme.surface)
            }

            Section {
                Text(AdminCopy.changeCount(plan))
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .accessibilityIdentifier("admin.merge.count")
                if plan.changeCount > 0 {
                    Text(AdminCopy.mergeConfirmNote(plan.target))
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    AdminField(label: "Type \(plan.target) to confirm", text: $confirmText, identifier: "admin.merge.confirm")
                        .disabled(admin.applyingMerge)
                    Button(role: .destructive) {
                        let typed = confirmText
                        Task { await admin.applyMerge(typed: typed) }
                    } label: {
                        HStack {
                            if admin.applyingMerge { ProgressView().tint(Theme.error) }
                            Text("Merge accounts").bold()
                        }
                    }
                    .disabled(confirmText != plan.target || admin.applyingMerge || !admin.hasPreview)
                    .accessibilityIdentifier("admin.merge.apply")
                }
            }
            .listRowBackground(Theme.surface)
        }
    }

    private func detailLine(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// One account of the merge: its role, name and created day, then its numbers.
    private func account(_ a: AdminMergePlan.Account) -> some View {
        let n = StatsWire.display
        return VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s2) {
                AdminChip(text: AdminCopy.roleLabel(a.role), tone: a.role == "result" ? .success : a.role == "target" ? .gold : .neutral)
                Text(a.username)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if a.role != "result" {
                Text("Created \(AdminDates.day(a.createdAt))")
            }
            Text("Games \(n(a.stats.gamesPlayed)) · W / L / D \(n(a.stats.wins)) / \(n(a.stats.losses)) / \(n(a.stats.draws))")
            Text("Points \(n(a.stats.totalPoints)) · Bot games \(n(a.botStats.gamesPlayed))")
            if let note = a.note {
                Text(note).foregroundStyle(Theme.textDim)
            }
        }
        .font(.footnote)
        .foregroundStyle(Theme.textSecondary)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("admin.merge.account.\(a.role).\(a.username)")
    }
}

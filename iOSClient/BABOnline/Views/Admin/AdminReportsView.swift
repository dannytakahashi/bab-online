import SwiftUI

/// Reports: player reports newest first (Open or All). An open one takes an optional note
/// and Resolve or Dismiss; a closed one says who closed it, when and why. The reported
/// name opens that player under Players.
struct AdminReportsView: View {
    @ObservedObject var admin: AdminState
    @State private var notes: [String: String] = [:]

    var body: some View {
        List {
            Section {
                Picker("Show", selection: $admin.reportFilter) {
                    ForEach(AdminState.ReportFilter.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("admin.reports.filter")
            }
            .listRowBackground(Theme.surface)

            if let reports = admin.reports {
                if reports.isEmpty {
                    Section {
                        Text(AdminCopy.emptyReports(openOnly: admin.reportFilter == .open))
                            .foregroundStyle(Theme.textDim)
                            .accessibilityIdentifier("admin.reports.empty")
                    }
                    .listRowBackground(Theme.surface)
                } else {
                    ForEach(reports) { r in
                        Section { card(r) }
                            .listRowBackground(Theme.surface)
                    }
                }
            } else {
                Section { AdminPlaceholderRow(loading: admin.inFlight > 0, text: "No list yet. Pull down to load it.") }
            }
        }
        .adminListStyle()
        .refreshable { await admin.loadReports() }
        .onChange(of: admin.reportFilter) { Task { await admin.loadReports() } }
    }

    @ViewBuilder
    private func card(_ r: AdminReport) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s2) {
            VStack(alignment: .leading, spacing: Theme.Space.s1) {
                Text("\(r.reporter)\(r.reporterDeleted ? " (deleted)" : "") reported")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                Button { admin.showPlayer(r.reported) } label: {
                    Text(r.reported)
                        .font(.body.weight(.semibold))
                        .frame(minHeight: 32)
                }
                .buttonStyle(.borderless)
                .tint(Theme.primary)
                .accessibilityLabel("\(r.reported): show in Players")
                .accessibilityIdentifier("admin.report.player.\(r.id)")
                HStack(spacing: Theme.Space.s2) {
                    if r.reportedDeleted { AdminChip(text: "account deleted") }
                    AdminChip(text: r.status, tone: r.isOpen ? .gold : .neutral)
                    Text(AdminDates.dateTime(r.createdAt))
                        .font(.caption)
                        .foregroundStyle(Theme.textDim)
                }
            }
            Text(r.reason)
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if !r.context.isEmpty {
                Text(r.context)
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("admin.report.\(r.id)")

        if r.isOpen {
            TextField("Note (optional)", text: note(r.id), axis: .vertical)
                .lineLimit(1...4)
                .foregroundStyle(Theme.textPrimary)
                .accessibilityIdentifier("admin.report.note.\(r.id)")
            HStack(spacing: Theme.Space.s4) {
                Button("Resolve") { close(r, "resolved") }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("admin.report.resolve.\(r.id)")
                Button("Dismiss") { close(r, "dismissed") }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("admin.report.dismiss.\(r.id)")
                Spacer(minLength: 0)
            }
            .tint(Theme.primary)
            .disabled(admin.closingReports.contains(r.id))
        } else {
            Text(AdminCopy.reportResolution(r))
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("admin.report.resolution.\(r.id)")
        }
    }

    private func note(_ id: String) -> Binding<String> {
        // the cap as the server counts it (UTF-16 units); the trim is at send
        Binding(get: { notes[id] ?? "" }, set: { notes[id] = $0.utf16.count > AdminCopy.reportNoteLimit ? AdminCopy.reportNote($0) : $0 })
    }

    private func close(_ r: AdminReport, _ status: String) {
        let text = notes[r.id] ?? ""
        Task { await admin.closeReport(r, as: status, note: text) }
    }
}

/// Admins: who is an admin and since when; Remove admin asks first (the server never
/// leaves zero admins). Making someone an admin is under Players.
struct AdminAdminsView: View {
    @ObservedObject var admin: AdminState
    @State private var confirm: AdminPendingConfirm?

    var body: some View {
        List {
            Section {
                if let admins = admin.admins {
                    ForEach(admins) { a in
                        ViewThatFits(in: .horizontal) {
                            HStack { who(a); Spacer(minLength: Theme.Space.s2); remove(a) }
                            VStack(alignment: .leading, spacing: Theme.Space.s1) { who(a); remove(a) }
                        }
                    }
                } else {
                    AdminPlaceholderRow(loading: admin.inFlight > 0, text: "No list yet. Pull down to load it.")
                }
            } footer: {
                Text(AdminCopy.adminsNote)
            }
            .listRowBackground(Theme.surface)
        }
        .adminListStyle()
        .refreshable { await admin.loadAdmins() }
        .adminConfirm($confirm)
    }

    private func who(_ a: AdminRoleEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(a.username + (admin.isSelf(a.username) ? " (you)" : ""))
                .font(.body.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Text("Since \(AdminDates.day(a.adminSince))")
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("admin.admins.row.\(a.username)")
    }

    private func remove(_ a: AdminRoleEntry) -> some View {
        Button("Remove admin", role: .destructive) {
            confirm = AdminPendingConfirm(spec: AdminCopy.adminConfirm(a.username, make: false, isSelf: admin.isSelf(a.username))) {
                await admin.setAdmin(a.username, false)
            }
        }
        .buttonStyle(.borderless)
        .frame(minHeight: 36)
        .disabled(admin.makingLink)
        .accessibilityLabel("Remove admin: \(a.username)")
        .accessibilityIdentifier("admin.admins.remove.\(a.username)")
    }
}

/// Audit: every admin action, newest first, read-only; Load more pages back.
struct AdminAuditView: View {
    @ObservedObject var admin: AdminState

    var body: some View {
        List {
            Section {
                if let audit = admin.audit {
                    if audit.isEmpty {
                        Text("No admin actions yet.").foregroundStyle(Theme.textDim)
                    }
                    ForEach(audit) { row($0) }
                    if admin.auditHasMore {
                        Button("Load more") { Task { await admin.loadAudit(append: true) } }
                            .tint(Theme.primary)
                            .accessibilityIdentifier("admin.audit.more")
                    }
                } else {
                    AdminPlaceholderRow(loading: admin.inFlight > 0, text: "No list yet. Pull down to load it.")
                }
            }
            .listRowBackground(Theme.surface)
        }
        .adminListStyle()
        .refreshable { await admin.loadAudit() }
    }

    private func resultColor(_ result: String) -> Color {
        switch result {
        case "ok": return Theme.success
        case "forbidden": return Theme.error
        default: return Theme.warning
        }
    }

    private func row(_ e: AdminAuditEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s2) {
                Text(e.action)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text(e.result)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(resultColor(e.result))
                Spacer(minLength: 0)
            }
            Text("\(e.actor ?? "—")\(e.target.map { " → \($0)" } ?? "")")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .accessibilityLabel("by \(e.actor ?? "unknown")\(e.target.map { ", target \($0)" } ?? "")")
            if let detail = e.detail {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(AdminDates.dateTime(e.at))
                .font(.caption)
                .foregroundStyle(Theme.textDim)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("admin.audit.row.\(e.id)")
    }
}

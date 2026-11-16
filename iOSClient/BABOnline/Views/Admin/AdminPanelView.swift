import SwiftUI

/// The admin panel (iOS 1.2.2): the web panel's five sections (Players, Merge, Reports,
/// Admins, Audit) as one sheet from the Account sheet's Admin entry, shown only to admins
/// (`AuthState.isAdmin`, display only: the server checks every request). A section loads
/// from the server each time it is opened, as the web's tabs do; one status line under the
/// section control says the last result or error and is announced to VoiceOver.
struct AdminPanelView: View {
    @ObservedObject var admin: AdminState
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                sectionPicker
                    .padding(.horizontal)
                    .padding(.vertical, Theme.Space.s2)
                    .frame(maxWidth: 560)

                AdminStatusLine(status: admin.status)

                Divider().background(Theme.divider)

                Group {
                    switch admin.tab {
                    case .players: AdminPlayersView(admin: admin)
                    case .merge: AdminMergeView(admin: admin)
                    case .reports: AdminReportsView(admin: admin)
                    case .admins: AdminAdminsView(admin: admin)
                    case .audit: AdminAuditView(admin: admin)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Admin")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { admin.close() }
                        .accessibilityLabel("Close admin panel")
                        .accessibilityIdentifier("admin.close")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if admin.inFlight > 0 {
                        ProgressView()
                            .accessibilityLabel("Waiting for the server")
                            .accessibilityIdentifier("admin.busy")
                    }
                }
            }
        }
        // opening a section loads it (also the first one, when the panel opens)
        .task(id: admin.tab) { await admin.tabOpened(admin.tab) }
        .sensoryFeedback(.selection, trigger: admin.tab)
    }

    /// Five segments where they fit; a menu at the larger type sizes, where five words
    /// across a phone would be cut.
    @ViewBuilder
    private var sectionPicker: some View {
        let picker = Picker("Admin sections", selection: $admin.tab) {
            ForEach(AdminTab.allCases) { Text($0.title).tag($0) }
        }
        if typeSize <= .xLarge {
            picker.pickerStyle(.segmented)
                .accessibilityIdentifier("admin.tabs")
        } else {
            // the menu alone, leading: a label beside it leaves no room for the section's name
            HStack {
                picker.pickerStyle(.menu)
                    .tint(Theme.primary)
                    .accessibilityIdentifier("admin.tabs")
                Spacer(minLength: 0)
            }
        }
    }
}

/// The last result or error, announced when it changes.
struct AdminStatusLine: View {
    let status: AdminState.Status?

    private var color: Color {
        switch status?.kind {
        case .error: return Theme.error
        case .success: return Theme.success
        default: return Theme.textSecondary
        }
    }

    var body: some View {
        Group {
            if let status {
                Text(status.text)
                    .font(.footnote)
                    .foregroundStyle(color)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.bottom, Theme.Space.s2)
                    .accessibilityAddTraits(.updatesFrequently)
                    .accessibilityIdentifier("admin.status")
            }
        }
        .onChange(of: status) { _, new in
            if let new { UIAccessibility.post(notification: .announcement, argument: new.text) }
        }
    }
}

// MARK: - Shared pieces

/// A small state word beside a name (you, online, admin, ...).
struct AdminChip: View {
    enum Tone { case neutral, success, gold }
    let text: String
    var tone: Tone = .neutral

    private var color: Color {
        switch tone {
        case .neutral: return Theme.textSecondary
        case .success: return Theme.success
        case .gold: return Theme.gold
        }
    }

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, Theme.Space.s2)
            .padding(.vertical, 2)
            .overlay(Capsule().stroke(color.opacity(0.6), lineWidth: 1))
            .fixedSize()
    }
}

/// A text field under its visible label; names are typed exactly (no capitals, no corrections).
struct AdminField: View {
    let label: String
    var placeholder = ""
    @Binding var text: String
    let identifier: String

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s1) {
            Text(label)
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
                .accessibilityHidden(true)
            TextField(placeholder, text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(Theme.textPrimary)
                .frame(minHeight: 36)
                .accessibilityLabel(label)
                .accessibilityIdentifier(identifier)
        }
    }
}

/// A line of a list of consequences or changes.
struct AdminBullet: View {
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s2) {
            Text("•").foregroundStyle(Theme.textDim).accessibilityHidden(true)
            Text(text)
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.subheadline)
    }
}

/// A section's first load, or nothing to show yet.
struct AdminPlaceholderRow: View {
    let loading: Bool
    let text: String

    var body: some View {
        HStack(spacing: Theme.Space.s3) {
            if loading { ProgressView() }
            Text(loading ? "Loading…" : text)
                .foregroundStyle(Theme.textDim)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .listRowBackground(Theme.surface)
    }
}

/// A question before an action, and what to run on yes.
struct AdminPendingConfirm: Identifiable {
    let id = UUID()
    let spec: AdminConfirm
    let run: () async -> Void
}

extension View {
    /// The yes / no alert of the web's confirmAction: Cancel first, the action named.
    func adminConfirm(_ pending: Binding<AdminPendingConfirm?>) -> some View {
        alert(pending.wrappedValue?.spec.title ?? "", isPresented: Binding(get: { pending.wrappedValue != nil },
                                                                             set: { if !$0 { pending.wrappedValue = nil } }),
              presenting: pending.wrappedValue) { p in
            Button("Cancel", role: .cancel) {}
            Button(p.spec.confirmLabel, role: p.spec.danger ? .destructive : nil) {
                Task { await p.run() }
            }
        } message: { p in
            Text(p.spec.text)
        }
    }

    /// The panel's lists: grouped rows on the app's background.
    func adminListStyle() -> some View {
        listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
    }
}

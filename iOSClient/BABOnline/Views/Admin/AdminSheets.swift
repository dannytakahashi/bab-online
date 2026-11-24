import SwiftUI

/// A destructive action that needs a name typed exactly (the web's openTypedConfirm): the
/// confirm button stays disabled until the typed text matches, case and spaces included. A
/// refusal from the server is shown here and the sheet stays open; while the request is in
/// flight the sheet cannot be dismissed (the action may already be happening). The field
/// is not focused on open: the keyboard would scroll the consequences away unread.
struct AdminTypedConfirmSheet: View {
    let spec: AdminTypedConfirm
    /// The server's answer; nil when none came (the panel says why).
    let submit: (String) async -> AdminResponse?

    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""
    @State private var busy = false
    @State private var refusal: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(spec.title)
                        .font(.headline)
                        .foregroundStyle(Theme.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("admin.confirm.title")
                    if let intro = spec.intro {
                        Text(intro).font(.subheadline).foregroundStyle(Theme.textSecondary)
                    }
                    ForEach(spec.lines, id: \.self) { AdminBullet(text: $0) }
                }
                .listRowBackground(Theme.surface)

                Section {
                    AdminField(label: "Type \(spec.expected) to confirm", text: $typed, identifier: "admin.confirm.field")
                        .focused($focused)
                        .onChange(of: typed) { refusal = nil }
                    if let refusal {
                        Text(refusal)
                            .font(.footnote)
                            .foregroundStyle(Theme.error)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("admin.confirm.alert")
                    }
                }
                .listRowBackground(Theme.surface)

                Section {
                    Button(role: .destructive, action: run) {
                        HStack {
                            if busy { ProgressView().tint(Theme.error) }
                            Text(spec.confirmLabel).bold()
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .disabled(!spec.isReady(typed) || busy)
                    .accessibilityIdentifier("admin.confirm.submit")
                    // also here: with the keyboard up a short window (the closed Duo) hides the bar's Cancel
                    Button("Cancel") { dismiss() }
                        .frame(maxWidth: .infinity)
                        .foregroundStyle(Theme.textSecondary)
                        .disabled(busy)
                        .accessibilityIdentifier("admin.confirm.cancel")
                }
                .listRowBackground(Theme.surface)
            }
            .adminListStyle()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Confirm")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(busy)
                        .accessibilityIdentifier("admin.confirm.close")
                }
            }
        }
        .interactiveDismissDisabled(busy)
    }

    private func run() {
        guard spec.isReady(typed), !busy else { return }
        busy = true
        Task {
            let res = await submit(typed)
            busy = false
            if let res, !res.ok {
                refusal = res.message
                A11y.announce(res.message)
                focused = true
            } else {
                dismiss()
            }
        }
    }
}

/// Rename: the new name, old → new shown as it is typed, and the new name typed again to
/// confirm (the web's openRenameDialog). A refusal stays in the sheet.
struct AdminRenameSheet: View {
    let oldName: String
    /// (newName trimmed, the second field as typed) -> the server's answer, nil when none came.
    let submit: (String, String) async -> AdminResponse?

    @Environment(\.dismiss) private var dismiss
    @State private var newName = ""
    @State private var again = ""
    @State private var busy = false
    @State private var refusal: String?
    @FocusState private var focused: Bool

    private var trimmed: String { newName.trimmingCharacters(in: .whitespaces) }
    private var ready: Bool { AdminCopy.renameReady(old: oldName, newName: newName, again: again) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(AdminCopy.renameLines(oldName), id: \.self) { AdminBullet(text: $0) }
                }
                .listRowBackground(Theme.surface)

                Section {
                    // beside the fields, so it stays in view while typing
                    Text("\(oldName) → \(trimmed.isEmpty ? "…" : trimmed)")
                        .font(.headline)
                        .foregroundStyle(Theme.textPrimary)
                        .accessibilityLabel("\(oldName) becomes \(trimmed.isEmpty ? "the new name" : trimmed)")
                        .accessibilityIdentifier("admin.rename.summary")
                    AdminField(label: "New name", text: $newName, identifier: "admin.rename.new")
                        .focused($focused)
                    AdminField(label: "Type the new name again to confirm", text: $again, identifier: "admin.rename.again")
                    if let refusal {
                        Text(refusal)
                            .font(.footnote)
                            .foregroundStyle(Theme.error)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("admin.rename.alert")
                    }
                } footer: {
                    Text(AdminCopy.renameRules)
                }
                .listRowBackground(Theme.surface)
                .onChange(of: newName) { refusal = nil }
                .onChange(of: again) { refusal = nil }

                Section {
                    Button(action: run) {
                        HStack {
                            if busy { ProgressView() }
                            Text("Rename").bold()
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .disabled(!ready || busy)
                    .accessibilityIdentifier("admin.rename.submit")
                    Button("Cancel") { dismiss() }
                        .frame(maxWidth: .infinity)
                        .foregroundStyle(Theme.textSecondary)
                        .disabled(busy)
                        .accessibilityIdentifier("admin.rename.cancel")
                }
                .listRowBackground(Theme.surface)
            }
            .adminListStyle()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Rename \(oldName)")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(busy)
                        .accessibilityIdentifier("admin.rename.close")
                }
            }
        }
        .interactiveDismissDisabled(busy)
    }

    private func run() {
        guard ready, !busy else { return }
        busy = true
        Task {
            let res = await submit(trimmed, again)
            busy = false
            if let res, !res.ok {
                refusal = res.message
                A11y.announce(res.message)
                focused = true
            } else {
                dismiss()
            }
        }
    }
}

/// A one-time reset link, shown once and closed only by Done: Copy (this device only, gone from the clipboard when
/// the link expires) or the system share sheet (Messages). The link is a bearer secret: it
/// lives only in `AdminState.resetLink` while this sheet is up, is never logged or spoken
/// (VoiceOver names the row, not the link), and is covered while the app is not in front
/// (`AdminState.linkCovered`, from UIKit's resign / become active: the app switcher's
/// snapshot never holds it).
struct AdminResetLinkSheet: View {
    let link: AdminResetLink
    @ObservedObject var admin: AdminState

    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if admin.linkCovered {
                        Text(AdminCopy.resetLinkCovered)
                            .font(.footnote)
                            .foregroundStyle(Theme.textDim)
                            .accessibilityIdentifier("admin.resetLink.covered")
                    } else {
                        Text(link.url)
                            .font(.footnote.monospaced())
                            .foregroundStyle(Theme.textPrimary)
                            .textSelection(.enabled)
                            .accessibilityLabel("Reset link")
                            // not the link itself: VoiceOver would read the secret aloud
                            .accessibilityValue(AdminCopy.resetLinkSpoken)
                            .accessibilityIdentifier("admin.resetLink.url")
                    }
                } header: {
                    Text("Reset link for \(link.username)").textCase(nil)
                } footer: {
                    Text(AdminCopy.resetLinkNote(expiresAt: link.expiresAt))
                        .accessibilityIdentifier("admin.resetLink.note")
                }
                .listRowBackground(Theme.surface)

                Section {
                    Button(action: copy) {
                        Label("Copy", systemImage: "doc.on.doc").foregroundStyle(Theme.primary)
                    }
                    .accessibilityIdentifier("admin.resetLink.copy")
                    ShareLink(item: link.url) {
                        Label("Share…", systemImage: "square.and.arrow.up").foregroundStyle(Theme.primary)
                    }
                    .accessibilityIdentifier("admin.resetLink.share")
                } footer: {
                    if copied {
                        Text(AdminCopy.linkCopied)
                            .foregroundStyle(Theme.success)
                            .accessibilityIdentifier("admin.resetLink.copied")
                    }
                }
                .listRowBackground(Theme.surface)
                .tint(Theme.primary)
            }
            .adminListStyle()
            .navigationTitle("Reset link")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("admin.resetLink.done")
                }
            }
        }
        // shown once: a stray swipe, or a tap beside the sheet on the iPad, must not lose it
        .interactiveDismissDisabled()
    }

    /// This device only (no Universal Clipboard), and only until the link expires.
    private func copy() {
        Pasteboard.copySecret(link.url, expiresAt: link.expiresAt)
        copied = true
        A11y.announce(AdminCopy.linkCopied)
    }
}

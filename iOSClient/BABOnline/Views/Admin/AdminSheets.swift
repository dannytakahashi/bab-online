import SwiftUI
import UIKit
import UniformTypeIdentifiers

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
                }
                .listRowBackground(Theme.surface)
            }
            .adminListStyle()
            .navigationTitle("Confirm")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(busy)
                        .accessibilityIdentifier("admin.confirm.cancel")
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
                UIAccessibility.post(notification: .announcement, argument: res.message)
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
                }
                .listRowBackground(Theme.surface)
            }
            .adminListStyle()
            .navigationTitle("Rename \(oldName)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(busy)
                        .accessibilityIdentifier("admin.rename.cancel")
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
                UIAccessibility.post(notification: .announcement, argument: res.message)
                focused = true
            } else {
                dismiss()
            }
        }
    }
}

/// A one-time reset link, shown once: Copy (this device only, gone from the clipboard when
/// the link expires) or the system share sheet (Messages). The link is a bearer secret: it
/// lives only in this sheet's state, is never logged, and is covered while the app is not
/// in front (the app switcher's snapshot).
struct AdminResetLinkSheet: View {
    let link: AdminResetLink

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var copied = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if scenePhase == .active {
                        Text(link.url)
                            .font(.footnote.monospaced())
                            .foregroundStyle(Theme.textPrimary)
                            .textSelection(.enabled)
                            .accessibilityLabel("Reset link")
                            .accessibilityValue(link.url)
                            .accessibilityIdentifier("admin.resetLink.url")
                    } else {
                        Text("Hidden while the app is not in front.")
                            .font(.footnote)
                            .foregroundStyle(Theme.textDim)
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
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("admin.resetLink.done")
                }
            }
        }
    }

    /// This device only (no Universal Clipboard), and only until the link expires.
    private func copy() {
        var options: [UIPasteboard.OptionsKey: Any] = [.localOnly: true]
        if let expires = link.expiresAt { options[.expirationDate] = expires }
        UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: link.url]], options: options)
        copied = true
        UIAccessibility.post(notification: .announcement, argument: AdminCopy.linkCopied)
    }
}

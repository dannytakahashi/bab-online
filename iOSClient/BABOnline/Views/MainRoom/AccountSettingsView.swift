import SwiftUI

/// Account management sheet: sign out, change password, legal links, blocked users, and
/// permanent account deletion (App Store Guideline 5.1.1(v)).
struct AccountSettingsView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var mainRoomState: MainRoomState
    @EnvironmentObject var lobbyState: LobbyState
    @EnvironmentObject var gameState: GameState
    @EnvironmentObject var tournamentState: TournamentState
    @EnvironmentObject var safetyState: SafetyState
    @EnvironmentObject var socketService: SocketService
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var sounds = SoundPlayer.shared

    /// Opens the admin panel once this sheet has closed (MainRoomView); the Admin entry shows
    /// only while `authState.isAdmin` and this is set.
    var openAdmin: (() -> Void)?

    @State private var showDeleteConfirm = false
    @State private var deletePassword = ""
    @State private var isDeleting = false

    // Change Password (changePassword -> changePasswordResponse)
    @State private var showPasswordChange = false
    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var newPasswordAgain = ""
    @State private var isChangingPassword = false
    @State private var passwordChangeAttempt = 0

    var body: some View {
        NavigationView {
            List {
                accountSection
                if authState.isAdmin, openAdmin != nil { adminSection }
                soundSection
                passwordSection
                blockedUsersSection
                legalSection
                deleteSection
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .onChange(of: authState.deleteAccountError) { _, newValue in
                if newValue != nil {
                    isDeleting = false
                }
            }
            .onChange(of: authState.changePasswordResult) { _, result in
                guard let result else { return }
                isChangingPassword = false
                if result.success {
                    currentPassword = ""
                    newPassword = ""
                    newPasswordAgain = ""
                }
                UIAccessibility.post(notification: .announcement, argument: result.message)
            }
            // Present safety feedback (e.g. unblock confirmation/errors) here:
            // the chat-surface alert hosts are covered while this sheet is up
            // and can't present, which would defer the alert until dismissal
            .alert(
                "Safety",
                isPresented: Binding(
                    get: { safetyState.feedbackMessage != nil },
                    set: { if !$0 { safetyState.feedbackMessage = nil } }
                )
            ) {
                Button("OK", role: .cancel) {
                    safetyState.feedbackMessage = nil
                }
            } message: {
                Text(safetyState.feedbackMessage ?? "")
            }
        }
        .onDisappear {
            authState.deleteAccountError = nil
            authState.changePasswordResult = nil
            safetyState.feedbackMessage = nil
        }
    }

    // MARK: - Sections

    private var accountSection: some View {
        Section {
            HStack {
                Text("Signed in as")
                    .foregroundColor(Theme.textSecondary)
                Spacer()
                Text(authState.username)
                    .bold()
                    .foregroundColor(Theme.textPrimary)
            }

            Button(action: signOut) {
                Text("Sign Out")
                    .foregroundColor(Theme.primary)
            }
        }
        .listRowBackground(Theme.surface)
    }

    /// Admins only (the flag is display only: the server checks every admin request).
    private var adminSection: some View {
        Section {
            Button {
                openAdmin?()
                dismiss()
            } label: {
                HStack {
                    Label("Admin", systemImage: "shield.lefthalf.filled")
                        .foregroundColor(Theme.primary)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundColor(Theme.textDim)
                        .accessibilityHidden(true)
                }
            }
            .accessibilityIdentifier("account.admin")
        } footer: {
            Text("Players, reports, merges, admins and the audit log.")
                .foregroundColor(Theme.textDim)
        }
        .listRowBackground(Theme.surface)
    }

    /// The same switch as the table's speaker (SoundToggleButton), plus the volume.
    private var soundSection: some View {
        Section {
            Toggle("Sound", isOn: $sounds.isEnabled)
                .foregroundColor(Theme.textPrimary)
                .tint(Theme.primary)
                .accessibilityIdentifier("settings.sound")
            if sounds.isEnabled {
                HStack(spacing: Theme.Space.s3) {
                    Image(systemName: "speaker.fill")
                        .foregroundColor(Theme.textDim)
                        .accessibilityHidden(true)
                    Slider(value: $sounds.volume, in: 0.05...1)
                        .tint(Theme.primary)
                        .accessibilityLabel("Sound volume")
                        .accessibilityIdentifier("settings.soundVolume")
                    Image(systemName: "speaker.wave.3.fill")
                        .foregroundColor(Theme.textDim)
                        .accessibilityHidden(true)
                }
            }
        } footer: {
            Text("Card, turn and trick sounds. The silent switch mutes them, except during voice chat.")
                .foregroundColor(Theme.textDim)
        }
        .listRowBackground(Theme.surface)
    }

    @ViewBuilder
    private var passwordSection: some View {
        Section {
            if !showPasswordChange {
                Button(action: { showPasswordChange = true }) {
                    Text("Change Password")
                        .foregroundColor(Theme.primary)
                }
                .accessibilityIdentifier("account.changePassword")
            } else {
                SecureField("Current password", text: $currentPassword)
                    .textContentType(.password)
                    .foregroundColor(Theme.textPrimary)
                    .accessibilityIdentifier("account.currentPassword")
                SecureField("New password (at least \(PasswordRule.minLength) characters)", text: $newPassword)
                    .textContentType(.newPassword)
                    .foregroundColor(Theme.textPrimary)
                    .accessibilityIdentifier("account.newPassword")
                SecureField("New password again", text: $newPasswordAgain)
                    .textContentType(.newPassword)
                    .foregroundColor(Theme.textPrimary)
                    .accessibilityIdentifier("account.newPasswordAgain")

                if let problem = PasswordRule.changeProblem(current: currentPassword, new: newPassword, again: newPasswordAgain) {
                    Text(problem)
                        .font(.caption)
                        .foregroundColor(Theme.error)
                } else if let result = authState.changePasswordResult {
                    Text(result.message)
                        .font(.caption)
                        .foregroundColor(result.success ? Theme.success : Theme.error)
                        .accessibilityIdentifier("account.changePasswordResult")
                }

                Button(action: changePassword) {
                    HStack {
                        if isChangingPassword {
                            ProgressView()
                                .scaleEffect(0.8)
                        }
                        Text("Change Password")
                            .bold()
                    }
                }
                .disabled(isChangingPassword || !socketService.isConnected
                          || !PasswordRule.canChange(current: currentPassword, new: newPassword, again: newPasswordAgain))
                .accessibilityIdentifier("account.changePasswordSubmit")

                Button("Cancel") {
                    showPasswordChange = false
                    currentPassword = ""
                    newPassword = ""
                    newPasswordAgain = ""
                    authState.changePasswordResult = nil
                }
                .foregroundColor(Theme.textSecondary)
            }
        } header: {
            Text("Password")
        } footer: {
            if showPasswordChange {
                Text("Your other devices will be signed out.")
            }
        }
        .listRowBackground(Theme.surface)
    }

    private var blockedUsersSection: some View {
        Section("Blocked Users") {
            if safetyState.blockedUsers.isEmpty {
                Text("No blocked users")
                    .foregroundColor(Theme.textDim)
            } else {
                ForEach(safetyState.blockedUsers.sorted(), id: \.self) { username in
                    HStack {
                        Text(username)
                            .foregroundColor(Theme.textPrimary)
                        Spacer()
                        Button("Unblock") {
                            SafetyEmitter.unblockUser(username: username)
                        }
                        .font(.callout.bold())
                        .foregroundColor(Theme.primary)
                        .buttonStyle(.borderless)
                    }
                }
            }
        }
        .listRowBackground(Theme.surface)
    }

    private var legalSection: some View {
        Section {
            Link("Privacy Policy", destination: URL(string: "https://babonline.io/privacy")!)
                .foregroundColor(Theme.primary)
            Link("Terms of Use", destination: URL(string: "https://babonline.io/terms")!)
                .foregroundColor(Theme.primary)
        }
        .listRowBackground(Theme.surface)
    }

    @ViewBuilder
    private var deleteSection: some View {
        Section {
            if !showDeleteConfirm {
                Button(role: .destructive, action: { showDeleteConfirm = true }) {
                    Text("Delete Account")
                }
            } else {
                Text("Permanently deletes your account, statistics, and profile. This cannot be undone. Your username stays reserved for 30 days.")
                    .font(.caption)
                    .foregroundColor(Theme.textSecondary)

                SecureField("Confirm password", text: $deletePassword)
                    .textContentType(.password)
                    .foregroundColor(Theme.textPrimary)

                if let error = authState.deleteAccountError {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(Theme.error)
                }

                Button(role: .destructive, action: deleteAccount) {
                    HStack {
                        if isDeleting {
                            ProgressView()
                                .tint(Theme.error)
                                .scaleEffect(0.8)
                        }
                        Text("Permanently Delete")
                            .bold()
                    }
                }
                .disabled(deletePassword.isEmpty || isDeleting)

                Button("Cancel") {
                    showDeleteConfirm = false
                    deletePassword = ""
                    authState.deleteAccountError = nil
                }
                .foregroundColor(Theme.textSecondary)
            }
        }
        .listRowBackground(Theme.surface)
    }

    // MARK: - Actions

    private func signOut() {
        authState.clearCredentials()
        gameState.reset()
        mainRoomState.reset()
        lobbyState.reset()
        tournamentState.reset()
        safetyState.reset()
        appState.screen = .signIn
        // Cycle the connection so the server-side session ends; the auto
        // session restore won't run because credentials are cleared.
        socketService.forceReconnect()
        dismiss()
    }

    private func changePassword() {
        isChangingPassword = true
        authState.changePasswordResult = nil
        passwordChangeAttempt += 1
        let attempt = passwordChangeAttempt
        AuthEmitter.changePassword(current: currentPassword, new: newPassword)

        // the button must not spin forever if no response arrives
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
            guard isChangingPassword, attempt == passwordChangeAttempt else { return }
            isChangingPassword = false
            authState.changePasswordResult = ChangePasswordResult(success: false, message: "No answer from the server. Try again.")
        }
    }

    private func deleteAccount() {
        isDeleting = true
        authState.deleteAccountError = nil
        AuthEmitter.deleteAccount(password: deletePassword)

        // Fallback so the button doesn't spin forever if no response arrives
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            isDeleting = false
        }
    }
}

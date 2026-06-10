import SwiftUI

/// Account management sheet: sign out, legal links, blocked users, and
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

    @State private var showDeleteConfirm = false
    @State private var deletePassword = ""
    @State private var isDeleting = false

    var body: some View {
        NavigationView {
            List {
                accountSection
                blockedUsersSection
                legalSection
                deleteSection
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.Theme.background)
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
            safetyState.feedbackMessage = nil
        }
    }

    // MARK: - Sections

    private var accountSection: some View {
        Section {
            HStack {
                Text("Signed in as")
                    .foregroundColor(Color.Theme.textSecondary)
                Spacer()
                Text(authState.username)
                    .bold()
                    .foregroundColor(Color.Theme.textPrimary)
            }

            Button(action: signOut) {
                Text("Sign Out")
                    .foregroundColor(Color.Theme.primary)
            }
        }
        .listRowBackground(Color.Theme.surface)
    }

    private var blockedUsersSection: some View {
        Section("Blocked Users") {
            if safetyState.blockedUsers.isEmpty {
                Text("No blocked users")
                    .foregroundColor(Color.Theme.textDim)
            } else {
                ForEach(safetyState.blockedUsers.sorted(), id: \.self) { username in
                    HStack {
                        Text(username)
                            .foregroundColor(Color.Theme.textPrimary)
                        Spacer()
                        Button("Unblock") {
                            SafetyEmitter.unblockUser(username: username)
                        }
                        .font(.callout.bold())
                        .foregroundColor(Color.Theme.primary)
                        .buttonStyle(.borderless)
                    }
                }
            }
        }
        .listRowBackground(Color.Theme.surface)
    }

    private var legalSection: some View {
        Section {
            Link("Privacy Policy", destination: URL(string: "https://babonline.io/privacy")!)
                .foregroundColor(Color.Theme.primary)
            Link("Terms of Use", destination: URL(string: "https://babonline.io/terms")!)
                .foregroundColor(Color.Theme.primary)
        }
        .listRowBackground(Color.Theme.surface)
    }

    @ViewBuilder
    private var deleteSection: some View {
        Section {
            if !showDeleteConfirm {
                Button(role: .destructive, action: { showDeleteConfirm = true }) {
                    Text("Delete Account")
                }
            } else {
                Text("Permanently deletes your account, statistics, and profile. This cannot be undone.")
                    .font(.caption)
                    .foregroundColor(Color.Theme.textSecondary)

                SecureField("Confirm password", text: $deletePassword)
                    .textContentType(.password)
                    .foregroundColor(Color.Theme.textPrimary)

                if let error = authState.deleteAccountError {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(Color.Theme.error)
                }

                Button(role: .destructive, action: deleteAccount) {
                    HStack {
                        if isDeleting {
                            ProgressView()
                                .tint(Color.Theme.error)
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
                .foregroundColor(Color.Theme.textSecondary)
            }
        }
        .listRowBackground(Color.Theme.surface)
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

import SwiftUI

/// The sign-in screen in the web's look (SignIn.js; AuthChrome.swift): the night card room,
/// the logo with a phrase, and a card with Username, Password, Sign In, "New user?" and
/// Create Account.
struct SignInView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var socketService: SocketService

    @State private var username = ""
    @State private var password = ""
    @State private var isLoading = false
    /// The sign-in with the password exactly as typed, sent once if the trimmed one is refused
    /// as a wrong password (PasswordEntry, AsTypedRetry).
    @State private var asTypedRetry = AsTypedRetry<SignInRequest>()
    @State private var attempt = 0
    /// One phrase per screen, as the web picks one when its screen is made.
    @State private var phrase = SplashPhrases.random()
    @FocusState private var focus: Field?

    private enum Field { case username, password }

    var body: some View {
        AuthScreen(phrase: phrase) {
            AuthCard {
                // Connection status
                if !socketService.isConnected {
                    HStack(spacing: Theme.Space.s2) {
                        ProgressView()
                            .tint(Theme.warning)
                            .scaleEffect(0.8)
                        Text("Connecting to server...")
                            .font(.caption)
                            .foregroundColor(Theme.warning)
                    }
                    .accessibilityElement(children: .combine)
                }

                AuthField(label: "Username", text: $username, contentType: .username, focus: $focus, field: .username)
                    .submitLabel(.next)
                    .onSubmit { focus = .password }

                AuthField(label: "Password", text: $password, secure: true, contentType: .password, focus: $focus, field: .password)
                    .submitLabel(.go)
                    .onSubmit { if canSignIn { signIn() } }

                if let error = authState.error {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(Theme.error)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button(action: signIn) {
                    HStack(spacing: Theme.Space.s2) {
                        if isLoading {
                            ProgressView()
                                .tint(Theme.buttonForeground)
                                .scaleEffect(0.8)
                        }
                        Text("Sign In")
                    }
                }
                .buttonStyle(AuthButtonStyle(kind: .primary))
                .disabled(!canSignIn)

                AuthDivider(text: "New user?")

                Button("Create Account") { appState.screen = .register }
                    .buttonStyle(AuthButtonStyle(kind: .secondary))
            }
        }
        .onAppear {
            // Pre-fill from Keychain
            if !authState.username.isEmpty {
                username = authState.username
            }
            authState.error = nil
        }
        .onChange(of: authState.error) { _, error in
            // the trimmed password was refused and the typed one had a space at an edge: an
            // account made before 1.2.2 may have it in its password, so that one goes once
            // (only for the wrong-password reply: a throttle or any other refusal is shown)
            guard error != nil, let again = asTypedRetry.resend(afterRefusal: error, wrongPassword: PasswordEntry.signInRefused) else { return }
            authState.error = nil
            AuthEmitter.signIn(username: again.username, password: again.password)
        }
        .onDisappear { asTypedRetry.clear() }
    }

    private var canSignIn: Bool {
        !username.isEmpty && !PasswordEntry.sent(password).isEmpty && socketService.isConnected && !isLoading
    }

    private func signIn() {
        isLoading = true
        authState.error = nil
        attempt += 1
        let sent = attempt, name = username
        asTypedRetry.arm(PasswordEntry.asTypedFallback(password).map { SignInRequest(username: name, password: $0) })
        AuthEmitter.signIn(username: name, password: PasswordEntry.sent(password))

        // Reset loading after timeout (a reply that never came gets no resend later)
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            isLoading = false
            if sent == attempt { asTypedRetry.clear() }
        }
    }
}

// MARK: - Custom TextField Style

/// The chat fields' style (main room, lobbies, the game log).
struct BABTextFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .padding(Theme.Space.s3)
            .background(Theme.inputBackground)
            .cornerRadius(Theme.Radius.md)
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).stroke(Theme.inputBorder, lineWidth: 1))
            .foregroundColor(Theme.textPrimary)
    }
}

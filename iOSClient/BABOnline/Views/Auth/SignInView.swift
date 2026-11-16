import SwiftUI

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

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            // Scrolls on short heights (keyboard, landscape), capped at a readable width
            GeometryReader { g in
            ScrollView {
            VStack(spacing: Theme.Space.s8) {
                Spacer(minLength: 24)

                // Logo / Title
                VStack(spacing: Theme.Space.s2) {
                    Text("BAB")
                        .themeFont(Theme.TypeScale.display, weight: Theme.Weight.bold, design: .rounded, relativeTo: .largeTitle)
                        .foregroundColor(Theme.primary)
                    Text("Back Alley Bridge")
                        .font(.title3)
                        .foregroundColor(Theme.textSecondary)
                }

                // Connection status
                if !socketService.isConnected {
                    HStack(spacing: 6) {
                        ProgressView()
                            .tint(Theme.warning)
                            .scaleEffect(0.8)
                        Text("Connecting to server...")
                            .font(.caption)
                            .foregroundColor(Theme.warning)
                    }
                }

                // Form
                VStack(spacing: Theme.Space.s4) {
                    TextField("Username", text: $username)
                        .textFieldStyle(BABTextFieldStyle())
                        .textContentType(.username)
                        .autocapitalization(.none)
                        .autocorrectionDisabled()

                    SecureField("Password", text: $password)
                        .textFieldStyle(BABTextFieldStyle())
                        .textContentType(.password)

                    if let error = authState.error {
                        Text(error)
                            .font(.caption)
                            .foregroundColor(Theme.error)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button(action: signIn) {
                        HStack {
                            if isLoading {
                                ProgressView()
                                    .tint(Theme.buttonForeground)
                                    .scaleEffect(0.8)
                            }
                            Text("Sign In")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(canSignIn ? Theme.buttonBackground : Theme.buttonDisabled)
                        .foregroundColor(canSignIn ? Theme.buttonForeground : Theme.buttonDisabledForeground)
                        .cornerRadius(Theme.Radius.md)
                    }
                    .disabled(!canSignIn)
                }
                .padding(.horizontal, Theme.Space.s8)

                Button(action: { appState.screen = .register }) {
                    Text("Don't have an account? ")
                        .foregroundColor(Theme.textSecondary) +
                    Text("Register")
                        .foregroundColor(Theme.primary)
                        .bold()
                }
                .font(.callout)

                Spacer(minLength: 24)
            }
            .frame(maxWidth: 440)
            .frame(maxWidth: .infinity, minHeight: g.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
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

import SwiftUI

/// The register screen in the web's look (Register.js; AuthChrome.swift): the sign-in's room
/// and logo (no phrase), and a card titled "Create Account" with the three fields, Register,
/// the terms and "Back to Sign In".
struct RegisterView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var socketService: SocketService

    @State private var username = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var isLoading = false
    @FocusState private var focus: Field?

    private enum Field { case username, password, confirm }

    var body: some View {
        AuthScreen {
            AuthCard {
                Text("Create Account")
                    .themeFont(Theme.TypeScale.lg, weight: Theme.Weight.bold, relativeTo: .title3)
                    .foregroundColor(Theme.textPrimary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, Theme.Space.s1)
                    .accessibilityAddTraits(.isHeader)

                // Connection status (the same as the sign-in's)
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

                AuthField(label: "Password", text: $password, secure: true, contentType: .newPassword, focus: $focus, field: .password)
                    .submitLabel(.next)
                    .onSubmit { focus = .confirm }

                AuthField(label: "Confirm Password", text: $confirmPassword, secure: true, contentType: .newPassword,
                          focus: $focus, field: .confirm)
                    .submitLabel(.go)
                    .onSubmit { if canRegister { signUp() } }

                if let error = authState.error {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(Theme.error)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                // the server's rule for new passwords (8-100); hidden until something is typed
                if !password.isEmpty, let problem = PasswordRule.newPasswordProblem(password) {
                    Text(problem)
                        .font(.caption)
                        .foregroundColor(Theme.error)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("register.passwordRule")
                }

                if !confirmPassword.isEmpty && password != confirmPassword {
                    Text("Passwords do not match")
                        .font(.caption)
                        .foregroundColor(Theme.error)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button(action: signUp) {
                    HStack(spacing: Theme.Space.s2) {
                        if isLoading {
                            ProgressView()
                                .tint(Theme.buttonForeground)
                                .scaleEffect(0.8)
                        }
                        Text("Register")
                    }
                }
                .buttonStyle(AuthButtonStyle(kind: .primary))
                .disabled(!canRegister)

                Text(.init("By creating an account you agree to the [Terms of Use](https://babonline.io/terms) — zero tolerance for abusive content."))
                    .themeFont(Theme.TypeScale.xs, relativeTo: .caption)
                    .foregroundColor(Theme.Auth.dividerText)
                    .tint(Theme.Auth.link)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity)

                Button("Back to Sign In") { appState.screen = .signIn }
                    .buttonStyle(AuthButtonStyle(kind: .ghost))
            }
        }
        .onAppear {
            authState.error = nil
        }
    }

    private var canRegister: Bool {
        // the password as it is sent: without spaces at its edges, like the web's (PasswordEntry)
        !username.isEmpty && !PasswordEntry.sent(password).isEmpty
            && PasswordEntry.sent(password) == PasswordEntry.sent(confirmPassword)
            && PasswordRule.newPasswordProblem(PasswordEntry.sent(password)) == nil
            && socketService.isConnected && !isLoading
    }

    private func signUp() {
        isLoading = true
        authState.error = nil
        AuthEmitter.signUp(username: username, password: PasswordEntry.sent(password))

        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            isLoading = false
        }
    }
}

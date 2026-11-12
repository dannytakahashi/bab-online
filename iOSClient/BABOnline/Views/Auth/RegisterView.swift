import SwiftUI

struct RegisterView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var socketService: SocketService

    @State private var username = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var isLoading = false

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            // Scrolls on short heights (keyboard, landscape), capped at a readable width
            GeometryReader { g in
            ScrollView {
            VStack(spacing: Theme.Space.s8) {
                Spacer(minLength: 24)

                Text("Create Account")
                    .themeFont(Theme.TypeScale.xxl, weight: Theme.Weight.bold, design: .rounded, relativeTo: .largeTitle)
                    .foregroundColor(Theme.textPrimary)

                VStack(spacing: Theme.Space.s4) {
                    TextField("Username", text: $username)
                        .textFieldStyle(BABTextFieldStyle())
                        .textContentType(.username)
                        .autocapitalization(.none)
                        .autocorrectionDisabled()

                    SecureField("Password", text: $password)
                        .textFieldStyle(BABTextFieldStyle())
                        .textContentType(.newPassword)

                    SecureField("Confirm Password", text: $confirmPassword)
                        .textFieldStyle(BABTextFieldStyle())
                        .textContentType(.newPassword)

                    if let error = authState.error {
                        Text(error)
                            .font(.caption)
                            .foregroundColor(Theme.error)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if !confirmPassword.isEmpty && password != confirmPassword {
                        Text("Passwords do not match")
                            .font(.caption)
                            .foregroundColor(Theme.error)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button(action: signUp) {
                        HStack {
                            if isLoading {
                                ProgressView()
                                    .tint(Theme.buttonForeground)
                                    .scaleEffect(0.8)
                            }
                            Text("Register")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(canRegister ? Theme.buttonBackground : Theme.buttonDisabled)
                        .foregroundColor(canRegister ? Theme.buttonForeground : Theme.buttonDisabledForeground)
                        .cornerRadius(Theme.Radius.md)
                    }
                    .disabled(!canRegister)

                    Text(.init("By creating an account you agree to the [Terms of Use](https://babonline.io/terms) — zero tolerance for abusive content."))
                        .font(.caption2)
                        .foregroundColor(Theme.textDim)
                        .tint(Theme.primary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
                .padding(.horizontal, Theme.Space.s8)

                Button(action: { appState.screen = .signIn }) {
                    Text("Already have an account? ")
                        .foregroundColor(Theme.textSecondary) +
                    Text("Sign In")
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
            authState.error = nil
        }
    }

    private var canRegister: Bool {
        !username.isEmpty && !password.isEmpty && password == confirmPassword
            && socketService.isConnected && !isLoading
    }

    private func signUp() {
        isLoading = true
        authState.error = nil
        AuthEmitter.signUp(username: username, password: password)

        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            isLoading = false
        }
    }
}

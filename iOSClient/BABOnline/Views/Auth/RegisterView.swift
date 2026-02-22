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
            Color.Theme.background.ignoresSafeArea()

            VStack(spacing: 32) {
                Spacer()

                Text("Create Account")
                    .font(.system(size: 32, weight: .bold, design: .rounded))
                    .foregroundColor(Color.Theme.textPrimary)

                VStack(spacing: 16) {
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
                            .foregroundColor(Color.Theme.error)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if !confirmPassword.isEmpty && password != confirmPassword {
                        Text("Passwords do not match")
                            .font(.caption)
                            .foregroundColor(Color.Theme.error)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button(action: signUp) {
                        HStack {
                            if isLoading {
                                ProgressView()
                                    .tint(.white)
                                    .scaleEffect(0.8)
                            }
                            Text("Register")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(canRegister ? Color.Theme.buttonBackground : Color.Theme.buttonDisabled)
                        .foregroundColor(.white)
                        .cornerRadius(10)
                    }
                    .disabled(!canRegister)
                }
                .padding(.horizontal, 32)

                Button(action: { appState.screen = .signIn }) {
                    Text("Already have an account? ")
                        .foregroundColor(Color.Theme.textSecondary) +
                    Text("Sign In")
                        .foregroundColor(Color.Theme.primary)
                        .bold()
                }
                .font(.callout)

                Spacer()
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

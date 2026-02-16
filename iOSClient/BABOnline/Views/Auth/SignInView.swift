import SwiftUI

struct SignInView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var authState: AuthState
    @EnvironmentObject var socketService: SocketService

    @State private var username = ""
    @State private var password = ""
    @State private var isLoading = false

    var body: some View {
        ZStack {
            Color.Theme.background.ignoresSafeArea()

            VStack(spacing: 32) {
                Spacer()

                // Logo / Title
                VStack(spacing: 8) {
                    Text("BAB")
                        .font(.system(size: 48, weight: .bold, design: .rounded))
                        .foregroundColor(Color.Theme.primary)
                    Text("Back Alley Bridge")
                        .font(.title3)
                        .foregroundColor(Color.Theme.textSecondary)
                }

                // Connection status
                if !socketService.isConnected {
                    HStack(spacing: 6) {
                        ProgressView()
                            .tint(Color.Theme.warning)
                            .scaleEffect(0.8)
                        Text("Connecting to server...")
                            .font(.caption)
                            .foregroundColor(Color.Theme.warning)
                    }
                }

                // Form
                VStack(spacing: 16) {
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
                            .foregroundColor(Color.Theme.error)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button(action: signIn) {
                        HStack {
                            if isLoading {
                                ProgressView()
                                    .tint(.white)
                                    .scaleEffect(0.8)
                            }
                            Text("Sign In")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(canSignIn ? Color.Theme.buttonBackground : Color.Theme.buttonDisabled)
                        .foregroundColor(.white)
                        .cornerRadius(10)
                    }
                    .disabled(!canSignIn)
                }
                .padding(.horizontal, 32)

                Button(action: { appState.screen = .register }) {
                    Text("Don't have an account? ")
                        .foregroundColor(Color.Theme.textSecondary) +
                    Text("Register")
                        .foregroundColor(Color.Theme.primary)
                        .bold()
                }
                .font(.callout)

                Spacer()
            }
        }
        .onAppear {
            // Pre-fill from Keychain
            if !authState.username.isEmpty {
                username = authState.username
            }
            authState.error = nil
        }
    }

    private var canSignIn: Bool {
        !username.isEmpty && !password.isEmpty && socketService.isConnected && !isLoading
    }

    private func signIn() {
        isLoading = true
        authState.error = nil
        AuthEmitter.signIn(username: username, password: password)

        // Reset loading after timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            isLoading = false
        }
    }
}

// MARK: - Custom TextField Style

struct BABTextFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .padding(12)
            .background(Color.Theme.inputBackground)
            .cornerRadius(8)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.Theme.inputBorder, lineWidth: 1))
            .foregroundColor(Color.Theme.textPrimary)
    }
}

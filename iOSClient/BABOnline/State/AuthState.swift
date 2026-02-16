import Foundation
import Security

/// Authentication state with Keychain persistence.
final class AuthState: ObservableObject {
    @Published var username: String = ""
    @Published var isAuthenticated: Bool = false
    @Published var error: String?

    private let keychainService = "com.bab-online.auth"
    private let usernameKey = "username"

    init() {
        loadCredentials()
    }

    func saveCredentials() {
        let data = username.data(using: .utf8)!
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: usernameKey,
        ]

        SecItemDelete(query as CFDictionary)

        var addQuery = query
        addQuery[kSecValueData as String] = data
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    func loadCredentials() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: usernameKey,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecSuccess, let data = result as? Data,
           let stored = String(data: data, encoding: .utf8), !stored.isEmpty {
            self.username = stored
        }
    }

    func clearCredentials() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: usernameKey,
        ]
        SecItemDelete(query as CFDictionary)

        username = ""
        isAuthenticated = false
        error = nil
    }
}

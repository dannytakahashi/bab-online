import Foundation
import Security

/// Authentication state with Keychain persistence.
final class AuthState: ObservableObject {
    @Published var username: String = ""
    @Published var sessionToken: String = ""
    @Published var isAuthenticated: Bool = false
    @Published var error: String?

    private let keychainService = "com.bab-online.auth"
    private let usernameKey = "username"
    private let sessionTokenKey = "sessionToken"

    /// Whether we have stored credentials that can be used for session restore
    var hasStoredSession: Bool {
        !username.isEmpty && !sessionToken.isEmpty
    }

    init() {
        loadCredentials()
    }

    func saveCredentials() {
        saveKeychainItem(key: usernameKey, value: username)
        saveKeychainItem(key: sessionTokenKey, value: sessionToken)
    }

    func loadCredentials() {
        if let stored = loadKeychainItem(key: usernameKey), !stored.isEmpty {
            self.username = stored
        }
        if let stored = loadKeychainItem(key: sessionTokenKey), !stored.isEmpty {
            self.sessionToken = stored
        }
    }

    func clearCredentials() {
        deleteKeychainItem(key: usernameKey)
        deleteKeychainItem(key: sessionTokenKey)

        username = ""
        sessionToken = ""
        isAuthenticated = false
        error = nil
    }

    // MARK: - Keychain Helpers

    private func saveKeychainItem(key: String, value: String) {
        guard let data = value.data(using: .utf8) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)

        var addQuery = query
        addQuery[kSecValueData as String] = data
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    private func loadKeychainItem(key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecSuccess, let data = result as? Data {
            return String(data: data, encoding: .utf8)
        }
        return nil
    }

    private func deleteKeychainItem(key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

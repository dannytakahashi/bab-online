import Foundation

/// The game server's origin (socket and HTTP: avatars, stock art): the
/// simulator talks to localhost:3000, a device to production.
///
/// Debug builds only: `-serverURL http://localhost:<port>` (a launch
/// argument, so it lands in the arguments domain of UserDefaults) points the
/// simulator at a local server on another port for live checks; anything that
/// is not a plain http(s) localhost origin is ignored.
enum ServerConfig {
    static var baseURL: String {
        #if DEBUG
        if let override = debugOverride { return override }
        #endif
        #if targetEnvironment(simulator)
        return "http://localhost:3000"
        #else
        return "https://babonline.io"
        #endif
    }

    #if DEBUG
    static var debugOverride: String? {
        guard let raw = UserDefaults.standard.string(forKey: "serverURL") else { return nil }
        return validLocalOrigin(raw)
    }
    #endif

    /// `raw` when it is `http(s)://localhost[:port]` or `127.0.0.1[:port]` with no path, else nil.
    static func validLocalOrigin(_ raw: String) -> String? {
        guard let c = URLComponents(string: raw), let scheme = c.scheme, ["http", "https"].contains(scheme),
              let host = c.host, ["localhost", "127.0.0.1"].contains(host),
              c.path.isEmpty || c.path == "/", c.query == nil, c.user == nil else { return nil }
        return raw.hasSuffix("/") ? String(raw.dropLast()) : raw
    }
}

/// This build's version, as App Store Connect and the upgrade gate see it.
enum AppInfo {
    /// CFBundleShortVersionString (MARKETING_VERSION), e.g. "1.2.0".
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }
    /// CFBundleVersion (CURRENT_PROJECT_VERSION), e.g. "3": the User-Agent build the upgrade gate reads.
    static var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0" }
}

/// c2s `clientHello` (contract/src/c2s.js; server/socket/clientInfo.js): sent on
/// every connect, before restoreSession, so every payload the server builds
/// for this socket afterwards uses the capable shapes (custom pictures as
/// `avatarUrl` / `avatarUrls`, docs/avatars.md). No reply; the last hello wins.
enum ClientHello {
    /// The capabilities this build acts on ($defs.clientCap).
    static let caps = ["avatarUrl"]

    static func payload(version: String = AppInfo.version, build: String = AppInfo.build) -> [String: Any] {
        ["client": "ios", "version": String(version.prefix(32)), "build": String(build.prefix(64)), "caps": caps]
    }
}

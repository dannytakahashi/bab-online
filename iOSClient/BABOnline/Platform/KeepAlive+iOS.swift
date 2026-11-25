#if os(iOS)
import UIKit

typealias PlatformKeepAlive = BackgroundTaskKeepAlive

/// A UIApplication background task named "SocketKeepAlive".
final class BackgroundTaskKeepAlive: KeepAlive {
    private var backgroundTaskId: UIBackgroundTaskIdentifier = .invalid
    private(set) var isActive = false

    var token: Int { backgroundTaskId.rawValue }

    func begin(expired: @escaping () -> Void) -> Bool {
        guard backgroundTaskId == .invalid else { return false }
        isActive = true
        backgroundTaskId = UIApplication.shared.beginBackgroundTask(withName: "SocketKeepAlive") {
            // Expiration handler — OS is about to kill the task
            expired()
        }
        return true
    }

    func end() -> Bool {
        guard backgroundTaskId != .invalid else { return false }
        isActive = false
        UIApplication.shared.endBackgroundTask(backgroundTaskId)
        backgroundTaskId = .invalid
        return true
    }
}
#endif

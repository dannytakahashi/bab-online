import Foundation

/// Keeps the app running for a while after it leaves the foreground, so the socket survives a
/// brief app switch (iOS: a UIApplication background task, ~30 s; `KeepAlive+iOS.swift`).
/// SocketService holds one (`PlatformKeepAlive`).
protocol KeepAlive: AnyObject {
    /// A keep-alive is running (begun and neither ended nor expired).
    var isActive: Bool { get }
    /// The running keep-alive's identity (a new one each begin; 0 while none was granted).
    var token: Int { get }
    /// Starts one unless one is held; `expired` runs when the system is about to end it.
    /// False when one was held already (nothing changes).
    func begin(expired: @escaping () -> Void) -> Bool
    /// Ends the one held; false when none was (nothing changes).
    func end() -> Bool
}

#if os(iOS)
import UIKit
import SwiftUI

extension AppPresence {
    /// The scene's phase (BABOnlineApp's `scenePhase`): a real background, and the foreground
    /// after one. inactive -> active without a real background (Control Center, the
    /// notification shade, a permission alert) does nothing: the socket was never at risk, and
    /// a reconnect there looks like a real disconnect to the server.
    func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            guard didEnterBackground else { return }
            didEnterBackground = false
            perform(.foreground(withinKeepAlive: keepAliveRunning))
        case .background:
            didEnterBackground = true
            perform(.background)
        default:
            break
        }
    }

    /// May a table sound or the bid clock's tune play: only while the app is active (Notification
    /// Center, Control Center or the app switcher make it inactive, not background).
    var mayPlaySound: Bool { Self.mayPlaySound(UIApplication.shared.applicationState) }

    nonisolated static func mayPlaySound(_ state: UIApplication.State) -> Bool { state == .active }

    /// Posted when the app stops being active (the tune stops) or goes to the background.
    nonisolated static let resignActiveNotifications = [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification]
    /// Posted when the app is active again (the tune comes back at its place).
    nonisolated static let becomeActiveNotification = UIApplication.didBecomeActiveNotification
    /// The admin panel's reset link is covered (true) while the app is not in front: UIKit posts
    /// these on the main thread, before the app switcher's snapshot is taken (`scenePhase` read
    /// inside a sheet can lag behind it).
    /// The app is about to be terminated (voice's SFU session sends its sfuLeave then).
    nonisolated static let willTerminateNotification = UIApplication.willTerminateNotification
    nonisolated static let coverNotifications = [(UIApplication.willResignActiveNotification, true), (UIApplication.didBecomeActiveNotification, false)]
}
#endif

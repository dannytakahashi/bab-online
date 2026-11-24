import Foundation
import Combine

/// Whether the app is in front, as the table's sounds, the mic, the admin panel's link and the
/// socket's keep-alive need it (iOSClient/CLAUDE.md, "iOS project": shared code never reads
/// `scenePhase` or UIApplication state for policy, it asks this). The platform halves feed it:
/// `AppPresence+iOS.swift` (the scene phase and UIApplication's state and notifications,
/// unchanged from before this type) and, on macOS, sleep, wake and the screen lock.
///
/// The effects of a background and a foreground (the mic muted and restored, the socket's
/// keep-alive, the connection check) are the same on both platforms and run through `target`.
@MainActor
final class AppPresence: ObservableObject {
    static let shared = AppPresence()

    /// What a move between the background and the foreground means for the app.
    enum Transition: Equatable {
        /// Gone to the background (iOS: the scene reached `.background`; never `.inactive`).
        case background
        /// Back in front; `withinKeepAlive`: the background keep-alive was still running.
        case foreground(withinKeepAlive: Bool)
    }

    /// What a transition acts on (the app: the socket and the voice manager; tests: a recorder).
    @MainActor
    protocol Target: AnyObject {
        var isBackgroundTaskActive: Bool { get }
        var isConnected: Bool { get }
        func beginBackgroundKeepAlive()
        func endBackgroundKeepAlive()
        func forceReconnect()
        func resumeAfterKeepAlive()
        func voiceBackgrounded()
        func voiceForegrounded()
    }

    /// Every transition, after its effects ran.
    let transitions = PassthroughSubject<Transition, Never>()

    /// True once the app has actually reached the background (iOS: the scene's `.background`).
    /// Control Center, the notification shade and system alerts (e.g. the mic permission prompt)
    /// only make the scene `.inactive`, and must not tear down the socket.
    var didEnterBackground = false

    private let makeTarget: @MainActor () -> Target
    private lazy var target: Target = makeTarget()

    /// `target`: made on the first transition (the app: the socket and the voice manager).
    init(target: (@MainActor () -> Target)? = nil) {
        makeTarget = target ?? { LivePresenceTarget() }
    }

    /// The effects of `transition`, then `transitions` hears it.
    func perform(_ transition: Transition) {
        switch transition {
        case .foreground(let withinKeepAlive):
            // Restore voice mic state
            target.voiceForegrounded()

            if withinKeepAlive {
                // Returned within the background keep-alive window (~30s).
                // Socket likely still connected — end the task and only reconnect if needed.
                print("[App] Foregrounded within keep-alive window")
                target.endBackgroundKeepAlive()
                if !target.isConnected {
                    print("[App] Socket disconnected during background — force reconnecting")
                    target.forceReconnect()
                }
            } else {
                // Background task expired or was never started. iOS can silently kill the
                // WebSocket without firing a disconnect event, so `isConnected` alone proves
                // nothing here: the connection is kept only if it is connected, session-ready
                // and answers a round trip at once; otherwise a new one (forceReconnect).
                print("[App] Foregrounded after keep-alive expired — checking the connection")
                target.resumeAfterKeepAlive()
            }
        case .background:
            // Mute voice mic for privacy while backgrounded
            target.voiceBackgrounded()

            print("[App] Backgrounded — starting socket keep-alive")
            target.beginBackgroundKeepAlive()
        }
        transitions.send(transition)
    }

    /// The keep-alive is still running (a foreground now is `.foreground(withinKeepAlive: true)`).
    var keepAliveRunning: Bool { target.isBackgroundTaskActive }
}

/// The app's target: `SocketService.shared` and `VoiceChatManager.shared`.
@MainActor
final class LivePresenceTarget: AppPresence.Target {
    private let socket = SocketService.shared
    var isBackgroundTaskActive: Bool { socket.isBackgroundTaskActive }
    var isConnected: Bool { socket.isConnected }
    func beginBackgroundKeepAlive() { socket.beginBackgroundKeepAlive() }
    func endBackgroundKeepAlive() { socket.endBackgroundKeepAlive() }
    func forceReconnect() { socket.forceReconnect() }
    func resumeAfterKeepAlive() { socket.resumeAfterKeepAlive() }
    func voiceBackgrounded() { VoiceChatManager.shared.handleBackground() }
    func voiceForegrounded() { VoiceChatManager.shared.handleForeground() }
}

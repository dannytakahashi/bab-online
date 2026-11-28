#if os(iOS)
#if DEBUG
import UIKit
import Combine

/// `-uiGateFlip <mode>:<ms>` (main-room fixtures): the session gate moves around the scene's
/// transitions as a live foreground moves it, with no socket, so a UI test can hold the main
/// room's controls to the gate many times over (the vertical bar's New Game, owner 2026-11-27).
/// - `resume:<ms>`: at willEnterForeground the gate closes (the library found the dead
///   connection and reconnects), `<ms>` later it opens (the restore answered); at
///   didBecomeActive the foreground probe runs for 15 ms (kept).
/// - `rebuild:<ms>`: at didBecomeActive the probe runs, 300 ms later the connection is rebuilt
///   (session gate closed, probe released), and `<ms>` after that the restore answers.
/// - `background:<ms>`: 1 s after didEnterBackground the gate closes, `<ms>` later it opens,
///   both while the app is away.
/// - `snap:<ms>`: closed at willResignActive, opened `<ms>` after didEnterBackground, while
///   the system snapshots the app (the vertical bar re-hosted: none, then trailing).
/// - `snapflip:<ms>`: closed and opened 30 ms apart, `<ms>` after didEnterBackground.
/// The probe `mainRoom.gate` reads "ready=<0|1> probing=<0|1> flips=<n>".
extension UIFixture {
    @MainActor private static var gateFlipObservers: [NSObjectProtocol] = []
    @MainActor private static var gateFlipBag: Set<AnyCancellable> = []

    @MainActor
    static func installGateFlip() {
        let socket = SocketService.shared
        socket.$isSessionReady.combineLatest(socket.$isForegroundProbing)
            .receive(on: DispatchQueue.main)
            .sink { ready, probing in
                gateFlips += 1
                TableDebugProbe.shared.gate = "ready=\(ready ? 1 : 0) probing=\(probing ? 1 : 0) flips=\(gateFlips)"
            }
            .store(in: &gateFlipBag)
        guard let spec = UserDefaults.standard.string(forKey: "uiGateFlip") else { return }
        let parts = spec.split(separator: ":")
        let mode = parts.first.map(String.init) ?? ""
        let ms = parts.count > 1 ? (Double(parts[1]) ?? 100) : 100
        let center = NotificationCenter.default
        func after(_ ms: Double, _ body: @escaping @MainActor () -> Void) {
            DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000) { MainActor.assumeIsolated { body() } }
        }
        func on(_ name: Notification.Name, _ body: @escaping @MainActor () -> Void) {
            gateFlipObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { body() }
            })
        }
        switch mode {
        case "resume":
            on(UIApplication.willEnterForegroundNotification) {
                socket.isSessionReady = false
                after(ms) { socket.isSessionReady = true }
            }
            on(UIApplication.didBecomeActiveNotification) {
                socket.holdForegroundProbeForFixture()
                after(15) { socket.releaseForegroundProbeForFixture() }
            }
        case "rebuild":
            on(UIApplication.didBecomeActiveNotification) {
                socket.holdForegroundProbeForFixture()
                after(300) {
                    socket.isSessionReady = false
                    socket.releaseForegroundProbeForFixture()
                    after(ms) { socket.isSessionReady = true }
                }
            }
        case "snap":
            // the gate closes at the resign and opens `<ms>` after the background notification,
            // while the system snapshots the app (the vertical bar re-hosted: none -> trailing)
            on(UIApplication.willResignActiveNotification) { socket.isSessionReady = false }
            on(UIApplication.didEnterBackgroundNotification) { after(ms) { socket.isSessionReady = true } }
        case "snapflip":
            // closed and opened again 30 ms apart, `<ms>` after the background notification
            on(UIApplication.didEnterBackgroundNotification) {
                after(ms) { socket.isSessionReady = false; after(30) { socket.isSessionReady = true } }
            }
        case "background":
            on(UIApplication.didEnterBackgroundNotification) {
                after(1000) {
                    socket.isSessionReady = false
                    after(ms) { socket.isSessionReady = true }
                }
            }
        default:
            break
        }
    }

    @MainActor private static var gateFlips = 0
}
#endif
#endif

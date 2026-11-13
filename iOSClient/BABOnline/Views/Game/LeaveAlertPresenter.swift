import UIKit

/// The Leave confirmation as a UIKit alert, which LeaveAlertFlow closes and opens again.
///
/// Not SwiftUI's `.alert(isPresented:)`: when that alert was closed and presented again
/// (the flow's reopen), SwiftUI finished the first dismissal after the second presentation
/// and wrote `isPresented = false` while the new alert stayed on screen (a fixture trace:
/// true, false, true, false). SwiftUI then treated that alert as gone: its Leave Game ran no
/// action, so no /leave was sent and the player stayed at the table (verifier, 2026-11-13,
/// live 2/2). Here each presentation is its own UIAlertController: its buttons call back
/// for that controller only, and `close` reports the end of UIKit's real dismissal, so a
/// reopen never overlaps the previous alert (no timing guess).
@MainActor
final class LeaveAlertPresenter {
    enum Answer: Equatable { case leave, cancel }

    static let title = "Leave game?"

    /// The open alert (nil: none, or closing).
    private weak var alert: UIAlertController?

    var isUp: Bool { alert != nil }

    /// Opens the alert showing `message`; `answered` runs once, after the player taps a
    /// button (not after `close` or `discard`). false: there was nothing to present on.
    @discardableResult
    func present(message: String, answered: @escaping (Answer) -> Void) -> Bool {
        guard alert == nil, let host = Self.topController() else { return false }
        let a = UIAlertController(title: Self.title, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Leave Game", style: .destructive) { [weak self, weak a] _ in
            self?.answer(a, .leave, answered)
        })
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self, weak a] _ in
            self?.answer(a, .cancel, answered)
        })
        alert = a
        host.present(a, animated: true)
        return true
    }

    /// A button of the open alert: of an alert already closing (a reopen), it does nothing.
    private func answer(_ a: UIAlertController?, _ answer: Answer, _ answered: (Answer) -> Void) {
        guard let a, alert === a else { return }
        alert = nil
        answered(answer)
    }

    /// Dismisses the open alert; `done` runs once it is gone (UIKit's completion), so the
    /// next alert can be presented then. Nothing is open: nothing runs.
    func close(done: @escaping () -> Void) {
        guard let a = alert else { return }
        alert = nil  // from here its buttons do nothing (`answer`)
        guard a.presentingViewController != nil else { done(); return }
        a.dismiss(animated: true, completion: done)
    }

    /// The table went away: drop the alert without a callback.
    func discard() {
        guard let a = alert else { return }
        alert = nil
        if a.presentingViewController != nil { a.dismiss(animated: false) }
    }

    /// The controller on top of the key window (the SwiftUI host, or whatever it presents).
    private static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap(\.windows)
        var top = (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController
        while let next = top?.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }
}

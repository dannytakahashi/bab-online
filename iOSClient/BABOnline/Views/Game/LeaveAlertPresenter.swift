#if os(iOS)
import UIKit

/// A confirmation as a UIKit alert: the in-game Leave ("Exit game?", which LeaveAlertFlow closes
/// and opens again) and the tournament lobby's Leave / Cancel Tournament / Stop Watching
/// (TournamentLobbyMenu, whose open alert's message changes in place).
///
/// Not SwiftUI's `.alert(isPresented:)`: when that alert was closed and presented again
/// (the flow's reopen), SwiftUI finished the first dismissal after the second presentation
/// and wrote `isPresented = false` while the new alert stayed on screen (a fixture trace:
/// true, false, true, false). SwiftUI then treated that alert as gone: its Leave Game ran no
/// action, so no /leave was sent and the player stayed at the table (verifier, 2026-11-13,
/// live 2/2). Here each presentation is its own UIAlertController: its buttons call back
/// for that controller only, and `close` reports the end of UIKit's real dismissal, so a
/// reopen never overlaps the previous alert (no timing guess). Being UIKit it also lives apart
/// from the SwiftUI view that asks for it (the tournament lobby's menu is rebuilt with `.id`, and
/// a toolbar item's content is hosted again in the Duo's vertical bar), and it is always the
/// centred alert, never a popover anchored to its button.
@MainActor
final class LeaveAlertPresenter {
    /// `confirm`: the destructive button; `keep`: the cancel-role button.
    enum Answer: Equatable { case confirm, keep }

    /// The alert's words, and the identifiers of its two buttons (UIAlertAction's
    /// `accessibilityIdentifier`; nil: none, as the in-game alert, found by its titles).
    struct Words: Equatable {
        var title: String
        var message: String
        var confirm: String
        var keep: String
        var confirmIdentifier: String?
        var keepIdentifier: String?

        /// The in-game Leave ("Exit game?", #235): its words as they always were.
        static func exitGame(message: String) -> Words {
            Words(title: LeaveAlertPresenter.title, message: message, confirm: "Exit Game", keep: "Cancel")
        }
    }

    nonisolated static let title = "Exit game?"

    /// The open alert (nil: none, or closing).
    private weak var alert: UIAlertController?

    var isUp: Bool { alert != nil }

    /// The open alert is presented (UIKit sets its presenting controller as `present` runs): false
    /// for one UIKit refused to present or something else dismissed (review of PR #437). The
    /// tournament lobby discards such an alert so it never locks its entry point.
    var isPresented: Bool { alert?.presentingViewController != nil }

    /// The open alert's message (nil: none open).
    var message: String? { alert?.message }

    /// The in-game Leave: "Exit game?" showing `message` (`Words.exitGame`).
    @discardableResult
    func present(message: String, answered: @escaping (Answer) -> Void) -> Bool {
        present(.exitGame(message: message), answered: answered)
    }

    /// Opens the alert with `words`; `answered` runs once, after the player taps a
    /// button (not after `close` or `discard`). false: there was nothing to present on.
    @discardableResult
    func present(_ words: Words, answered: @escaping (Answer) -> Void) -> Bool {
        guard alert == nil, let host = Self.topController() else { return false }
        let a = UIAlertController(title: words.title, message: words.message, preferredStyle: .alert)
        let confirm = UIAlertAction(title: words.confirm, style: .destructive) { [weak self, weak a] _ in
            self?.answer(a, .confirm, answered)
        }
        let keep = UIAlertAction(title: words.keep, style: .cancel) { [weak self, weak a] _ in
            self?.answer(a, .keep, answered)
        }
        if let id = words.confirmIdentifier { confirm.accessibilityIdentifier = id }
        if let id = words.keepIdentifier { keep.accessibilityIdentifier = id }
        a.addAction(confirm)
        a.addAction(keep)
        alert = a
        host.present(a, animated: true)
        return true
    }

    /// The open alert's message changes where it stands (never closed and opened again: the
    /// buttons stay the same ones, under the player's finger). Nothing open: nothing changes.
    func update(message: String) {
        guard let a = alert, a.message != message else { return }
        a.message = message
    }

    /// Whether the open alert's destructive button can be tapped (nil: none open).
    var confirmEnabled: Bool? { confirmAction?.isEnabled }

    /// Enables or disables the open alert's destructive button where it stands (the tournament
    /// lobby's Cancel waits for the session). Nothing open: nothing changes.
    func setConfirmEnabled(_ on: Bool) {
        guard let action = confirmAction, action.isEnabled != on else { return }
        action.isEnabled = on
    }

    private var confirmAction: UIAlertAction? { alert?.actions.first { $0.style == .destructive } }

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

    /// The table (or the lobby, or the choice) went away: drop the alert without a callback.
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
#endif

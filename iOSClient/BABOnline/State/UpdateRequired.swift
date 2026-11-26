import Foundation
import Combine

/// s2c `updateRequired {message, url}` (2026-11-25, private, unsequenced; server
/// server/socket/upgradeGate.js): the server gates this build (its User-Agent build is below
/// MIN_IOS_BUILD, or the env BAB_MIN_IOS_BUILD that only raises it), so every request it sends
/// gets the update message only. From build 41 the app shows it as a full-screen update screen
/// with Open the App Store on every screen (ContentView, `UpdateRequiredView`), never just the
/// sign-in's red caption; the saved session is kept (nothing is signed out), so the updated app
/// comes back signed in. Builds 39 / 40 ignore the event.
struct UpdateRequiredNotice: Equatable {
    static let defaultMessage = "Update required. Please update BAB Online in the App Store."

    let message: String
    let url: URL

    /// Lenient: a missing or empty message is the default text, a url that is not the App
    /// Store's (contract pattern ^https://apps\.apple\.com/) is `AppStoreLink.url`.
    static func from(_ dict: [String: Any]?) -> UpdateRequiredNotice {
        let raw = (dict?["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let message = raw.isEmpty ? defaultMessage : String(raw.prefix(500))
        let url = (dict?["url"] as? String).flatMap { $0.hasPrefix("https://apps.apple.com/") ? URL(string: $0) : nil } ?? AppStoreLink.url
        return UpdateRequiredNotice(message: message, url: url)
    }
}

/// The one update notice of this app run (set by AuthSocketHandler; never cleared: a gated
/// build stays gated until it is updated).
final class UpdateRequiredState: ObservableObject {
    static let shared = UpdateRequiredState()
    @Published var notice: UpdateRequiredNotice?

    func receive(_ dict: [String: Any]?) {
        let n = UpdateRequiredNotice.from(dict)
        if n != notice { notice = n }
    }
}

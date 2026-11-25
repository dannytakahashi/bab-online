import Foundation
#if os(iOS)
import UIKit
import UniformTypeIdentifiers
#endif

/// The system pasteboard for a secret (the admin panel's reset link): this device only (no
/// Universal Clipboard) and gone once it expires.
enum Pasteboard {}

/// The keyboard (the first responder's text input).
enum Keyboard {}

#if os(iOS)
extension Pasteboard {
    /// `text` as plain text on this device only, removed at `expiresAt` (nil: kept).
    static func copySecret(_ text: String, expiresAt: Date?) {
        var options: [UIPasteboard.OptionsKey: Any] = [.localOnly: true]
        if let expires = expiresAt { options[.expirationDate] = expires }
        UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: text]], options: options)
    }
}

extension Keyboard {
    /// Ends text editing wherever it is (the keyboard goes down).
    static func dismiss() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}
#endif

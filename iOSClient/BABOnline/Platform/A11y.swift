import SpriteKit
#if os(iOS)
import UIKit
#endif

/// The platform's accessibility calls (VoiceOver on iOS, NSAccessibility on macOS). Shared code
/// says `A11y.announce`, `A11y.reduceMotion`, `node.speak(_:)` and `hideFromAccessibility()`,
/// never UIAccessibility.
enum A11y {}

/// What a SpriteKit element is to VoiceOver (iOS: UIAccessibilityTraits).
enum A11yRole: Equatable {
    case none, button
}

#if os(iOS)
extension A11y {
    /// Says `text` to VoiceOver (an announcement).
    static func announce(_ text: String) {
        UIAccessibility.post(notification: .announcement, argument: text)
    }

    /// Is Reduce Motion on (the system's setting)?
    static var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }
}

extension A11yRole {
    var traits: UIAccessibilityTraits {
        switch self {
        case .none: return .none
        case .button: return .button
        }
    }
}

extension SKNode {
    /// Not an accessibility element (also no `name`: see `role`). A label's text is listed even
    /// so (SpriteKit reads an SKLabelNode's text when it has no label of its own), so a label is
    /// given an empty one.
    func hideFromAccessibility() {
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        if self is SKLabelNode { accessibilityLabel = "" }
    }

    /// An accessibility element reading `label` (a card, a seat's name, a chat line, a bid). A named
    /// node may keep its `name` for lookups only with a label: SpriteKit reads a node without one by
    /// its name ("hand.card.Q_clubs", "seat.left"). Containers and drawing nodes take a `role` instead.
    func speak(_ label: String, role: A11yRole = .none) {
        isAccessibilityElement = true
        accessibilityLabel = label
        accessibilityTraits = role.traits
    }
}
#endif

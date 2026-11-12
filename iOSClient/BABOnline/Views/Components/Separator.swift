import SwiftUI

/// A 1 pt rule in the input-border color, vertical or horizontal (inside an
/// AnyLayout, where a Divider's orientation would follow the old stack).
struct Separator: View {
    var vertical: Bool

    var body: some View {
        Rectangle()
            .fill(Theme.inputBorder)
            .frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
            .frame(maxWidth: vertical ? nil : .infinity, maxHeight: vertical ? .infinity : nil)
    }
}

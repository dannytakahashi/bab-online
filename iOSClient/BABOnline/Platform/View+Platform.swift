import SwiftUI

// SwiftUI modifiers and placements that only one platform has, under one name. On iOS each
// helper is exactly the modifier or value the views used before (a rename); the macOS halves
// land with the macOS platform.

#if os(iOS)
extension ToolbarItemPlacement {
    /// The bar's leading edge (iOS: `.topBarLeading`).
    static var barLeading: ToolbarItemPlacement { .topBarLeading }
    /// The bar's trailing edge (iOS: `.topBarTrailing`).
    static var barTrailing: ToolbarItemPlacement { .topBarTrailing }
}

/// A text field's content type for AutoFill (iOS: UITextContentType).
typealias PlatformTextContentType = UITextContentType

extension View {
    /// A small title in the navigation bar (iOS: `navigationBarTitleDisplayMode(.inline)`).
    func inlineNavigationTitle() -> some View {
        navigationBarTitleDisplayMode(.inline)
    }

    /// No automatic capitals (iOS: `textInputAutocapitalization(.never)`).
    func noAutocapitalization() -> some View {
        textInputAutocapitalization(.never)
    }

    /// The grouped list look of settings screens (iOS: `.insetGrouped`).
    func groupedInsetList() -> some View {
        listStyle(.insetGrouped)
    }
}
#endif

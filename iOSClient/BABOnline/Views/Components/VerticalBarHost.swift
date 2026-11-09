import SwiftUI

/// What a screen inside a `VerticalBarHost` needs to know.
struct VerticalBarContext: Equatable {
    /// The system shows the vertical bar (the iPhone Duo's side column with the
    /// status bar: closed, open in landscape, book pose): the screen's bar
    /// controls are toolbar items there instead of its own header buttons.
    var usesVerticalBar: Bool
    /// The window's top safe-area inset, measured outside the navigation
    /// container; nil without one (before iOS 27.1).
    var windowTopInset: CGFloat?

    static let none = VerticalBarContext(usesVerticalBar: false, windowTopInset: nil)
}

/// Hosts a screen whose controls go into the vertical bar (iOS 27.1 SDK): standard
/// toolbar items that the system lays out in that column under the status bar, and
/// folds into its overflow menu when Live Activities need the room.
///
/// The screen is wrapped in a `NavigationStack` on every iOS 27.1 device (its
/// navigation bar hidden where no vertical bar is used, see `verticalBarChrome`),
/// so a fold or unfold never rebuilds it. `toolbarVerticalEdge` is nil where the
/// system never places a vertical bar (other phones, the iPad, the open Duo in
/// portrait). The screen should own its state: the container hosts its root in
/// its own controller.
struct VerticalBarHost<Screen: View>: View {
    private let screen: (VerticalBarContext) -> Screen

    init(@ViewBuilder screen: @escaping (VerticalBarContext) -> Screen) {
        self.screen = screen
    }

    var body: some View {
        if #available(iOS 27.1, *) {
            VerticalBarStack(screen: screen)
        } else {
            screen(.none)
        }
    }
}

@available(iOS 27.1, *)
private struct VerticalBarStack<Screen: View>: View {
    let screen: (VerticalBarContext) -> Screen

    @Environment(\.toolbarVerticalEdge) private var verticalEdge
    @State private var windowTopInset: CGFloat = 0

    var body: some View {
        NavigationStack {
            screen(VerticalBarContext(usesVerticalBar: verticalEdge != nil, windowTopInset: windowTopInset))
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.safeAreaInsets.top }) { windowTopInset = $0 }
        #if DEBUG
        .onChange(of: verticalEdge, initial: true) { _, edge in
            print("[Regions] vertical bar \(edge.map { "\($0)" } ?? "none")")
            if UIFixture.isActive { TableDebugProbe.shared.verticalBar = edge.map { "\($0)" } ?? "-" }
        }
        #endif
    }
}

extension View {
    /// The root of a `VerticalBarHost`: the navigation bar only while the screen
    /// shows bar controls, never a bar background, and the window's own top inset.
    /// With the vertical bar the navigation bar has no height but UIKit still
    /// places it 24 pt down, and the content's top safe area would end there;
    /// without it the bar is hidden, but it takes its full height for the first
    /// pass after launch. (The stack also lays its root out once at zero size:
    /// measure nothing at 0 x 0.)
    func verticalBarChrome(_ context: VerticalBarContext, showsBarControls: Bool) -> some View {
        self
            .safeAreaPadding(.top, context.windowTopInset ?? 0)
            .ignoresSafeArea(.container, edges: context.windowTopInset == nil ? [] : .top)
            .toolbar(showsBarControls ? .automatic : .hidden, for: .navigationBar)
            .toolbarBackground(.hidden, for: .navigationBar)
    }
}

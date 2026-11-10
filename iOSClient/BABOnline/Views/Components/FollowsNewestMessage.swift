import SwiftUI

extension View {
    /// Keeps a chat's message list on its newest message: when it appears,
    /// when a message arrives (animated), and when the list gets shorter (the
    /// keyboard opening, a layout change), so typing never hides the latest
    /// messages. Apply to the messages' ScrollView inside its ScrollViewReader.
    func followsNewestMessage<ID: Hashable>(_ proxy: ScrollViewProxy, lastID: ID?, count: Int) -> some View {
        modifier(FollowsNewestMessage(proxy: proxy, lastID: lastID, count: count))
    }
}

private struct FollowsNewestMessage<ID: Hashable>: ViewModifier {
    let proxy: ScrollViewProxy
    let lastID: ID?
    let count: Int
    @State private var height: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .onAppear { scrollToNewest(animated: false) }
            .onChange(of: count) { scrollToNewest(animated: true) }
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { newHeight in
                let shrank = height > 0 && newHeight < height - 0.5
                height = newHeight
                if shrank { scrollToNewest(animated: false) }
            }
    }

    private func scrollToNewest(animated: Bool) {
        guard let lastID else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(lastID, anchor: .bottom) }
        } else {
            proxy.scrollTo(lastID, anchor: .bottom)
        }
    }
}

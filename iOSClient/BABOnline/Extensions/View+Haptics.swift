import SwiftUI

extension View {
    func onTapWithHaptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .light, action: @escaping () -> Void) -> some View {
        self.onTapGesture {
            let generator = UIImpactFeedbackGenerator(style: style)
            generator.impactOccurred()
            action()
        }
    }
}

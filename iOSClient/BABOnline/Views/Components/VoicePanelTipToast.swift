import SwiftUI

/// The voice panel tip (VoicePanelTip): the info toast's look (ServerErrorToast), drawn by the
/// screen that shows the mic so it never covers it: the table pane's top (over the score bar,
/// where the other toasts show; the mic, my hand and the bid panel are lower), and just under
/// the game lobby's header (whose top-right corner holds the mic). Tap to dismiss.
struct VoicePanelTipToast: View {
    @ObservedObject private var tip = VoicePanelTip.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            if let text = tip.text {
                HStack(spacing: Theme.Space.s2) {
                    Image(systemName: "lightbulb.fill")
                        .foregroundColor(Theme.teamA)
                        .accessibilityHidden(true)
                    Text(text)
                        .font(.callout.bold())
                        .foregroundColor(Theme.textPrimary)
                        .multilineTextAlignment(.leading)
                        // wraps at the screen's width, never per glyph
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("voicePanelTip")
                .padding(.horizontal, Theme.Space.s4)
                .padding(.vertical, 10)
                .background(Theme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .elevation(Theme.Elevation.e2)
                .onTapGesture { tip.dismiss() }
                .frame(maxWidth: 520)
                .padding(.horizontal, Theme.Space.s4)
                .transition(.motion(.move(edge: .top).combined(with: .opacity), reduceMotion: reduceMotion))
            }
        }
        .frame(maxWidth: .infinity)
        // over the table: a few lines at most at the largest sizes (as the disconnect banner)
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .animation(.easeInOut(duration: 0.3), value: tip.text)
    }
}

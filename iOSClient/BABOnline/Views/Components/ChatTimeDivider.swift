import SwiftUI

/// The centred time line above a chat message (ChatTimestamps): small, secondary,
/// read by VoiceOver in its full form; re-labels itself each minute (Today ->
/// Yesterday at midnight).
struct ChatTimeDivider: View {
    let date: Date

    var body: some View {
        TimelineView(.everyMinute) { context in
            Text(ChatTimestamps.label(for: date, now: context.date))
                .font(.caption2.weight(.medium))
                .foregroundColor(Theme.textDim)
                .frame(maxWidth: .infinity)
                .padding(.top, Theme.Space.s2)
                .padding(.bottom, Theme.Space.s1)
                .accessibilityLabel(ChatTimestamps.spokenLabel(for: date, now: context.date))
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("chatTimeDivider")
        }
    }
}

extension View {
    /// This chat row, with the time divider above it when `divider` is true.
    func chatTimeDivider(_ divider: Bool, date: Date) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if divider { ChatTimeDivider(date: date) }
            self
        }
    }
}

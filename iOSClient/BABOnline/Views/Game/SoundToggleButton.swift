import SwiftUI

/// The table's speaker toggle, in the game log's header (the drawer, the Duo's docked
/// panel and book page alike): one tap from the Log button, and never a new obstacle in
/// TableLayout's measured corners. Remembered on the device (SoundPlayer "soundEnabled").
struct SoundToggleButton: View {
    @ObservedObject var sounds = SoundPlayer.shared

    var body: some View {
        Button(action: { sounds.isEnabled.toggle() }) {
            Image(systemName: sounds.isEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill")
                .foregroundColor(sounds.isEnabled ? Theme.textSecondary : Theme.textDim)
                .frame(minWidth: Theme.hitTarget, minHeight: Theme.hitTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("sound")
        .accessibilityLabel("Sound")
        .accessibilityValue(sounds.isEnabled ? "On" : "Off")
        .accessibilityAddTraits(.isToggle)
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .accessibilityShowsLargeContentViewer()
    }
}

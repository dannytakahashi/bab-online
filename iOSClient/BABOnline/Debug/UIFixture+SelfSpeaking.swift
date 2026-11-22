#if DEBUG
import SwiftUI

/// `-uiSelfSpeaking YES|pulse` (with `-uiVoice YES` or `-uiSpectatorVoice muted`): my own mic
/// starts unmuted and I am talking (fixture mode never starts voice, so nothing else sets
/// `isSelfSpeaking`): `YES` talks throughout, `pulse` talks and stops every 1.5 s, so a
/// screenshot or the probe sees the green glyph / ring follow it live. A tap still mutes (and
/// the speaking state then shows nothing, as with a real call).
extension UIFixture {
    /// `-uiBarFiller <n>` (0...9): n extra vertical bar items after the table's own, to push the
    /// bar into its overflow menu (which item folds first). `-uiBarMicPriority standard`: the
    /// bar's mic without `.visibilityPriority(.high)` (the control case).
    static let barFiller: Int = isActive ? min(9, max(0, UserDefaults.standard.integer(forKey: "uiBarFiller"))) : 0
    static let barMicPriority: String? = isActive ? UserDefaults.standard.string(forKey: "uiBarMicPriority") : nil

    static let selfSpeaking: String? = isActive ? UserDefaults.standard.string(forKey: "uiSelfSpeaking") : nil

    @MainActor
    static func runSelfSpeaking(_ voice: VoiceChatManager = .shared) async {
        guard let mode = selfSpeaking else { return }
        voice.isSelfMuted = false
        voice.isSelfSpeaking = true
        guard mode == "pulse" else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(1.5))
            voice.isSelfSpeaking.toggle()
        }
    }

    /// The `table.voice` probe's text: where my mic is drawn and the bar glyph's state.
    @MainActor
    static func voiceProbe(inBar: Bool, onFelt: Bool, listenOnly: Bool, voice: VoiceChatManager) -> String {
        guard inBar || onFelt else { return "at=-" }
        let symbol = VoiceBarButton.symbol(listenOnly: listenOnly, muted: voice.isSelfMuted)
        let tint: String
        switch VoiceBarButton.tint(listenOnly: listenOnly, muted: voice.isSelfMuted, speaking: voice.isSelfSpeaking) {
        case Theme.danger?: tint = "red"
        case Theme.success?: tint = "green"
        default: tint = "-"
        }
        return "at=\(inBar ? "bar" : "felt") symbol=\(symbol) tint=\(tint)"
    }
}
#endif

#if DEBUG
import SwiftUI

/// Live checks only (`-sfuProbe YES`, LiveSfuVoiceTests): the SFU transport's state as one
/// accessibility element on the tournament lobby (`voice.sfu.probe`, refreshed twice a second),
/// and a button that forces a recovery (`voice.sfu.iceRestart`: an ICE restart on the same
/// session, the undocumented form, confirmed from iOS against the DEV app). Never in a release.
struct SfuProbeView: View {
    static var isOn: Bool { UserDefaults.standard.bool(forKey: "sfuProbe") }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { _ in
            let _ = Self.pollRequests()
            let line = Self.line(VoiceChatManager.shared)
            VStack(alignment: .leading, spacing: 0) {
                Text(line)
                    .font(.system(size: 6))
                    .foregroundColor(.white.opacity(0.3))
                    .lineLimit(1)
                    .accessibilityLabel(line)
                    .accessibilityIdentifier("voice.sfu.probe")
                Button("sfu ice restart") { VoiceChatManager.shared.sfu.recover(force: true, why: "probe") }
                    .font(.system(size: 6))
                    .accessibilityIdentifier("voice.sfu.iceRestart")
            }
            .frame(width: 60, height: 16, alignment: .leading)
        }
    }

    /// `-sfuProbeCtl <host dir>` (the live run's ctl directory): a file `app-ice-restart` there
    /// forces a recovery (an ICE restart on a published session), as the button does; it is
    /// removed once acted on. A file channel, so a live test needs no tap on a tiny button.
    @MainActor
    static func pollRequests() -> Bool {
        guard let dir = UserDefaults.standard.string(forKey: "sfuProbeCtl"), !dir.isEmpty else { return false }
        let path = (dir as NSString).appendingPathComponent("app-ice-restart")
        guard FileManager.default.fileExists(atPath: path) else { return false }
        try? FileManager.default.removeItem(atPath: path)
        VoiceChatManager.shared.sfu.recover(force: true, why: "probe")
        return true
    }

    @MainActor
    static func line(_ m: VoiceChatManager) -> String {
        let s = m.sfu
        let state = s.connectionState.map(SfuVoice.name) ?? "-"
        let pulls = s.pulls.keys.sorted().map { u -> String in
            let rx = m.sfuInbound[u]
            let id = VoiceChatManager.sfuId(u)
            let vol = m.remoteTrackVolume(id).map { String(format: "%.2f", $0) } ?? "-"
            let on = m.remoteTrackEnabled(id).map { $0 ? "on" : "off" } ?? "-"
            let speaking = m.speakingPeers.contains(id) ? "talk" : "quiet"
            return "\(u):\(rx?.packets ?? 0):\(rx?.bytes ?? 0):\(vol):\(on):\(speaking)"
        }.joined(separator: ",")
        let status: String
        switch s.status {
        case .none: status = "none"
        case .admitted: status = "admitted"
        case .waiting(let cap): status = "waiting\(cap.map { "/\($0)" } ?? "")"
        case .out: status = "out"
        }
        return ["sfu", "status=\(status)", "pc=\(state)", "sid=\(s.sessionId.map(SfuVoice.short) ?? "-")",
                "pub=\(s.publishedTrackName ?? "-")", "sent=\(m.sfuBytesSent)", "muted=\(m.isSelfMuted)",
                "active=\(m.isActive)", "members=\(s.memberNames.count)", "pulls=\(pulls.isEmpty ? "-" : pulls)",
                "sessions=\(s.counts["session"] ?? 0)", "resumes=\(s.counts["resume"] ?? 0)",
                "restarts=\(s.counts["iceRestart"] ?? 0)", "ice=\(s.lastIceRestartMs.map(String.init) ?? "-")",
                "rec=\(s.recoveries.last?.replacingOccurrences(of: " ", with: "_") ?? "-")",
                "poll=\(m.speakingPollPeriod)", "audio=\(m.ownsAudioSession)"].joined(separator: " ")
    }
}
#endif

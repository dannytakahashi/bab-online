#if DEBUG
import Foundation

/// Who watches which hand in fixture mode (SeatWatchUITests): `-uiWatchers <seat>:<count>[,...]`
/// sends the table, right after the seed, the private wide `spectatorsUpdated` a capable socket
/// gets (the whole list, `shoulder` on the watchers' entries, docs/claude/spectators.md "Who
/// watches which hand"): `count` watchers of that seat's hand ("zach", "yan", "xena", ...), seat 0
/// plain spectators with no `shoulder` (today's list). E.g. `-uiWatchers 3:1,1:2,0:1`.
extension UIFixture {
    static let watchersSpec: String? = isActive ? UserDefaults.standard.string(forKey: "uiWatchers") : nil

    static let watcherNames = ["zach", "yan", "xena", "wes", "vic", "uma", "tod", "sal", "rae", "quin", "pia", "oto"]

    /// The list's entries for `spec` ("3:1,1:2,0:1"), in that order.
    static func watcherEntries(_ spec: String) -> [[String: Any]] {
        var out: [[String: Any]] = []
        for part in spec.split(separator: ",") {
            let pair = part.split(separator: ":").compactMap { Int($0) }
            guard pair.count == 2, (0...4).contains(pair[0]), pair[1] > 0 else { continue }
            for _ in 0..<pair[1] {
                let i = out.count
                let name = i < watcherNames.count ? watcherNames[i] : "watcher\(i + 1)"
                var entry: [String: Any] = ["username": name, "pic": 10 + i % 60]
                if pair[0] > 0 { entry["shoulder"] = pair[0] }
                out.append(entry)
            }
        }
        return out
    }

    @MainActor
    static func seedWatchers(_ store: GameState, _ snap: TableSnapshot) {
        guard let spec = watchersSpec else { return }
        let entries = watcherEntries(spec)
        _ = store.apply(serverEvent: "spectatorsUpdated", payload: [[
            "gameId": snap.gameId, "spectators": entries, "count": entries.count,
        ] as [String: Any]])
    }

    /// Spectator voice in fixture mode (fixture mode never starts voice): `-uiSpeakingSpectators
    /// <name>[,<name>]` makes a voice peer per name ("spk-<name>", the peer's username that name)
    /// and marks it talking (VoiceChatManager.speakingPeers), so the spectator badge's speaking
    /// outline, its list's dots and its VoiceOver value show (SpeakingWatchers decides who counts:
    /// a seat's name or mine never does). `?` is a talking peer with no username. With
    /// `-uiSpeakingStop <seconds>` they all stop talking after that long (the outline goes).
    /// E.g. `-uiWatchers 0:2 -uiSpeakingSpectators zach,yan`.
    static let speakingSpectators: [String] = isActive
        ? (UserDefaults.standard.string(forKey: "uiSpeakingSpectators") ?? "").split(separator: ",").map(String.init) : []
    static let speakingStop: TimeInterval? = isActive
        ? UserDefaults.standard.string(forKey: "uiSpeakingStop").flatMap(Double.init) : nil

    @MainActor
    static func seedSpeakingSpectators() {
        guard !speakingSpectators.isEmpty else { return }
        let voice = VoiceChatManager.shared
        var ids: [String] = []
        for (i, name) in speakingSpectators.enumerated() {
            let id = name == "?" ? "spk-unnamed-\(i)" : "spk-\(name)"
            voice.peerInfos[id] = VoiceChatManager.PeerInfo(username: name == "?" ? "" : name)
            ids.append(id)
        }
        voice.speakingPeers.formUnion(ids)
        if let after = speakingStop {
            DispatchQueue.main.asyncAfter(deadline: .now() + after) {
                MainActor.assumeIsolated { voice.speakingPeers.subtract(ids) }
            }
        }
    }
}
#endif

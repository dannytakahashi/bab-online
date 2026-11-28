#if DEBUG
import Foundation
@preconcurrency import WebRTC

/// Live checks only (`-meshProbeFile <host path>`, a Debug build on a simulator; never in a
/// release): every second the mesh's calls as one JSON object written to that file, for a host
/// script to count the calls per remote player and whether each one receives audio
/// (docs/claude/voice.md "One call per player after a reconnect"). Each call: the socket id it
/// is keyed by, the player, its ICE / connection / signaling state and its receiver's
/// inbound-rtp packets and bytes.
@MainActor
enum MeshProbe {
    private static var timer: Timer?

    static func startIfAsked(_ manager: VoiceChatManager) {
        guard timer == nil, let path = UserDefaults.standard.string(forKey: "meshProbeFile"), !path.isEmpty else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak manager] _ in
            MainActor.assumeIsolated {
                guard let manager else { return }
                write(manager, to: path)
            }
        }
    }

    private static func write(_ manager: VoiceChatManager, to path: String) {
        let calls = manager.meshProbeCalls()
        let mine = SocketService.shared.socketId ?? "-"
        var rows: [[String: Any]] = []
        let group = DispatchGroup()
        let lock = NSLock()
        for call in calls {
            var row: [String: Any] = [
                "id": call.socketId, "user": call.username,
                "ice": call.connection.iceConnectionState.rawValue,
                "conn": call.connection.connectionState.rawValue,
                "sig": call.connection.signalingState.rawValue,
                "packets": 0, "bytes": 0,
            ]
            guard let receiver = call.connection.transceivers.first(where: { $0.mediaType == .audio })?.receiver,
                  call.connection.signalingState != .closed else {
                lock.lock(); rows.append(row); lock.unlock()
                continue
            }
            group.enter()
            call.connection.statistics(for: receiver) { report in
                if let c = SpeakingPoll.inboundCounters(report.statistics.values.map { ($0.type, $0.values) }) {
                    row["packets"] = c.packets
                    row["bytes"] = c.bytes
                }
                lock.lock(); rows.append(row); lock.unlock()
                group.leave()
            }
        }
        let active = manager.isActive
        group.notify(queue: .main) {
            let doc: [String: Any] = ["t": Date().timeIntervalSince1970, "me": mine, "active": active, "calls": rows]
            guard let data = try? JSONSerialization.data(withJSONObject: doc, options: [.sortedKeys]) else { return }
            try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
    }
}
#endif

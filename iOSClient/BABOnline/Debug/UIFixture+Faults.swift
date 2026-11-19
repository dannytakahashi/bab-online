#if DEBUG
import Foundation

/// Fault rows in fixture mode (FaultRowsUITests; no server). `-uiFaults YES`: the seeded
/// snapshot's log ends with an earlier hand's lines and its two stored fault lines (the server's
/// gameLogEntry `fault`, rules.handFaults), so they replay red; 2 s after launch one more fault
/// line arrives live (sequenced, as handleHandComplete sends it); 4 s after launch the table is
/// restored from a snapshot that holds all three (a reconnect), so each shows exactly once.
extension UIFixture {
    static let faultsMode: Bool = isActive && UserDefaults.standard.bool(forKey: "uiFaults")

    /// The live line's text (the third fault row).
    static let liveFaultLine = "Fault: hal (bid 4, took 2)"

    private static func faultEntries(_ snap: [String: Any]) -> [[String: Any]] {
        let at = ((snap["log"] as? [[String: Any]])?.last?["at"] as? Int) ?? 1_767_268_800_000
        return [
            ["message": "Hand 1 over. ivy and hal were set.", "type": "system", "position": NSNull(), "at": at + 1],
            ["message": "Fault: ivy (bid 3, took 1)", "type": "system", "position": NSNull(), "at": at + 1,
             "fault": ["position": 1, "bid": 3, "took": 1]],
            ["message": "Fault: hal (bid 2, took 0)", "type": "system", "position": NSNull(), "at": at + 1,
             "fault": ["position": 3, "bid": 2, "took": 0]],
        ]
    }

    /// The snapshot's log with the stored fault lines (before it is decoded).
    /// `-uiSnapshotHelpUses <n>`: the snapshot's viewer.assist says n /help uses this game (a
    /// rejoin after n; the chat list's count).
    static func editFaults(_ snap: inout [String: Any]) {
        guard isActive else { return }
        if let n = Int(UserDefaults.standard.string(forKey: "uiSnapshotHelpUses") ?? ""), n >= 0,
           var viewer = snap["viewer"] as? [String: Any] {
            viewer["assist"] = ["uses": n, "freeUses": 3, "assisted": n > 3]
            snap["viewer"] = viewer
        }
        guard faultsMode else { return }
        var log = snap["log"] as? [[String: Any]] ?? []
        log += faultEntries(snap)
        snap["log"] = log
    }

    @MainActor
    static func seedFaults(_ store: GameState, _ snap: TableSnapshot) {
        guard faultsMode, var dict = seededSnapshot else { return }
        let seq = snap.seq + 1
        let live: [String: Any] = ["message": liveFaultLine, "type": "system", "seq": seq,
                                   "fault": ["position": 3, "bid": 4, "took": 2]]
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            MainActor.assumeIsolated { _ = store.apply(serverEvent: "gameLogEntry", payload: [live]) }
        }
        // the reconnect: the server's snapshot now stores the live line too
        var log = dict["log"] as? [[String: Any]] ?? []
        let at = (log.last?["at"] as? Int ?? 0) + 1
        log.append(["message": liveFaultLine, "type": "system", "position": NSNull(), "at": at, "fault": live["fault"] as Any])
        dict["log"] = log
        dict["seq"] = seq
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
            MainActor.assumeIsolated {
                guard let again = try? TableSnapshot.decode(dict, strict: true) else { print("[UIFixture] fault snapshot did not decode"); return }
                seededSnapshot = dict
                store.apply(.snapshot(again, .rejoin, hints: nil))
            }
        }
    }
}
#endif

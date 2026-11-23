#if DEBUG
import Foundation
import SwiftUI

/// Fault rows in fixture mode (FaultRowsUITests; no server). `-uiFaults YES`: the seeded
/// snapshot's log ends with an earlier hand's lines and its two stored fault lines (the server's
/// gameLogEntry `fault`, rules.handFaults), so they replay red; 2 s after launch one more fault
/// line arrives live (sequenced, as handleHandComplete sends it); 4 s after launch the table is
/// restored from a snapshot that holds all three (a reconnect), so each shows exactly once.
/// Before them the log holds one stored /help room notice (`help`), a gold row, and one stored
/// tutorial line (`tutorial`, hal's), a row in the cap's colour that puts no cap on hal's avatar.
extension UIFixture {
    static let faultsMode: Bool = isActive && UserDefaults.standard.bool(forKey: "uiFaults")

    /// The live line's text (the third fault row).
    static let liveFaultLine = "Fault: hal (bid 4, took 2)"

    private static func faultEntries(_ snap: [String: Any]) -> [[String: Any]] {
        let at = ((snap["log"] as? [[String: Any]])?.last?["at"] as? Int) ?? 1_767_268_800_000
        return [
            // the /help room notice (server `help`, drawn gold): replayed in place too
            ["message": "ivy used /help.", "type": "system", "position": NSNull(), "at": at, "help": ["position": 1]],
            // a tutorial line (server `tutorial`, drawn in the cap's colour): replayed, it styles only
            ["message": "hal is playing with the tutorial.", "type": "system", "position": NSNull(), "at": at,
             "tutorial": ["position": 3, "on": true]],
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

    /// `-uiLogProbe YES` (DEBUG, also outside fixture mode: LiveFaultRowsTests against a local
    /// server): the probe "table.logFaults" lists the game log's red rows, whether or not the
    /// log's lazy list has them on screen.
    static let logProbe: Bool = UserDefaults.standard.bool(forKey: "uiLogProbe")
}

/// "table.logFaults": "<n>: <row> | <row> ..." (the log's fault rows in order; "0:" none).
struct LogFaultsProbe: View {
    let rows: [ChatMessage]

    var body: some View {
        let faults = rows.filter(\.isFault).map(\.message)
        VStack(spacing: 0) {
            Rectangle()
                .fill(Color.black)
                .frame(width: 1, height: 1)
                .opacity(0.01)
                .accessibilityElement()
                .accessibilityLabel("table.logFaults")
                .accessibilityIdentifier("table.logFaults")
                .accessibilityValue("\(faults.count): " + faults.joined(separator: " | "))
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .allowsHitTesting(false)
    }
}
#endif

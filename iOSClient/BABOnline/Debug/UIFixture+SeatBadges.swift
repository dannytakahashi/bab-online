#if DEBUG
import Foundation

/// The avatar badges in fixture mode (SeatBadgesUITests; no server). `-uiSeatBadges
/// bulb:<pos>,cap:<pos>,pop:<pos>` (any of them, each may repeat): the seeded snapshot's seats
/// carry `askedHelp` (bulb) and `tutorial` (cap) as the server's do, so they show at launch with no
/// pop; `pop:<pos>` sends that seat's live /help room notice ("<name> used /help." with `help
/// {position}`, sequenced, as the server broadcasts it) 2 s after launch: its lightbulb pops in
/// (probe "table.badges" pops=1; `-uiReduceMotion YES`: the fade).
extension UIFixture {
    static let seatBadges: [(kind: String, position: Int)] = {
        guard isActive, let spec = UserDefaults.standard.string(forKey: "uiSeatBadges") else { return [] }
        return spec.split(separator: ",").compactMap { item in
            let parts = item.split(separator: ":").map(String.init)
            guard parts.count == 2, ["bulb", "cap", "pop"].contains(parts[0]), let pos = Int(parts[1]), (1...4).contains(pos) else { return nil }
            return (parts[0], pos)
        }
    }()

    /// The snapshot's seats with the badges (before it is decoded).
    static func editSeatBadges(_ snap: inout [String: Any]) {
        guard !seatBadges.isEmpty, var seats = snap["seats"] as? [[String: Any]] else { return }
        for i in seats.indices {
            guard let pos = seats[i]["position"] as? Int else { continue }
            if seatBadges.contains(where: { $0.kind == "bulb" && $0.position == pos }) { seats[i]["askedHelp"] = true }
            if seatBadges.contains(where: { $0.kind == "cap" && $0.position == pos }) { seats[i]["tutorial"] = true }
        }
        snap["seats"] = seats
    }

    @MainActor
    static func seedSeatBadges(_ store: GameState, _ snap: TableSnapshot) {
        let pops = seatBadges.filter { $0.kind == "pop" }.map(\.position)
        guard !pops.isEmpty else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            MainActor.assumeIsolated {
                for pos in pops {
                    let name = snap.seats.first { $0.position == pos }?.username ?? "P\(pos)"
                    let seq = (store.state.sync.lastSeq ?? snap.seq) + 1
                    _ = store.apply(serverEvent: "gameLogEntry", payload: [[
                        "message": "\(name) used /help.", "type": "system", "seq": seq, "help": ["position": pos],
                    ] as [String: Any]])
                }
            }
        }
    }
}
#endif

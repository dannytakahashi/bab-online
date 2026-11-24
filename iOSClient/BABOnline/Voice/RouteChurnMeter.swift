import Foundation

/// Route-change churn, for telemetry: more than `limit` route changes within `window` while
/// voice runs is reported once per launch (clientError kind `voiceRouteChurn`, with the
/// reasons seen), so a loop on a device shows in the server log. Pure.
struct RouteChurnMeter {
    static let window: TimeInterval = 10
    static let limit = 20

    private(set) var times: [TimeInterval] = []
    private(set) var reasons: [UInt: Int] = [:]

    /// Records one change; true the first time the window holds more than `limit`.
    mutating func record(reason: UInt, at now: TimeInterval) -> Bool {
        times = times.filter { now - $0 < Self.window }
        times.append(now)
        reasons[reason, default: 0] += 1
        return times.count == Self.limit + 1
    }

    /// "reasons 3:12, 8:9" (AVAudioSession.RouteChangeReason raw values, most first).
    var summary: String {
        "reasons " + reasons.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
            .map { "\($0.key):\($0.value)" }.joined(separator: ", ")
    }
}

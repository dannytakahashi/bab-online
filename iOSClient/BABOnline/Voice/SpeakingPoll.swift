import Foundation

/// The speaking indicator's poll (iOS 1.2.7, for the tournament voice room of up to 20 people:
/// 19 calls each; the Cut for a buck spec section 8; docs/claude/voice.md "Speaking levels at 20").
/// Through 1.2.6 every call was asked for its whole stats report every 100 ms (every candidate
/// pair, codec, transport and certificate of the call): with 19 calls that is 190 full reports a
/// second. Now each call is asked for its own receiver's stats only (`statistics(for:
/// receiver)`, a handful of objects; mine from one call's sender), one request at a time per
/// call, and past 8 calls the poll runs every 200 ms. The hold stays 400 ms, two polls at the
/// slower rate, so a word never flickers the ring off between polls.
enum SpeakingPoll {
    /// Up to this many calls the poll runs every `baseInterval` (the family lobby's 7, the
    /// tournament room's default 8 people).
    static let busyCalls = 8
    static let baseInterval: TimeInterval = 0.1
    static let busyInterval: TimeInterval = 0.2
    /// How long a level above the threshold keeps the ring on.
    static let hold: TimeInterval = 0.4

    static func interval(calls: Int) -> TimeInterval {
        calls > busyCalls ? busyInterval : baseInterval
    }

    /// The loudest inbound audio level in a receiver's stats (inbound-rtp, kind audio).
    static func inboundLevel(_ stats: [(type: String, values: [String: NSObject])]) -> Float {
        stats.reduce(Float(0)) { best, s in
            guard s.type == "inbound-rtp", kind(s.values) == "audio" else { return best }
            return max(best, level(s.values))
        }
    }

    /// My level in a sender's stats: its outbound-rtp audio level, or the media-source's (where
    /// libwebrtc reports the microphone's level).
    static func outboundLevel(_ stats: [(type: String, values: [String: NSObject])]) -> Float {
        stats.reduce(Float(0)) { best, s in
            guard s.type == "outbound-rtp" || s.type == "media-source", kind(s.values) == "audio" else { return best }
            return max(best, level(s.values))
        }
    }

    private static func kind(_ values: [String: NSObject]) -> String? {
        values["kind"] as? String
    }

    private static func level(_ values: [String: NSObject]) -> Float {
        guard let n = values["audioLevel"] as? NSNumber, n.doubleValue.isFinite else { return 0 }
        return Float(n.doubleValue)
    }
}

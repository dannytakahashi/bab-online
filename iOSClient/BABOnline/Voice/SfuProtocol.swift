import Foundation

/// The Cloudflare SFU client protocol's wire and rules (docs/claude/voice.md "SFU voice (server)",
/// "The client protocol", steps 1-15; "SFU voice, iOS" for this app's choices). Pure: parsing the
/// server's sfuRoster / sfuMember / sfuReply, what each error code means, the pull plan, the
/// recovery choice and the downlink stall rule. The transport that acts on them is `SfuVoice`.
enum SfuPolicy {
    /// The clientHello cap (contract `$defs.clientCapSfuVoice`, server/voice/sfu/config.js): with
    /// it, and the server flag `VOICE_SFU=tournament`, the tournament lobby's voice room is an SFU
    /// room. A server with the flag off ignores it (the mesh exactly as before).
    static let cap = "sfuVoice"
    /// This app's one published track per session (step 4).
    static let trackName = "mic"
    /// The SFU's STUN server (step 3; what the spike and the server's smoke run used).
    static let stunServer = "stun:stun.cloudflare.com:3478"

    /// Step 8: wait at most this long for any reply (the server answers within about 11 s: a 3 s
    /// queue deadline plus one 8 s Cloudflare call).
    static let replyTimeout: TimeInterval = 12
    /// Step 8: the retry backoff for rate_limited / busy / timeout / cloudflare_unreachable /
    /// retryable cloudflare_error (at least the server's retryAfterMs).
    static let backoff: [TimeInterval] = [0.5, 1, 2, 4]
    /// Step 9: never act on the first `disconnected` (5-12 s drops heal by themselves).
    static let disconnectWait: TimeInterval = 2
    /// Step 9: away under this long (and the session not 410'd, a track published): an ICE
    /// restart on the same session; else a new session.
    static let iceRestartWindow: TimeInterval = 25
    /// Step 9: an ICE restart waits this long for `connected`, at most `maxIceRestarts` tries.
    static let iceRestartConnectWait: TimeInterval = 6
    static let maxIceRestarts = 2
    /// Step 10: every pulled track silent this long while connected = a downlink stall, acted on
    /// at most once per `stallCooldown`.
    static let stallWindow: TimeInterval = 2
    static let stallCooldown: TimeInterval = 10
    /// Step 12: after a new bootId, no pull of a member who is missing or has a null session is
    /// closed for this long (they are re-registering).
    static let restartHold: TimeInterval = 20
    /// Step 5: Cloudflare's empty_track_error / not_found_track_error (the publisher has no media
    /// yet, or it went): that track again every second, at most 10 times.
    static let pullRetryDelay: TimeInterval = 1
    static let pullRetries = 10
    /// Cloudflare's per-request track limit (step 5).
    static let maxPullBatch = 64

    /// The delay before retry `attempt` (0-based) of a retryable refusal.
    static func backoffDelay(attempt: Int, retryAfterMs: Int?) -> TimeInterval {
        let base = backoff[min(max(attempt, 0), backoff.count - 1)]
        let server = retryAfterMs.map { TimeInterval($0) / 1000 } ?? 0
        return max(base, server)
    }
}

/// A member's record as the server announces it (`$defs.sfuMemberEntry`).
struct SfuMemberRecord: Equatable {
    enum State: String { case live, reconnecting }
    var username: String
    var sessionId: String?
    var trackName: String?
    var state: State

    /// The published track (both set), the pair a pull is of.
    var track: SfuTrackKey? {
        guard let sessionId, let trackName else { return nil }
        return SfuTrackKey(sessionId: sessionId, trackName: trackName)
    }

    static func from(_ any: Any?) -> SfuMemberRecord? {
        guard let d = any as? [String: Any], let username = d["username"] as? String, !username.isEmpty else { return nil }
        return SfuMemberRecord(username: username,
                               sessionId: Self.nonEmpty(d["sessionId"]),
                               trackName: Self.nonEmpty(d["trackName"]),
                               state: State(rawValue: d["state"] as? String ?? "") ?? .live)
    }

    static func nonEmpty(_ any: Any?) -> String? {
        guard let s = any as? String, !s.isEmpty else { return nil }
        return s
    }
}

/// A published track: a member's session and its track name.
struct SfuTrackKey: Hashable {
    var sessionId: String
    var trackName: String
}

/// s2c sfuRoster: the room as this member sees it (to one socket when it enters, comes back on a
/// new socket, draws its lobby again, is let in from the line or put in it, or leaves).
struct SfuRoster: Equatable {
    enum Status: String { case admitted, waiting, out }
    struct Me: Equatable {
        var sessionId: String?
        var trackName: String?
        var state: SfuMemberRecord.State
    }
    var tournamentId: String
    var bootId: String
    var rev: Int
    var status: Status
    var cap: Int?
    var graceMs: Int?
    var me: Me?
    var members: [SfuMemberRecord]

    static func from(_ any: Any?) -> SfuRoster? {
        guard let d = any as? [String: Any], let tournamentId = d["tournamentId"] as? String,
              let bootId = d["bootId"] as? String,
              let status = Status(rawValue: d["status"] as? String ?? "") else { return nil }
        var me: Me?
        if let s = d["self"] as? [String: Any] {
            me = Me(sessionId: SfuMemberRecord.nonEmpty(s["sessionId"]), trackName: SfuMemberRecord.nonEmpty(s["trackName"]),
                    state: SfuMemberRecord.State(rawValue: s["state"] as? String ?? "") ?? .live)
        }
        let members = (d["members"] as? [Any] ?? []).compactMap(SfuMemberRecord.from)
        return SfuRoster(tournamentId: tournamentId, bootId: bootId, rev: Self.int(d["rev"]) ?? 0, status: status,
                         cap: Self.int(d["cap"]), graceMs: Self.int(d["graceMs"]), me: me, members: members)
    }

    static func int(_ any: Any?) -> Int? {
        if TournamentRounds.isBoolean(any) { return nil }
        if let n = any as? Int { return n }
        if let n = any as? NSNumber { return n.intValue }
        return nil
    }
}

/// s2c sfuMember: one other member's new record (apply it as an upsert; `left` removes).
struct SfuMemberEvent: Equatable {
    var tournamentId: String
    var bootId: String
    var rev: Int
    var event: String
    var member: SfuMemberRecord

    var isLeft: Bool { event == "left" }

    static func from(_ any: Any?) -> SfuMemberEvent? {
        guard let d = any as? [String: Any], let tournamentId = d["tournamentId"] as? String,
              let event = d["event"] as? String, let member = SfuMemberRecord.from(d["member"]) else { return nil }
        return SfuMemberEvent(tournamentId: tournamentId, bootId: d["bootId"] as? String ?? "",
                              rev: SfuRoster.int(d["rev"]) ?? 0, event: event, member: member)
    }
}

/// An sfuReply's error (`$defs.sfuError`), or the client's own reply timeout.
struct SfuError: Equatable, Error {
    var code: String
    var retryable: Bool
    var retryAfterMs: Int?
    var status: Int?
    var cfCode: String?

    /// No reply within `SfuPolicy.replyTimeout` (never on the wire: the client's own).
    static let clientTimeout = SfuError(code: "client_timeout", retryable: false, retryAfterMs: nil, status: nil, cfCode: nil)

    static func from(_ any: Any?) -> SfuError {
        guard let d = any as? [String: Any] else {
            return SfuError(code: "server_error", retryable: false, retryAfterMs: nil, status: nil, cfCode: nil)
        }
        return SfuError(code: d["code"] as? String ?? "server_error", retryable: d["retryable"] as? Bool ?? false,
                        retryAfterMs: SfuRoster.int(d["retryAfterMs"]), status: SfuRoster.int(d["status"]),
                        cfCode: d["cfCode"] as? String)
    }
}

/// What step 8 says to do with a refused request.
enum SfuErrorAction: Equatable {
    /// rate_limited / busy / timeout / cloudflare_unreachable / a retryable cloudflare_error or
    /// server_error: the same request again after the backoff.
    case retry
    /// session_gone (410): the session is dead; never retry on it: a new session, push again if
    /// published, re-pull everyone. Also the client's own reply timeout (the session's state at
    /// the SFU is unknown then: a pull may have opened mids nobody mapped).
    case newSession
    /// not_your_session: this socket has not resumed that session: sfuResume (else a new one).
    case resume
    /// not_in_room: SFU voice stops until the next sfuRoster.
    case stopUntilRoster
    /// superseded: the work belonged to a replaced session.
    case drop
    /// invalid / bad_token / already_published / no_local_track / unavailable, a cloudflare_error
    /// that is not retryable: a bug or a state change, never the same request again.
    case giveUp

    static func of(_ error: SfuError) -> SfuErrorAction {
        switch error.code {
        case "session_gone", "client_timeout": return .newSession
        case "superseded": return .drop
        case "not_your_session": return .resume
        case "not_in_room": return .stopUntilRoster
        case "rate_limited", "busy", "timeout", "cloudflare_unreachable": return .retry
        case "cloudflare_error", "server_error": return error.retryable ? .retry : .giveUp
        default: return .giveUp
        }
    }
}

/// A per-track result of a pull (`$defs.sfuPulledTrack`).
struct SfuPulledTrack: Equatable {
    var username: String?
    var key: SfuTrackKey?
    var mid: String?
    var errorCode: String?

    static func from(_ any: Any?) -> SfuPulledTrack? {
        guard let d = any as? [String: Any] else { return nil }
        var key: SfuTrackKey?
        if let s = SfuMemberRecord.nonEmpty(d["sessionId"]), let t = SfuMemberRecord.nonEmpty(d["trackName"]) {
            key = SfuTrackKey(sessionId: s, trackName: t)
        }
        return SfuPulledTrack(username: d["username"] as? String, key: key, mid: SfuMemberRecord.nonEmpty(d["mid"]),
                              errorCode: SfuMemberRecord.nonEmpty(d["errorCode"]))
    }

    /// What a failed track means (step 5).
    enum Outcome: Equatable { case pulled, retryLater, refused }
    var outcome: Outcome {
        if let errorCode {
            return ["empty_track_error", "not_found_track_error"].contains(errorCode) ? .retryLater : .refused
        }
        return mid == nil ? .refused : .pulled
    }
}

/// Step 6 / 12: which pulls to close and which tracks to pull, from the pulls I HOLD (per
/// username) and the members as announced, never from the last roster value.
enum SfuPlan {
    struct Result: Equatable {
        /// Usernames whose pull closes (left, unpublished, or a new session / track).
        var close: [String] = []
        /// Tracks to pull (after the closes), in username order.
        var pull: [(username: String, key: SfuTrackKey)] = []

        static func == (a: Result, b: Result) -> Bool {
            a.close == b.close && a.pull.map(\.username) == b.pull.map(\.username) && a.pull.map(\.key) == b.pull.map(\.key)
        }
    }

    /// `held`: my pulls by username; `members`: the other members (an upsert view); `busy`:
    /// usernames whose pull is in flight or waits for a retry; `refused`: tracks the server
    /// refused (not until the roster changes); `holding`: inside the restart hold (step 12).
    static func reconcile(held: [String: SfuTrackKey], members: [String: SfuMemberRecord],
                          busy: Set<String> = [], refused: [String: SfuTrackKey] = [:], holding: Bool = false) -> Result {
        var out = Result()
        for (username, key) in held.sorted(by: { $0.key < $1.key }) {
            guard let m = members[username] else {
                if !holding { out.close.append(username) }  // left (or still missing after the hold)
                continue
            }
            if m.state == .reconnecting { continue }  // it may come back on the same session: keep
            guard let now = m.track else {
                // unpublished; a null session inside the hold is a member re-registering
                if !(holding && m.sessionId == nil) { out.close.append(username) }
                continue
            }
            if now != key { out.close.append(username) }  // a new session or track: close, then pull it
        }
        let closing = Set(out.close)
        for (username, m) in members.sorted(by: { $0.key < $1.key }) {
            guard let key = m.track, !busy.contains(username) else { continue }
            if held[username] != nil && !closing.contains(username) { continue }  // the pull I hold stays
            if refused[username] == key { continue }
            out.pull.append((username, key))
        }
        return out
    }

    /// Up to `SfuPolicy.maxPullBatch` tracks per sfuPull.
    static func batches<T>(_ items: [T], size: Int = SfuPolicy.maxPullBatch) -> [[T]] {
        stride(from: 0, to: items.count, by: max(size, 1)).map { Array(items[$0..<min($0 + size, items.count)]) }
    }
}

/// Step 9: how a media drop is recovered.
enum SfuRecovery: Equatable {
    case iceRestart
    case newSession

    /// `away`: since the connection was lost; `published`: this session pushed a track (the
    /// restart form re-declares it: a pull-only session answers no_local_track).
    /// `everConnected`: the session's PeerConnection was connected once. One that never was
    /// (made while the path to the SFU was down) is replaced, never restarted: measured live
    /// (2026-11-26), a session that pushed while cut off and connected only through an ICE
    /// restart was heard by nobody (the others' pulls of its track timed out at Cloudflare),
    /// while a new session after the network came back was heard at once.
    static func decide(away: TimeInterval, sessionGone: Bool, published: Bool, restartTries: Int,
                       everConnected: Bool = true) -> SfuRecovery {
        guard !sessionGone, published, everConnected, restartTries < SfuPolicy.maxIceRestarts,
              away < SfuPolicy.iceRestartWindow else { return .newSession }
        return .iceRestart
    }
}

/// Step 10: the downlink stall detector over the per-receiver stats the speaking poll reads.
struct SfuStallDetector {
    private(set) var lastPackets: [String: Int] = [:]
    private(set) var lastRxAt: [String: Date] = [:]
    private(set) var lastFired: Date?

    /// A pulled track's packetsReceived at `now` (a new track starts its clock at its first sample).
    mutating func sample(_ id: String, packets: Int, now: Date) {
        if let last = lastPackets[id], packets <= last {
            if lastRxAt[id] == nil { lastRxAt[id] = now }
        } else {
            lastRxAt[id] = now
        }
        // a counter never goes back for one receiver (a new pull starts with `forget`)
        lastPackets[id] = max(lastPackets[id] ?? 0, packets)
    }

    mutating func forget(_ id: String) {
        lastPackets[id] = nil
        lastRxAt[id] = nil
    }

    mutating func reset() {
        lastPackets = [:]
        lastRxAt = [:]
    }

    /// Fire (an ICE restart though ICE says connected) when connected, pulling `pulls` (at least
    /// one) and EVERY one of them received nothing for `stallWindow`, at most once per cooldown.
    /// A track that never received a packet does not count as stalled (the SFU may not have
    /// started forwarding it yet; the NAT rebinding case is tracks that were flowing).
    mutating func check(connected: Bool, pulls: Set<String>, now: Date) -> Bool {
        guard connected, !pulls.isEmpty else { return false }
        for id in pulls {
            guard let at = lastRxAt[id], (lastPackets[id] ?? 0) > 0,
                  now.timeIntervalSince(at) >= SfuPolicy.stallWindow else { return false }
        }
        if let lastFired, now.timeIntervalSince(lastFired) < SfuPolicy.stallCooldown { return false }
        lastFired = now
        return true
    }
}

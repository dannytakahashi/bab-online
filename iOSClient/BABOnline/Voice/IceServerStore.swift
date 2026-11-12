import Foundation

/// One RTCIceServer from `voiceIceServers` ($defs.iceServer). The credential is
/// short-lived TURN material: it is never printed (the descriptions below
/// leave it out), logged or persisted; it lives in memory for the session only.
struct IceServerEntry: Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    var urls: [String]
    var username: String?
    var credential: String?

    var description: String { "IceServer(\(urls.map { $0.split(separator: ":").first.map(String.init) ?? "?" }.joined(separator: ",")))" }
    var debugDescription: String { description }
}

/// The ICE servers of the current voice session (roadmap 29; V1_REMOVALS "iOS TURN").
struct IceConfig: Equatable, CustomStringConvertible {
    var servers: [IceServerEntry]
    /// Cloudflare TURN (true) or the public STUN servers (false).
    var turn: Bool
    /// When the TURN credentials stop working (nil for STUN).
    var expiresAt: Date?
    /// Whose credentials (they are minted per signed-in user).
    var username: String?
    /// Our own STUN fallback (no answer within `IcePolicy.fetchTimeout`, or a malformed one).
    var fallback: Bool

    var description: String { turn ? "TURN (\(servers.count) servers)" : (fallback ? "STUN only (fallback)" : "STUN only") }

    static func stun(username: String?, fallback: Bool) -> IceConfig {
        IceConfig(servers: IcePolicy.stunServers, turn: false, expiresAt: nil, username: username, fallback: fallback)
    }
}

/// The rules the web VoiceChatManager follows (client/src/voice/VoiceChatManager.js), as pure functions.
enum IcePolicy {
    /// What voice used before TURN, and still uses without it (iOS 1.1.0's hard-coded pair).
    static let stunServers = [
        IceServerEntry(urls: ["stun:stun.l.google.com:19302"]),
        IceServerEntry(urls: ["stun:stun1.l.google.com:19302"]),
    ]
    /// How long to wait for voiceIceServers before using STUN only.
    static let fetchTimeout: TimeInterval = 4
    /// Refresh TURN credentials this long before they expire.
    static let refreshBefore: TimeInterval = 30 * 60
    /// A connection not up by then counts as failed (with no candidate pair it may never say so).
    static let connectTimeout: TimeInterval = 20
    /// The side that does not re-offer waits this long for the other side's restart.
    static let restartWait: TimeInterval = 15

    /// Only well-formed entries (stun: / turn: / turns: URLs; username and credential strings), nil when none is left.
    static func sanitize(_ list: Any?) -> [IceServerEntry]? {
        guard let list = list as? [Any] else { return nil }
        var out: [IceServerEntry] = []
        for item in list {
            guard let d = item as? [String: Any] else { continue }
            let raw: [Any] = (d["urls"] as? [Any]) ?? (d["urls"].map { [$0] } ?? [])
            let urls = raw.compactMap { $0 as? String }.filter { u in
                let l = u.lowercased()
                return l.hasPrefix("stun:") || l.hasPrefix("turn:") || l.hasPrefix("turns:")
            }
            guard !urls.isEmpty else { continue }
            out.append(IceServerEntry(urls: urls, username: d["username"] as? String, credential: d["credential"] as? String))
        }
        return out.isEmpty ? nil : out
    }

    /// The config a `voiceIceServers` reply gives (nil reply: the timeout's STUN fallback).
    static func config(from reply: [String: Any]?, username: String?, now: Date) -> IceConfig {
        guard let reply, let servers = sanitize(reply["iceServers"]) else { return .stun(username: username, fallback: true) }
        let turn = (reply["turn"] as? Bool) ?? false
        let secs = (reply["expiresInSec"] as? NSNumber).flatMap { CFGetTypeID($0) == CFBooleanGetTypeID() ? nil : $0.doubleValue }
        return IceConfig(servers: servers, turn: turn, expiresAt: secs.map { now.addingTimeInterval($0) }, username: username, fallback: false)
    }

    /// A TURN answer for this user that is not about to expire is reused for the session;
    /// a STUN-only answer never is (each voice start and each restart ask again, so one
    /// TURN outage does not leave the session on STUN).
    static func isReusable(_ c: IceConfig?, username: String?, now: Date) -> Bool {
        guard let c, c.turn, c.username == username else { return false }
        guard let exp = c.expiresAt else { return true }
        return exp.timeIntervalSince(now) > refreshBefore
    }

    /// When to ask again for TURN credentials still in use (30 min before expiry, at least 60 s from now).
    static func refreshDelay(_ c: IceConfig?, now: Date) -> TimeInterval? {
        guard let c, c.turn, let exp = c.expiresAt else { return nil }
        return max(60, exp.timeIntervalSince(now) - refreshBefore)
    }
}

/// Asks the server for ICE servers (`getVoiceIceServers {requestId: "ice-<n>"}` →
/// `voiceIceServers {iceServers, turn, expiresInSec, requestId}`), at most one
/// request in flight, STUN after `IcePolicy.fetchTimeout`. Injected emit and
/// clock, so the tests run it without a socket.
@MainActor
final class IceServerStore {
    private(set) var current: IceConfig?
    private var pending: [String: (([String: Any]?) -> Void)] = [:]
    private var inFlight: Task<IceConfig, Never>?
    private var requestNo = 0
    private let emit: ([String: Any]) -> Void
    private let now: () -> Date
    private let timeout: TimeInterval
    /// Called whenever `current` changes (VoiceChatManager applies it to open connections).
    var onChange: ((IceConfig) -> Void)?

    init(timeout: TimeInterval = IcePolicy.fetchTimeout, now: @escaping () -> Date = Date.init,
         emit: @escaping ([String: Any]) -> Void) {
        self.timeout = timeout
        self.now = now
        self.emit = emit
    }

    /// The ICE servers to use now: the reusable TURN answer, else a fresh request. Never fails.
    func ensure(username: String?) async -> IceConfig {
        if IcePolicy.isReusable(current, username: username, now: now()), let c = current { return c }
        return await fetch(username: username)
    }

    /// One request (joins the one in flight).
    func fetch(username: String?) async -> IceConfig {
        if let t = inFlight { return await t.value }
        let task = Task { @MainActor [weak self] () -> IceConfig in
            guard let self else { return .stun(username: username, fallback: true) }
            let reply = await self.request()
            let config = IcePolicy.config(from: reply, username: username, now: self.now())
            self.current = config
            self.inFlight = nil
            #if DEBUG
            print("[Voice] ICE servers: \(config)")
            #endif
            self.onChange?(config)
            return config
        }
        inFlight = task
        return await task.value
    }

    private func request() async -> [String: Any]? {
        requestNo += 1
        let id = "ice-\(requestNo)"
        return await withCheckedContinuation { (cont: CheckedContinuation<[String: Any]?, Never>) in
            var done = false
            let finish: ([String: Any]?) -> Void = { reply in
                guard !done else { return }
                done = true
                cont.resume(returning: reply)
            }
            pending[id] = finish
            emit(["requestId": id])
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.pending.removeValue(forKey: id) != nil else { return }
                    #if DEBUG
                    print("[Voice] no voiceIceServers within \(self.timeout) s: STUN only")
                    #endif
                    finish(nil)
                }
            }
        }
    }

    /// `voiceIceServers` from the server: an answer to no open request (late, another session's) is ignored.
    func handleReply(_ dict: [String: Any]) {
        guard let id = dict["requestId"] as? String, let finish = pending.removeValue(forKey: id) else { return }
        finish(dict)
    }

    /// Voice shut down: open requests answer STUN, the session's credentials are forgotten.
    func reset() {
        let waiting = pending.values
        pending.removeAll()
        waiting.forEach { $0(nil) }
        current = nil
    }

    var hasPendingRequest: Bool { !pending.isEmpty }
}

/// Per-peer connection recovery (the web's _onPeerFailed): ONE restart, then
/// "voice unavailable". The peer with the lower socket id offers again on a
/// new connection; the other waits `IcePolicy.restartWait` for that offer.
struct VoiceRecovery: Equatable {
    enum Action: Equatable {
        case none
        /// Refresh the ICE servers, close the connection and offer again.
        case restartAsOfferer
        /// Refresh the ICE servers and wait for the peer's new offer (then `waitExpired`).
        case waitForRestart
        case markUnavailable
    }

    private(set) var restarts: [String: Int] = [:]
    private(set) var unavailable: Set<String> = []
    private(set) var waiting: Set<String> = []

    mutating func failed(_ peer: String, myId: String) -> Action {
        if unavailable.contains(peer) || waiting.contains(peer) { return .none }
        if (restarts[peer] ?? 0) >= 1 {
            unavailable.insert(peer)
            return .markUnavailable
        }
        restarts[peer] = 1
        if !myId.isEmpty && myId < peer { return .restartAsOfferer }
        waiting.insert(peer)
        return .waitForRestart
    }

    /// The restart's offer did not come in time.
    mutating func waitExpired(_ peer: String) -> Action {
        guard waiting.remove(peer) != nil else { return .none }
        unavailable.insert(peer)
        return .markUnavailable
    }

    mutating func connected(_ peer: String) {
        restarts[peer] = nil
        unavailable.remove(peer)
        waiting.remove(peer)
    }

    /// A new offer from the peer: it is trying again (its restart, or a later retry).
    mutating func offered(_ peer: String) {
        unavailable.remove(peer)
        waiting.remove(peer)
    }

    /// The peer left (keepRecovery false), or its connection was replaced by the restart.
    mutating func closed(_ peer: String, keepRecovery: Bool) {
        waiting.remove(peer)
        guard !keepRecovery else { return }
        restarts[peer] = nil
        unavailable.remove(peer)
    }

    mutating func reset() { self = VoiceRecovery() }
}

import Foundation
@preconcurrency import WebRTC
@testable import BAB_Online

/// A scripted stand-in for the server's SFU relay and Cloudflare (server/socket/sfuHandlers.js +
/// server/testUtils/fakeCloudflare.js), in process: every c2s sfu* request the client sends is
/// answered with one sfuReply, in the server's shapes. Each session the client makes is a REAL
/// RTCPeerConnection here (on `SilentAudioDevice`): the client's push offer is answered by it, a
/// pull adds a sendonly transceiver per pulled track and returns its offer, the client's answer,
/// close and ICE restart offers are applied to it. So every SDP the client applies is WebRTC's
/// own. `script` overrides the next reply of an event (a refusal, no reply, a delay).
@MainActor
final class FakeSfuServer {
    enum Scripted {
        /// ok false with this error.
        case error(String, retryable: Bool = false, retryAfterMs: Int? = nil)
        /// Never answered (the client's 12 s wait).
        case noReply
        /// Per-track error codes for a pull, by publisher session id (the rest pulled);
        /// "code:description" sets the errorDescription too.
        case trackErrors([String: String])
    }

    private let factory: RTCPeerConnectionFactory
    /// Delivers a reply to the client (the socket's sfuReply).
    var deliver: (@MainActor ([String: Any]) -> Void)?
    private(set) var requests: [(event: String, payload: [String: Any])] = []
    var script: [String: [Scripted]] = [:]
    /// Published tracks other members hold: session id -> username.
    var publishers: [String: String] = [:]
    /// Sessions that answer session_gone (410).
    var dead = Set<String>()
    private(set) var sessions: [String: RTCPeerConnection] = [:]
    private var nextSession = 0
    /// Tracks pulled per client session (publisher session id -> mid).
    private(set) var pulled: [String: [String: String]] = [:]
    /// How many requests were being worked on at once (the client's queue keeps it at 1).
    private(set) var busy = 0, maxBusy = 0
    /// Mids closed by force (no SDP).
    private(set) var forceClosed = Set<String>()
    /// Every reply is delivered on a later main-queue turn (as a socket would).
    var replyDelay: TimeInterval = 0

    init() {
        factory = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(),
                                           decoderFactory: RTCDefaultVideoDecoderFactory(),
                                           audioDevice: SilentAudioDevice())
    }

    func close() {
        for pc in sessions.values { pc.close() }
        sessions.removeAll()
    }

    func count(_ event: String) -> Int { requests.filter { $0.event == event }.count }
    func last(_ event: String) -> [String: Any]? { requests.last { $0.event == event }?.payload }

    /// The c2s emit.
    func receive(_ event: String, _ payload: [String: Any]) {
        requests.append((event, payload))
        guard let requestId = payload["requestId"] as? String else { return }
        let op = Self.op(event)
        if var queue = script[event], !queue.isEmpty {
            let next = queue.removeFirst()
            script[event] = queue
            switch next {
            case .error(let code, let retryable, let retryAfterMs):
                reply(["requestId": requestId, "op": op, "ok": false, "sessionId": payload["sessionId"] ?? NSNull(),
                       "error": ["code": code, "retryable": retryable, "retryAfterMs": retryAfterMs ?? NSNull(), "status": NSNull(), "cfCode": NSNull()]])
                return
            case .noReply:
                return
            case .trackErrors(let errors):
                Task { await self.answer(event, op, requestId, payload, trackErrors: errors) }
                return
            }
        }
        Task { await self.answer(event, op, requestId, payload, trackErrors: [:]) }
    }

    static func op(_ event: String) -> String {
        switch event {
        case "sfuSession": return "session"
        case "sfuPush": return "push"
        case "sfuPull": return "pull"
        case "sfuRenegotiate": return "renegotiate"
        case "sfuClose": return "close"
        case "sfuIceRestart": return "iceRestart"
        case "sfuResume": return "resume"
        default: return "leave"
        }
    }

    private func reply(_ body: [String: Any]) {
        let send = { [weak self] in self?.deliver?(body) }
        if replyDelay > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + replyDelay) { MainActor.assumeIsolated { send() } }
        } else {
            DispatchQueue.main.async { MainActor.assumeIsolated { send() } }
        }
    }

    private func fail(_ requestId: String, _ op: String, _ code: String) {
        reply(["requestId": requestId, "op": op, "ok": false, "error": ["code": code, "retryable": false, "retryAfterMs": NSNull(), "status": NSNull(), "cfCode": NSNull()]])
    }

    private func answer(_ event: String, _ op: String, _ requestId: String, _ payload: [String: Any], trackErrors: [String: String]) async {
        busy += 1
        maxBusy = max(maxBusy, busy)
        defer { busy -= 1 }
        let sid = payload["sessionId"] as? String ?? ""
        if event != "sfuSession", event != "sfuLeave", dead.contains(sid) {
            return fail(requestId, op, "session_gone")
        }
        switch event {
        case "sfuSession":
            nextSession += 1
            let id = String(format: "%064x", 0xC0FFEE00 + nextSession)
            let config = RTCConfiguration()
            config.bundlePolicy = .maxBundle  // Cloudflare always bundles
            let pc = factory.peerConnection(with: config, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: nil)!
            sessions[id] = pc
            reply(["requestId": requestId, "op": op, "ok": true, "sessionId": id, "sessionToken": String(repeating: "t", count: 43)])
        case "sfuPush":
            guard let pc = sessions[sid], let offer = SfuVoice.description(payload["offer"], type: .offer),
                  let answer = await apply(pc, offer) else { return fail(requestId, op, "invalid") }
            reply(["requestId": requestId, "op": op, "ok": true, "sessionId": sid, "answer": SfuVoice.wire(answer),
                   "tracks": [["mid": payload["mid"] ?? "0", "trackName": payload["trackName"] ?? "mic", "errorCode": NSNull(), "errorDescription": NSNull()]]])
        case "sfuPull":
            guard let pc = sessions[sid], let tracks = payload["tracks"] as? [[String: Any]] else { return fail(requestId, op, "invalid") }
            var results: [[String: Any]] = []
            var added: [(String, RTCRtpTransceiver)] = []
            for t in tracks {
                let pub = t["sessionId"] as? String ?? ""
                let name = t["trackName"] as? String ?? ""
                let user = publishers[pub] ?? "?"
                if let spec = trackErrors[pub] {
                    let parts = spec.split(separator: ":", maxSplits: 1).map(String.init)
                    results.append(["username": user, "sessionId": pub, "trackName": name, "mid": NSNull(), "errorCode": parts[0],
                                    "errorDescription": parts.count > 1 ? parts[1] : NSNull()])
                    continue
                }
                let txInit = RTCRtpTransceiverInit()
                txInit.direction = .sendOnly
                txInit.streamIds = [pub]
                let track = factory.audioTrack(with: factory.audioSource(with: nil), trackId: "t-\(pub.prefix(6))-\(name)")
                guard let tx = pc.addTransceiver(with: track, init: txInit) else { continue }
                added.append((pub, tx))
                results.append(["username": user, "sessionId": pub, "trackName": name])
            }
            var offerWire: Any = NSNull()
            if !added.isEmpty {
                guard let offer = await pc.sfuOffer(SfuVoice.plain), await pc.sfuSetLocal(offer) == nil else { return fail(requestId, op, "invalid") }
                offerWire = SfuVoice.wire(pc.localDescription ?? offer)
            }
            var i = 0
            results = results.map { r in
                var r = r
                if r["errorCode"] == nil {
                    let (pub, tx) = added[i]
                    i += 1
                    r["mid"] = tx.mid
                    r["errorCode"] = NSNull()
                    r["errorDescription"] = NSNull()
                    pulled[sid, default: [:]][pub] = tx.mid
                }
                return r
            }
            reply(["requestId": requestId, "op": op, "ok": true, "sessionId": sid, "requiresImmediateRenegotiation": !added.isEmpty,
                   "offer": offerWire, "tracks": results])
        case "sfuRenegotiate":
            guard let pc = sessions[sid], let answer = SfuVoice.description(payload["answer"], type: .answer),
                  await pc.sfuSetRemote(answer) == nil else { return fail(requestId, op, "invalid") }
            reply(["requestId": requestId, "op": op, "ok": true, "sessionId": sid])
        case "sfuClose":
            guard let pc = sessions[sid], let mids = payload["mids"] as? [String] else { return fail(requestId, op, "invalid") }
            for (pub, mid) in pulled[sid] ?? [:] where mids.contains(mid) { pulled[sid]?[pub] = nil }
            let tracks = mids.map { ["mid": $0, "trackName": NSNull(), "errorCode": NSNull(), "errorDescription": NSNull()] as [String: Any] }
            if payload["force"] as? Bool == true {
                // Cloudflare closes them: its next offer has those m-sections stopped, except the
                // BUNDLE tag (the first m-section), which it keeps idle and never reuses (live
                // 2026-11-26: a force close of mid 0 left the session working, the next pull on mid 3)
                let tag = pc.transceivers.first { !$0.isStopped && !$0.mid.isEmpty }?.mid
                for tx in pc.transceivers where mids.contains(tx.mid) && !tx.isStopped {
                    if tx.mid == tag {
                        tx.sender.track = nil
                        var error: NSError?
                        tx.setDirection(.inactive, error: &error)
                    } else {
                        tx.stopInternal()
                    }
                }
                forceClosed.formUnion(mids)
                reply(["requestId": requestId, "op": op, "ok": true, "sessionId": sid, "answer": NSNull(), "tracks": tracks])
                return
            }
            guard let offer = SfuVoice.description(payload["offer"], type: .offer), let answer = await apply(pc, offer) else {
                return fail(requestId, op, "invalid")
            }
            reply(["requestId": requestId, "op": op, "ok": true, "sessionId": sid, "answer": SfuVoice.wire(answer), "tracks": tracks])
        case "sfuIceRestart":
            guard let pc = sessions[sid], let offer = SfuVoice.description(payload["offer"], type: .offer),
                  let answer = await apply(pc, offer) else { return fail(requestId, op, "invalid") }
            reply(["requestId": requestId, "op": op, "ok": true, "sessionId": sid, "answer": SfuVoice.wire(answer), "tracks": []])
        case "sfuResume":
            reply(["requestId": requestId, "op": op, "ok": true, "sessionId": sid])
        default:  // sfuLeave
            reply(["requestId": requestId, "op": op, "ok": true])
        }
    }

    /// The client's offer on the session's PeerConnection, and its answer.
    private func apply(_ pc: RTCPeerConnection, _ offer: RTCSessionDescription) async -> RTCSessionDescription? {
        guard await pc.sfuSetRemote(offer) == nil, let answer = await pc.sfuAnswer(SfuVoice.plain),
              await pc.sfuSetLocal(answer) == nil else { return nil }
        return pc.localDescription ?? answer
    }
}

/// The SFU transport's clock in the unit tests: `now` moves and timers fire only by `advance`.
@MainActor
final class SfuTestClock {
    private(set) var now = Date(timeIntervalSince1970: 1_800_000_000)
    private var timers: [(at: Date, n: Int, run: @MainActor () -> Void)] = []
    private var n = 0

    var hooks: (now: @MainActor () -> Date, after: @MainActor (TimeInterval, @escaping @MainActor () -> Void) -> Void) {
        ({ [unowned self] in self.now }, { [unowned self] delay, run in self.schedule(delay, run) })
    }

    private func schedule(_ delay: TimeInterval, _ run: @escaping @MainActor () -> Void) {
        n += 1
        timers.append((now.addingTimeInterval(delay), n, run))
    }

    var pending: Int { timers.count }

    /// Moves `now` on, firing every timer due by then in order (timers they set fire too when due).
    func advance(_ seconds: TimeInterval) {
        let end = now.addingTimeInterval(seconds)
        while let next = timers.filter({ $0.at <= end }).min(by: { ($0.at, $0.n) < ($1.at, $1.n) }) {
            timers.removeAll { $0.n == next.n }
            if next.at > now { now = next.at }
            next.run()
        }
        now = end
    }
}

import Foundation
import os
// WebRTC's ObjC types aren't annotated Sendable; its objects are thread-safe.
@preconcurrency import WebRTC

/// What the SFU transport needs from the voice manager (`VoiceChatManager`): whether voice runs,
/// the local track, the audio session, and where pulled tracks go (the panel's rows, mute, volume,
/// the speaking poll).
@MainActor
protocol SfuVoiceOwner: AnyObject {
    /// Voice runs on this screen (wanted, with company): pulls and the push may happen.
    var sfuVoiceRunning: Bool { get }
    /// Unmuted by hand with the microphone allowed: push (step 4: the first unmute, never before).
    var sfuWantsToPublish: Bool { get }
    /// The one local track (disabled while muted; a mute never renegotiates).
    var sfuLocalTrack: RTCAudioTrack? { get }
    /// The session's RTCPeerConnection was made (the audio session is claimed then) / closed.
    func sfuPeerConnectionOpened()
    func sfuPeerConnectionClosed()
    /// A member's pulled track (its mute and volume are the manager's, by username).
    func sfuTrackPulled(_ username: String, _ track: RTCAudioTrack)
    func sfuTrackDropped(_ username: String)
    /// The room changed: who is in it (company) or the line ("Voice is full (N people)").
    func sfuRoomChanged()
}

/// The Cloudflare SFU transport for the tournament lobby's voice room (PR 3, iOS; owner
/// 2026-11-26: the SFU when the server's `VOICE_SFU=tournament` is on, no small cap; tables and
/// every other room stay on the peer-to-peer mesh). It follows docs/claude/voice.md "The client
/// protocol" step by step:
///
/// 1. The room is an SFU room when an `sfuRoster` comes (VoiceSocketHandler); a mesh event while a
///    session is held closes the PeerConnection first (no sfuLeave).
/// 2. Lazy: `sfuSession` only when someone publishes (a member with a trackName) or at the
///    first unmute. The session id and token stay in memory.
/// 3. ONE RTCPeerConnection per session (max-bundle, the SFU's STUN); every request goes through
///    ONE serial queue (`enqueue`); a replaced session drops the old queue's work and answers its
///    waiting requests at once (`bumpGeneration`).
/// 4. Push on the first unmute (a sendonly transceiver, `sfuPush`); a mute is `isEnabled`.
/// 5. Pulls batched (<= 64), each mid mapped to its member before `setRemoteDescription`, the
///    SFU's offer answered (`sfuRenegotiate`) even when some tracks failed; per-track errors.
/// 6. Closes negotiated (`transceiver.stopInternal`, offer, `sfuClose`), else by force; compared
///    with the pull I HOLD (`SfuPlan`); a reconnecting member's pull is kept.
/// 7. `sfuMember` is an upsert by username.
/// 8. Every sfuReply error code (`SfuErrorAction`), a 12 s wait for each reply.
/// 9. Media drops: nothing on the first `disconnected` for 2 s; then (or on `failed`, the
///    network coming back (`NWPathMonitor`), a stall) an ICE restart on the same session when
///    away under 25 s with a published track (at most 2), else a new session.
/// 10. The downlink stall detector on the speaking poll's per-receiver stats.
/// 11. A new socket's roster with my session reconnecting: `sfuResume` at once if the
///     PeerConnection is alive, else a new session; my session null on the same bootId: closed.
/// 12. A new bootId: `sfuResume` with the SAME session and, for 20 s, no pull of a missing or
///     null-session member is closed.
/// 13. Leaving: `sfuLeave` (best effort) then `pc.close()`; never on a socket drop.
@MainActor
final class SfuVoice {
    /// The timers and the clock (the unit tests' are manual), the emit, the ICE servers.
    struct Hooks {
        var send: @MainActor (_ event: String, _ payload: [String: Any]) -> Void
        var now: @MainActor () -> Date = { Date() }
        var after: @MainActor (_ delay: TimeInterval, _ run: @escaping @MainActor () -> Void) -> Void = { delay, run in
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated { run() } }
        }
        var iceServers: [String] = [SfuPolicy.stunServer]
        #if DEBUG
        /// Live checks only (`-sfuRelay host:port`, LiveSfuVoiceTests): the SFU's candidates in
        /// every remote description are rewritten to a local UDP relay the run can cut.
        var rewriteRemote: (@MainActor (String) -> String)? = nil
        #endif
    }

    /// The room as the server last said (sfuRoster.status).
    enum Status: Equatable {
        case none, admitted, waiting(cap: Int?), out
    }

    struct Pull {
        var key: SfuTrackKey
        var mid: String
        var receiver: RTCRtpReceiver?
        var track: RTCAudioTrack?
    }

    weak var owner: SfuVoiceOwner?
    private let factory: RTCPeerConnectionFactory
    private let hooks: Hooks

    // MARK: The room
    private(set) var tournamentId: String?
    private(set) var bootId: String?
    private(set) var rev = 0
    private(set) var status: Status = .none
    /// The other members (an upsert view of the roster and every sfuMember since).
    private(set) var members: [String: SfuMemberRecord] = [:]
    /// After a tournamentJoined of the same tournament (a socket reconnect, the lobby drawn
    /// again): the session is kept for the roster that follows (step 11), nothing else happens
    /// until it comes; a mesh event or `awaitRosterLimit` without one ends it.
    private(set) var awaitingRoster = false
    private var awaitToken = 0
    static let awaitRosterLimit: TimeInterval = 10

    // MARK: The session
    private(set) var pc: RTCPeerConnection?
    private(set) var sessionId: String?
    private var sessionToken: String?
    private(set) var localMid: String?
    private(set) var publishedTrackName: String?
    private(set) var localTransceiver: RTCRtpTransceiver?
    /// The session answered 410 (session_gone): never an ICE restart on it.
    private(set) var sessionGone = false
    private(set) var pulls: [String: Pull] = [:]
    /// A pull's mid -> username, set before the SFU's offer is applied (step 5).
    private(set) var midOwners: [String: String] = [:]
    private var pullsInFlight = Set<String>()
    /// Cloudflare's empty / not-found tracks: retried every second up to 10 times.
    private var pullRetryCount: [String: Int] = [:]
    private var pullRetryWaiting = Set<String>()
    /// Tracks the server refused (not_in_room, own_track, blocked, duplicate, too_many_pulls,
    /// no_result): not again until the roster changes.
    private var refused: [String: SfuTrackKey] = [:]
    /// Step 12: inside the hold no pull of a missing or null-session member is closed.
    private(set) var holdUntil: Date?
    private var publishing = false
    private var sessionAsked = false

    // MARK: Recovery
    private(set) var lostAt: Date?
    /// This session's PeerConnection was connected once (`SfuRecovery.decide`; settable for the
    /// unit tests, whose in-process PeerConnections may connect for real).
    var everConnected = false
    private var disconnectToken = 0
    private(set) var restartTries = 0
    private(set) var recovering = false
    private var recoveryPending = false
    private(set) var networkSatisfied = true
    private var pathSignature: String?
    private var stall = SfuStallDetector()
    private var backgroundedAt: Date?
    private var foregroundedAt: Date?
    private var lastBackground: TimeInterval = 0

    // MARK: The queue
    private struct Job { let gen: Int; let name: String; let run: @MainActor () async -> Void }
    private var jobs: [Job] = []
    private var draining = false
    private var syncQueued = false
    private(set) var generation = 0
    private struct Waiter { let gen: Int; let event: String; let resume: (Result<[String: Any], SfuError>) -> Void }
    private var waiters: [String: Waiter] = [:]
    private var nextRequest = 0
    private var connectedWaiters: [Int: (Bool) -> Void] = [:]
    private var nextConnectedWaiter = 0

    // MARK: For tests and the live probe
    private(set) var sent: [(event: String, payload: [String: Any])] = []
    private(set) var counts: [String: Int] = [:]
    /// What the last recoveries did ("iceRestart ok 182 ms", "newSession"), newest last.
    private(set) var recoveries: [String] = []
    private(set) var lastIceRestartMs: Int?
    private(set) var inFlight = 0
    private(set) var maxInFlight = 0

    init(factory: RTCPeerConnectionFactory, hooks: Hooks) {
        self.factory = factory
        self.hooks = hooks
    }

    /// Every line goes to the unified log too (Console on a device, `log show` on a simulator):
    /// states, ops, error codes and timings, never an SDP or the session token.
    private static let logger = Logger(subsystem: "com.bab-online.BABOnline", category: "VoiceSFU")
    private func log(_ s: String) {
        print("[VoiceSFU] \(s)")
        Self.logger.notice("\(s, privacy: .public)")
    }
    private var now: Date { hooks.now() }

    // MARK: - Reading

    /// The room's members (company: another member listed, step 2).
    var memberNames: [String] { Array(members.keys) }
    var isAdmitted: Bool { status == .admitted }
    /// In line for a full room (step 1): "Voice is full (N people)", N = the server's cap.
    var isWaiting: Bool {
        if case .waiting = status { return true }
        return false
    }
    var waitingCap: Int? {
        if case .waiting(let cap) = status { return cap }
        return nil
    }
    var holdsSession: Bool { sessionId != nil }
    /// The session's connection state (as WebRTC reports it, or as a unit test set it).
    var connectionState: RTCPeerConnectionState? { pc == nil ? nil : (testState ?? pc?.connectionState) }
    var isConnected: Bool { connectionState == .connected }
    /// The pulled receivers, for the speaking poll (one stats request each).
    var pulledReceivers: [(username: String, receiver: RTCRtpReceiver)] {
        pulls.compactMap { u, p in p.receiver.map { (u, $0) } }.sorted { $0.username < $1.username }
    }
    /// My published track's sender, for my own speaking level.
    var localSender: RTCRtpSender? { localMid == nil ? nil : localTransceiver?.sender }
    var pcAlive: Bool {
        guard let pc, let state = connectionState else { return false }
        return state != .failed && state != .closed && pc.signalingState != .closed
    }
    /// Whether the PeerConnection was given the max-bundle policy and the SFU's STUN (step 3).
    var configuration: RTCConfiguration? { pc?.configuration }
    var sessionTokenForTests: String? { sessionToken }

    // MARK: - The room (s2c)

    func applyRoster(_ r: SfuRoster) {
        awaitingRoster = false
        awaitToken &+= 1
        if let t = tournamentId, t != r.tournamentId, holdsSession {
            end(leave: false, why: "another tournament's room")
        }
        tournamentId = r.tournamentId
        let newBoot = bootId != nil && bootId != r.bootId
        bootId = r.bootId
        rev = r.rev
        refused.removeAll()
        switch r.status {
        case .out:
            log("roster: out")
            end(leave: false, why: "out of the room")
            status = .out
            members = [:]
            owner?.sfuRoomChanged()
            return
        case .waiting:
            log("roster: waiting (cap \(r.cap.map(String.init) ?? "?"))")
            end(leave: false, why: "in line")
            status = .waiting(cap: r.cap)
            members = [:]
            owner?.sfuRoomChanged()
            return
        case .admitted:
            status = .admitted
        }
        members = Dictionary(r.members.map { ($0.username, $0) }, uniquingKeysWith: { _, b in b })
        log("roster: admitted, \(members.count) other member(s), rev \(r.rev)\(newBoot ? ", new bootId" : "")")
        if newBoot, holdsSession {
            holdUntil = now.addingTimeInterval(SfuPolicy.restartHold)
            hooks.after(SfuPolicy.restartHold) { [weak self] in
                guard let self, let until = self.holdUntil, self.now >= until else { return }
                self.holdUntil = nil
                self.log("restart hold over")
                self.scheduleSync()
            }
        }
        if let sid = sessionId {
            let mine = r.me?.sessionId
            if mine == sid {
                if r.me?.state == .reconnecting {
                    // step 11: a new socket; my PeerConnection alive: resume at once
                    if pcAlive && !staleAfterBackground { enqueueResume(why: "reconnected socket") } else { renewSession(why: "reconnected with a dead PeerConnection") }
                }
            } else if mine == nil {
                if newBoot {
                    // step 12: the server restarted; media never stopped: the SAME session
                    if pcAlive && !staleAfterBackground { enqueueResume(why: "new bootId") } else { renewSession(why: "new bootId, dead PeerConnection") }
                } else {
                    // step 11: the same bootId with no session: the server dropped mine (the
                    // grace ran out) and closed its pulls: a new one when needed
                    log("the server dropped my session: closing it")
                    dropSession(leave: false, why: "dropped by the server")
                }
            } else {
                // the server holds another session of mine: mine is the one I can still use
                if pcAlive && !staleAfterBackground { enqueueResume(why: "another session on record") } else { renewSession(why: "another session on record") }
            }
        }
        owner?.sfuRoomChanged()
        scheduleSync()
    }

    func applyMember(_ e: SfuMemberEvent) {
        guard e.tournamentId == tournamentId, status == .admitted else { return }
        let before = members[e.member.username]
        if e.isLeft {
            members[e.member.username] = nil
        } else {
            members[e.member.username] = e.member
        }
        rev = max(rev, e.rev)
        if before?.track != e.member.track || e.isLeft {
            pullRetryCount[e.member.username] = nil
        }
        refused.removeAll()  // the roster changed
        log("member \(e.event): \(e.member.username) \(e.member.track == nil ? "no track" : "publishing") \(e.member.state.rawValue)")
        owner?.sfuRoomChanged()
        scheduleSync()
    }

    /// A tournamentJoined of the tournament whose room this session is in (step 11): keep the
    /// session and the members for the roster that follows in the same handler.
    func awaitRoster(tournamentId id: String?) {
        guard let id, id == tournamentId else {
            end(leave: false, why: "another tournament")
            forgetRoom()
            return
        }
        awaitingRoster = true
        awaitToken &+= 1
        let token = awaitToken
        hooks.after(Self.awaitRosterLimit) { [weak self] in
            guard let self, self.awaitingRoster, self.awaitToken == token else { return }
            self.log("no roster after the room change: ending the session")
            self.awaitingRoster = false
            self.end(leave: false, why: "no roster")
            self.forgetRoom()
        }
    }

    /// The room is a mesh (voicePeerList / voicePeerJoined / tournamentVoiceStatus) or gone (a
    /// table, tournamentLeft, the main room): `pc.close()`, no sfuLeave (step 1).
    func meshOrGone(why: String) {
        guard holdsSession || status != .none else { return }
        end(leave: false, why: why)
        forgetRoom()
    }

    func forgetRoom() {
        awaitingRoster = false
        awaitToken &+= 1
        members = [:]
        status = .none
        tournamentId = nil
        holdUntil = nil
        refused.removeAll()
        owner?.sfuRoomChanged()
    }

    // MARK: - Replies

    func handleReply(_ dict: [String: Any]) {
        guard let id = dict["requestId"] as? String, let w = waiters.removeValue(forKey: id) else {
            // after I gave up (12 s) or for a replaced session: ignored by requestId (step 8)
            return
        }
        inFlight = max(0, inFlight - 1)
        if dict["ok"] as? Bool == true {
            w.resume(.success(dict))
        } else {
            let e = SfuError.from(dict["error"])
            log("\(w.event) refused: \(e.code)\(e.retryable ? " (retryable)" : "")")
            w.resume(.failure(e))
        }
    }

    // MARK: - The voice manager

    /// Voice started on the screen (muted, or unmuted after an unmute by hand): the pulls held
    /// across a room change are the panel's again, and the plan runs.
    func voiceStarted() {
        for (u, p) in pulls { if let t = p.track { owner?.sfuTrackPulled(u, t) } }
        scheduleSync()
    }

    /// The first unmute (or an unmuted start): push when not published yet.
    func publishWanted() {
        scheduleSync()
    }

    /// Voice stops on this screen while still in the room (no company, the app going away):
    /// sfuLeave then `pc.close()` (step 13). The roster stays (company).
    func leave(why: String) {
        guard holdsSession else { return }
        end(leave: true, why: why)
    }

    /// The local track was made again (a new voice start on a kept session): the sender sends it.
    func localTrackReplaced(_ track: RTCAudioTrack?) {
        guard let tx = localTransceiver, !tx.isStopped else { return }
        tx.sender.track = track
    }

    // MARK: - Network, background (steps 9, 15)

    /// NWPathMonitor's path: `satisfied` and the interfaces in use (a change = a path change).
    func networkPath(satisfied: Bool, signature: String) {
        let wasUp = networkSatisfied
        let old = pathSignature
        networkSatisfied = satisfied
        pathSignature = signature
        guard satisfied, holdsSession else { return }
        if !wasUp {
            log("network up")
            recoveryPending = false
            recover(force: false, why: "network up")
        } else if let old, old != signature {
            log("network path changed (\(old) -> \(signature))")
            recover(force: true, why: "path change")
        }
    }

    /// In the background (no audio background mode: voice can neither play nor record there)
    /// a recovery waits for the foreground, which runs it with the time away counted from the
    /// background (step 9's 25 s rule).
    private(set) var inBackground = false

    func backgrounded() {
        backgroundedAt = now
        inBackground = true
    }

    func foregrounded() {
        let at = now
        if let b = backgroundedAt { lastBackground = at.timeIntervalSince(b) }
        foregroundedAt = at
        inBackground = false
        guard holdsSession, let state = connectionState else { return }
        log("foreground after \(Int(lastBackground)) s: \(Self.name(state))")
        if recoveryPending || state == .failed || state == .disconnected {
            recoveryPending = false
            if lostAt == nil { lostAt = backgroundedAt ?? at }
            recover(force: false, why: "foreground")
        }
    }

    /// A socket reconnect's roster within 10 s of a foreground after 25 s or more away (step 9's
    /// window): the socket died, so the app was suspended (no ICE consent from a stopped app),
    /// and Cloudflare drops such a session ~30-35 s after its last packet. The PeerConnection
    /// still reads `connected` then (it saw nothing while stopped; measured live after a 60 s
    /// suspension: `disconnected` 5 s after the resume), so a resume would be followed by a
    /// drop and a new session anyway: a new session at once.
    private var staleAfterBackground: Bool {
        // the socket may reconnect before the foreground (a resumed app in the background)
        if inBackground, let b = backgroundedAt { return now.timeIntervalSince(b) >= SfuPolicy.iceRestartWindow }
        guard let f = foregroundedAt, now.timeIntervalSince(f) < 10 else { return false }
        return lastBackground >= SfuPolicy.iceRestartWindow
    }

    /// The speaking poll's per-receiver sample (step 10).
    func noteInbound(_ username: String, packets: Int) {
        guard pulls[username] != nil else { return }
        stall.sample(username, packets: packets, now: now)
    }

    /// Run at each speaking poll: every pulled track silent 2 s while connected -> recover.
    func checkStall() {
        guard holdsSession, !recovering else { return }
        if stall.check(connected: isConnected, pulls: Set(pulls.keys), now: now) {
            log("downlink stall: every pulled track silent \(Int(SfuPolicy.stallWindow)) s while connected")
            recover(force: true, why: "downlink stall")
        }
    }

    // MARK: - The plan (steps 2, 5, 6)

    private var wantsSession: Bool {
        guard owner?.sfuVoiceRunning == true, status == .admitted, !awaitingRoster else { return false }
        return owner?.sfuWantsToPublish == true || members.values.contains { $0.track != nil }
    }

    func scheduleSync() {
        guard !syncQueued else { return }
        syncQueued = true
        enqueue("sync") { [weak self] in await self?.sync() }
    }

    private func sync() async {
        syncQueued = false
        guard owner?.sfuVoiceRunning == true, status == .admitted, !awaitingRoster else { return }
        if sessionId == nil {
            guard wantsSession, !sessionAsked else { return }
            await newSession(why: "needed")
            return
        }
        let gen = generation
        if owner?.sfuWantsToPublish == true, localMid == nil, !publishing, owner?.sfuLocalTrack != nil {
            await push(gen)
            guard gen == generation else { return }
        }
        let holding = holdUntil.map { now < $0 } ?? false
        let plan = SfuPlan.reconcile(held: pulls.mapValues(\.key), members: members,
                                     busy: pullsInFlight.union(pullRetryWaiting), refused: refused, holding: holding)
        if !plan.close.isEmpty {
            await close(plan.close, gen)
            guard gen == generation else { return }
        }
        for batch in SfuPlan.batches(plan.pull) {
            await pull(batch, gen)
            guard gen == generation else { return }
        }
    }

    // MARK: - The session (steps 3, 8)

    /// A new session at once (a 410, the recovery's fallback, a dead PeerConnection): the old
    /// queue's work goes, the new session pushes again if I published and pulls everyone again.
    func renewSession(why: String) {
        // the audio session is handed to the next PeerConnection (released if none follows)
        dropSession(leave: false, why: why, handoff: true)
        if wantsSession { scheduleSync() } else { releaseHeldAudio() }
    }

    /// The audio session kept across a renewal (`renewSession`) goes when no PeerConnection follows.
    private func releaseHeldAudio() {
        guard audioHeld else { return }
        audioHeld = false
        if pc == nil { owner?.sfuPeerConnectionClosed() }
    }

    private func newSession(why: String) async {
        guard !sessionAsked else { return }
        sessionAsked = true
        defer { sessionAsked = false }
        let gen = generation
        log("new session (\(why))")
        count("session")
        let r = await call(SocketEvents.Client.sfuSession, [:], gen)
        guard gen == generation else { return }
        switch r {
        case .failure(let e):
            releaseHeldAudio()
            failed(e, op: "session")
        case .success(let d):
            guard let sid = d["sessionId"] as? String, let token = d["sessionToken"] as? String, status == .admitted else {
                releaseHeldAudio()
                return
            }
            sessionId = sid
            sessionToken = token
            sessionGone = false
            restartTries = 0
            lostAt = nil
            openPeerConnection()
            log("session \(Self.short(sid)) ready")
            syncQueued = false
            await sync()
        }
    }

    private func openPeerConnection() {
        closePeerConnection()
        testState = nil
        audioHeld = false
        everConnected = false
        let config = RTCConfiguration()
        config.iceServers = hooks.iceServers.isEmpty ? [] : [RTCIceServer(urlStrings: hooks.iceServers)]
        config.bundlePolicy = .maxBundle
        config.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: ["DtlsSrtpKeyAgreement": "true"])
        // the audio session first: the SFU's offer can start playout (iOS 1.2.6 claim rule)
        owner?.sfuPeerConnectionOpened()
        guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: nil) else { return }
        let delegate = SfuPeerDelegate(owner: self)
        pc.delegate = delegate
        objc_setAssociatedObject(pc, "sfuDelegate", delegate, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        self.pc = pc
        count("peerConnection")
    }

    /// `handoff`: a new session follows at once (a renewal): the audio session is kept for it.
    private func closePeerConnection(handoff: Bool = false) {
        guard let pc else { return }
        pc.close()
        self.pc = nil
        if handoff { audioHeld = true } else { owner?.sfuPeerConnectionClosed() }
    }
    private var audioHeld = false

    /// The session ends here: optionally sfuLeave first (best effort, no reply awaited), then
    /// `pc.close()`; every pull goes from the panel, the queue's work goes.
    private func end(leave: Bool, why: String) {
        guard holdsSession || pc != nil || !pulls.isEmpty else {
            bumpGeneration()
            return
        }
        dropSession(leave: leave, why: why)
    }

    private func dropSession(leave: Bool, why: String, handoff: Bool = false) {
        if leave, let sid = sessionId {
            nextRequest += 1
            let payload: [String: Any] = ["requestId": "sfu-ios-\(nextRequest)", "sessionId": sid]
            record("sfuLeave", payload)
            hooks.send(SocketEvents.Client.sfuLeave, payload)
        }
        if holdsSession { log("session \(Self.short(sessionId ?? "")) ends (\(why))") }
        bumpGeneration()
        for u in pulls.keys { owner?.sfuTrackDropped(u) }
        pulls.removeAll()
        midOwners.removeAll()
        pullsInFlight.removeAll()
        pullRetryWaiting.removeAll()
        pullRetryCount.removeAll()
        stall.reset()
        closePeerConnection(handoff: handoff)
        if !handoff { releaseHeldAudio() }
        sessionId = nil
        sessionToken = nil
        localMid = nil
        publishedTrackName = nil
        localTransceiver = nil
        sessionGone = false
        publishing = false
        lostAt = nil
        restartTries = 0
        recovering = false
        recoveryPending = false
        holdUntil = nil
    }

    /// Every queued job of the old session goes and its waiting requests answer at once (a
    /// replaced session's work never holds the new session's: step 3).
    private func bumpGeneration() {
        generation &+= 1
        jobs.removeAll()
        syncQueued = false
        let old = waiters
        waiters.removeAll()
        inFlight = 0
        for (_, w) in old { w.resume(.failure(.superseded)) }
        let connected = connectedWaiters
        connectedWaiters.removeAll()
        for (_, w) in connected { w(false) }
    }

    // MARK: - Push (step 4)

    private func push(_ gen: Int) async {
        guard let pc, let sid = sessionId, let track = owner?.sfuLocalTrack, localMid == nil, !publishing else { return }
        publishing = true
        defer { publishing = false }
        let t0 = now
        let txInit = RTCRtpTransceiverInit()
        txInit.direction = .sendOnly
        txInit.streamIds = ["stream0"]
        guard let tx = pc.addTransceiver(with: track, init: txInit) else { return }
        localTransceiver = tx
        guard let offer = await pc.sfuOffer(Self.plain), await pc.sfuSetLocal(offer) == nil, gen == generation else {
            if gen == generation { await abandonPush(tx) }
            return
        }
        let mid = tx.mid
        count("push")
        let r = await call(SocketEvents.Client.sfuPush, ["sessionId": sid, "offer": Self.wire(offer), "mid": mid, "trackName": SfuPolicy.trackName], gen)
        guard gen == generation else { return }
        switch r {
        case .failure(let e):
            await abandonPush(tx)
            failed(e, op: "push")
        case .success(let d):
            let tracks = (d["tracks"] as? [[String: Any]]) ?? []
            if let bad = tracks.first(where: { ($0["mid"] as? String ?? mid) == mid && $0["errorCode"] as? String != nil }) {
                log("push: my track refused (\(bad["errorCode"] ?? "?"))")
                await abandonPush(tx)
                return
            }
            guard let answer = Self.description(d["answer"], type: .answer), await pc.sfuSetRemote(rewrite(answer)) == nil,
                  gen == generation else {
                if gen == generation { renewSession(why: "push answer not applied") }
                return
            }
            localMid = mid
            publishedTrackName = SfuPolicy.trackName
            log("published mid \(mid) in \(Int(now.timeIntervalSince(t0) * 1000)) ms")
        }
    }

    private func abandonPush(_ tx: RTCRtpTransceiver) async {
        if let pc, pc.signalingState == .haveLocalOffer { _ = await pc.sfuSetLocal(RTCSessionDescription(type: .rollback, sdp: "")) }
        if !tx.isStopped { tx.stopInternal() }
        if localTransceiver === tx { localTransceiver = nil }
    }

    // MARK: - Pull (step 5)

    private func pull(_ batch: [(username: String, key: SfuTrackKey)], _ gen: Int) async {
        guard let pc, let sid = sessionId, !batch.isEmpty else { return }
        let names = batch.map(\.username)
        pullsInFlight.formUnion(names)
        defer { if gen == generation { pullsInFlight.subtract(names) } }
        count("pull")
        let r = await call(SocketEvents.Client.sfuPull,
                           ["sessionId": sid, "tracks": batch.map { ["sessionId": $0.key.sessionId, "trackName": $0.key.trackName] }], gen)
        guard gen == generation else { return }
        guard case .success(let d) = r else {
            if case .failure(let e) = r { failed(e, op: "pull") }
            return
        }
        let results = ((d["tracks"] as? [Any]) ?? []).compactMap(SfuPulledTrack.from)
        var opened: [(username: String, key: SfuTrackKey, mid: String)] = []
        for (i, asked) in batch.enumerated() {
            let res = results.first { $0.key == asked.key } ?? (i < results.count ? results[i] : nil)
            guard let res else { continue }
            switch res.outcome {
            case .pulled:
                if let mid = res.mid {
                    opened.append((asked.username, asked.key, mid))
                    midOwners[mid] = asked.username  // before the offer is applied (ontrack fires inside it)
                }
            case .retryLater:
                schedulePullRetry(asked.username, code: res.errorCode ?? "")
            case .refused:
                log("pull of \(asked.username) refused: \(res.errorCode ?? "no mid")")
                refused[asked.username] = asked.key
            }
        }
        // answer the SFU's offer whenever there is one, even when some tracks failed
        if let offer = Self.description(d["offer"], type: .offer) {
            let remoteError = await pc.sfuSetRemote(rewrite(offer))
            guard remoteError == nil, gen == generation,
                  let answer = await pc.sfuAnswer(Self.plain), await pc.sfuSetLocal(answer) == nil, gen == generation else {
                if gen == generation {
                    log("the SFU's offer: \(remoteError?.localizedDescription ?? "no answer")")
                    renewSession(why: "the SFU's offer could not be answered")
                }
                return
            }
            count("renegotiate")
            let rr = await call(SocketEvents.Client.sfuRenegotiate, ["sessionId": sid, "answer": Self.wire(answer)], gen)
            guard gen == generation else { return }
            if case .failure(let e) = rr {
                failed(e, op: "renegotiate")
                if SfuErrorAction.of(e) == .giveUp { renewSession(why: "renegotiate refused") }
                return
            }
        }
        for o in opened {
            let tx = pc.transceivers.first { $0.mid == o.mid && !$0.isStopped }
            let track = tx?.receiver.track as? RTCAudioTrack
            pulls[o.username] = Pull(key: o.key, mid: o.mid, receiver: tx?.receiver, track: track)
            pullRetryCount[o.username] = nil
            stall.forget(o.username)
            if let track { owner?.sfuTrackPulled(o.username, track) }
            log("pulled \(o.username) on mid \(o.mid)")
        }
    }

    private func schedulePullRetry(_ username: String, code: String) {
        let n = (pullRetryCount[username] ?? 0) + 1
        pullRetryCount[username] = n
        guard n <= SfuPolicy.pullRetries else {
            log("pull of \(username): \(code) \(n - 1) times, given up until the roster changes")
            if let key = members[username]?.track { refused[username] = key }
            return
        }
        pullRetryWaiting.insert(username)
        let gen = generation
        hooks.after(SfuPolicy.pullRetryDelay) { [weak self] in
            guard let self, gen == self.generation else { return }
            self.pullRetryWaiting.remove(username)
            self.scheduleSync()
        }
    }

    // MARK: - Close (step 6)

    private func close(_ usernames: [String], _ gen: Int) async {
        guard let pc, let sid = sessionId else { return }
        let held = usernames.compactMap { u in pulls[u].map { (u, $0) } }
        guard !held.isEmpty else { return }
        let mids = held.map(\.1.mid)
        for (u, p) in held {
            if let tx = pc.transceivers.first(where: { $0.mid == p.mid }), !tx.isStopped { tx.stopInternal() }
            pulls[u] = nil
            midOwners[p.mid] = nil
            stall.forget(u)
            owner?.sfuTrackDropped(u)
        }
        count("close")
        log("closing \(held.map(\.0).joined(separator: ", "))")
        // negotiated (step 6); an offer that cannot be made or applied (with max-bundle, a
        // session whose every m-section would be stopped) goes straight to the force close
        if let offer = await pc.sfuOffer(Self.plain), await pc.sfuSetLocal(offer) == nil, gen == generation {
            let r = await call(SocketEvents.Client.sfuClose, ["sessionId": sid, "mids": mids, "offer": Self.wire(offer)], gen)
            guard gen == generation else { return }
            if case .success(let d) = r {
                if let answer = Self.description(d["answer"], type: .answer), await pc.sfuSetRemote(rewrite(answer)) == nil { return }
                if d["answer"] == nil || d["answer"] is NSNull { return }
            } else if case .failure(let e) = r, SfuErrorAction.of(e) == .newSession || SfuErrorAction.of(e) == .drop {
                failed(e, op: "close")
                return
            }
            // roll the offer back, then close by force (no SDP)
            if pc.signalingState == .haveLocalOffer { _ = await pc.sfuSetLocal(RTCSessionDescription(type: .rollback, sdp: "")) }
        }
        guard gen == generation else { return }
        count("closeForce")
        let f = await call(SocketEvents.Client.sfuClose, ["sessionId": sid, "mids": mids, "force": true], gen)
        if gen == generation, case .failure(let e) = f { failed(e, op: "close (force)") }
    }

    // MARK: - Resume (steps 11, 12)

    private func enqueueResume(why: String) {
        enqueue("resume") { [weak self] in await self?.resume(why: why) }
    }

    private func resume(why: String) async {
        guard let sid = sessionId, let token = sessionToken else { return }
        let gen = generation
        count("resume")
        log("resume \(Self.short(sid)) (\(why))")
        let pullList: [[String: Any]] = pulls.values.map { ["mid": $0.mid, "sessionId": $0.key.sessionId, "trackName": $0.key.trackName] }
        let r = await call(SocketEvents.Client.sfuResume, [
            "sessionId": sid, "sessionToken": token,
            "trackName": publishedTrackName ?? NSNull(), "mid": (publishedTrackName == nil ? nil : localMid) ?? NSNull(),
            "pulls": pullList,
        ], gen)
        guard gen == generation else { return }
        if case .success = r { scheduleSync() }
        if case .failure(let e) = r {
            switch e.code {
            case "session_gone", "bad_token", "invalid": renewSession(why: "resume refused (\(e.code))")
            default: failed(e, op: "resume")
            }
        }
    }

    // MARK: - Recovery (steps 9, 10)

    /// Recover the media path: an ICE restart on the same session or a new session (step 9).
    /// `force`: act even while ICE says connected (a stall, a path change).
    func recover(force: Bool, why: String) {
        guard holdsSession, pc != nil else { return }
        guard networkSatisfied, !inBackground else {
            log("recover (\(why)): waiting for \(inBackground ? "the foreground" : "the network")")
            recoveryPending = true
            return
        }
        guard !recovering else { return }
        if !force, isConnected { return }
        recovering = true
        enqueue("recover") { [weak self] in await self?.runRecovery(force: force, why: why) }
    }

    private func runRecovery(force: Bool, why: String) async {
        defer { recovering = false }
        let gen = generation
        var attempts = 0
        while gen == generation {
            // healed by itself (or by the last try) meanwhile: nothing more to do
            if !force || attempts > 0, isConnected { return }
            attempts += 1
            var since = lostAt ?? now
            // back from a long background: the connection was lost when the app went
            if let b = backgroundedAt, let f = foregroundedAt, now.timeIntervalSince(f) < 10, b < since { since = b }
            let away = now.timeIntervalSince(since)
            let choice = SfuRecovery.decide(away: away, sessionGone: sessionGone, published: publishedTrackName != nil,
                                            restartTries: restartTries, everConnected: everConnected)
            log("recover (\(why)): away \(String(format: "%.1f", away)) s -> \(choice)")
            switch choice {
            case .iceRestart:
                restartTries += 1
                if await iceRestart(gen) {
                    restartTries = 0  // connected again: the next drop gets its 2 tries
                    recoveries.append("iceRestart ok \(lastIceRestartMs ?? 0) ms (\(why))")
                    return
                }
                recoveries.append("iceRestart failed (\(why))")
            case .newSession:
                recoveries.append("newSession (\(why))")
                renewSession(why: "recovery")
                return
            }
        }
    }

    /// `pc.restartIce()`, `createOffer({iceRestart: true})`, sfuIceRestart, the answer, then up to
    /// 6 s for connected; the offer rolled back on an error.
    private func iceRestart(_ gen: Int) async -> Bool {
        guard let pc, let sid = sessionId else { return false }
        let t0 = now
        pc.restartIce()
        let constraints = RTCMediaConstraints(mandatoryConstraints: [kRTCMediaConstraintsIceRestart: kRTCMediaConstraintsValueTrue],
                                              optionalConstraints: nil)
        guard let offer = await pc.sfuOffer(constraints), await pc.sfuSetLocal(offer) == nil, gen == generation else { return false }
        count("iceRestart")
        let r = await call(SocketEvents.Client.sfuIceRestart, ["sessionId": sid, "offer": Self.wire(offer)], gen)
        guard gen == generation else { return false }
        switch r {
        case .failure(let e):
            if pc.signalingState == .haveLocalOffer { _ = await pc.sfuSetLocal(RTCSessionDescription(type: .rollback, sdp: "")) }
            if e.code == "session_gone" { sessionGone = true }
            if e.code == "no_local_track" { renewSession(why: "no local track to re-declare"); return true }
            failed(e, op: "iceRestart")
            return false
        case .success(let d):
            guard let answer = Self.description(d["answer"], type: .answer), await pc.sfuSetRemote(rewrite(answer)) == nil,
                  gen == generation else { return false }
            let answeredMs = Int(now.timeIntervalSince(t0) * 1000)
            let up = await waitConnected(SfuPolicy.iceRestartConnectWait, gen)
            lastIceRestartMs = answeredMs
            log("ICE restart answered in \(answeredMs) ms, \(up ? "connected" : "not connected in 6 s")")
            return up
        }
    }

    private func waitConnected(_ timeout: TimeInterval, _ gen: Int) async -> Bool {
        if isConnected { return true }
        nextConnectedWaiter += 1
        let id = nextConnectedWaiter
        return await withCheckedContinuation { cont in
            connectedWaiters[id] = { cont.resume(returning: $0) }
            hooks.after(timeout) { [weak self] in
                guard let self, let w = self.connectedWaiters.removeValue(forKey: id) else { return }
                w(self.isConnected)
            }
        }
    }

    /// From the delegate (on main).
    func connectionChanged(_ changed: RTCPeerConnection, _ state: RTCPeerConnectionState) {
        guard testState == nil else { return }
        handleConnection(changed, state)
    }

    /// A unit test's connection state from now on, as if WebRTC reported it (WebRTC's own
    /// reports are ignored until the next PeerConnection).
    private var testState: RTCPeerConnectionState?
    func simulateConnection(_ state: RTCPeerConnectionState) {
        testState = state
        if let pc { handleConnection(pc, state) }
    }

    private func handleConnection(_ changed: RTCPeerConnection, _ state: RTCPeerConnectionState) {
        guard changed === pc else { return }
        log("connection: \(Self.name(state))")
        switch state {
        case .connected:
            lostAt = nil
            restartTries = 0
            everConnected = true
            disconnectToken &+= 1
            let w = connectedWaiters
            connectedWaiters.removeAll()
            for (_, f) in w { f(true) }
            // anything given up on while the connection was down (a pull) is asked again
            scheduleSync()
        case .disconnected:
            if lostAt == nil { lostAt = now }
            disconnectToken &+= 1
            let token = disconnectToken
            // never act on the first disconnected: 5-12 s drops heal by themselves
            hooks.after(SfuPolicy.disconnectWait) { [weak self] in
                guard let self, self.disconnectToken == token, self.pc === changed,
                      self.connectionState == .disconnected || self.connectionState == .failed else { return }
                self.recover(force: false, why: "still disconnected after \(Int(SfuPolicy.disconnectWait)) s")
            }
        case .failed:
            if lostAt == nil { lostAt = now }
            recover(force: false, why: "failed")
        default:
            break
        }
    }

    // MARK: - Errors (step 8)

    private func failed(_ e: SfuError, op: String) {
        let action = SfuErrorAction.of(e)
        log("\(op): \(e.code) -> \(action)")
        switch action {
        case .newSession:
            if e.code == "session_gone" { sessionGone = true }
            renewSession(why: "\(op): \(e.code)")
        case .resume:
            if pcAlive { enqueueResume(why: "not_your_session") } else { renewSession(why: "not_your_session, dead PeerConnection") }
        case .stopUntilRoster:
            end(leave: false, why: "not in the room")
            status = .none
            owner?.sfuRoomChanged()
        case .drop, .retry, .giveUp:
            break
        }
    }

    // MARK: - Requests

    private func enqueue(_ name: String, _ run: @escaping @MainActor () async -> Void) {
        jobs.append(Job(gen: generation, name: name, run: run))
        drain()
    }

    private func drain() {
        guard !draining else { return }
        draining = true
        Task { @MainActor in
            while !self.jobs.isEmpty {
                let job = self.jobs.removeFirst()
                guard job.gen == self.generation else { continue }
                await job.run()
            }
            self.draining = false
        }
    }

    /// One request and its retries (step 8): rate_limited / busy / timeout /
    /// cloudflare_unreachable / a retryable cloudflare_error again after 0.5, 1, 2, 4 s (at
    /// least the server's retryAfterMs).
    private func call(_ event: String, _ payload: [String: Any], _ gen: Int) async -> Result<[String: Any], SfuError> {
        var attempt = 0
        while true {
            let r = await ask(event, payload, gen)
            guard gen == generation else { return .failure(.superseded) }
            // no retry on a failed PeerConnection: its recovery (queued behind this job) comes first
            if case .failure(let e) = r, SfuErrorAction.of(e) == .retry, attempt < SfuPolicy.backoff.count,
               connectionState != .failed || event == SocketEvents.Client.sfuSession {
                let delay = SfuPolicy.backoffDelay(attempt: attempt, retryAfterMs: e.retryAfterMs)
                attempt += 1
                log("\(event): \(e.code), again in \(delay) s")
                await sleep(delay)
                guard gen == generation else { return .failure(.superseded) }
                // the connection failed meanwhile: give up here, its recovery is queued
                if connectionState == .failed, event != SocketEvents.Client.sfuSession { return r }
                continue
            }
            return r
        }
    }

    private func ask(_ event: String, _ payload: [String: Any], _ gen: Int) async -> Result<[String: Any], SfuError> {
        nextRequest += 1
        let id = "sfu-ios-\(nextRequest)"
        var body = payload
        body["requestId"] = id
        inFlight += 1
        maxInFlight = max(maxInFlight, inFlight)
        return await withCheckedContinuation { cont in
            waiters[id] = Waiter(gen: gen, event: event, resume: { cont.resume(returning: $0) })
            record(event, body)
            hooks.send(event, body)
            hooks.after(SfuPolicy.replyTimeout) { [weak self] in
                guard let self, let w = self.waiters.removeValue(forKey: id) else { return }
                self.inFlight = max(0, self.inFlight - 1)
                self.log("\(event): no reply in \(Int(SfuPolicy.replyTimeout)) s")
                w.resume(.failure(.clientTimeout))
            }
        }
    }

    private func sleep(_ seconds: TimeInterval) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            hooks.after(seconds) { cont.resume() }
        }
    }

    private func record(_ event: String, _ payload: [String: Any]) {
        sent.append((event, payload))
        if sent.count > 400 { sent.removeFirst(sent.count - 400) }
    }

    private func count(_ what: String) { counts[what, default: 0] += 1 }

    private func rewrite(_ sdp: RTCSessionDescription) -> RTCSessionDescription {
        #if DEBUG
        if let f = hooks.rewriteRemote { return RTCSessionDescription(type: sdp.type, sdp: f(sdp.sdp)) }
        #endif
        return sdp
    }

    // MARK: - Helpers

    static let plain = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)

    static func wire(_ sdp: RTCSessionDescription) -> [String: Any] {
        ["type": sdp.type.webString, "sdp": sdp.sdp]
    }

    static func description(_ any: Any?, type: RTCSdpType) -> RTCSessionDescription? {
        guard let d = any as? [String: Any], let sdp = d["sdp"] as? String, !sdp.isEmpty,
              RTCSdpType(from: d["type"] as? String ?? "") == type else { return nil }
        return RTCSessionDescription(type: type, sdp: sdp)
    }

    static func short(_ id: String) -> String { String(id.prefix(8)) }

    static func name(_ s: RTCPeerConnectionState) -> String {
        switch s {
        case .new: return "new"
        case .connecting: return "connecting"
        case .connected: return "connected"
        case .disconnected: return "disconnected"
        case .failed: return "failed"
        case .closed: return "closed"
        @unknown default: return "unknown"
        }
    }
}

extension SfuError {
    /// The work belonged to a replaced session (local: a waiting request answered at once).
    static let superseded = SfuError(code: "superseded", retryable: false, retryAfterMs: nil, status: nil, cfCode: nil)
}

private final class SfuPeerDelegate: NSObject, RTCPeerConnectionDelegate {
    weak var owner: SfuVoice?
    init(owner: SfuVoice) { self.owner = owner }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        DispatchQueue.main.async { [weak self, weak peerConnection] in
            guard let pc = peerConnection else { return }
            MainActor.assumeIsolated { self?.owner?.connectionChanged(pc, newState) }
        }
    }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

// MARK: - async WebRTC

extension RTCPeerConnection {
    func sfuOffer(_ constraints: RTCMediaConstraints) async -> RTCSessionDescription? {
        await withCheckedContinuation { cont in
            offer(for: constraints) { sdp, _ in cont.resume(returning: sdp) }
        }
    }

    func sfuAnswer(_ constraints: RTCMediaConstraints) async -> RTCSessionDescription? {
        await withCheckedContinuation { cont in
            answer(for: constraints) { sdp, _ in cont.resume(returning: sdp) }
        }
    }

    /// nil when applied, else the error.
    func sfuSetLocal(_ sdp: RTCSessionDescription) async -> Error? {
        await withCheckedContinuation { cont in
            setLocalDescription(sdp) { error in cont.resume(returning: error) }
        }
    }

    func sfuSetRemote(_ sdp: RTCSessionDescription) async -> Error? {
        await withCheckedContinuation { cont in
            setRemoteDescription(sdp) { error in cont.resume(returning: error) }
        }
    }
}

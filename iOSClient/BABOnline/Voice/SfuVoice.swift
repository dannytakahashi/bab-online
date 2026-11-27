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
    /// A start is on its way (`initialize` has not finished): a held session is not idle.
    var sfuVoiceStarting: Bool { get }
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
///    with the pull I HOLD (`SfuPlan`); a reconnecting member's pull is kept. The pull on the
///    BUNDLE-tag m-section (the first, `bundleTag`) is never stopped: it is closed by force and
///    its m-section stays, idle (stopping it rejects the bundle's transport: the session went
///    deaf and mute, live 2026-11-26).
/// 7. `sfuMember` is an upsert by username.
/// 8. Every sfuReply error code (`SfuErrorAction`), a 12 s wait for each reply sent on a
///    connected socket. A request is never sent while the socket is down or before the room's
///    roster on a new socket (it waits, `parked`); one sent on a socket that went answers at
///    once as `socket_lost` / `socket_replaced` (`.redo`: asked again or planned again after the
///    resume, never a new session).
/// 9. Media drops: nothing on the first `disconnected` for 2 s; then (or on `failed`, the
///    network coming back (`NWPathMonitor`), a stall) an ICE restart on the same session when
///    away under 25 s with a published track (at most 2), else a new session.
/// 10. The downlink stall detector on the speaking poll's per-receiver stats.
/// 11. A new socket's roster with my session reconnecting: `sfuResume` at once (ahead of the
///     queue, `startResume`) if the PeerConnection is alive, else a new session; my session null
///     on the same bootId: closed. A session kept through a room change that voice does not
///     start again on (nobody else there) ends `VoiceCompany.grace` later (`armIdle`).
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
    /// `sent`: emitted (else parked until the socket and the room are back); `sentAt` for the
    /// reply wait's background check.
    private struct Waiter {
        let gen: Int
        let event: String
        var sent = false
        var sentAt: Date?
        let resume: (Result<[String: Any], SfuError>) -> Void
    }
    private var waiters: [String: Waiter] = [:]
    /// Requests made while signaling is paused (`paused`), sent in order when it is not.
    private var parked: [(id: String, send: @MainActor () -> Void)] = []
    private var nextRequest = 0
    /// When each event last went out (the ICE restart's timing counts from its send).
    private var lastSentAt: [String: Date] = [:]

    // MARK: Signaling (the socket)
    /// The socket as SocketService says (`socketChanged`; the unit tests' socket is up unless a
    /// test says otherwise).
    private(set) var socketUp = true
    /// The socket went down while in the room: nothing is sent until the room's roster on the
    /// new socket (a request before it would answer not_in_room / not_your_session).
    private(set) var needsRoster = false
    /// The roster's sfuResume is on its way (sent ahead of the queue): the rest waits for it.
    private(set) var resuming = false
    private var resumeToken = 0
    /// Nothing is sent now: parked until the socket, the room's roster and its resume are back.
    var paused: Bool { !socketUp || needsRoster || awaitingRoster || resuming }

    // MARK: A kept session voice does not run on
    private var idleToken = 0
    private(set) var idleArmed = false
    /// A pull the server already holds on a mid I do not use (its reply was lost with a socket):
    /// that mid is closed by force and the track pulled again, once per user until the roster changes.
    private var duplicateCloses = Set<String>()
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
        needsRoster = false
        defer { flushParked() }
        if let t = tournamentId, t != r.tournamentId, holdsSession {
            end(leave: false, why: "another tournament's room")
        }
        tournamentId = r.tournamentId
        let newBoot = bootId != nil && bootId != r.bootId
        bootId = r.bootId
        rev = r.rev
        refused.removeAll()
        duplicateCloses.removeAll()
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
                    if pcAlive && !staleAfterBackground { startResume(why: "reconnected socket") } else { renewSession(why: "reconnected with a dead PeerConnection") }
                }
            } else if mine == nil {
                if newBoot {
                    // step 12: the server restarted; media never stopped: the SAME session
                    if pcAlive && !staleAfterBackground { startResume(why: "new bootId") } else { renewSession(why: "new bootId, dead PeerConnection") }
                } else {
                    // step 11: the same bootId with no session: the server dropped mine (the
                    // grace ran out) and closed its pulls: a new one when needed
                    log("the server dropped my session: closing it")
                    dropSession(leave: false, why: "dropped by the server")
                }
            } else {
                // the server holds another session of mine: mine is the one I can still use
                if pcAlive && !staleAfterBackground { startResume(why: "another session on record") } else { renewSession(why: "another session on record") }
            }
        }
        owner?.sfuRoomChanged()
        scheduleSync()
        armIdle()
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
        // back from reconnecting (or away again): its silence meanwhile says nothing about my
        // downlink, so the stall detector starts its clock again at its next sample
        if before?.state != e.member.state { stall.forget(e.member.username) }
        refused.removeAll()  // the roster changed
        duplicateCloses.removeAll()
        log("member \(e.event): \(e.member.username) \(e.member.track == nil ? "no track" : "publishing") \(e.member.state.rawValue)")
        owner?.sfuRoomChanged()
        scheduleSync()
        armIdle()
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
        needsRoster = false
        flushParked()
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
        disarmIdle()
        for (u, p) in pulls { if let t = p.track { owner?.sfuTrackPulled(u, t) } }
        scheduleSync()
    }

    /// A session kept across a room change (`awaitRoster`) whose roster came while voice does not
    /// run here (nobody else in the room: no voice alone never starts it, and VoiceGate arms no
    /// grace for a voice that is not running): it ends `VoiceCompany.grace` later as a running
    /// voice would, with sfuLeave (step 13), unless voice starts meanwhile (`voiceStarted`).
    private func armIdle() {
        guard holdsSession, !idleArmed, owner?.sfuVoiceRunning != true, owner?.sfuVoiceStarting != true else { return }
        idleArmed = true
        idleToken &+= 1
        let token = idleToken
        log("kept session with voice not running: it ends in \(Int(VoiceCompany.grace)) s unless voice starts")
        hooks.after(VoiceCompany.grace) { [weak self] in
            guard let self, self.idleToken == token else { return }
            self.idleArmed = false
            guard self.holdsSession, self.owner?.sfuVoiceRunning != true else { return }
            if self.owner?.sfuVoiceStarting == true { self.armIdle(); return }
            self.leave(why: "voice not running after the room change")
        }
    }

    private func disarmIdle() {
        guard idleArmed else { return }
        idleArmed = false
        idleToken &+= 1
    }

    /// The first unmute (or an unmuted start): push when not published yet.
    func publishWanted() {
        scheduleSync()
    }

    /// Voice stops on this screen while still in the room (no company, the app going away):
    /// sfuLeave then `pc.close()` (step 13). The roster stays (company).
    func leave(why: String) {
        guard holdsSession else {
            releaseHeldAudio()
            return
        }
        end(leave: true, why: why)
    }

    /// The local track was made again (a new voice start on a kept session): the sender sends it.
    func localTrackReplaced(_ track: RTCAudioTrack?) {
        guard let tx = localTransceiver, !tx.isStopped else { return }
        tx.sender.track = track
    }

    // MARK: - The socket (steps 8, 11)

    /// SocketService's connection (its `isConnected`: false on a `.disconnect` or any status but
    /// connected, true at the next `.connect`). Socket.IO-Client-Swift drops an emit made while
    /// not connected without a word (SocketIOClient.emit: "Tried emitting when not connected"),
    /// and a reply to a request sent before a drop goes to the old socket: so at a drop every
    /// request waiting for its reply answers at once as `socket_lost` (`.redo`), and nothing is
    /// sent until the new socket's roster (and its resume) say the room has me again.
    func socketChanged(connected: Bool) {
        guard connected != socketUp else { return }
        socketUp = connected
        if connected {
            log("socket up\(needsRoster ? ": requests wait for the room's roster" : "")")
            flushParked()
            return
        }
        if holdsSession || status != .none { needsRoster = true }
        log("socket down: requests wait for the socket and the room's roster")
        failSentWaiters(.socketLost)
    }

    /// Every request already sent answers now (its reply can never reach this socket).
    private func failSentWaiters(_ e: SfuError) {
        let ids = waiters.filter { $0.value.sent }.map(\.key).sorted()
        guard !ids.isEmpty else { return }
        log("\(ids.count) request(s) lost with the socket: \(e.code)")
        for id in ids {
            guard let w = waiters.removeValue(forKey: id) else { continue }
            inFlight = max(0, inFlight - 1)
            w.resume(.failure(e))
        }
    }

    /// The parked requests go, in order, once nothing pauses signaling.
    private func flushParked() {
        guard !paused, !parked.isEmpty else { return }
        let ready = parked
        parked.removeAll()
        log("sending \(ready.count) waiting request(s)")
        for p in ready where waiters[p.id] != nil { p.send() }
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

    /// Run at each speaking poll: every pulled track of a LIVE member silent 2 s while connected
    /// -> recover. A reconnecting member's silence is expected (their phone or network is away),
    /// so it never counts; with no live member pulled there is nothing to judge. A
    /// PeerConnection that was connected and reads `new` / `connecting` again counts as
    /// connected here (a transport torn down under it: the detector must not go blind).
    func checkStall() {
        guard holdsSession, !recovering else { return }
        let live = Set(pulls.keys.filter { members[$0]?.state == .live })
        guard !live.isEmpty else { return }
        if stall.check(connected: isConnected || lostTransport, pulls: live, now: now) {
            log("downlink stall: every live pulled track silent \(Int(SfuPolicy.stallWindow)) s (next check in \(Int(stall.cooldown)) s)")
            recover(force: true, why: "downlink stall")
        }
    }

    /// Connected once, now `new` / `connecting` (not `disconnected` / `failed`, which step 9's own
    /// timers handle): its transport went away under it (a rejected BUNDLE tag did this).
    private var lostTransport: Bool {
        guard everConnected, let s = connectionState else { return false }
        return s == .new || s == .connecting
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
        guard owner?.sfuVoiceRunning == true, status == .admitted, !awaitingRoster else {
            if sessionId == nil, !sessionAsked { releaseHeldAudio() }
            return
        }
        if sessionId == nil {
            guard wantsSession, !sessionAsked else {
                // a renewal kept the audio session for a next PeerConnection that is no longer
                // wanted (the only publisher went before this sync ran): release it now
                if !sessionAsked { releaseHeldAudio() }
                return
            }
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
            releaseHeldAudio()  // a renewal's audio session with no PeerConnection after it
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
        disarmIdle()
        duplicateCloses.removeAll()
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
        parked.removeAll()
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
        var stale: [String] = []
        defer {
            if !stale.isEmpty, gen == generation {
                enqueue("close stale mids") { [weak self] in
                    guard let self, gen == self.generation, let sid = self.sessionId else { return }
                    self.count("closeForce")
                    let f = await self.call(SocketEvents.Client.sfuClose, ["sessionId": sid, "mids": stale, "force": true], gen, redo: true)
                    guard gen == self.generation else { return }
                    if case .failure(let e) = f { self.failed(e, op: "close (stale)") }
                    self.scheduleSync()
                }
            }
        }
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
                // the server already holds a pull of this track on a mid I do not use (an
                // earlier pull or its renegotiation whose reply was lost with a socket): close
                // that mid by force, then pull the track again (step 5's `duplicate` rule)
                if res.errorCode == "duplicate", let mid = SfuPulledTrack.duplicateMid(res.errorDescription),
                   !pulls.values.contains(where: { $0.mid == mid }), !duplicateCloses.contains(asked.username) {
                    duplicateCloses.insert(asked.username)
                    stale.append(mid)
                    if midOwners[mid] == asked.username { midOwners[mid] = nil }
                    log("pull of \(asked.username): the server holds it on mid \(mid) already: closing that mid")
                    continue
                }
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
        let all = usernames.compactMap { u in pulls[u].map { (u, $0) } }
        guard !all.isEmpty else { return }
        // Never reject the BUNDLE-tag m-section (the first one, whose transport the bundle
        // uses): a negotiated close of it took the whole session's transport down (live
        // 2026-11-26: the connection went `new`, nothing sent or received, no recovery). Its
        // pull is closed by force with its m-section kept, idle (Cloudflare never reuses that
        // mid); the other pulls close negotiated as before.
        let tag = Self.bundleTag(pc)
        let onTag = all.filter { $0.1.mid == tag }
        let held = all.filter { $0.1.mid != tag }
        for (u, p) in all {
            if p.mid != tag, let tx = pc.transceivers.first(where: { $0.mid == p.mid }), !tx.isStopped { tx.stopInternal() }
            pulls[u] = nil
            midOwners[p.mid] = nil
            stall.forget(u)
            owner?.sfuTrackDropped(u)
        }
        count("close")
        log("closing \(all.map(\.0).joined(separator: ", "))\(onTag.isEmpty ? "" : " (mid \(tag ?? "?"), the BUNDLE tag: by force, kept)")")
        if !held.isEmpty {
            await closeMids(held.map(\.1.mid), pc: pc, sid: sid, gen)
            guard gen == generation else { return }
        }
        if !onTag.isEmpty {
            count("closeForce")
            let f = await call(SocketEvents.Client.sfuClose, ["sessionId": sid, "mids": onTag.map(\.1.mid), "force": true], gen, redo: true)
            if gen == generation, case .failure(let e) = f { failed(e, op: "close (force, BUNDLE tag)") }
        }
    }

    /// The BUNDLE group's first mid in my local description (the m-section whose transport the
    /// bundle uses), else the first live transceiver's.
    static func bundleTag(_ pc: RTCPeerConnection) -> String? {
        if let tag = bundleTag(sdp: pc.localDescription?.sdp) { return tag }
        return pc.transceivers.first { !$0.isStopped && !$0.mid.isEmpty }?.mid
    }

    static func bundleTag(sdp: String?) -> String? {
        guard let sdp else { return nil }
        for line in sdp.split(whereSeparator: \.isNewline) where line.hasPrefix("a=group:BUNDLE") {
            return line.split(separator: " ").dropFirst().first.map(String.init)
        }
        return nil
    }

    /// Negotiated (step 6); an offer that cannot be made or applied goes straight to the force close.
    private func closeMids(_ mids: [String], pc: RTCPeerConnection, sid: String, _ gen: Int) async {
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
        let f = await call(SocketEvents.Client.sfuClose, ["sessionId": sid, "mids": mids, "force": true], gen, redo: true)
        if gen == generation, case .failure(let e) = f { failed(e, op: "close (force)") }
    }

    // MARK: - Resume (steps 11, 12)

    private func enqueueResume(why: String) {
        enqueue("resume") { [weak self] in await self?.resume(why: why) }
    }

    /// Step 11 / 12's resume AT ONCE: ahead of the queue (a job of the queue may be waiting for a
    /// reply that went to the old socket). Every request sent before this roster answers now as
    /// `socket_replaced` (its reply can never come here), without touching the session; whatever
    /// the queue asks meanwhile waits (`resuming`) and goes after the resume.
    private func startResume(why: String) {
        failSentWaiters(.socketReplaced)
        resumeToken &+= 1
        let token = resumeToken
        resuming = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.resume(why: why, ahead: true)
            guard self.resumeToken == token else { return }
            self.resuming = false
            self.flushParked()
        }
    }

    private func resume(why: String, ahead: Bool = false) async {
        guard let sid = sessionId, let token = sessionToken else { return }
        let gen = generation
        count("resume")
        log("resume \(Self.short(sid)) (\(why))")
        let pullList: [[String: Any]] = pulls.values.map { ["mid": $0.mid, "sessionId": $0.key.sessionId, "trackName": $0.key.trackName] }
        let r = await call(SocketEvents.Client.sfuResume, [
            "sessionId": sid, "sessionToken": token,
            "trackName": publishedTrackName ?? NSNull(), "mid": (publishedTrackName == nil ? nil : localMid) ?? NSNull(),
            "pulls": pullList,
        ], gen, ahead: ahead)
        guard gen == generation else { return }
        if case .success = r {
            scheduleSync()
            // the media went down too while signaling was away: its recovery (again) now
            if pc != nil, everConnected, !isConnected { recover(force: false, why: "after the resume") }
        }
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
        // the same offer again if its reply went with the socket (sent once the room has me back)
        let r = await call(SocketEvents.Client.sfuIceRestart, ["sessionId": sid, "offer": Self.wire(offer)], gen, redo: true)
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
            // from when it went out (it may have waited for the socket and the room's roster)
            let sentAt = lastSentAt[SocketEvents.Client.sfuIceRestart].map { max($0, t0) } ?? t0
            let answeredMs = Int(now.timeIntervalSince(sentAt) * 1000)
            let waitedMs = Int(sentAt.timeIntervalSince(t0) * 1000)
            let up = await waitConnected(SfuPolicy.iceRestartConnectWait, gen)
            lastIceRestartMs = answeredMs
            log("ICE restart answered in \(answeredMs) ms\(waitedMs > 50 ? " (after \(waitedMs) ms waiting to be sent)" : ""), \(up ? "connected" : "not connected in 6 s")")
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
            armDisconnectWait(changed, what: "disconnected")
        case .new where everConnected, .connecting where everConnected:
            // connected once and back to `new` / `connecting`: the transport went away under it
            // (a rejected BUNDLE tag did that, silently, with no `disconnected`): treated as a
            // disconnect, so a dead transport never sits silent
            armDisconnectWait(changed, what: Self.name(state))
        case .failed:
            if lostAt == nil { lostAt = now }
            recover(force: false, why: "failed")
        default:
            break
        }
    }

    /// Never act on the first disconnected: 5-12 s drops heal by themselves (step 9).
    private func armDisconnectWait(_ changed: RTCPeerConnection, what: String) {
        if lostAt == nil { lostAt = now }
        disconnectToken &+= 1
        let token = disconnectToken
        hooks.after(SfuPolicy.disconnectWait) { [weak self] in
            guard let self, self.disconnectToken == token, self.pc === changed, let state = self.connectionState,
                  state == .disconnected || state == .failed || (self.everConnected && (state == .new || state == .connecting)) else { return }
            self.recover(force: false, why: "still \(what) after \(Int(SfuPolicy.disconnectWait)) s")
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
        case .drop, .redo, .retry, .giveUp:
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
    /// `redo`: a request safe to send again as it was (a force close, an ICE restart's offer):
    /// one lost with the socket (`.redo`) is sent again once signaling is back (at most 3
    /// times); the others are planned again instead. `ahead`: sent even while signaling waits
    /// for the resume (the resume itself).
    private func call(_ event: String, _ payload: [String: Any], _ gen: Int, redo: Bool = false,
                      ahead: Bool = false) async -> Result<[String: Any], SfuError> {
        var attempt = 0
        var redone = 0
        while true {
            let r = await ask(event, payload, gen, ahead: ahead)
            guard gen == generation else { return .failure(.superseded) }
            if case .failure(let e) = r, SfuErrorAction.of(e) == .redo, redo, redone < 3 {
                redone += 1
                log("\(event): \(e.code), sent again once the room has me back")
                continue
            }
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

    /// One request and its reply. Sent at once, or parked while signaling is paused (the socket
    /// down, the room's roster or its resume still to come: an emit then would be dropped by
    /// Socket.IO-Client-Swift or refused by the server) and sent when it is not. The 12 s wait
    /// starts when it is sent; a wait that spans a background (the app may have been suspended,
    /// its socket with it) ends as `socket_lost`, not as a timeout of a working session.
    private func ask(_ event: String, _ payload: [String: Any], _ gen: Int, ahead: Bool = false) async -> Result<[String: Any], SfuError> {
        nextRequest += 1
        let id = "sfu-ios-\(nextRequest)"
        var body = payload
        body["requestId"] = id
        return await withCheckedContinuation { cont in
            waiters[id] = Waiter(gen: gen, event: event, resume: { cont.resume(returning: $0) })
            let send: @MainActor () -> Void = { [weak self] in
                guard let self, self.waiters[id] != nil else { return }
                let sentAt = self.now
                self.waiters[id]?.sent = true
                self.waiters[id]?.sentAt = sentAt
                self.inFlight += 1
                self.maxInFlight = max(self.maxInFlight, self.inFlight)
                self.lastSentAt[event] = sentAt
                self.record(event, body)
                self.hooks.send(event, body)
                self.hooks.after(SfuPolicy.replyTimeout) { [weak self] in
                    guard let self, let w = self.waiters[id], w.sentAt == sentAt else { return }
                    self.waiters[id] = nil
                    self.inFlight = max(0, self.inFlight - 1)
                    if self.inBackground || (self.foregroundedAt.map { $0 > sentAt } ?? false) {
                        self.log("\(event): no reply in \(Int(SfuPolicy.replyTimeout)) s across a background: lost with the socket")
                        w.resume(.failure(.socketLost))
                        self.scheduleSync()  // whatever it was for is planned again
                    } else {
                        self.log("\(event): no reply in \(Int(SfuPolicy.replyTimeout)) s")
                        w.resume(.failure(.clientTimeout))
                    }
                }
            }
            if paused && !ahead {
                log("\(event) waits: \(!socketUp ? "socket down" : resuming ? "the resume first" : "the room's roster")")
                parked.append((id, send))
            } else {
                send()
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
    /// Sent on a socket that dropped (or across a background that likely suspended the app): its
    /// reply can never come (local, `.redo`).
    static let socketLost = SfuError(code: "socket_lost", retryable: false, retryAfterMs: nil, status: nil, cfCode: nil)
    /// Sent before the roster of a new socket that resumes the session (local, `.redo`).
    static let socketReplaced = SfuError(code: "socket_replaced", retryable: false, retryAfterMs: nil, status: nil, cfCode: nil)
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

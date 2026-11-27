/**
 * The web's Cloudflare SFU transport for the tournament lobby's voice room
 * (owner 2026-11-26; docs/claude/voice.md, "SFU voice (server)", whose 15
 * steps of "The client protocol" this follows, and "SFU voice, web").
 *
 * The server relays every request (sfu* -> sfuReply); media goes between
 * this page and Cloudflare on ONE RTCPeerConnection per session. The room's
 * roster (sfuRoster, then sfuMember upserts) says who is here and what each
 * member publishes; this transport keeps its session in step with it by one
 * serial reconcile loop: register the session on this socket (resume), make
 * one when there is something to pull or push (lazy), push my microphone
 * after the first unmute, close the pulls the roster no longer backs, pull
 * the rest in batches of 64. A session's requests all go through that one
 * loop, on the session's own SerialQueue, so a replaced session's pending
 * work is dropped with it (step 3).
 *
 * The page decides the mode (main.js, step 1): an sfuRoster after a
 * tournament lobby entry is this transport's room; a mesh event
 * (voicePeerList / voicePeerJoined / tournamentVoiceStatus) means the mesh,
 * and a session still held is closed first (`onMeshEvent`). Audio goes to
 * the VoiceChatManager (`audio.add` / `audio.remove`, one AudioContext for
 * every pull, step 14); the microphone comes from it (`getMicTrack`).
 */

import { CLIENT_EVENTS } from '../../constants/events.js';
import { createSfuRequester, SerialQueue } from './sfuRequests.js';

/** What the spike used; the SFU is ice-lite, so nothing waits for gathering. */
export const SFU_ICE_SERVERS = Object.freeze([Object.freeze({ urls: 'stun:stun.cloudflare.com:3478' })]);
export const TRACK_NAME = 'mic';
/** At most this many tracks per sfuPull (Cloudflare's per-request limit). */
export const PULL_BATCH = 64;
/** empty_track_error / not_found_track_error: retried this often, this many times. */
export const PULL_RETRY_MS = 1000;
export const PULL_RETRY_MAX = 10;
/** Retryable errors: retryAfterMs, at least these, growing per failure in a row. */
export const BACKOFF_MS = Object.freeze([500, 1000, 2000, 4000]);
/** Step 9: never act on the first `disconnected`; recover when still down after this. */
export const DISCONNECT_WAIT_MS = 2000;
/** Away under this (and published, not 410'd): an ICE restart on the same session; else a new one. */
export const ICE_RESTART_MAX_AWAY_MS = 25000;
export const ICE_RESTART_CONNECT_MS = 6000;
export const ICE_RESTART_TRIES = 2;
/**
 * A new session's connection not up this long after its first negotiation
 * (the SFU connects in 0.6-0.9 s; Chromium reports failed only after ~15 s,
 * seen once in six live runs): recovered as a drop (step 9).
 */
export const CONNECT_TIMEOUT_MS = 5000;
/** Step 10: the downlink stall detector. */
export const STALL_SAMPLE_MS = 500;
export const STALL_MS = 2000;
export const STALL_COOLDOWN_MS = 10000;
/** Step 12: after a new bootId, close no pull of a member who is missing or has no session yet. */
export const BOOT_HOLD_MS = 20000;
/**
 * Opus through the SFU runs ~32 kbps a stream against ~24 in the mesh
 * (step 14). null: Chromium's default. A number caps my sender
 * (RTCRtpSender.setParameters maxBitrate, bits per second).
 */
export const OPUS_MAX_BITRATE = null;

/** Per-track pull errors worth a retry (Cloudflare's: the publisher has no media yet, or not yet everywhere). */
const PULL_RETRY_CODES = new Set(['empty_track_error', 'not_found_track_error']);
/** Request errors retried after a backoff (step 8), plus this side's own. */
const RETRY_CODES = new Set(['rate_limited', 'busy', 'timeout', 'cloudflare_unreachable', 'server_error', 'client_timeout', 'disconnected']);

const sdpOf = (d) => ({ type: d.type, sdp: d.sdp });
const pairKey = (username, sessionId, trackName) => `${username}|${sessionId}|${trackName}`;

/**
 * What a failed reply asks for (step 8).
 * @returns {'gone'|'drop'|'register'|'pause'|'retry'|'fatal'|'cancelled'}
 */
export function classifyError(reply) {
  const code = reply?.error?.code;
  if (code === 'session_gone') return 'gone';
  if (code === 'superseded') return 'drop';
  if (code === 'not_your_session') return 'register';
  if (code === 'not_in_room') return 'pause';
  if (code === 'cancelled') return 'cancelled';
  if (RETRY_CODES.has(code)) return 'retry';
  if (code === 'cloudflare_error' && reply.error.retryable) return 'retry';
  return 'fatal';
}

export class SfuTransport {
  /**
   * @param {Object} o
   * @param {() => (Object|null)} o.getSocket - the SocketManager ({id, isConnected, emit})
   * @param {{add: Function, remove: Function}} o.audio - (username, track, info) / (username)
   * @param {() => (MediaStreamTrack|null)} o.getMicTrack - my microphone's track, null until the first unmute
   * @param {(config: Object) => RTCPeerConnection} [o.createPeerConnection]
   * @param {Window|EventTarget|null} [o.win] - online / offline / pagehide
   * @param {Function} [o.log]
   */
  constructor({ getSocket, audio, getMicTrack, createPeerConnection, win, log } = {}) {
    this._getSocket = getSocket || (() => null);
    this._audio = audio || { add() {}, remove() {} };
    this._getMicTrack = getMicTrack || (() => null);
    this._createPc = createPeerConnection || ((config) => new RTCPeerConnection(config));
    this._win = win === undefined ? (typeof window !== 'undefined' ? window : null) : win;
    this._log = log || ((...a) => console.log('[Voice SFU]', ...a));
    this.opusMaxBitrate = OPUS_MAX_BITRATE;

    this._req = createSfuRequester({
      emit: (event, data) => this._getSocket()?.emit(event, data),
      isConnected: () => !!this._getSocket()?.isConnected,
    });

    /** null (undecided: no voice event yet on this screen) | 'sfu' | 'mesh'. */
    this.mode = null;
    this._room = this._emptyRoom();
    /** @type {Object|null} the session: see _newSession */
    this.session = null;
    this._running = false;
    this._paused = false;      // not_in_room / unavailable: until the next sfuRoster
    this._retryAt = 0;         // backoff after a retryable error
    this._failures = 0;
    this._holdUntil = 0;       // step 12
    this._pullFail = new Map(); // pairKey -> {attempts, retryAt, permanent}
    this._busy = false;
    this._dirty = false;
    this._wake = null;         // the timer that re-runs the loop (backoff, retries, the hold's end)
    this._wakeAt = 0;
    this._changeCallbacks = [];
    this._listeners = null;
    this._offlineAt = null;
    this._hidden = false;
    this.stats = { sessions: 0, pushes: 0, pulls: 0, closes: 0, iceRestarts: 0, resumes: 0, stalls: 0, errors: 0 };
  }

  _emptyRoom() {
    return { tournamentId: null, bootId: null, rev: -1, status: null, cap: null, graceMs: null, self: null, members: new Map(), socketId: null };
  }

  // ------------------------------------------------------------ the page's view

  /** Room status: null | 'admitted' | 'waiting' | 'out'. */
  get status() { return this.mode === 'sfu' ? this._room.status : null; }
  get cap() { return this._room.cap; }
  get bootId() { return this._room.bootId; }
  get running() { return this._running; }

  /** Is another member listed in my SFU room (no voice alone, step 2)? */
  hasCompany() {
    return this.mode === 'sfu' && this._room.status === 'admitted' && this._room.members.size > 0;
  }

  /** The room's other members, in roster order: [{username, state, publishing, pulled}]. */
  members() {
    if (this.mode !== 'sfu' || this._room.status !== 'admitted') return [];
    const s = this.session;
    return [...this._room.members].map(([username, m]) => ({
      username,
      state: m.state,
      publishing: !!(m.sessionId && m.trackName),
      pulled: !!s?.pulls.get(username)?.mid,
    }));
  }

  /** A change the page may draw (company, status, members). */
  onChange(cb) {
    this._changeCallbacks.push(cb);
  }

  _notify() {
    for (const cb of [...this._changeCallbacks]) {
      try { cb(); } catch (e) { /* ignore */ }
    }
  }

  // ------------------------------------------------------------ the page's calls

  /**
   * The tournament lobby screen was (re-)entered: the next voice event
   * decides the mode (step 1); a session held so far waits for it (an
   * sfuRoster resumes it, a mesh event closes it).
   */
  enterRoom() {
    this.mode = null;
    this._paused = false;
    this._notify();
  }

  /** Off the tournament lobby screen (the voice stop ran first): forget the room. */
  exitRoom() {
    if (this.session) this._closeSession(this.session, { leave: true });
    this.mode = null;
    this._room = this._emptyRoom();
    this._holdUntil = 0;
    this._pullFail.clear();
    this._paused = false;
    this._notify();
  }

  /**
   * A mesh voice event: this room is a mesh (step 1). A session still held
   * (a deploy onto a process with the flag off) is closed with no sfuLeave
   * (it would answer not_in_room there).
   */
  onMeshEvent() {
    if (this.mode === 'mesh' && !this.session) return;
    if (this.session) {
      this._log('mesh room: closing the SFU session');
      this._closeSession(this.session, { leave: false });
    }
    this.mode = 'mesh';
    this._room = { ...this._emptyRoom(), bootId: this._room.bootId };
    this._notify();
  }

  /** Voice runs (VoiceChatManager.initialize): the loop may make a session now. */
  start() {
    if (this._running) return;
    this._running = true;
    this._listen();
    this._kick();
  }

  /**
   * Voice stops (VoiceChatManager.shutdown: no company, the screen left, a
   * stop): sfuLeave (best effort: the room drops my track at once and the
   * server closes my pulls) and the PeerConnection closes (step 13). The
   * roster stays, so voice can start again on the next arrival.
   */
  stop({ leave = true } = {}) {
    this._running = false;
    this._unlisten();
    this._clearWake();
    if (this.session) this._closeSession(this.session, { leave });
    this._req.cancelAll();
  }

  /** My microphone is open (the first unmute): push it (step 4). */
  micReady() {
    this._kick();
  }

  /** The gear menu switched microphones: the published sender takes the new track. */
  async replaceMicTrack(track) {
    const sender = this.session?.published?.sender || this.session?.pushTx?.sender;
    if (!sender) return;
    try {
      await sender.replaceTrack(track);
    } catch (err) {
      this._log('replaceTrack failed:', err?.message);
    }
  }

  // ------------------------------------------------------------ the wire

  /** sfuRoster: the room as the server has it for this socket (steps 1, 7, 11, 12). */
  onRoster(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.members)) return;
    const prev = this._room;
    const sock = this._getSocket()?.id ?? null;
    const members = new Map();
    for (const m of d.members) {
      if (m && typeof m.username === 'string') members.set(m.username, { sessionId: m.sessionId ?? null, trackName: m.trackName ?? null, state: m.state || 'live' });
    }
    this._room = {
      tournamentId: d.tournamentId ?? null,
      bootId: d.bootId ?? null,
      rev: typeof d.rev === 'number' ? d.rev : -1,
      status: d.status,
      cap: d.cap ?? null,
      graceMs: d.graceMs ?? null,
      self: d.self || null,
      members,
      socketId: sock,
    };
    this.mode = 'sfu';
    this._paused = false;
    this._failures = 0;
    this._retryAt = 0;
    // "do not retry until the roster changes": it changed
    for (const [k, f] of this._pullFail) if (f.permanent) this._pullFail.delete(k);
    const s = this.session;
    if (d.status !== 'admitted') {
      // waiting in line or out of the room: no voice here (no sfuLeave)
      if (s) this._closeSession(s, { leave: false });
    } else if (s && prev.bootId && d.bootId && prev.bootId !== d.bootId) {
      // a server restart: media never stopped; resume the same session and
      // hold every pull while the others re-register (step 12)
      this._holdUntil = Date.now() + BOOT_HOLD_MS;
      this._log('new bootId: resuming, pulls held', BOOT_HOLD_MS, 'ms');
      this._wakeIn(BOOT_HOLD_MS + 10);
    }
    this._notify();
    this._kick();
  }

  /** sfuMember: one member's whole record, an upsert by username (`left` removes; step 7). */
  onMember(d) {
    if (!d || typeof d !== 'object' || !d.member || typeof d.member.username !== 'string') return;
    const room = this._room;
    if (this.mode !== 'sfu' || room.status !== 'admitted') return;
    if (room.tournamentId && d.tournamentId && d.tournamentId !== room.tournamentId) return;
    if (room.bootId && d.bootId && d.bootId !== room.bootId) return;
    if (typeof d.rev === 'number' && d.rev <= room.rev) return;
    if (typeof d.rev === 'number') room.rev = d.rev;
    const u = d.member.username;
    if (d.event === 'left') room.members.delete(u);
    else room.members.set(u, { sessionId: d.member.sessionId ?? null, trackName: d.member.trackName ?? null, state: d.member.state || 'live' });
    for (const [k, f] of this._pullFail) if (f.permanent && k.startsWith(`${u}|`)) this._pullFail.delete(k);
    this._notify();
    this._kick();
  }

  /** sfuReply (every one, from handlers/voiceHandlers.js). */
  onReply(d) {
    return this._req.onReply(d);
  }

  // ------------------------------------------------------------ the loop

  _kick() {
    if (this._busy) {
      this._dirty = true;
      return;
    }
    this._busy = true;
    this._dirty = true;
    (async () => {
      try {
        let guard = 0;
        while (this._dirty && guard++ < 200) {
          this._dirty = false;
          // one step at a time; a step that did something runs the loop again
          // eslint-disable-next-line no-await-in-loop
          if (await this._step()) this._dirty = true;
        }
      } catch (err) {
        this._log('loop error:', err?.message);
        this._backoff(null);
      } finally {
        this._busy = false;
        if (this._dirty) this._kick();
      }
    })();
  }

  _sock() {
    return this._getSocket()?.id ?? null;
  }

  /** Is the room mine to act in now (running, an SFU room that admitted this very socket)? */
  _ready() {
    if (!this._running || this.mode !== 'sfu' || this._paused || this._hidden) return false;
    const room = this._room;
    if (room.status !== 'admitted') return false;
    const socket = this._getSocket();
    if (!socket?.isConnected || !room.socketId || socket.id !== room.socketId) return false;
    if (Date.now() < this._retryAt) {
      this._wakeAt0(this._retryAt);
      return false;
    }
    return true;
  }

  async _step() {
    if (!this._ready()) return false;
    const s = this.session;
    if (s && s.socketId !== this._sock()) return this._register(s);
    if (s && s.recover) return this._recover(s);
    if (!s) return this._needsSession() ? this._newSession() : false;
    if (s.closeBacklog.length) return this._forceClose(s, s.closeBacklog.splice(0, PULL_BATCH));
    if (this._getMicTrack() && !s.published && !s.publishFailed) return this._push(s);
    const closes = this._closesNeeded(s);
    if (closes.length) return this._close(s, closes);
    const pulls = this._pullsNeeded(s);
    if (pulls.length) return this._pull(s, pulls);
    return false;
  }

  _alive(s) {
    return this.session === s && this._running && !s.queue.dropped;
  }

  /** Something to pull (another member publishing) or to push (my microphone): step 2's lazy session. */
  _needsSession() {
    if (this._getMicTrack()) return true;
    return this._pullsWanted(null).length > 0;
  }

  _backoff(retryAfterMs) {
    const step = BACKOFF_MS[Math.min(this._failures, BACKOFF_MS.length - 1)];
    this._failures++;
    const wait = Math.max(step, typeof retryAfterMs === 'number' ? retryAfterMs : 0);
    this._retryAt = Date.now() + wait;
    this._wakeAt0(this._retryAt);
  }

  _ok() {
    this._failures = 0;
    this._retryAt = 0;
  }

  /** Run the loop again at `at` (the earliest asked wins). */
  _wakeAt0(at) {
    if (this._wake && this._wakeAt <= at) return;
    this._clearWake();
    this._wakeAt = at;
    this._wake = setTimeout(() => {
      this._wake = null;
      this._wakeAt = 0;
      this._kick();
    }, Math.max(0, at - Date.now()));
  }

  _wakeIn(ms) {
    this._wakeAt0(Date.now() + ms);
  }

  _clearWake() {
    if (this._wake) clearTimeout(this._wake);
    this._wake = null;
    this._wakeAt = 0;
  }

  /**
   * Act on a failed reply (step 8); the caller stops its step (the loop
   * runs again on its own when there is anything to do).
   * @returns {string} the class (classifyError)
   */
  _failed(s, op, r) {
    const kind = classifyError(r);
    this.stats.errors++;
    this._log(op, 'refused:', r?.error?.code, kind);
    if (kind === 'gone') {
      if (s && this.session === s) {
        s.gone = true;
        this._closeSession(s, { leave: false });
      }
    } else if (kind === 'register') {
      if (s && this.session === s) s.socketId = null;
      this._dirty = true;
    } else if (kind === 'drop') {
      // the work belonged to a replaced session: dropped; the loop looks
      // again after a short wait (never a tight loop of refused asks)
      this._backoff(null);
    } else if (kind === 'pause') {
      this._paused = true;
    } else if (kind === 'retry') {
      this._backoff(r?.error?.retryAfterMs ?? null);
    }
    return kind;
  }

  // ------------------------------------------------------------ steps

  /** A new session (step 2) and its one PeerConnection (step 3). */
  async _newSession() {
    const sock = this._sock();
    const r = await this._req.request(CLIENT_EVENTS.SFU_SESSION, {});
    if (!this._running || this.session || this._sock() !== sock) return false;
    if (!r.ok) {
      const kind = this._failed(null, 'session', r);
      if (kind === 'fatal') this._paused = true; // unavailable / invalid: until the next roster
      return false;
    }
    this._ok();
    const pc = this._createPc({ bundlePolicy: 'max-bundle', iceServers: SFU_ICE_SERVERS.map((x) => ({ ...x })) });
    const s = {
      sessionId: r.sessionId,
      token: r.sessionToken,
      pc,
      queue: new SerialQueue(),
      socketId: sock,
      bootId: this._room.bootId,
      published: null,
      pushTx: null,
      publishFailed: false,
      closeBacklog: [],   // mids a close could not reach the SFU for yet (closed by force next)
      pulls: new Map(),   // username -> {sessionId, trackName, mid, transceiver, bytes, grewAt}
      byMid: new Map(),   // mid -> username (set BEFORE setRemoteDescription: ontrack fires inside it)
      recover: false,
      forced: false,
      downSince: null,
      iceTries: 0,
      gone: false,
      timers: new Set(),
      stall: { timer: null, lastAt: 0 },
      createdAt: Date.now(),
    };
    this.session = s;
    this.stats.sessions++;
    this._log('session created');
    this._watchPc(s);
    this._notify();
    return true;
  }

  _watchPc(s) {
    const pc = s.pc;
    pc.ontrack = (e) => {
      if (this.session !== s) return;
      const mid = e.transceiver?.mid ?? null;
      const username = mid !== null ? s.byMid.get(mid) : null;
      if (!username || !e.track) return;
      const p = s.pulls.get(username);
      if (p) p.track = e.track;
      this._audio.add(username, e.track, { mid });
    };
    const onState = () => {
      if (this.session !== s) return;
      const c = pc.connectionState;
      const ice = pc.iceConnectionState;
      if (c === 'connected' || ice === 'connected' || ice === 'completed') {
        this._clearTimer(s, 'down');
        this._clearTimer(s, 'connect');
        // a forced recovery (stall, online) still runs, and keeps when the
        // drop began (_healed compares the media with it)
        if (!s.forced) {
          s.recover = false;
          s.downSince = null;
          s.iceTries = 0;
        }
        s.connectedOnce = true;
        this._startStallWatch(s);
        if (s.waitConnected) s.waitConnected();
        return;
      }
      if (c === 'failed' || ice === 'failed') {
        if (s.downSince === null) s.downSince = Date.now();
        this._requestRecover(s, 'failed');
        return;
      }
      if ((c === 'disconnected' || ice === 'disconnected') && s.downSince === null) {
        // never on the first blip: 5-12 s drops heal by themselves
        s.downSince = Date.now();
        this._setTimer(s, 'down', DISCONNECT_WAIT_MS, () => {
          if (this.session !== s) return;
          const still = pc.connectionState !== 'connected' && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed';
          if (still) this._requestRecover(s, 'disconnected');
        });
      }
    };
    pc.onconnectionstatechange = onState;
    pc.oniceconnectionstatechange = onState;
  }

  _setTimer(s, name, ms, fn) {
    this._clearTimer(s, name);
    const t = setTimeout(() => {
      s.timers.delete(s[`_t_${name}`]);
      s[`_t_${name}`] = null;
      fn();
    }, ms);
    s[`_t_${name}`] = t;
    s.timers.add(t);
  }

  _clearTimer(s, name) {
    const t = s[`_t_${name}`];
    if (t) {
      clearTimeout(t);
      s.timers.delete(t);
    }
    s[`_t_${name}`] = null;
  }

  /** After a session's first negotiation: it must connect within CONNECT_TIMEOUT_MS. */
  _armConnectTimer(s) {
    if (s.connectedOnce || s._t_connect) return;
    this._setTimer(s, 'connect', CONNECT_TIMEOUT_MS, () => {
      if (this.session !== s || s.connectedOnce) return;
      if (s.downSince === null) s.downSince = Date.now() - CONNECT_TIMEOUT_MS;
      // never connected: nothing to keep, so no ICE restart (a new session)
      s.iceTries = ICE_RESTART_TRIES;
      this._requestRecover(s, 'not connected');
    });
  }

  _requestRecover(s, why, { force = false } = {}) {
    if (this.session !== s || s.gone) return;
    this._log('recover:', why);
    s.recover = true;
    if (force) s.forced = true;
    this._kick();
  }

  /**
   * Register a held session on this socket (step 11, step 12): the roster
   * lists my session as reconnecting (a new socket), or a new bootId lists
   * none (a server restart): sfuResume at once while the PeerConnection is
   * alive. The same bootId with no session: the server dropped it (the
   * grace ran out): a new one.
   */
  async _register(s) {
    const room = this._room;
    const self = room.self || {};
    const pcAlive = s.pc.connectionState !== 'failed' && s.pc.connectionState !== 'closed' && s.pc.signalingState !== 'closed';
    const listed = self.sessionId === s.sessionId;
    const restarted = !self.sessionId && room.bootId && s.bootId && room.bootId !== s.bootId;
    if (!pcAlive || !(listed || restarted)) {
      this._log('session not resumable:', !pcAlive ? 'connection gone' : 'the server dropped it');
      this._closeSession(s, { leave: false });
      return true;
    }
    const sock = this._sock();
    const pulls = [];
    for (const p of s.pulls.values()) if (p.mid) pulls.push({ mid: p.mid, sessionId: p.sessionId, trackName: p.trackName });
    const r = await s.queue.run(() => this._req.request(CLIENT_EVENTS.SFU_RESUME, {
      sessionId: s.sessionId,
      sessionToken: s.token,
      trackName: s.published?.trackName ?? null,
      mid: s.published?.mid ?? null,
      pulls: pulls.slice(0, 512),
    }));
    if (r.superseded || !this._alive(s) || this._sock() !== sock) return false;
    if (!r.ok) {
      const kind = this._failed(s, 'resume', r);
      // bad_token / invalid (a bug or a state change): never the same resume again
      if (kind === 'fatal' && this.session === s) this._closeSession(s, { leave: false });
      return false;
    }
    this._ok();
    s.socketId = sock;
    s.bootId = room.bootId;
    this.stats.resumes++;
    this._log('session resumed', { published: !!s.published, pulls: pulls.length });
    return true;
  }

  /** The first unmute: publish my microphone on this session (step 4). */
  async _push(s) {
    const mic = this._getMicTrack();
    if (!mic) return false;
    const r = await s.queue.run(async () => {
      const pc = s.pc;
      if (!s.pushTx) s.pushTx = pc.addTransceiver(mic, { direction: 'sendonly' });
      else if (s.pushTx.sender?.track !== mic) await s.pushTx.sender?.replaceTrack?.(mic);
      await pc.setLocalDescription(await pc.createOffer());
      if (!this._alive(s)) return { superseded: true };
      const mid = s.pushTx.mid;
      const reply = await this._req.request(CLIENT_EVENTS.SFU_PUSH, { sessionId: s.sessionId, offer: sdpOf(pc.localDescription), mid, trackName: TRACK_NAME });
      if (!this._alive(s)) return { superseded: true };
      if (!reply.ok) {
        await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        return reply;
      }
      await pc.setRemoteDescription(reply.answer);
      return { ...reply, mid };
    });
    if (r.superseded || !this._alive(s)) return false;
    if (!r.ok) {
      const kind = this._failed(s, 'push', r);
      if (kind === 'fatal') s.publishFailed = true; // already_published / invalid: not the same push again
      return false;
    }
    this._ok();
    const mine = (r.tracks || []).find((t) => t.mid === r.mid) || (r.tracks || [])[0];
    if (mine?.errorCode) {
      this._log('push track error:', mine.errorCode);
      this._backoff(null);
      return false;
    }
    s.published = { mid: r.mid, trackName: TRACK_NAME, sender: s.pushTx.sender };
    this.stats.pushes++;
    this._armConnectTimer(s);
    this._applyOpusCap(s);
    this._log('published', { mid: r.mid });
    return true;
  }

  async _applyOpusCap(s) {
    const sender = s.published?.sender;
    if (!this.opusMaxBitrate || !sender?.getParameters || !sender.setParameters) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = this.opusMaxBitrate;
      await sender.setParameters(params);
    } catch (err) {
      this._log('opus cap not applied:', err?.message);
    }
  }

  /** The members whose published track I do not pull yet and may (step 5). */
  _pullsWanted(s) {
    const out = [];
    const now = Date.now();
    let soonest = 0;
    for (const [username, m] of this._room.members) {
      if (!m.sessionId || !m.trackName) continue;
      if (s && (s.pulls.has(username))) continue;
      const f = this._pullFail.get(pairKey(username, m.sessionId, m.trackName));
      if (f?.permanent) continue;
      if (f && f.retryAt > now) {
        soonest = soonest ? Math.min(soonest, f.retryAt) : f.retryAt;
        continue;
      }
      out.push({ username, sessionId: m.sessionId, trackName: m.trackName });
    }
    if (out.length === 0 && soonest && s) this._wakeAt0(soonest);
    return out;
  }

  _pullsNeeded(s) {
    return this._pullsWanted(s).slice(0, PULL_BATCH);
  }

  /**
   * The pulls the roster no longer backs (step 6), compared with the pull
   * I HOLD: a member gone, unpublished, or on another (sessionId,
   * trackName). A member reconnecting keeps its pull; during the restart
   * hold (step 12) so does one missing or with no session yet.
   */
  _closesNeeded(s) {
    const out = [];
    const hold = Date.now() < this._holdUntil;
    for (const [username, p] of s.pulls) {
      const m = this._room.members.get(username);
      if (!m) {
        if (!hold) out.push(username);
        continue;
      }
      if (m.state === 'reconnecting') continue;
      if (!m.sessionId) {
        if (!hold) out.push(username);
        continue;
      }
      if (!m.trackName || m.sessionId !== p.sessionId || m.trackName !== p.trackName) out.push(username);
    }
    return out.slice(0, PULL_BATCH);
  }

  /** Batched pull (step 5): map each mid before setRemoteDescription, answer whenever offered. */
  async _pull(s, list) {
    for (const t of list) s.pulls.set(t.username, { sessionId: t.sessionId, trackName: t.trackName, mid: null, transceiver: null, asking: true, bytes: 0, grewAt: 0 });
    const r = await s.queue.run(async () => {
      const reply = await this._req.request(CLIENT_EVENTS.SFU_PULL, { sessionId: s.sessionId, tracks: list.map((t) => ({ sessionId: t.sessionId, trackName: t.trackName })) });
      if (!this._alive(s) || !reply.ok) return reply;
      const fresh = [];
      for (const t of reply.tracks || []) {
        const want = list.find((x) => x.sessionId === t.sessionId && x.trackName === t.trackName && (!t.username || x.username === t.username));
        if (!want || !t.mid || t.errorCode) continue;
        s.byMid.set(String(t.mid), want.username);
        fresh.push(String(t.mid));
      }
      let reneg = null;
      if (reply.offer) {
        const pc = s.pc;
        await pc.setRemoteDescription(reply.offer);
        for (const tx of pc.getTransceivers?.() || []) {
          const u = tx.mid !== null ? s.byMid.get(tx.mid) : null;
          if (u && s.pulls.get(u) && !s.pulls.get(u).transceiver && fresh.includes(tx.mid)) s.pulls.get(u).transceiver = tx;
        }
        await pc.setLocalDescription(await pc.createAnswer());
        if (!this._alive(s)) return { superseded: true };
        reneg = await this._renegotiate(s);
      }
      return { ...reply, fresh, reneg };
    });
    if (r.superseded || !this._alive(s)) {
      if (this.session === s) for (const t of list) if (s.pulls.get(t.username)?.asking) s.pulls.delete(t.username);
      return false;
    }
    if (!r.ok) {
      for (const t of list) if (s.pulls.get(t.username)?.asking) s.pulls.delete(t.username);
      const kind = this._failed(s, 'pull', r);
      if (kind === 'fatal') for (const t of list) this._pullFail.set(pairKey(t.username, t.sessionId, t.trackName), { attempts: 0, retryAt: 0, permanent: true });
      return false;
    }
    this._ok();
    const forceClose = [];
    for (const t of list) {
      const res = (r.tracks || []).find((x) => x.sessionId === t.sessionId && x.trackName === t.trackName && (!x.username || x.username === t.username));
      const p = s.pulls.get(t.username);
      const key = pairKey(t.username, t.sessionId, t.trackName);
      if (res && res.mid && !res.errorCode && p) {
        p.mid = String(res.mid);
        p.asking = false;
        this._pullFail.delete(key);
        this.stats.pulls++;
        continue;
      }
      s.pulls.delete(t.username);
      const code = res?.errorCode || 'no_result';
      if (PULL_RETRY_CODES.has(code)) {
        const f = this._pullFail.get(key) || { attempts: 0, retryAt: 0, permanent: false };
        f.attempts++;
        f.retryAt = Date.now() + PULL_RETRY_MS;
        f.permanent = f.attempts >= PULL_RETRY_MAX;
        this._pullFail.set(key, f);
        if (!f.permanent) this._wakeAt0(f.retryAt);
      } else if (code === 'duplicate') {
        // this session pulls it already (a pull whose reply came too late
        // to be read): close the mid I do not use, then pull again once
        const m = /mid (\S+)/.exec(res?.errorDescription || '');
        const f = this._pullFail.get(key);
        if (m && !s.byMid.has(m[1]) && !f?.dupClosed) {
          forceClose.push(m[1]);
          this._pullFail.set(key, { attempts: 0, retryAt: 0, permanent: false, dupClosed: true });
        } else {
          this._pullFail.set(key, { attempts: 0, retryAt: 0, permanent: true });
        }
      } else {
        // not_in_room / own_track / blocked / too_many_pulls / no_result: until the roster changes
        this._pullFail.set(key, { attempts: 0, retryAt: 0, permanent: true });
      }
    }
    if (r.reneg && !r.reneg.ok) {
      // the SFU never got my answer: these pulls cannot flow; closed by force and asked again later
      const mids = r.fresh.filter((mid) => s.byMid.has(mid));
      for (const mid of mids) {
        const u = s.byMid.get(mid);
        s.byMid.delete(mid);
        if (u && s.pulls.get(u)?.mid === mid) {
          s.pulls.delete(u);
          this._audio.remove(u);
        }
      }
      forceClose.push(...mids);
      const kind = this._failed(s, 'renegotiate', r.reneg);
      if (kind === 'gone' || kind === 'pause') return false;
    }
    if (r.reneg?.ok) this._armConnectTimer(s);
    if (forceClose.length && this._alive(s)) await this._forceClose(s, forceClose);
    this._notify();
    return true;
  }

  /** My answer to the SFU's offer, retried on a retryable error (a few times). */
  async _renegotiate(s) {
    let reply = null;
    for (let i = 0; i < 3; i++) {
      reply = await this._req.request(CLIENT_EVENTS.SFU_RENEGOTIATE, { sessionId: s.sessionId, answer: sdpOf(s.pc.localDescription) });
      if (reply.ok || !this._alive(s) || classifyError(reply) !== 'retry') return reply;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => setTimeout(res, Math.max(reply.error?.retryAfterMs || 0, BACKOFF_MS[i])));
      if (!this._alive(s)) return reply;
    }
    return reply;
  }

  /**
   * Close pulls (step 6): negotiated (transceiver.stop(), my offer, the
   * SFU's answer); on any error roll back and close by force. The audio
   * goes at once.
   */
  async _close(s, usernames) {
    const items = [];
    for (const u of usernames) {
      const p = s.pulls.get(u);
      s.pulls.delete(u);
      this._audio.remove(u);
      if (!p?.mid) continue;
      if (s.byMid.get(p.mid) === u) s.byMid.delete(p.mid);
      items.push(p);
    }
    this._notify();
    if (items.length === 0) return true;
    const mids = items.map((p) => p.mid);
    const r = await s.queue.run(async () => {
      const pc = s.pc;
      let offered = false;
      try {
        for (const p of items) {
          const tx = p.transceiver || (pc.getTransceivers?.() || []).find((x) => x.mid === p.mid);
          tx?.stop?.();
        }
        await pc.setLocalDescription(await pc.createOffer());
        offered = true;
      } catch (err) {
        this._log('close offer failed:', err?.message);
      }
      if (!this._alive(s)) return { superseded: true };
      if (offered) {
        const reply = await this._req.request(CLIENT_EVENTS.SFU_CLOSE, { sessionId: s.sessionId, mids, offer: sdpOf(pc.localDescription) });
        if (!this._alive(s)) return { superseded: true };
        if (reply.ok) {
          try {
            if (reply.answer) await pc.setRemoteDescription(reply.answer);
            return reply;
          } catch (err) {
            this._log('close answer failed:', err?.message);
          }
        } else if (classifyError(reply) === 'gone' || classifyError(reply) === 'pause' || classifyError(reply) === 'register') {
          return reply;
        }
        await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
      }
      return { forceNeeded: true };
    });
    if (r.superseded || !this._alive(s)) return false;
    if (r.forceNeeded) return this._forceClose(s, mids);
    if (!r.ok) {
      // gone: nothing left to close; else (my socket's registration, a
      // pause) by force once the session is mine again
      if (this._failed(s, 'close', r) !== 'gone') s.closeBacklog.push(...mids);
      return false;
    }
    this._ok();
    this.stats.closes += mids.length;
    return true;
  }

  async _forceClose(s, mids) {
    const r = await s.queue.run(() => this._req.request(CLIENT_EVENTS.SFU_CLOSE, { sessionId: s.sessionId, mids: mids.slice(0, PULL_BATCH), force: true }));
    if (r.superseded || !this._alive(s)) return false;
    if (!r.ok) {
      // retried when it may work later; otherwise the server closes what a
      // session it no longer holds pulled, and a live one keeps the stray
      // mid (silent: nothing maps it) until the session ends
      const kind = this._failed(s, 'close(force)', r);
      if (kind === 'retry' || kind === 'register' || kind === 'pause') s.closeBacklog.push(...mids);
      return false;
    }
    this._ok();
    this.stats.closes += mids.length;
    return true;
  }

  /**
   * Media drop recovery (step 9): away under 25 s, not 410'd and
   * published: an ICE restart on the same session (at most 2 tries, 6 s
   * each for connected); otherwise a new session (pushed again when
   * unmuted, everyone pulled again).
   */
  async _recover(s) {
    // Healed by itself meanwhile (a 5-12 s drop does; the recovery may have
    // waited for the signaling socket): connected and media flowing again
    if (this._healed(s)) {
      this._log('recover skipped: healed');
      s.recover = false;
      s.forced = false;
      s.downSince = null;
      s.iceTries = 0;
      return true;
    }
    const away = s.downSince === null ? 0 : Date.now() - s.downSince;
    if (away < ICE_RESTART_MAX_AWAY_MS && !s.gone && s.published && s.iceTries < ICE_RESTART_TRIES) {
      s.iceTries++;
      this.stats.iceRestarts++;
      const t0 = Date.now();
      const r = await s.queue.run(async () => {
        const pc = s.pc;
        try {
          pc.restartIce?.();
          await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
        } catch (err) {
          return { ok: false, error: { code: 'local_error', retryable: false } };
        }
        if (!this._alive(s)) return { superseded: true };
        const reply = await this._req.request(CLIENT_EVENTS.SFU_ICE_RESTART, { sessionId: s.sessionId, offer: sdpOf(pc.localDescription) });
        if (!this._alive(s)) return { superseded: true };
        if (!reply.ok) {
          await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
          return reply;
        }
        try {
          await pc.setRemoteDescription(reply.answer);
        } catch (err) {
          await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
          return { ok: false, error: { code: 'local_error', retryable: false } };
        }
        const up = await this._waitConnected(s, ICE_RESTART_CONNECT_MS);
        return { ok: true, up };
      });
      if (r.superseded || !this._alive(s)) return false;
      if (!r.ok) {
        const code = r.error?.code;
        if (code === 'no_local_track') {
          this._closeSession(s, { leave: false });
          return true;
        }
        const kind = this._failed(s, 'iceRestart', r);
        if (kind === 'gone' || kind === 'pause' || kind === 'register') return false;
        return true; // the next try, or a new session after the last
      }
      this._ok();
      if (r.up) {
        this._log('ICE restart connected in', Date.now() - t0, 'ms');
        // media gets STALL_MS on the new path before the detector judges it
        const now = Date.now();
        for (const p of s.pulls.values()) if (p.grewAt) p.grewAt = now;
        s.recover = false;
        s.forced = false;
        s.downSince = null;
        s.iceTries = 0;
      }
      return true;
    }
    this._log('recover with a new session', { away, gone: s.gone, published: !!s.published, tries: s.iceTries });
    this._closeSession(s, { leave: false });
    return true;
  }

  /**
   * A pulled track received bytes again after the drop began (the stall
   * detector's samples, taken in every state): the path works again, even
   * while ICE still says disconnected for a moment.
   */
  _healed(s) {
    if (s.downSince === null || s.pc.connectionState === 'failed' || s.pc.connectionState === 'closed') return false;
    const now = Date.now();
    for (const p of s.pulls.values()) {
      if (p.grewAt && p.grewAt > s.downSince + STALL_MS && now - p.grewAt < STALL_MS) return true;
    }
    return false;
  }

  /**
   * Connected again within `ms`? A connection that says connected already
   * (a forced restart: the stall detector or the network-up event) is not
   * waited on: its state never changes, and the stall detector checks the
   * media again.
   */
  _waitConnected(s, ms) {
    const pc = s.pc;
    const isUp = () => pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
    if (isUp()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v) => {
        s.waitConnected = null;
        this._clearTimer(s, 'iceWait');
        resolve(v);
      };
      s.waitConnected = () => done(true);
      this._setTimer(s, 'iceWait', ms, () => done(isUp()));
    });
  }

  /**
   * The downlink stall detector (step 10): connected, pulling at least one
   * track, and every pulled track that has received bytes received nothing
   * for 2 s: recover (an ICE restart though ICE says connected), at most
   * once per 10 s.
   */
  _startStallWatch(s) {
    if (s.stall.timer) return;
    s.stall.timer = setInterval(() => this._sampleStall(s), STALL_SAMPLE_MS);
    s.timers.add(s.stall.timer);
  }

  async _sampleStall(s) {
    if (this.session !== s || !s.pc.getStats || s.sampling) return;
    const pc = s.pc;
    if (pc.signalingState === 'closed') return;
    s.sampling = true;
    let report = null;
    try {
      report = await pc.getStats();
    } catch (err) {
      report = null;
    } finally {
      s.sampling = false;
    }
    if (!report || this.session !== s) return;
    const bytesByMid = new Map();
    report.forEach((st) => {
      if (st.type !== 'inbound-rtp' || st.kind !== 'audio' || st.mid === undefined) return;
      // Chrome may keep a tiny extra stream on a mid that survived a close: the biggest counts
      const prev = bytesByMid.get(String(st.mid)) || 0;
      bytesByMid.set(String(st.mid), Math.max(prev, st.bytesReceived || 0));
    });
    const now = Date.now();
    let watched = 0;
    let stalled = 0;
    for (const [username, p] of s.pulls) {
      if (!p.mid) continue;
      const b = bytesByMid.get(p.mid) || 0;
      if (b > p.bytes) {
        p.bytes = b;
        p.grewAt = now;
      }
      const m = this._room.members.get(username);
      if (!p.grewAt || m?.state === 'reconnecting') continue;
      watched++;
      if (now - p.grewAt >= STALL_MS) stalled++;
    }
    // the bytes are watched in every state (a recovery that waited may find
    // the media flowing again: _healed); a stall counts only while connected
    const up = pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
    if (up && !s.recover && watched > 0 && stalled === watched && now - s.stall.lastAt >= STALL_COOLDOWN_MS) {
      s.stall.lastAt = now;
      this.stats.stalls++;
      if (s.downSince === null) s.downSince = now - STALL_MS;
      this._requestRecover(s, 'downlink stall', { force: true });
    }
  }

  /** Inbound bytes per pulled member (tests and the live harness): {username: bytes}. */
  pulledBytes() {
    const out = {};
    for (const [u, p] of this.session?.pulls || []) out[u] = p.bytes;
    return out;
  }

  // ------------------------------------------------------------ teardown

  _closeSession(s, { leave }) {
    if (leave && s.socketId && s.socketId === this._sock()) {
      // best effort, never awaited
      this._req.request(CLIENT_EVENTS.SFU_LEAVE, { sessionId: s.sessionId });
    }
    s.queue.drop();
    for (const t of s.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    s.timers.clear();
    s.waitConnected = null;
    try {
      s.pc.ontrack = null;
      s.pc.onconnectionstatechange = null;
      s.pc.oniceconnectionstatechange = null;
      if (s.pc.signalingState !== 'closed') s.pc.close();
    } catch (err) { /* closed already */ }
    for (const u of s.pulls.keys()) this._audio.remove(u);
    s.pulls.clear();
    s.byMid.clear();
    if (this.session === s) {
      this.session = null;
      this._notify();
      if (this._running) this._kick();
    }
  }

  // ------------------------------------------------------------ the page's network events

  _listen() {
    const w = this._win;
    if (!w || this._listeners || typeof w.addEventListener !== 'function') return;
    this._listeners = {
      offline: () => { this._offlineAt = Date.now(); },
      online: () => {
        // the OS says the network is back: recover now (step 9), not after ICE notices
        const s = this.session;
        const since = this._offlineAt;
        this._offlineAt = null;
        if (!s) return this._kick();
        if (s.downSince === null) s.downSince = since ?? Date.now();
        this._requestRecover(s, 'online', { force: true });
        return undefined;
      },
      pagehide: () => {
        // the page goes away (step 13): the room drops my track now, and
        // nothing new is made while it unloads
        this._hidden = true;
        if (this.session) this._closeSession(this.session, { leave: true });
      },
      pageshow: () => {
        this._hidden = false;
        this._kick();
      },
    };
    for (const [ev, fn] of Object.entries(this._listeners)) w.addEventListener(ev, fn);
  }

  _unlisten() {
    const w = this._win;
    if (!w || !this._listeners) return;
    for (const [ev, fn] of Object.entries(this._listeners)) w.removeEventListener(ev, fn);
    this._listeners = null;
  }
}

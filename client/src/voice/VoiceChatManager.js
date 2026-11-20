/**
 * VoiceChatManager - WebRTC peer-to-peer voice chat.
 *
 * Full-mesh topology: each human player maintains an RTCPeerConnection to
 * every other human. The server relays signaling only; media goes peer to
 * peer, or through Cloudflare's TURN relay (encrypted SRTP) when a direct
 * path fails.
 *
 * ICE servers come from the server (getVoiceIceServers -> voiceIceServers:
 * short-lived TURN credentials, else the public STUN servers) before the
 * first peer connection of a session; a missing or late answer falls back
 * to STUN_ICE_SERVERS. They are reused for the session (per username) and
 * refreshed REFRESH_BEFORE_MS before they expire (setConfiguration on the
 * open connections). A failed connection (or one not up within
 * CONNECT_TIMEOUT_MS) gets ONE restart (the peer with
 * the lower socket id offers again on fresh ICE servers; the other waits for
 * that offer); if it still fails the peer shows "voice unavailable".
 *
 * Muted at the start (owner 2026-11-18: "by default the mic should be muted
 * and you can click to unmute / activate mic"; docs/claude/voice.md): a
 * session starts with no microphone (`_wantTalk` false, `selfMuted` true),
 * so joining voice never prompts; the first unmute (setMuted(false)) asks
 * for it (getUserMedia) and a refusal stays muted (`micDenied`, listen
 * only). Every call carries an audio sender from the start: the
 * microphone's track, else a silent track (`_silentSource`: an empty
 * MediaStreamAudioDestinationNode of the session's AudioContext), so an
 * unmute only swaps the sender's track (replaceTrack): no renegotiation,
 * no call is re-created, and every peer (shipped iOS builds included) sees
 * an ordinary sendrecv call from the first offer. Muting again keeps the
 * microphone and disables its track (as before).
 *
 * Fallback (no AudioContext destination: an old browser, the unit tests'
 * fake): no sender without a microphone, so an offer carries a recvonly
 * audio transceiver and an answer adds no track; getting the microphone
 * then re-offers each such call (setTalk: the restart path, a replacement
 * offer; each side keeps its per-peer mute and volume); a call still
 * waiting for its answer is re-offered after it.
 *
 * Crossing offers (both ends re-offer the same call at once: two spectators
 * changing mode on one voiceSettings): the end with the lower socket id
 * keeps its own offer and ignores the other's (the same end that restarts
 * a failed call); the higher end replaces its offer with an answer. An
 * offer that arrives after the answer to ours is a new negotiation, never
 * a collision (the server relays one sender's signals in order).
 */

import { CLIENT_EVENTS } from '../constants/events.js';
import { getGameState } from '../state/GameState.js';
import { sessionWantsUnmuted, rememberSessionMute, micAlreadyAllowed } from './voiceSessionMute.js';

/** What voice used before TURN, and still uses without it. */
export const STUN_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: 'stun:stun.l.google.com:19302' }),
  Object.freeze({ urls: 'stun:stun1.l.google.com:19302' })
]);

/** How long to wait for voiceIceServers before using STUN only. */
export const ICE_FETCH_TIMEOUT_MS = 4000;
/** Refresh TURN credentials this long before they expire. */
export const REFRESH_BEFORE_MS = 30 * 60 * 1000;
/** The side that does not re-offer waits this long for the restart. */
export const RESTART_WAIT_MS = 15000;
/** A connection not up by then counts as failed (it may never say so). */
export const CONNECT_TIMEOUT_MS = 20000;

const SPEAKING_THRESHOLD = 0.005;
const SPEAKING_POLL_INTERVAL = 100;
const SPEAKING_HOLD_MS = 400; // Keep gate open after speech stops
// Candidates kept per buffered offer while voice is not running yet
const MAX_PENDING_CANDIDATES = 100;

/** A setTalk's re-offers wait this long (the server's voicePeerLeft for a pair it drops lands first). */
export const REOFFER_DELAY_MS = 300;
// Audio elements unlocked by the session's first gesture (WebKit plays an
// element with sound without a gesture only once a gesture has played it,
// or while the page captures a microphone, which a muted start does not):
// the most calls a session holds (7, a mesh of 8) and one spare
export const AUDIO_POOL_SIZE = 8;

/** Keep only well-formed RTCIceServer entries from a voiceIceServers payload. */
export function sanitizeIceServers(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls])
      .filter(u => typeof u === 'string' && /^(stun|turn|turns):/i.test(u));
    if (urls.length === 0) continue;
    const entry = { urls };
    if (typeof s.username === 'string') entry.username = s.username;
    if (typeof s.credential === 'string') entry.credential = s.credential;
    out.push(entry);
  }
  return out.length > 0 ? out : null;
}

export class VoiceChatManager {
  constructor() {
    /** @type {MediaStream|null} */
    this.localStream = null;

    /** @type {Map<string, {connection: RTCPeerConnection, username: string, stream: MediaStream|null}>} */
    this.peers = new Map();

    this.socketManager = null;
    // Muted until the person unmutes (owner 2026-11-18): no microphone yet
    this.selfMuted = true;
    this.active = false;

    // Speaking detection
    this._audioContext = null;
    this._analysers = new Map(); // socketId|'self' → { analyser, dataArray }
    this._speakingStates = new Map(); // socketId|'self' → boolean
    this._speakingLastActive = new Map(); // socketId|'self' → timestamp of last above-threshold
    this._speakingInterval = null;
    this._speakingCallbacks = [];

    // Per-peer mute state
    this._peerMuted = new Map(); // socketId → boolean

    // Talk mode: the desired one (the microphone; read by every new
    // connection), whether the microphone was refused, the mode changes in
    // order, the calls whose re-offer waits for their answer (fallback
    // only), the scheduled re-offer
    this._wantTalk = false;
    this.micDenied = false;
    // The silent sender track while no microphone is held: {stream, track}
    // (null: not made yet, or this browser cannot: the fallback)
    this._silent = null;
    this._modeChain = Promise.resolve();
    this._reofferPending = new Set();
    this._reofferTimer = null;
    this._modeCallbacks = [];

    // Autoplay: an audio element the browser would not play waits for the
    // next pointerdown (every element is played again then)
    this._autoplayArmed = false;
    this._autoplayListener = null;
    this._autoplayCallbacks = [];
    // Unlocked audio elements not in a call (_takeAudioEl / _releaseAudioEl)
    // and the listener that unlocks them at the session's first gesture
    this._audioPool = [];
    this._unlockListener = null;

    // Per-peer volume control (Web Audio API)
    this._gainNodes = new Map(); // socketId → GainNode
    this._peerVolumes = new Map(); // socketId → number (0.0–2.0, default 1.0)

    // Local username for offer relay
    this._localUsername = null;

    // Buffered events received before initialization completes (or while
    // voice is not running: no voice alone, owner 2026-11-19, a newcomer's
    // offer reaches a page whose voice starts on its arrival): the offers,
    // the peers to call and each offer's trickled candidates
    this._pendingPeers = [];
    this._pendingOffers = [];
    this._pendingCandidates = new Map(); // socketId -> [candidate]

    // ICE servers: { username, iceServers, turn, expiresAt (ms) | null, fallback };
    // kept across shutdown; a TURN answer is reused for the session (per
    // username), a STUN-only one is asked again (ensureIceServers)
    this._ice = null;
    this._iceFetch = null;          // in-flight Promise<void>
    this._iceRequests = new Map();  // requestId → resolve
    this._iceRequestSeq = 0;
    this._iceRefreshTimer = null;

    // Connection recovery: socketId → restarts used (0 or 1); socketIds whose
    // connection failed for good; socketId → wait timer for the remote restart
    this._restarts = new Map();
    this._unavailable = new Set();
    this._restartTimers = new Map();
    this._connectTimers = new Map(); // socketId → CONNECT_TIMEOUT_MS timer

    // Bumped by shutdown: an initialize still awaiting stops when it changes
    this._generation = 0;
    // Unmutes waiting for the microphone prompt (micRequestInFlight)
    this._micRequests = 0;
    // The microphone picked in the gear menu (kept for the tab, like the
    // browser's own choice; null: the default)
    this._preferredDeviceId = null;
    // This page got the microphone once (kept through shutdown): a later
    // start may open it again with no prompt (voiceSessionMute.js)
    this._micGrantedThisPage = false;
  }

  /**
   * Initialize voice chat (muted: no microphone is asked for unless `talk`)
   * and set up signaling listeners. A refused microphone falls back to
   * listen-only: the session starts anyway and hears everyone (`micDenied`).
   * @param {import('../socket/SocketManager.js').SocketManager} socketManager
   * @param {Object} [opts]
   * @param {boolean} [opts.talk] - start with the microphone, unmuted (default: the current mode, muted)
   */
  async initialize(socketManager, { talk } = {}) {
    if (this.active) return;

    this.socketManager = socketManager;
    if (typeof talk === 'boolean') this._wantTalk = talk;
    const generation = this._generation;
    // In parallel with the microphone prompt; never rejects
    const iceReady = this.ensureIceServers();

    // Unmuted by hand earlier in this tab (owner 2026-11-19: it stays
    // unmuted for the session): with the microphone already allowed this
    // start opens it (no prompt) and starts unmuted; otherwise muted as
    // every first start. A failure here is not a refusal: muted, no toast
    let resumed = null;
    if (typeof talk !== 'boolean' && !this._wantTalk && sessionWantsUnmuted() &&
        await micAlreadyAllowed({ grantedThisPage: this._micGrantedThisPage })) {
      try {
        if (generation === this._generation) resumed = await this._getPreferredMic();
      } catch (err) {
        console.warn('[Voice] the microphone did not open again:', err?.message);
      }
      if (resumed && generation !== this._generation) {
        // shut down while it opened: this start is over (the stop reset the mode)
        resumed.getTracks().forEach(t => t.stop());
        return;
      }
      if (resumed) {
        this._wantTalk = true;
        this.micDenied = false;
        this._micGrantedThisPage = true;
      }
    }

    let stream = await this._streamForMode(resumed, generation);
    await iceReady;
    // A voiceSettings during the prompt or the ICE wait changed the mode:
    // the latest one wins
    stream = await this._streamForMode(stream, generation);
    if (generation !== this._generation || this.active) {
      // shut down (or started elsewhere) while waiting: release the mic
      stream?.getTracks().forEach(t => t.stop());
      return;
    }
    this.localStream = stream;
    // A session that starts with its microphone (talk) starts unmuted
    this.selfMuted = !stream;

    this.active = true;
    this._localUsername = getGameState().username || null;
    // Set up speaking detection for local stream
    this._setupAudioContext();
    if (this.localStream) this._addAnalyser('self', this.localStream);
    else this._silentSource();
    this._startSpeakingDetection();
    this._armUnlock();

    console.log('[Voice] initialized, username:', this._localUsername, 'talk:', !!this.localStream, 'audioCtx:', this._audioContext?.state);
    this._notifyMode();

    // Flush buffered events that arrived before initialization.
    // Process offers first — if we have an offer from a peer, we don't need
    // to also initiate to them (that would cause WebRTC glare).
    const offerPeerIds = new Set(this._pendingOffers.map(o => o.fromSocketId));
    const pendingPeers = this._pendingPeers;
    const pendingOffers = this._pendingOffers;
    const pendingCandidates = this._pendingCandidates;
    this._pendingPeers = [];
    this._pendingOffers = [];
    this._pendingCandidates = new Map();

    console.log('[Voice] flushing', pendingOffers.length, 'offers,', pendingPeers.length, 'peers');
    for (const o of pendingOffers) {
      // handleOffer sets the remote description before its first await, so
      // the candidates that came with the offer queue behind it
      this.handleOffer(o.fromSocketId, o.offer, o.username);
      for (const c of pendingCandidates.get(o.fromSocketId) || []) this.handleIceCandidate(o.fromSocketId, c);
    }
    for (const p of pendingPeers) {
      if (!offerPeerIds.has(p.socketId)) {
        this.connectToPeer(p.socketId, p.username);
      }
    }
  }

  /**
   * The microphone stream the desired mode wants, from `stream` (one held
   * already, or null): asks for it while talk is wanted (a refusal turns
   * the mode to listen-only), releases it when not. Repeats while the mode
   * changed during the prompt.
   * @returns {Promise<MediaStream|null>}
   */
  async _streamForMode(stream, generation) {
    for (let i = 0; i < 4; i++) {
      if (generation !== this._generation) break;
      if (this._wantTalk && !stream) {
        stream = await this._getMic();
        if (!stream) break; // refused: listen-only
      } else if (!this._wantTalk && stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
      } else {
        break;
      }
    }
    return stream;
  }

  /**
   * The microphone, or null (refused or unavailable: listen-only from now
   * on). The one picked in the gear menu before the first unmute
   * (`_preferredDeviceId`) when it is still there, else the default.
   */
  async _getMic() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable');
      const stream = await this._getPreferredMic();
      this.micDenied = false;
      this._micGrantedThisPage = true;
      return stream;
    } catch (err) {
      console.warn('Mic permission denied:', err?.message);
      this.micDenied = true;
      this._wantTalk = false;
      return null;
    }
  }

  /** getUserMedia for the picked microphone; one that is gone (unplugged) falls back to the default. */
  async _getPreferredMic() {
    const id = this._preferredDeviceId;
    if (!id) return navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } } });
    } catch (err) {
      // a refusal is a refusal (never a second prompt); only a missing device falls back
      if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') throw err;
      this._preferredDeviceId = null;
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }

  /** Is this session sending (holding a microphone)? */
  isTalking() {
    return !!(this.active && this.localStream);
  }

  /** Is this session running listen-only (no microphone: muted, or refused)? */
  isListenOnly() {
    return !!(this.active && !this.localStream);
  }

  /** Is an unmute waiting for the microphone (the browser's prompt is up)? */
  get micRequestInFlight() {
    return this._micRequests > 0;
  }

  /** Is my microphone muted (my mute, or no microphone held)? What the mic button shows. */
  isMuted() {
    return !!this.selfMuted || !this.localStream;
  }

  /**
   * Mute (true: the microphone track is disabled, the microphone is kept)
   * or unmute (false: the first unmute of a session asks for the
   * microphone; a refusal leaves it muted, `micDenied`).
   * @returns {Promise<boolean>} muted afterwards
   */
  async setMuted(muted) {
    if (muted) {
      this.selfMuted = true;
      this.localStream?.getAudioTracks().forEach(t => { t.enabled = false; });
      return true;
    }
    this.selfMuted = false;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => { t.enabled = true; });
      return false;
    }
    // The microphone prompt is up until setTalk settles: a toggle meanwhile
    // is a mute (toggleSelfMute), never a second unmute
    this._micRequests++;
    try {
      await this.setTalk(true);
    } finally {
      this._micRequests--;
    }
    if (!this.localStream) {
      this.selfMuted = true;
      return true;
    }
    // a mute while the prompt was up wins
    this.localStream.getAudioTracks().forEach(t => { t.enabled = !this.selfMuted; });
    return this.isMuted();
  }

  /**
   * The silent sender track while no microphone is held (made once per
   * session from its AudioContext), or null where the browser cannot
   * (the fallback: recvonly offers, re-offers when the microphone comes).
   * @returns {{stream: MediaStream, track: MediaStreamTrack}|null}
   */
  _silentSource() {
    if (this._silent) return this._silent;
    const ctx = this._audioContext;
    if (!ctx || typeof ctx.createMediaStreamDestination !== 'function') return null;
    try {
      const dest = ctx.createMediaStreamDestination();
      const track = dest.stream?.getAudioTracks?.()[0];
      if (!track) return null;
      this._silent = { stream: dest.stream, track, dest };
    } catch (err) {
      console.warn('[Voice] no silent track:', err?.message);
      return null;
    }
    return this._silent;
  }

  /** What a call sends: the microphone, else the silent track, else nothing (the fallback). */
  _sendSource() {
    const mic = this.localStream?.getAudioTracks()[0];
    if (mic) return { track: mic, stream: this.localStream };
    return this._silentSource();
  }

  /**
   * Put the current send source on every call that has a sender (no
   * renegotiation). Calls without one (the fallback) are re-offered by
   * _scheduleReofferAll.
   */
  async _replaceSenders() {
    const src = this._sendSource();
    const track = src?.track ?? null;
    for (const [, peer] of [...this.peers]) {
      if (!peer.sender || peer.connection.signalingState === 'closed') continue;
      if (peer.sender.track === track) continue;
      try {
        await peer.sender.replaceTrack(track);
      } catch (err) {
        console.warn('[Voice] replaceTrack failed:', err?.message);
      }
    }
  }

  /** The desired mode (what new connections are built with). */
  get wantsTalk() {
    return this._wantTalk;
  }

  /**
   * Register a talk-mode change callback ({talking, micDenied}): when a
   * session starts and whenever setTalk changed what it sends (or a
   * microphone was refused).
   */
  onModeChange(callback) {
    this._modeCallbacks.push(callback);
  }

  _notifyMode() {
    const info = { talking: !!this.localStream, micDenied: this.micDenied };
    for (const cb of [...this._modeCallbacks]) {
      try { cb(info); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Talk (true: the microphone, asked for when not held; a refusal stays
   * listen-only) or listen only (false: the microphone tracks stop at
   * once, muted). While voice is starting this only sets the mode its
   * initialize reads; on a running session a real change swaps the track
   * every call sends (replaceTrack) and re-offers only the calls with no
   * sender (the fallback; REOFFER_DELAY_MS later, a call waiting for its
   * answer after that answer). Changes run in order.
   * @returns {Promise<boolean>} whether the session talks afterwards
   */
  setTalk(talk) {
    this._wantTalk = !!talk;
    if (!this.active) return Promise.resolve(false);
    const run = this._modeChain.then(() => this._applyMode());
    this._modeChain = run.catch(() => {});
    return run.then(() => this.isTalking(), () => this.isTalking());
  }

  async _applyMode() {
    if (!this.active) return;
    const generation = this._generation;
    const has = !!this.localStream;
    if (this._wantTalk === has) return;
    if (this._wantTalk) {
      const stream = await this._getMic();
      if (!stream) {
        this._notifyMode();
        return;
      }
      if (generation !== this._generation || !this.active || !this._wantTalk || this.localStream) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      stream.getAudioTracks().forEach(t => { t.enabled = !this.selfMuted; });
      this.localStream = stream;
      this._addAnalyser('self', stream);
      await this._replaceSenders();
    } else {
      const old = this.localStream;
      this.localStream = null;
      this.selfMuted = true;
      await this._replaceSenders();
      old.getTracks().forEach(t => t.stop());
      this._cleanupAnalyser('self');
      if (this._speakingStates.get('self')) {
        this._speakingStates.set('self', false);
        this._speakingCallbacks.forEach(cb => {
          try { cb('self', false); } catch (e) { /* ignore */ }
        });
      }
    }
    console.log('[Voice] talk mode:', !!this.localStream);
    this._notifyMode();
    this._scheduleReofferAll();
  }

  /**
   * Re-offer every call in the current mode (the restart path: a new
   * connection, keeping the recovery count; the other side's handleOffer
   * replaces its own and keeps its mute and volume). A call whose offer
   * still waits for its answer is re-offered once that answer lands (or
   * its connect timer runs out): offers and answers carry no generation,
   * so a stale answer must never meet the new connection.
   */
  _scheduleReofferAll() {
    if (this._reofferTimer) clearTimeout(this._reofferTimer);
    this._reofferTimer = setTimeout(() => {
      this._reofferTimer = null;
      this._reofferAll();
    }, REOFFER_DELAY_MS);
  }

  _reofferAll() {
    if (!this.active) return;
    const talking = !!this.localStream;
    for (const [socketId, peer] of [...this.peers]) {
      // A call with a sender carries the new track already (replaceTrack):
      // nothing to re-offer. A call without one (the fallback) built in
      // this mode already (offered or answered after the change) needs
      // nothing either: re-offering it would only cross the other end's
      // offer. An "unavailable" call (failed for good) is offered again (a
      // retry)
      const settled = peer.sender ? true : peer.builtTalk === talking;
      if (settled && !this._unavailable.has(socketId)) {
        this._reofferPending.delete(socketId);
        continue;
      }
      if (peer.connection.signalingState === 'have-local-offer') {
        this._reofferPending.add(socketId);
        continue;
      }
      this._reoffer(socketId);
    }
  }

  _reoffer(socketId) {
    const peer = this.peers.get(socketId);
    this._reofferPending.delete(socketId);
    if (!this.active || !peer) return;
    const username = peer.username;
    this._closePeer(socketId, { keepRecovery: true });
    this.connectToPeer(socketId, username);
  }

  /**
   * Create a peer connection and send an offer (initiator side).
   * Called when we receive voicePeerList — we initiate to existing peers.
   * Listen-only: a recvonly audio transceiver instead of the mic track.
   */
  async connectToPeer(socketId, username) {
    if (!this.active) {
      console.log('[Voice] buffering connectToPeer', socketId, username);
      this._pendingPeers.push({ socketId, username });
      return;
    }
    if (this.peers.has(socketId)) {
      console.log('[Voice] already connected to', socketId);
      return;
    }
    console.log('[Voice] connectToPeer', socketId, username);

    const pc = this._createPeerConnection(socketId, username);
    const peer = this.peers.get(socketId);
    // The mode this call is built in (the fallback re-offers only the
    // others), and "our offer is being made" (crossing offers: handleOffer)
    peer.builtTalk = !!this.localStream;
    peer.makingOffer = true;

    // The microphone, else the silent track (muted: an unmute swaps it in);
    // with neither (the fallback) receive only
    const src = this._sendSource();
    if (src) {
      peer.sender = pc.addTrack(src.track, src.stream) || null;
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    try {
      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // replaced meanwhile (the other end's offer won, a re-offer, a leave):
      // this offer would meet a connection that is gone
      if (this.peers.get(socketId) !== peer || pc.signalingState === 'closed') return;

      this.socketManager.emit(CLIENT_EVENTS.VOICE_OFFER, {
        targetSocketId: socketId,
        offer: pc.localDescription,
        username: this._localUsername
      });
    } catch (err) {
      // PC may have been closed by a concurrent handleOffer — safe to ignore
      console.log('connectToPeer aborted for', socketId, err.message);
    } finally {
      peer.makingOffer = false;
    }
  }

  /**
   * Does an offer from `socketId` cross one of ours? Our call to it is an
   * offer still being made or sent and not answered yet (an answer already
   * received means the other end took our offer, so its new offer is a new
   * negotiation).
   */
  _offerCollides(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer || peer.answered) return false;
    const state = peer.connection.signalingState;
    if (state === 'closed') return false;
    return !!peer.makingOffer || state === 'have-local-offer';
  }

  /** The end that keeps its own offer when two cross: the lower socket id (as for a restart). */
  _keepsOwnOffer(socketId) {
    const myId = this.socketManager?.id || '';
    return !!myId && myId < socketId;
  }

  /**
   * Handle an incoming offer from a peer (responder side).
   */
  async handleOffer(fromSocketId, offer, username) {
    if (!this.active) {
      console.log('[Voice] buffering handleOffer', fromSocketId, username);
      // a newer offer from the same peer replaces the older one (and its candidates)
      this._pendingOffers = this._pendingOffers.filter((o) => o.fromSocketId !== fromSocketId);
      this._pendingCandidates.delete(fromSocketId);
      this._pendingOffers.push({ fromSocketId, offer, username });
      return;
    }
    console.log('[Voice] handleOffer from', fromSocketId, username);

    // Crossing offers: the lower socket id keeps its own (the other end
    // answers it), the higher one answers this one instead of its own
    if (this._offerCollides(fromSocketId) && this._keepsOwnOffer(fromSocketId)) {
      console.log('[Voice] crossing offer from', fromSocketId, 'ignored: ours stands');
      return;
    }

    // If we already have a connection, close it and recreate (a restart
    // after a failure keeps its count; the peer is trying again, so it is
    // no longer "unavailable")
    if (this.peers.has(fromSocketId)) {
      this._closePeer(fromSocketId, { keepRecovery: true });
    }
    this._unavailable.delete(fromSocketId);
    // This new call is built in the current mode: no re-offer owed
    this._reofferPending.delete(fromSocketId);

    const pc = this._createPeerConnection(fromSocketId, username || 'Unknown');
    const peer = this.peers.get(fromSocketId);
    peer.builtTalk = !!this.localStream;

    // The microphone, else the silent track (added before the remote
    // description, so the offer's audio section takes it); with neither
    // (the fallback) the answer sends nothing
    const src = this._sendSource();
    if (src) peer.sender = pc.addTrack(src.track, src.stream) || null;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.socketManager.emit(CLIENT_EVENTS.VOICE_ANSWER, {
        targetSocketId: fromSocketId,
        answer: pc.localDescription
      });
    } catch (err) {
      console.warn('handleOffer failed for', fromSocketId, err.message);
    }
  }

  /**
   * Handle an incoming answer from a peer.
   */
  async handleAnswer(fromSocketId, answer) {
    const peer = this.peers.get(fromSocketId);
    if (!peer) {
      console.warn('[Voice] handleAnswer: no peer for', fromSocketId);
      return;
    }
    // An unavailable peer's connection is closed: nothing to answer
    if (peer.connection.signalingState === 'closed') return;
    console.log('[Voice] handleAnswer from', fromSocketId);
    // Set before the await: an offer that follows this answer is a new
    // negotiation, not a crossing one
    peer.answered = true;
    try {
      await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.warn('[Voice] handleAnswer failed for', fromSocketId, err.message);
    }
    // A mode change waited for this answer: re-offer in the new mode now
    if (this._reofferPending.has(fromSocketId) && this.peers.get(fromSocketId) === peer) {
      this._reoffer(fromSocketId);
    }
  }

  /**
   * Handle an incoming ICE candidate.
   */
  async handleIceCandidate(fromSocketId, candidate) {
    const peer = this.peers.get(fromSocketId);
    if (!peer) {
      // a buffered offer's candidates wait with it (at most 100 per peer)
      if (!this.active && this._pendingOffers.some((o) => o.fromSocketId === fromSocketId)) {
        const list = this._pendingCandidates.get(fromSocketId) || [];
        if (list.length < MAX_PENDING_CANDIDATES) list.push(candidate);
        this._pendingCandidates.set(fromSocketId, list);
      }
      return;
    }

    try {
      await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('Failed to add ICE candidate:', err.message);
    }
  }

  /**
   * Remove a peer connection (peer left).
   */
  removePeer(socketId) {
    // a peer that left before voice started: nothing of it is flushed later
    this._pendingPeers = this._pendingPeers.filter((p) => p.socketId !== socketId);
    this._pendingOffers = this._pendingOffers.filter((o) => o.fromSocketId !== socketId);
    this._pendingCandidates.delete(socketId);
    this._closePeer(socketId);
  }

  /**
   * Toggle my mute (setMuted: the first unmute asks for the microphone).
   * While that prompt is up (the browser's prompt does not block the page)
   * a toggle is a mute and wins: the granted microphone comes muted, as on
   * iOS (a third toggle unmutes again). isMuted() is still true then (no
   * microphone yet), so this reads the pending choice, selfMuted.
   * @returns {Promise<boolean>} the new muted state
   */
  toggleSelfMute() {
    const run = this.micRequestInFlight ? this.setMuted(!this.selfMuted) : this.setMuted(!this.isMuted());
    // A choice by hand is the tab's from now on (voiceSessionMute.js): a
    // refused unmute settles muted, a mute during the prompt wins
    return run.then((muted) => {
      rememberSessionMute(muted);
      return muted;
    });
  }

  /**
   * Mute a specific peer's audio output.
   */
  mutePeer(socketId) {
    this._peerMuted.set(socketId, true);
    this._applyVolume(socketId);
  }

  /**
   * Unmute a specific peer's audio output.
   */
  unmutePeer(socketId) {
    this._peerMuted.set(socketId, false);
    this._applyVolume(socketId, { speaking: true });
  }

  /** My mute of this peer: what every volume write checks. */
  _effectiveMuted(socketId) {
    return !!this._peerMuted.get(socketId);
  }

  /**
   * The element's volume from the mutes, the stored volume and the noise
   * gate (`speaking`: true opens it, false closes it, null keeps the last
   * state the speaking poll saw).
   */
  _applyVolume(socketId, { speaking = null } = {}) {
    const peer = this.peers.get(socketId);
    if (!peer?.audioEl) return;
    if (this._effectiveMuted(socketId)) {
      peer.audioEl.volume = 0;
      return;
    }
    const open = speaking === null ? this._speakingStates.get(socketId) !== false : speaking;
    peer.audioEl.volume = open ? Math.min(1, this._peerVolumes.get(socketId) ?? 1.0) : 0;
  }

  /**
   * Check if a peer is muted.
   */
  isPeerMuted(socketId) {
    return this._peerMuted.get(socketId) || false;
  }

  /**
   * Set a peer's volume (0.0–2.0). Does not apply if peer is muted.
   */
  setPeerVolume(socketId, volume) {
    const clamped = Math.max(0, Math.min(2, volume));
    this._peerVolumes.set(socketId, clamped);
    this._applyVolume(socketId, { speaking: true });
  }

  /**
   * Get a peer's stored volume (default 1.0).
   */
  getPeerVolume(socketId) {
    return this._peerVolumes.get(socketId) ?? 1.0;
  }

  /**
   * Register a speaking change callback.
   * @param {(socketId: string, isSpeaking: boolean) => void} callback
   * socketId is 'self' for local user
   */
  onSpeakingChange(callback) {
    this._speakingCallbacks.push(callback);
  }

  /**
   * Get all connected peers with their info.
   * @returns {Array<{socketId: string, username: string}>}
   */
  getPeers() {
    const result = [];
    for (const [socketId, peer] of this.peers) {
      result.push({ socketId, username: peer.username });
    }
    return result;
  }

  /**
   * Check if a peer or self is currently speaking.
   */
  isSpeaking(socketId) {
    return this._speakingStates.get(socketId) || false;
  }

  /**
   * Did the voice connection to this peer fail for good (after its one
   * restart)? The overlay shows it as "voice unavailable".
   */
  isUnavailable(socketId) {
    return this._unavailable.has(socketId);
  }

  /**
   * Are the current ICE servers Cloudflare TURN (not STUN only)?
   */
  hasTurn() {
    return !!this._ice?.turn;
  }

  // ============================================
  // ICE servers (server/voice/turnCredentials.js via voiceIceServers)
  // ============================================

  /**
   * Make sure ICE servers for this user are known and not about to expire:
   * reuses a TURN answer for the session, else asks the server (STUN on
   * error or after ICE_FETCH_TIMEOUT_MS). A STUN-only answer (the server's,
   * on a Cloudflare failure, backoff or unset env, or our own fallback) is
   * never kept: each voice start and the restart ask again, so one TURN
   * outage does not leave the tab on STUN. Never rejects.
   * @returns {Promise<void>}
   */
  ensureIceServers() {
    const username = getGameState().username || null;
    const ice = this._ice;
    const fresh = ice && ice.username === username && ice.turn &&
      (ice.expiresAt === null || ice.expiresAt - Date.now() > REFRESH_BEFORE_MS);
    if (fresh) return Promise.resolve();
    if (this._iceFetch) return this._iceFetch;
    this._iceFetch = this.fetchIceServers(username).finally(() => { this._iceFetch = null; });
    return this._iceFetch;
  }

  /**
   * One getVoiceIceServers round trip. Never rejects: any failure keeps
   * STUN_ICE_SERVERS (marked `fallback`; like any STUN answer, not reused).
   */
  async fetchIceServers(username = getGameState().username || null) {
    const sm = this.socketManager;
    let reply = null;
    if (sm && typeof sm.emit === 'function') {
      const requestId = `ice-${++this._iceRequestSeq}`;
      reply = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this._iceRequests.delete(requestId);
          resolve(null);
        }, ICE_FETCH_TIMEOUT_MS);
        this._iceRequests.set(requestId, (data) => {
          clearTimeout(timer);
          resolve(data);
        });
        try {
          sm.emit(CLIENT_EVENTS.GET_VOICE_ICE_SERVERS, { requestId });
        } catch (err) {
          clearTimeout(timer);
          this._iceRequests.delete(requestId);
          resolve(null);
        }
      });
    }
    const servers = sanitizeIceServers(reply?.iceServers);
    if (servers) {
      const secs = Number.isFinite(reply.expiresInSec) ? reply.expiresInSec : null;
      this._ice = {
        username,
        iceServers: servers,
        turn: !!reply.turn,
        expiresAt: secs === null ? null : Date.now() + secs * 1000,
        fallback: false,
      };
    } else {
      this._ice = { username, iceServers: STUN_ICE_SERVERS.map(s => ({ ...s })), turn: false, expiresAt: null, fallback: true };
    }
    console.log('[Voice] ICE servers:', this._ice.turn ? 'TURN' : 'STUN only');
    this._applyIceToPeers();
    this._scheduleIceRefresh();
  }

  /**
   * voiceIceServers from the server (registered in handlers/voiceHandlers.js).
   * An answer to no open request (late, or another tab's) is ignored.
   */
  onIceServers(data) {
    const id = data?.requestId;
    const resolve = typeof id === 'string' ? this._iceRequests.get(id) : null;
    if (!resolve) return;
    this._iceRequests.delete(id);
    resolve(data);
  }

  _currentIceServers() {
    return (this._ice?.iceServers || STUN_ICE_SERVERS).map(s => ({ ...s }));
  }

  /** New credentials for connections already open (TURN refreshes need it). */
  _applyIceToPeers() {
    for (const [, peer] of this.peers) {
      const pc = peer.connection;
      if (!pc || pc.signalingState === 'closed' || typeof pc.setConfiguration !== 'function') continue;
      try {
        const cfg = typeof pc.getConfiguration === 'function' ? pc.getConfiguration() : {};
        pc.setConfiguration({ ...cfg, iceServers: this._currentIceServers() });
      } catch (err) {
        console.warn('[Voice] setConfiguration failed:', err.message);
      }
    }
  }

  _scheduleIceRefresh() {
    if (this._iceRefreshTimer) clearTimeout(this._iceRefreshTimer);
    this._iceRefreshTimer = null;
    if (!this.active && !this.socketManager) return;
    const at = this._ice?.expiresAt;
    if (!at) return;
    const inMs = Math.max(60 * 1000, at - Date.now() - REFRESH_BEFORE_MS);
    this._iceRefreshTimer = setTimeout(() => {
      this._iceRefreshTimer = null;
      if (this.socketManager) this.fetchIceServers();
    }, inMs);
  }

  /**
   * Enumerate available audio input devices.
   * @returns {Promise<Array<{deviceId: string, label: string}>>}
   */
  async getAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter(d => d.kind === 'audioinput')
        .map(d => ({ deviceId: d.deviceId, label: d.label || `Microphone (${d.deviceId.slice(0, 8)})` }));
    } catch (err) {
      console.warn('[Voice] enumerateDevices failed:', err.message);
      return [];
    }
  }

  /**
   * Get the deviceId of the currently active mic track.
   * @returns {string|null}
   */
  getActiveDeviceId() {
    // no microphone yet (muted at the start): the one the first unmute will use
    if (!this.localStream) return this._preferredDeviceId || null;
    const track = this.localStream.getAudioTracks()[0];
    if (!track) return null;
    const settings = track.getSettings();
    return settings.deviceId || null;
  }

  /**
   * Switch to a different audio input device without renegotiating WebRTC.
   * @param {string} deviceId
   */
  async switchAudioDevice(deviceId) {
    // No microphone held yet (muted at the start, or refused): remember the
    // pick for the first unmute (_getMic)
    if (!this.localStream) {
      this._preferredDeviceId = deviceId || null;
      return;
    }
    if (!this.active) return;

    const oldStream = this.localStream;

    // Get new stream from selected device
    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } }
      });
    } catch (err) {
      console.warn('[Voice] Failed to get new audio device:', err.message);
      throw err;
    }

    const newTrack = newStream.getAudioTracks()[0];

    // Re-apply mute state to the new track before connecting
    if (this.selfMuted) {
      newTrack.enabled = false;
    }

    try {
      // Replace track on all peer connections BEFORE stopping old tracks
      for (const [, peer] of this.peers) {
        if (peer.connection.signalingState === 'closed') continue; // voice unavailable
        const audioSender = peer.sender || peer.connection.getSenders().find(s => s.track?.kind === 'audio');
        if (audioSender) {
          await audioSender.replaceTrack(newTrack);
        }
      }
    } catch (err) {
      // Rollback: stop the new stream and leave old one intact
      console.warn('[Voice] replaceTrack failed, rolling back:', err.message);
      newStream.getTracks().forEach(t => t.stop());
      throw err;
    }

    // All replacements succeeded — now safe to stop old tracks
    this.localStream = newStream;
    this._preferredDeviceId = deviceId || null;
    if (oldStream) {
      oldStream.getAudioTracks().forEach(t => t.stop());
    }

    // Resume AudioContext if suspended (some browsers suspend after getUserMedia)
    if (this._audioContext?.state === 'suspended') {
      await this._audioContext.resume().catch(() => {});
    }

    // Properly disconnect old analyser source node, then create new one
    this._cleanupAnalyser('self');
    this._addAnalyser('self', newStream);
  }

  /**
   * Play a short test tone (~300ms, 440Hz) through the speakers.
   * @returns {Promise<void>} Resolves when the tone finishes.
   */
  playTestTone() {
    this._setupAudioContext();
    const ctx = this._audioContext;
    if (!ctx) return Promise.resolve();

    // Resume if suspended (user gesture requirement)
    const ready = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();

    return ready.then(() => {
      const duration = 0.3;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.value = 440;

      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      // Ramp down for a clean end
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration);

      oscillator.connect(gain);
      gain.connect(ctx.destination);

      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + duration);

      return new Promise(resolve => {
        oscillator.onended = resolve;
      });
    });
  }

  /**
   * Shut down all voice connections and clean up.
   */
  shutdown() {
    this.active = false;
    this._generation++;

    // Stop speaking detection
    if (this._speakingInterval) {
      clearInterval(this._speakingInterval);
      this._speakingInterval = null;
    }

    // Close all peer connections
    for (const socketId of this.peers.keys()) {
      this._closePeer(socketId);
    }
    this.peers.clear();

    // Stop local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    // Close audio context
    if (this._audioContext) {
      this._audioContext.close().catch(() => {});
      this._audioContext = null;
    }

    this._analysers.clear();
    this._speakingStates.clear();
    this._speakingLastActive.clear();
    this._speakingCallbacks = [];
    this._peerMuted.clear();
    this._gainNodes.clear();
    this._peerVolumes.clear();
    this._pendingPeers = [];
    this._pendingOffers = [];
    this._pendingCandidates = new Map();
    this._localUsername = null;
    // Muted while no session runs; the next one follows the tab's choice
    // (muted unless unmuted by hand earlier: voiceSessionMute.js)
    this.selfMuted = true;
    this.socketManager = null;

    // Talk mode back to the default (muted, no microphone)
    this._wantTalk = false;
    this.micDenied = false;
    this._silent?.track?.stop?.();
    this._silent = null;
    this._modeChain = Promise.resolve();
    this._reofferPending.clear();
    if (this._reofferTimer) {
      clearTimeout(this._reofferTimer);
      this._reofferTimer = null;
    }
    this._modeCallbacks = [];
    this._disarmAutoplay();
    this._autoplayCallbacks = [];
    this._disarmUnlock();
    for (const el of this._audioPool) el.remove();
    this._audioPool = [];

    // Recovery state; the ICE servers themselves are kept for the session
    for (const t of this._restartTimers.values()) clearTimeout(t);
    for (const t of this._connectTimers.values()) clearTimeout(t);
    this._connectTimers.clear();
    this._restartTimers.clear();
    this._restarts.clear();
    this._unavailable.clear();
    if (this._iceRefreshTimer) {
      clearTimeout(this._iceRefreshTimer);
      this._iceRefreshTimer = null;
    }
    // A request still open answers STUN to its waiter at once
    for (const resolve of this._iceRequests.values()) resolve(null);
    this._iceRequests.clear();
  }

  // ============================================
  // Private Methods
  // ============================================

  _createPeerConnection(socketId, username) {
    const pc = new RTCPeerConnection({ iceServers: this._currentIceServers() });

    // Audio element for reliable playback (Web Audio API alone is unreliable
    // for remote WebRTC streams): an unlocked one from the pool when there is
    // one, so a call made or replaced after the first gesture plays in Safari
    const audioEl = this._takeAudioEl(socketId);

    this.peers.set(socketId, {
      connection: pc,
      audioEl,
      username,
      stream: null
    });

    // ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate && this.socketManager) {
        this.socketManager.emit(CLIENT_EVENTS.VOICE_ICE_CANDIDATE, {
          targetSocketId: socketId,
          candidate: event.candidate
        });
      }
    };

    // Remote stream handling
    pc.ontrack = (event) => {
      console.log('[Voice] ontrack from', socketId);
      const peer = this.peers.get(socketId);
      if (peer) {
        peer.stream = event.streams[0];
        // Audio element for playback
        peer.audioEl.srcObject = event.streams[0];
        this._applyVolume(socketId, { speaking: true });
        this._play(peer.audioEl);
        // Web Audio analyser for speaking detection only
        this._addAnalyser(socketId, event.streams[0]);
      }
    };

    // Connection state monitoring: connected clears any failure; failed
    // (either state machine) gets one restart, then "voice unavailable"
    const onState = () => {
      if (this.peers.get(socketId)?.connection !== pc) return; // a replaced connection
      if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this._onPeerConnected(socketId);
      } else if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
        this._onPeerFailed(socketId);
      }
    };
    pc.onconnectionstatechange = () => {
      console.log(`[Voice] peer ${socketId} connection: ${pc.connectionState}`);
      onState();
    };
    pc.oniceconnectionstatechange = () => {
      console.log(`[Voice] peer ${socketId} ICE: ${pc.iceConnectionState}`);
      onState();
    };

    // A connection that never gets a candidate pair (no usable relay, a
    // lost offer) stays "new" / "checking" and never reports failed: past
    // CONNECT_TIMEOUT_MS it counts as a failure, so nothing hangs silently
    const prev = this._connectTimers.get(socketId);
    if (prev) clearTimeout(prev);
    this._connectTimers.set(socketId, setTimeout(() => {
      this._connectTimers.delete(socketId);
      if (this.peers.get(socketId)?.connection !== pc || pc.signalingState === 'closed') return;
      // a re-offer that waited for this call's answer, which never came: it goes now
      if (this._reofferPending.has(socketId)) {
        this._reoffer(socketId);
        return;
      }
      if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;
      console.log(`[Voice] connection to ${socketId} not up after ${CONNECT_TIMEOUT_MS} ms`);
      this._onPeerFailed(socketId);
    }, CONNECT_TIMEOUT_MS));

    return pc;
  }

  _onPeerConnected(socketId) {
    const ct = this._connectTimers.get(socketId);
    if (ct) clearTimeout(ct);
    this._connectTimers.delete(socketId);
    const t = this._restartTimers.get(socketId);
    if (t) clearTimeout(t);
    this._restartTimers.delete(socketId);
    this._restarts.delete(socketId);
    this._unavailable.delete(socketId);
  }

  /**
   * A connection failed. First failure: the peer with the lower socket id
   * offers again on a new connection (fresh ICE servers; the other side's
   * handleOffer replaces its own), the other waits RESTART_WAIT_MS for that
   * offer. A second failure, or no restart in time: voice unavailable for
   * this peer (connection closed, row kept; a later offer from it retries).
   */
  _onPeerFailed(socketId) {
    if (!this.active || this._unavailable.has(socketId)) return;
    if (this._restartTimers.has(socketId)) return; // already waiting for the remote restart
    const used = this._restarts.get(socketId) || 0;
    const peer = this.peers.get(socketId);
    if (!peer) return;
    if (used >= 1) {
      this._markUnavailable(socketId);
      return;
    }
    this._restarts.set(socketId, 1);
    const myId = this.socketManager?.id || '';
    if (myId && myId < socketId) {
      console.log(`[Voice] connection to ${socketId} failed: restarting once`);
      const username = peer.username;
      // Credentials may have expired: refresh first when they are due
      this.ensureIceServers().then(() => {
        if (!this.active || this.peers.get(socketId) !== peer) return;
        this._closePeer(socketId, { keepRecovery: true });
        this.connectToPeer(socketId, username);
      });
    } else {
      console.log(`[Voice] connection to ${socketId} failed: waiting for its restart`);
      // A STUN-only session asks for TURN again meanwhile; an answer reaches
      // the restart's connection through _applyIceToPeers
      this.ensureIceServers();
      // The restart's offer clears this timer (handleOffer)
      this._restartTimers.set(socketId, setTimeout(() => {
        this._restartTimers.delete(socketId);
        if (this.peers.get(socketId) === peer) this._markUnavailable(socketId);
      }, RESTART_WAIT_MS));
    }
  }

  _markUnavailable(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    console.log(`[Voice] voice unavailable for ${socketId}`);
    this._unavailable.add(socketId);
    if (peer.connection.signalingState !== 'closed') peer.connection.close();
    if (peer.audioEl) {
      peer.audioEl.srcObject = null;
    }
    this._cleanupAnalyser(socketId);
    if (this._speakingStates.get(socketId)) {
      this._speakingStates.set(socketId, false);
      this._speakingCallbacks.forEach(cb => {
        try { cb(socketId, false); } catch (e) { /* ignore */ }
      });
    }
  }

  /**
   * @param {string} socketId
   * @param {{keepRecovery?: boolean}} [opts] - keep the restart count (a
   *   connection replaced by its restart); the peer left otherwise
   */
  _closePeer(socketId, { keepRecovery = false } = {}) {
    const timer = this._restartTimers.get(socketId);
    if (timer) clearTimeout(timer);
    this._restartTimers.delete(socketId);
    const ct = this._connectTimers.get(socketId);
    if (ct) clearTimeout(ct);
    this._connectTimers.delete(socketId);
    if (!keepRecovery) {
      this._restarts.delete(socketId);
      this._unavailable.delete(socketId);
      this._reofferPending.delete(socketId);
    }
    const peer = this.peers.get(socketId);
    if (!peer) return;

    if (peer.connection.signalingState !== 'closed') {
      peer.connection.close();
    }
    if (peer.audioEl) this._releaseAudioEl(peer.audioEl);

    this._gainNodes.delete(socketId);
    this._cleanupAnalyser(socketId);
    // A peer speaking as its call ends (it left, or its call is replaced:
    // the new one starts silent) stops speaking now: nothing else would
    // say so (a listen-only replacement has no track, so no poll)
    const wasSpeaking = !!this._speakingStates.get(socketId);
    this._speakingStates.delete(socketId);
    this._speakingLastActive.delete(socketId);
    if (wasSpeaking) {
      this._speakingCallbacks.forEach(cb => {
        try { cb(socketId, false); } catch (e) { /* ignore */ }
      });
    }

    this.peers.delete(socketId);
  }

  // ============================================
  // Autoplay: a page that receives voice without a gesture
  // ============================================

  /**
   * Register an autoplay-blocked callback: the browser refused to play a
   * call's audio (NotAllowedError, no user gesture yet). The next
   * pointerdown plays every call's element again; a call re-created later
   * and blocked again calls it again.
   */
  onAutoplayBlocked(callback) {
    this._autoplayCallbacks.push(callback);
  }

  /** Is a blocked element waiting for the next gesture? */
  get autoplayBlocked() {
    return this._autoplayArmed;
  }

  _play(audioEl) {
    if (!audioEl || typeof audioEl.play !== 'function') return;
    let p;
    try {
      p = audioEl.play();
    } catch (err) {
      return;
    }
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (err?.name !== 'NotAllowedError') return;
        audioEl._voiceUnlocked = false;
        this._armAutoplay();
      });
    }
  }

  _armAutoplay() {
    if (this._autoplayArmed || !this.active) return;
    this._autoplayArmed = true;
    this._autoplayListener = () => this.resumePlayback();
    document.addEventListener('pointerdown', this._autoplayListener, true);
    document.addEventListener('keydown', this._autoplayListener, true);
    for (const cb of [...this._autoplayCallbacks]) {
      try { cb(); } catch (e) { /* ignore */ }
    }
  }

  _disarmAutoplay() {
    if (this._autoplayListener) {
      document.removeEventListener('pointerdown', this._autoplayListener, true);
      document.removeEventListener('keydown', this._autoplayListener, true);
    }
    this._autoplayListener = null;
    this._autoplayArmed = false;
  }

  /**
   * A user gesture: play every current call's element and unlock the pool
   * (calls made later take an unlocked element; a replaced call gives its
   * element back and takes it again).
   */
  resumePlayback() {
    this._disarmAutoplay();
    this._disarmUnlock();
    if (this._audioContext?.state === 'suspended') this._audioContext.resume?.()?.catch?.(() => {});
    for (const peer of this.peers.values()) {
      if (!peer.audioEl) continue;
      if (peer.audioEl.srcObject) {
        peer.audioEl._voiceUnlocked = true;
        this._play(peer.audioEl);
      } else {
        this._unlockEl(peer.audioEl);
      }
    }
    if (!this.active) return;
    while (this._audioPool.length < AUDIO_POOL_SIZE) this._audioPool.push(this._newAudioEl());
    for (const el of this._audioPool) if (!el._voiceUnlocked) this._unlockEl(el);
  }

  /** The session's first pointerdown / keydown unlocks audio (resumePlayback), blocked or not. */
  _armUnlock() {
    if (this._unlockListener) return;
    this._unlockListener = () => this.resumePlayback();
    document.addEventListener('pointerdown', this._unlockListener, true);
    document.addEventListener('keydown', this._unlockListener, true);
  }

  _disarmUnlock() {
    if (!this._unlockListener) return;
    document.removeEventListener('pointerdown', this._unlockListener, true);
    document.removeEventListener('keydown', this._unlockListener, true);
    this._unlockListener = null;
  }

  _newAudioEl() {
    const el = document.createElement('audio');
    el.autoplay = true;
    document.body.appendChild(el);
    return el;
  }

  /** A call's audio element: an unlocked spare from the pool, else a new one. */
  _takeAudioEl(socketId) {
    const el = this._audioPool.pop() || this._newAudioEl();
    el.id = `voice-audio-${socketId}`;
    return el;
  }

  /**
   * A closed call's element: back to the pool when unlocked (and the
   * session runs on), else removed. The pool stays small: only the first
   * gesture adds spares, so at most AUDIO_POOL_SIZE plus the calls.
   */
  _releaseAudioEl(el) {
    el.srcObject = null;
    if (el._voiceUnlocked && this.active) {
      el.removeAttribute('id');
      this._audioPool.push(el);
      return;
    }
    el.remove();
  }

  /**
   * play() inside a gesture with nothing to play: WebKit lifts the
   * element's gesture rule on that call, so a later play() of a call's
   * stream needs none. Only a refusal (no gesture after all) undoes it.
   */
  _unlockEl(el) {
    el._voiceUnlocked = true;
    let p;
    try {
      p = el.play();
    } catch (err) {
      return;
    }
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (err?.name === 'NotAllowedError') el._voiceUnlocked = false;
      });
    }
  }

  _setupAudioContext() {
    if (this._audioContext) return;
    this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  _addAnalyser(id, stream) {
    if (!this._audioContext || !stream) return;

    try {
      const source = this._audioContext.createMediaStreamSource(stream);
      const analyser = this._audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const dataArray = new Float32Array(analyser.fftSize);
      this._analysers.set(id, { analyser, dataArray, source });
    } catch (err) {
      console.warn('Failed to create analyser for', id, err.message);
    }
  }

  /**
   * Properly clean up an analyser entry by disconnecting its Web Audio source node.
   */
  _cleanupAnalyser(id) {
    const entry = this._analysers.get(id);
    if (!entry) return;
    try {
      entry.source?.disconnect();
    } catch (e) { /* already disconnected */ }
    this._analysers.delete(id);
  }

  _startSpeakingDetection() {
    if (this._speakingInterval) return;

    this._speakingInterval = setInterval(() => {
      for (const [id, { analyser, dataArray }] of this._analysers) {
        analyser.getFloatTimeDomainData(dataArray);

        // Calculate RMS
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);

        const now = Date.now();
        if (rms > SPEAKING_THRESHOLD) {
          this._speakingLastActive.set(id, now);
        }

        const wasSpeaking = this._speakingStates.get(id) || false;
        const lastActive = this._speakingLastActive.get(id) || 0;
        const isSpeaking = (now - lastActive) < SPEAKING_HOLD_MS;

        if (isSpeaking !== wasSpeaking) {
          this._speakingStates.set(id, isSpeaking);

          // Noise gate: mute audio element when peer isn't speaking (a
          // muted peer stays at 0)
          if (id !== 'self') this._applyVolume(id, { speaking: isSpeaking });

          this._speakingCallbacks.forEach(cb => {
            try { cb(id, isSpeaking); } catch (e) { /* ignore */ }
          });
        }
      }
    }, SPEAKING_POLL_INTERVAL);
  }
}

// Singleton
let instance = null;

export function getVoiceChatManager() {
  if (!instance) {
    instance = new VoiceChatManager();
  }
  return instance;
}

export function resetVoiceChatManager() {
  if (instance) {
    instance.shutdown();
  }
  instance = null;
}

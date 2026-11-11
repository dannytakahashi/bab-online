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
 */

import { CLIENT_EVENTS } from '../constants/events.js';
import { getGameState } from '../state/GameState.js';

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
    this.selfMuted = false;
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

    // Per-peer volume control (Web Audio API)
    this._gainNodes = new Map(); // socketId → GainNode
    this._peerVolumes = new Map(); // socketId → number (0.0–2.0, default 1.0)

    // Local username for offer relay
    this._localUsername = null;

    // Buffered events received before initialization completes
    this._pendingPeers = [];
    this._pendingOffers = [];

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
  }

  /**
   * Initialize voice chat: capture mic and set up signaling listeners.
   * @param {import('../socket/SocketManager.js').SocketManager} socketManager
   */
  async initialize(socketManager) {
    if (this.active) return;

    this.socketManager = socketManager;
    const generation = this._generation;
    // In parallel with the microphone prompt; never rejects
    const iceReady = this.ensureIceServers();

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn('Mic permission denied:', err.message);
      throw err;
    }
    await iceReady;
    if (generation !== this._generation || this.active) {
      // shut down (or started elsewhere) while waiting: release the mic
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    this.localStream = stream;

    this.active = true;
    this._localUsername = getGameState().username || null;
    // Set up speaking detection for local stream
    this._setupAudioContext();
    this._addAnalyser('self', this.localStream);
    this._startSpeakingDetection();

    console.log('[Voice] initialized, username:', this._localUsername, 'audioCtx:', this._audioContext?.state);

    // Flush buffered events that arrived before initialization.
    // Process offers first — if we have an offer from a peer, we don't need
    // to also initiate to them (that would cause WebRTC glare).
    const offerPeerIds = new Set(this._pendingOffers.map(o => o.fromSocketId));
    const pendingPeers = this._pendingPeers;
    const pendingOffers = this._pendingOffers;
    this._pendingPeers = [];
    this._pendingOffers = [];

    console.log('[Voice] flushing', pendingOffers.length, 'offers,', pendingPeers.length, 'peers');
    for (const o of pendingOffers) {
      this.handleOffer(o.fromSocketId, o.offer, o.username);
    }
    for (const p of pendingPeers) {
      if (!offerPeerIds.has(p.socketId)) {
        this.connectToPeer(p.socketId, p.username);
      }
    }
  }

  /**
   * Create a peer connection and send an offer (initiator side).
   * Called when we receive voicePeerList — we initiate to existing peers.
   */
  async connectToPeer(socketId, username) {
    if (!this.active || !this.localStream) {
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

    // Add local audio tracks
    this.localStream.getAudioTracks().forEach(track => {
      pc.addTrack(track, this.localStream);
    });

    try {
      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.socketManager.emit(CLIENT_EVENTS.VOICE_OFFER, {
        targetSocketId: socketId,
        offer: pc.localDescription,
        username: this._localUsername
      });
    } catch (err) {
      // PC may have been closed by a concurrent handleOffer — safe to ignore
      console.log('connectToPeer aborted for', socketId, err.message);
    }
  }

  /**
   * Handle an incoming offer from a peer (responder side).
   */
  async handleOffer(fromSocketId, offer, username) {
    if (!this.active || !this.localStream) {
      console.log('[Voice] buffering handleOffer', fromSocketId, username);
      this._pendingOffers.push({ fromSocketId, offer, username });
      return;
    }
    console.log('[Voice] handleOffer from', fromSocketId, username);

    // If we already have a connection, close it and recreate (a restart
    // after a failure keeps its count; the peer is trying again, so it is
    // no longer "unavailable")
    if (this.peers.has(fromSocketId)) {
      this._closePeer(fromSocketId, { keepRecovery: true });
    }
    this._unavailable.delete(fromSocketId);

    const pc = this._createPeerConnection(fromSocketId, username || 'Unknown');

    // Add local audio tracks
    this.localStream.getAudioTracks().forEach(track => {
      pc.addTrack(track, this.localStream);
    });

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
    try {
      await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.warn('[Voice] handleAnswer failed for', fromSocketId, err.message);
    }
  }

  /**
   * Handle an incoming ICE candidate.
   */
  async handleIceCandidate(fromSocketId, candidate) {
    const peer = this.peers.get(fromSocketId);
    if (!peer) return;

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
    this._closePeer(socketId);
  }

  /**
   * Toggle self-mute (disable/enable local audio tracks).
   * @returns {boolean} New muted state
   */
  toggleSelfMute() {
    this.selfMuted = !this.selfMuted;

    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !this.selfMuted;
      });
    }

    return this.selfMuted;
  }

  /**
   * Mute a specific peer's audio output.
   */
  mutePeer(socketId) {
    this._peerMuted.set(socketId, true);
    const peer = this.peers.get(socketId);
    if (peer?.audioEl) peer.audioEl.volume = 0;
  }

  /**
   * Unmute a specific peer's audio output.
   */
  unmutePeer(socketId) {
    this._peerMuted.set(socketId, false);
    const vol = this._peerVolumes.get(socketId) ?? 1.0;
    const peer = this.peers.get(socketId);
    if (peer?.audioEl) peer.audioEl.volume = Math.min(1, vol);
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
    if (!this._peerMuted.get(socketId)) {
      const peer = this.peers.get(socketId);
      if (peer?.audioEl) peer.audioEl.volume = Math.min(1, clamped);
    }
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
    if (!this.localStream) return null;
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
        const senders = peer.connection.getSenders();
        const audioSender = senders.find(s => s.track?.kind === 'audio' || s.track === null);
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
    this._localUsername = null;
    this.selfMuted = false;
    this.socketManager = null;

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

    // Audio element for reliable playback (Web Audio API alone is unreliable for remote WebRTC streams)
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.id = `voice-audio-${socketId}`;
    document.body.appendChild(audioEl);

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
        peer.audioEl.volume = this._peerMuted.get(socketId) ? 0 : Math.min(1, this._peerVolumes.get(socketId) ?? 1.0);
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
    }
    const peer = this.peers.get(socketId);
    if (!peer) return;

    if (peer.connection.signalingState !== 'closed') {
      peer.connection.close();
    }
    if (peer.audioEl) {
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
    }

    this._gainNodes.delete(socketId);
    this._cleanupAnalyser(socketId);
    this._speakingStates.delete(socketId);
    this._speakingLastActive.delete(socketId);

    this.peers.delete(socketId);
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

          // Noise gate: mute audio element when peer isn't speaking
          if (id !== 'self') {
            const peer = this.peers.get(id);
            if (peer?.audioEl && !this._peerMuted.get(id)) {
              peer.audioEl.volume = isSpeaking ? Math.min(1, this._peerVolumes.get(id) ?? 1.0) : 0;
            }
          }

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

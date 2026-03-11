/**
 * VoiceChatManager - WebRTC peer-to-peer voice chat.
 *
 * Full-mesh topology: each human player maintains a direct RTCPeerConnection
 * to every other human. The server only relays signaling messages.
 */

import { CLIENT_EVENTS } from '../constants/events.js';
import { getGameState } from '../state/GameState.js';

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const SPEAKING_THRESHOLD = 0.005;
const SPEAKING_POLL_INTERVAL = 100;
const SPEAKING_HOLD_MS = 400; // Keep gate open after speech stops

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

    // Relay fallback state
    this._relayedPeers = new Set();          // socketIds using relay
    this._relayProcessor = null;              // shared ScriptProcessorNode
    this._relaySource = null;                 // MediaStreamSource for relay capture
    this._relayMuteNode = null;              // GainNode(0) to prevent echo
    this._relayPlaybackTime = new Map();     // socketId → next scheduled playback time
    this._relayGainNodes = new Map();        // socketId → GainNode for volume control
  }

  /**
   * Initialize voice chat: capture mic and set up signaling listeners.
   * @param {import('../socket/SocketManager.js').SocketManager} socketManager
   */
  async initialize(socketManager) {
    if (this.active) return;

    this.socketManager = socketManager;

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn('Mic permission denied:', err.message);
      throw err;
    }

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

    // If we already have a connection, close it and recreate
    if (this.peers.has(fromSocketId)) {
      this._closePeer(fromSocketId);
    }

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
    console.log('[Voice] handleAnswer from', fromSocketId);
    await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
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
    const relayGain = this._relayGainNodes.get(socketId);
    if (relayGain) relayGain.gain.value = 0;
  }

  /**
   * Unmute a specific peer's audio output.
   */
  unmutePeer(socketId) {
    this._peerMuted.set(socketId, false);
    const vol = this._peerVolumes.get(socketId) ?? 1.0;
    const peer = this.peers.get(socketId);
    if (peer?.audioEl) peer.audioEl.volume = Math.min(1, vol);
    const relayGain = this._relayGainNodes.get(socketId);
    if (relayGain) relayGain.gain.value = vol;
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
      const relayGain = this._relayGainNodes.get(socketId);
      if (relayGain) relayGain.gain.value = clamped;
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
   * Check if a peer is using relay (non-P2P) mode.
   */
  isRelayed(socketId) {
    return this._relayedPeers.has(socketId);
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

    // Reconnect relay processor to new stream if relay is active
    if (this._relayProcessor && this._relayedPeers.size > 0) {
      if (this._relaySource) {
        this._relaySource.disconnect();
      }
      this._relaySource = this._audioContext.createMediaStreamSource(newStream);
      this._relaySource.connect(this._relayProcessor);
    }
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

    // Clean up relay state
    this._stopRelayCapture();
    this._relayedPeers.clear();
    this._relayPlaybackTime.clear();
    for (const gain of this._relayGainNodes.values()) {
      gain.disconnect();
    }
    this._relayGainNodes.clear();
  }

  // ============================================
  // Private Methods
  // ============================================

  _createPeerConnection(socketId, username) {
    const pc = new RTCPeerConnection(ICE_CONFIG);

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

    // Connection state monitoring
    pc.onconnectionstatechange = () => {
      console.log(`[Voice] peer ${socketId} connection: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        console.log(`[Voice] P2P connection failed for ${socketId}, switching to relay`);
        this._startRelay(socketId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[Voice] peer ${socketId} ICE: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        console.log(`[Voice] P2P failed for ${socketId}, switching to relay`);
        this._startRelay(socketId);
      }
    };

    return pc;
  }

  _closePeer(socketId) {
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

    // Clean up relay state
    this._relayedPeers.delete(socketId);
    this._relayPlaybackTime.delete(socketId);
    const relayGain = this._relayGainNodes.get(socketId);
    if (relayGain) {
      relayGain.disconnect();
      this._relayGainNodes.delete(socketId);
    }
    if (this._relayedPeers.size === 0) {
      this._stopRelayCapture();
    }

    this.peers.delete(socketId);
  }

  /**
   * Switch a peer to relay mode after ICE failure.
   */
  _startRelay(socketId) {
    if (this._relayedPeers.has(socketId)) return;

    const peer = this.peers.get(socketId);
    if (!peer) return;

    // Close the P2P connection but keep the peer entry for username/metadata
    if (peer.connection.signalingState !== 'closed') {
      peer.connection.close();
    }
    if (peer.audioEl) {
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
      peer.audioEl = null;
    }

    // Remove P2P analyser — speaking detection for relay uses RMS from received PCM
    this._cleanupAnalyser(socketId);

    this._relayedPeers.add(socketId);
    this._ensureRelayCapture();

    // Create per-peer GainNode for volume/mute control on playback
    if (this._audioContext) {
      const gain = this._audioContext.createGain();
      const vol = this._peerMuted.get(socketId) ? 0 : (this._peerVolumes.get(socketId) ?? 1.0);
      gain.gain.value = vol;
      gain.connect(this._audioContext.destination);
      this._relayGainNodes.set(socketId, gain);
    }
  }

  /**
   * Set up shared ScriptProcessorNode for relay audio capture.
   */
  _ensureRelayCapture() {
    if (this._relayProcessor) return;
    if (!this._audioContext || !this.localStream) return;

    this._relaySource = this._audioContext.createMediaStreamSource(this.localStream);

    // ScriptProcessorNode for capturing and downsampling audio
    this._relayProcessor = this._audioContext.createScriptProcessor(4096, 1, 1);

    // GainNode(0) connected to destination — required for processing to fire
    this._relayMuteNode = this._audioContext.createGain();
    this._relayMuteNode.gain.value = 0;

    this._relaySource.connect(this._relayProcessor);
    this._relayProcessor.connect(this._relayMuteNode);
    this._relayMuteNode.connect(this._audioContext.destination);

    const inputSampleRate = this._audioContext.sampleRate;
    const outputSampleRate = 8000;

    this._relayProcessor.onaudioprocess = (e) => {
      if (this.selfMuted || this._relayedPeers.size === 0) return;
      if (!this.socketManager) return;

      const input = e.inputBuffer.getChannelData(0);

      // Downsample to 8kHz
      const ratio = inputSampleRate / outputSampleRate;
      const outputLength = Math.floor(input.length / ratio);
      const output = new Int16Array(outputLength);

      for (let i = 0; i < outputLength; i++) {
        const srcIndex = Math.floor(i * ratio);
        // Clamp and convert float [-1, 1] to Int16
        const sample = Math.max(-1, Math.min(1, input[srcIndex]));
        output[i] = sample * 32767;
      }

      // Send to each relayed peer
      for (const targetSocketId of this._relayedPeers) {
        this.socketManager.emit(CLIENT_EVENTS.VOICE_RELAY_AUDIO, {
          targetSocketId,
          audio: output.buffer
        });
      }
    };
  }

  /**
   * Tear down relay capture when no more relayed peers.
   */
  _stopRelayCapture() {
    if (this._relayProcessor) {
      this._relayProcessor.onaudioprocess = null;
      this._relayProcessor.disconnect();
      this._relayProcessor = null;
    }
    if (this._relaySource) {
      this._relaySource.disconnect();
      this._relaySource = null;
    }
    if (this._relayMuteNode) {
      this._relayMuteNode.disconnect();
      this._relayMuteNode = null;
    }
  }

  /**
   * Handle incoming relay audio from a peer.
   */
  _onRelayAudio(fromSocketId, audioData) {
    if (!this._audioContext || !this._relayedPeers.has(fromSocketId)) return;

    // Convert ArrayBuffer/Int16Array → Float32Array
    const int16 = new Int16Array(audioData);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32767;
    }

    // Speaking detection: compute RMS from received PCM
    let sum = 0;
    for (let i = 0; i < float32.length; i++) {
      sum += float32[i] * float32[i];
    }
    const rms = Math.sqrt(sum / float32.length);

    const now = Date.now();
    if (rms > SPEAKING_THRESHOLD) {
      this._speakingLastActive.set(fromSocketId, now);
    }
    const wasSpeaking = this._speakingStates.get(fromSocketId) || false;
    const lastActive = this._speakingLastActive.get(fromSocketId) || 0;
    const isSpeaking = (now - lastActive) < SPEAKING_HOLD_MS;

    if (isSpeaking !== wasSpeaking) {
      this._speakingStates.set(fromSocketId, isSpeaking);
      this._speakingCallbacks.forEach(cb => {
        try { cb(fromSocketId, isSpeaking); } catch (e) { /* ignore */ }
      });
    }

    // Playback: create AudioBuffer and schedule via AudioBufferSourceNode
    const gainNode = this._relayGainNodes.get(fromSocketId);
    if (!gainNode) return;

    const sampleRate = 8000;
    const buffer = this._audioContext.createBuffer(1, float32.length, sampleRate);
    buffer.getChannelData(0).set(float32);

    const source = this._audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNode);

    // Schedule playback contiguously to avoid gaps
    const currentTime = this._audioContext.currentTime;
    let startTime = this._relayPlaybackTime.get(fromSocketId) || 0;
    if (startTime < currentTime) {
      startTime = currentTime;
    }
    source.start(startTime);
    this._relayPlaybackTime.set(fromSocketId, startTime + buffer.duration);
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

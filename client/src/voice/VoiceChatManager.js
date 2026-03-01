/**
 * VoiceChatManager - WebRTC peer-to-peer voice chat.
 *
 * Full-mesh topology: each human player maintains a direct RTCPeerConnection
 * to every other human. The server only relays signaling messages.
 */

import { CLIENT_EVENTS } from '../constants/events.js';

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const SPEAKING_THRESHOLD = 0.01;
const SPEAKING_POLL_INTERVAL = 100;

export class VoiceChatManager {
  constructor() {
    /** @type {MediaStream|null} */
    this.localStream = null;

    /** @type {Map<string, {connection: RTCPeerConnection, audioEl: HTMLAudioElement, username: string, stream: MediaStream|null}>} */
    this.peers = new Map();

    this.socketManager = null;
    this.selfMuted = false;
    this.active = false;

    // Speaking detection
    this._audioContext = null;
    this._analysers = new Map(); // socketId|'self' → { analyser, dataArray }
    this._speakingStates = new Map(); // socketId|'self' → boolean
    this._speakingInterval = null;
    this._speakingCallbacks = [];

    // Per-peer mute state
    this._peerMuted = new Map(); // socketId → boolean
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

    // Set up speaking detection for local stream
    this._setupAudioContext();
    this._addAnalyser('self', this.localStream);
    this._startSpeakingDetection();
  }

  /**
   * Create a peer connection and send an offer (initiator side).
   * Called when we receive voicePeerList — we initiate to existing peers.
   */
  async connectToPeer(socketId, username) {
    if (!this.active || !this.localStream) return;
    if (this.peers.has(socketId)) return;

    const pc = this._createPeerConnection(socketId, username);

    // Add local audio tracks
    this.localStream.getAudioTracks().forEach(track => {
      pc.addTrack(track, this.localStream);
    });

    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.socketManager.emit(CLIENT_EVENTS.VOICE_OFFER, {
      targetSocketId: socketId,
      offer: pc.localDescription
    });
  }

  /**
   * Handle an incoming offer from a peer (responder side).
   */
  async handleOffer(fromSocketId, offer, username) {
    if (!this.active || !this.localStream) return;

    // If we already have a connection, close it and recreate
    if (this.peers.has(fromSocketId)) {
      this._closePeer(fromSocketId);
    }

    const pc = this._createPeerConnection(fromSocketId, username || 'Unknown');

    // Add local audio tracks
    this.localStream.getAudioTracks().forEach(track => {
      pc.addTrack(track, this.localStream);
    });

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.socketManager.emit(CLIENT_EVENTS.VOICE_ANSWER, {
      targetSocketId: fromSocketId,
      answer: pc.localDescription
    });
  }

  /**
   * Handle an incoming answer from a peer.
   */
  async handleAnswer(fromSocketId, answer) {
    const peer = this.peers.get(fromSocketId);
    if (!peer) return;

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
    if (peer && peer.audioEl) {
      peer.audioEl.muted = true;
    }
  }

  /**
   * Unmute a specific peer's audio output.
   */
  unmutePeer(socketId) {
    this._peerMuted.set(socketId, false);
    const peer = this.peers.get(socketId);
    if (peer && peer.audioEl) {
      peer.audioEl.muted = false;
    }
  }

  /**
   * Check if a peer is muted.
   */
  isPeerMuted(socketId) {
    return this._peerMuted.get(socketId) || false;
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
    this._speakingCallbacks = [];
    this._peerMuted.clear();
    this.selfMuted = false;
    this.socketManager = null;
  }

  // ============================================
  // Private Methods
  // ============================================

  _createPeerConnection(socketId, username) {
    const pc = new RTCPeerConnection(ICE_CONFIG);

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.id = `voice-audio-${socketId}`;
    document.body.appendChild(audioEl);

    // Apply existing mute state if any
    if (this._peerMuted.get(socketId)) {
      audioEl.muted = true;
    }

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
      const peer = this.peers.get(socketId);
      if (peer) {
        peer.stream = event.streams[0];
        peer.audioEl.srcObject = event.streams[0];

        // Set up speaking detection for this peer
        this._addAnalyser(socketId, event.streams[0]);
      }
    };

    // Connection state monitoring
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        console.log(`Voice peer ${socketId} connection ${pc.connectionState}`);
      }
    };

    return pc;
  }

  _closePeer(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer) return;

    peer.connection.close();
    if (peer.audioEl) {
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
    }

    this._analysers.delete(socketId);
    this._speakingStates.delete(socketId);
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
      this._analysers.set(id, { analyser, dataArray });
    } catch (err) {
      console.warn('Failed to create analyser for', id, err.message);
    }
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

        const wasSpeaking = this._speakingStates.get(id) || false;
        const isSpeaking = rms > SPEAKING_THRESHOLD;

        if (isSpeaking !== wasSpeaking) {
          this._speakingStates.set(id, isSpeaking);
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

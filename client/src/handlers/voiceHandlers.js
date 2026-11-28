/**
 * Voice chat socket event handlers.
 *
 * Registers listeners for WebRTC signaling events and delegates
 * to VoiceChatManager. Uses global listeners (socketManager.on)
 * since voice spans lobby → game.
 */

import { SERVER_EVENTS } from '../constants/events.js';
import { getVoiceChatManager } from '../voice/VoiceChatManager.js';

/**
 * Register voice chat handlers.
 * @param {import('../socket/SocketManager.js').SocketManager} socketManager
 * @param {Object} [callbacks]
 * @param {Function} [callbacks.onVoiceSettings] - voiceSettings (a casual game's
 *   spectator voice: role, canTalk, canChange; docs/claude/voice.md)
 * @param {Function} [callbacks.onVoicePeers] - (kind 'list' | 'joined' | 'left', data)
 *   after the manager handled a voicePeerList / voicePeerJoined / voicePeerLeft:
 *   the page's tournament-room company (main.js, Tournament voice)
 * @param {Function} [callbacks.onTournamentVoiceStatus] - tournamentVoiceStatus
 *   {admitted, cap} (private, unsequenced; only to a socket that sent the cap
 *   tournamentVoiceStatus): waiting in line for a full tournament voice room,
 *   or let in (main.js, Tournament voice: "Voice is full (N people)")
 */
export function registerVoiceHandlers(socketManager, { onVoiceSettings, onVoicePeers, onTournamentVoiceStatus } = {}) {
  const voiceManager = getVoiceChatManager();
  // The SFU room's roster comes before voice starts (no voice alone): the
  // transport sends and listens on this socket from the start
  voiceManager.setSignalSocket?.(socketManager);

  // Cloudflare SFU voice (the tournament lobby room with VOICE_SFU=tournament;
  // docs/claude/voice.md "SFU voice, web"): an sfuRoster makes the room an
  // SFU room (step 1), sfuMember upserts it, sfuReply answers a request
  socketManager.on(SERVER_EVENTS.SFU_ROSTER, (data) => {
    voiceManager.sfu?.onRoster(data);
  });
  socketManager.on(SERVER_EVENTS.SFU_MEMBER, (data) => {
    voiceManager.sfu?.onMember(data);
  });
  socketManager.on(SERVER_EVENTS.SFU_REPLY, (data) => {
    voiceManager.sfu?.onReply(data);
  });

  // A casual game's voice settings (private, unsequenced; only to a socket
  // that said casualSpectators): the page sets the talk mode, starts voice
  // for a spectator, forces mute for a player while spectators may not talk
  socketManager.on(SERVER_EVENTS.VOICE_SETTINGS, (data) => {
    if (!data || typeof data !== 'object') return;
    onVoiceSettings?.(data);
  });

  // The tournament voice room's over-cap notice: the page shows it on the
  // tournament lobby screen while this socket waits in line
  socketManager.on(SERVER_EVENTS.TOURNAMENT_VOICE_STATUS, (data) => {
    if (!data || typeof data !== 'object' || typeof data.admitted !== 'boolean') return;
    // the room is a mesh (an SFU session still held closes first)
    voiceManager.sfu?.onMeshEvent();
    onTournamentVoiceStatus?.(data);
  });

  socketManager.on(SERVER_EVENTS.VOICE_PEER_LIST, (data) => {
    // a mesh room (or a table): an SFU session still held closes first
    voiceManager.sfu?.onMeshEvent();
    const { peers } = data;
    peers.forEach(peer => {
      voiceManager.connectToPeer(peer.socketId, peer.username);
    });
    onVoicePeers?.('list', data);
  });

  socketManager.on(SERVER_EVENTS.VOICE_PEER_JOINED, (data) => {
    // Don't initiate here — the new joiner will initiate to us via voicePeerList.
    // If both sides initiate simultaneously, WebRTC glare breaks both connections.
    console.log('Voice peer joined:', data.socketId, data.username);
    voiceManager.sfu?.onMeshEvent();
    // One call per player: a call to them on an older socket id moves to
    // this one (still flowing) or closes (docs/claude/voice.md)
    voiceManager.peerJoined?.(data.socketId, data.username);
    onVoicePeers?.('joined', data);
  });

  socketManager.on(SERVER_EVENTS.VOICE_PEER_LEFT, (data) => {
    voiceManager.removePeer(data.socketId);
    onVoicePeers?.('left', data);
  });

  socketManager.on(SERVER_EVENTS.VOICE_OFFER, async (data) => {
    await voiceManager.handleOffer(data.fromSocketId, data.offer, data.username);
  });

  socketManager.on(SERVER_EVENTS.VOICE_ANSWER, async (data) => {
    await voiceManager.handleAnswer(data.fromSocketId, data.answer);
  });

  socketManager.on(SERVER_EVENTS.VOICE_ICE_CANDIDATE, async (data) => {
    await voiceManager.handleIceCandidate(data.fromSocketId, data.candidate);
  });

  // The reply to getVoiceIceServers (TURN credentials, else STUN). The PCM
  // relay (voiceRelayAudio) is gone: TURN replaced it, so nothing listens.
  socketManager.on(SERVER_EVENTS.VOICE_ICE_SERVERS, (data) => {
    voiceManager.onIceServers(data);
  });
}

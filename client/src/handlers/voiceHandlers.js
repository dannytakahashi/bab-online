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
 */
export function registerVoiceHandlers(socketManager) {
  const voiceManager = getVoiceChatManager();

  socketManager.on(SERVER_EVENTS.VOICE_PEER_LIST, (data) => {
    if (!voiceManager.active) return;
    const { peers } = data;
    peers.forEach(peer => {
      voiceManager.connectToPeer(peer.socketId, peer.username);
    });
  });

  socketManager.on(SERVER_EVENTS.VOICE_PEER_JOINED, (data) => {
    // A new peer joined — they will send us an offer, so we just wait.
    // No action needed here; we handle their offer in VOICE_OFFER.
    console.log('Voice peer joined:', data.username);
  });

  socketManager.on(SERVER_EVENTS.VOICE_PEER_LEFT, (data) => {
    voiceManager.removePeer(data.socketId);
  });

  socketManager.on(SERVER_EVENTS.VOICE_OFFER, async (data) => {
    if (!voiceManager.active) return;
    await voiceManager.handleOffer(data.fromSocketId, data.offer);
  });

  socketManager.on(SERVER_EVENTS.VOICE_ANSWER, async (data) => {
    await voiceManager.handleAnswer(data.fromSocketId, data.answer);
  });

  socketManager.on(SERVER_EVENTS.VOICE_ICE_CANDIDATE, async (data) => {
    await voiceManager.handleIceCandidate(data.fromSocketId, data.candidate);
  });
}

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
    const { peers } = data;
    peers.forEach(peer => {
      voiceManager.connectToPeer(peer.socketId, peer.username);
    });
  });

  socketManager.on(SERVER_EVENTS.VOICE_PEER_JOINED, (data) => {
    voiceManager.connectToPeer(data.socketId, data.username);
  });

  socketManager.on(SERVER_EVENTS.VOICE_PEER_LEFT, (data) => {
    voiceManager.removePeer(data.socketId);
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
}

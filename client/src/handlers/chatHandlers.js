/**
 * Chat-related socket event handlers.
 *
 * Handles: chatMessage
 */

import { SERVER_EVENTS } from '../constants/events.js';
import { getGameState } from '../state/GameState.js';

/**
 * Register chat handlers.
 *
 * @param {SocketManager} socketManager - Socket manager instance
 * @param {Object} callbacks - UI callbacks
 * @param {Function} callbacks.onChatMessage - Called when chat message received
 */
export function registerChatHandlers(socketManager, callbacks = {}) {
  const { onChatMessage } = callbacks;

  // In-game chat message
  socketManager.onGame(SERVER_EVENTS.CHAT_MESSAGE, (data) => {
    console.log('💬 Chat message:', data.message, 'from P', data.position);
    onChatMessage?.(data);
  });
}

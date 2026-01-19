/**
 * Socket event handler registration.
 *
 * Organizes the 33+ event handlers into modules by domain.
 * Each handler module exports a registerHandlers function.
 */

import { registerAuthHandlers } from './authHandlers.js';
import { registerLobbyHandlers } from './lobbyHandlers.js';
import { registerGameHandlers, cleanupGameHandlers as cleanupGame } from './gameHandlers.js';
import { registerChatHandlers } from './chatHandlers.js';
import { registerProfileHandlers } from './profileHandlers.js';

/**
 * Register all socket event handlers.
 *
 * @param {SocketManager} socketManager - Socket manager instance
 * @param {Object} callbacks - UI callbacks for updates
 */
export function registerAllHandlers(socketManager, callbacks = {}) {
  const {
    // Auth callbacks
    onSignInSuccess,
    onSignInError,
    onSignUpSuccess,
    onSignUpError,
    onForceLogout,
    onActiveGameFound,
    // Lobby callbacks
    onMainRoomJoined,
    onMainRoomMessage,
    onLobbiesUpdated,
    onMainRoomPlayerJoined,
    onLobbyCreated,
    onLobbyJoined,
    onPlayerReadyUpdate,
    onLobbyMessage,
    onLobbyPlayerLeft,
    onLobbyPlayerJoined,
    onLeftLobby,
    onAllPlayersReady,
    // Game callbacks
    onPositionUpdate,
    onGameStart,
    onStartDraw,
    onYouDrew,
    onPlayerDrew,
    onTeamsAnnounced,
    onCreateUI,
    onBidReceived,
    onDoneBidding,
    onUpdateTurn,
    onCardPlayed,
    onTrickComplete,
    onHandComplete,
    onGameEnd,
    onRainbow,
    onDestroyHands,
    onAbortGame,
    onRoomFull,
    onPlayerDisconnected,
    onPlayerReconnected,
    onRejoinSuccess,
    onRejoinFailed,
    // Chat callbacks
    onChatMessage,
    // Profile callbacks
    onProfileReceived,
    onProfileError,
    onProfilePicUpdated,
    onProfilePicUpdateError,
    onCustomProfilePicUploaded,
    onCustomProfilePicUploadError,
  } = callbacks;

  // Register auth handlers
  registerAuthHandlers(socketManager, {
    onSignInSuccess,
    onSignInError,
    onSignUpSuccess,
    onSignUpError,
    onForceLogout,
    onActiveGameFound,
  });

  // Register lobby handlers
  registerLobbyHandlers(socketManager, {
    onMainRoomJoined,
    onMainRoomMessage,
    onLobbiesUpdated,
    onMainRoomPlayerJoined,
    onLobbyCreated,
    onLobbyJoined,
    onPlayerReadyUpdate,
    onLobbyMessage,
    onLobbyPlayerLeft,
    onLobbyPlayerJoined,
    onLeftLobby,
    onAllPlayersReady,
  });

  // Register game handlers
  registerGameHandlers(socketManager, {
    onPositionUpdate,
    onGameStart,
    onStartDraw,
    onYouDrew,
    onPlayerDrew,
    onTeamsAnnounced,
    onCreateUI,
    onBidReceived,
    onDoneBidding,
    onUpdateTurn,
    onCardPlayed,
    onTrickComplete,
    onHandComplete,
    onGameEnd,
    onRainbow,
    onDestroyHands,
    onAbortGame,
    onRoomFull,
    onPlayerDisconnected,
    onPlayerReconnected,
    onRejoinSuccess,
    onRejoinFailed,
  });

  // Register chat handlers
  registerChatHandlers(socketManager, {
    onChatMessage,
  });

  // Register profile handlers
  registerProfileHandlers(socketManager, {
    onProfileReceived,
    onProfileError,
    onProfilePicUpdated,
    onProfilePicUpdateError,
    onCustomProfilePicUploaded,
    onCustomProfilePicUploadError,
  });
}

/**
 * Unregister all game handlers (for cleanup between games).
 */
export function cleanupGameHandlers(socketManager) {
  cleanupGame(socketManager);
}

// Re-export individual register functions for selective use
export { registerAuthHandlers } from './authHandlers.js';
export { registerLobbyHandlers } from './lobbyHandlers.js';
export { registerGameHandlers } from './gameHandlers.js';
export { registerChatHandlers } from './chatHandlers.js';
export { registerProfileHandlers } from './profileHandlers.js';

/**
 * Lobby and main room socket event handlers.
 *
 * Handles: mainRoomJoined, mainRoomMessage, lobbiesUpdated, mainRoomPlayerJoined,
 *          lobbyCreated, playerReadyUpdate, lobbyMessage,
 *          lobbyPlayerLeft, lobbyPlayerJoined, leftLobby, allPlayersReady
 *
 * No lobbyJoined listener: the server never sends it (joining a lobby is
 * answered with lobbyCreated; contract status clientOnly, V1_REMOVALS #3).
 */

import { SERVER_EVENTS } from '../constants/events.js';
import { getGameState, PHASE } from '../state/GameState.js';

/**
 * Register lobby/main room handlers.
 *
 * @param {SocketManager} socketManager - Socket manager instance
 * @param {Object} callbacks - UI callbacks
 */
export function registerLobbyHandlers(socketManager, callbacks = {}) {
  const {
    // Main room callbacks
    onMainRoomJoined,
    onMainRoomMessage,
    onLobbiesUpdated,
    onMainRoomPlayerJoined,
    // Lobby callbacks
    onLobbyCreated,
    onPlayerReadyUpdate,
    onLobbyMessage,
    onLobbyPlayerLeft,
    onLobbyPlayerJoined,
    onLeftLobby,
    onAllPlayersReady,
    // Spectator callbacks
    onSpectatorJoined,
  } = callbacks;

  const state = getGameState();

  // ==================== MAIN ROOM HANDLERS ====================

  socketManager.on(SERVER_EVENTS.MAIN_ROOM_JOINED, (data) => {
    console.log('🏠 Joined main room:', data);
    state.setPhase(PHASE.NONE);
    onMainRoomJoined?.(data);
  });

  socketManager.on(SERVER_EVENTS.MAIN_ROOM_MESSAGE, (data) => {
    console.log('💬 Main room message:', data);
    onMainRoomMessage?.(data);
  });

  socketManager.on(SERVER_EVENTS.LOBBIES_UPDATED, (data) => {
    console.log('📋 Lobbies updated:', data);
    onLobbiesUpdated?.(data);
  });

  socketManager.on(SERVER_EVENTS.MAIN_ROOM_PLAYER_JOINED, (data) => {
    console.log('👋 Player joined main room:', data);
    onMainRoomPlayerJoined?.(data);
  });

  // ==================== LOBBY HANDLERS ====================

  socketManager.on(SERVER_EVENTS.LOBBY_CREATED, (data) => {
    console.log('🎮 Lobby created:', data);
    state.setPhase(PHASE.LOBBY);
    state.lobbyId = data.lobbyId;
    onLobbyCreated?.(data);
  });

  socketManager.on(SERVER_EVENTS.PLAYER_READY_UPDATE, (data) => {
    console.log('✅ Player ready update:', data);
    onPlayerReadyUpdate?.(data);
  });

  socketManager.on(SERVER_EVENTS.LOBBY_MESSAGE, (data) => {
    console.log('💬 Lobby message:', data);
    onLobbyMessage?.(data);
  });

  socketManager.on(SERVER_EVENTS.LOBBY_PLAYER_LEFT, (data) => {
    console.log('👋 Player left lobby:', data);
    onLobbyPlayerLeft?.(data);
  });

  socketManager.on(SERVER_EVENTS.LOBBY_PLAYER_JOINED, (data) => {
    console.log('👋 Player joined lobby:', data);
    onLobbyPlayerJoined?.(data);
  });

  socketManager.on(SERVER_EVENTS.LEFT_LOBBY, () => {
    console.log('🚪 Left lobby');
    state.setPhase(PHASE.NONE);
    state.lobbyId = null;
    onLeftLobby?.();
  });

  socketManager.on(SERVER_EVENTS.ALL_PLAYERS_READY, (data) => {
    console.log('🎉 All players ready:', data);
    onAllPlayersReady?.(data);
  });

  // ==================== SPECTATOR HANDLERS ====================

  socketManager.on(SERVER_EVENTS.SPECTATOR_JOINED, (data) => {
    console.log('👁️ Spectator joined game:', data);
    onSpectatorJoined?.(data);
  });
}

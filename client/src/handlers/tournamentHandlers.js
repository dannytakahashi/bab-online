/**
 * Tournament socket event handlers.
 *
 * Handles: tournamentCreated, tournamentJoined, tournamentPlayerJoined,
 *          tournamentPlayerLeft, tournamentReadyUpdate, tournamentMessage,
 *          tournamentRoundStart, tournamentGameAssignment, tournamentGameComplete,
 *          tournamentRoundComplete, tournamentComplete, tournamentLeft,
 *          activeTournamentFound
 */

import { SERVER_EVENTS } from '../constants/events.js';

/**
 * Register tournament handlers.
 *
 * @param {SocketManager} socketManager - Socket manager instance
 * @param {Object} callbacks - UI callbacks
 */
export function registerTournamentHandlers(socketManager, callbacks = {}) {
  const {
    onTournamentCreated,
    onTournamentJoined,
    onTournamentPlayerJoined,
    onTournamentPlayerLeft,
    onTournamentReadyUpdate,
    onTournamentMessage,
    onTournamentRoundStart,
    onTournamentGameAssignment,
    onTournamentGameComplete,
    onTournamentRoundComplete,
    onTournamentComplete,
    onTournamentLeft,
    onTournamentCancelled,
    onActiveTournamentFound,
  } = callbacks;

  socketManager.on(SERVER_EVENTS.TOURNAMENT_CREATED, (data) => {
    console.log('Tournament created:', data);
    onTournamentCreated?.(data);
  });

  socketManager.on(SERVER_EVENTS.TOURNAMENT_JOINED, (data) => {
    console.log('Tournament joined:', data);
    onTournamentJoined?.(data);
  });

  socketManager.on(SERVER_EVENTS.TOURNAMENT_PLAYER_JOINED, (data) => {
    console.log('Tournament player joined:', data);
    onTournamentPlayerJoined?.(data);
  });

  socketManager.on(SERVER_EVENTS.TOURNAMENT_PLAYER_LEFT, (data) => {
    console.log('Tournament player left:', data);
    onTournamentPlayerLeft?.(data);
  });

  socketManager.on(SERVER_EVENTS.TOURNAMENT_READY_UPDATE, (data) => {
    console.log('Tournament ready update:', data);
    onTournamentReadyUpdate?.(data);
  });

  socketManager.on(SERVER_EVENTS.TOURNAMENT_MESSAGE, (data) => {
    console.log('Tournament message:', data);
    onTournamentMessage?.(data);
  });

  socketManager.on(SERVER_EVENTS.TOURNAMENT_ROUND_START, (data) => {
    console.log('Tournament round start:', data);
    onTournamentRoundStart?.(data);
  });

  socketManager.on(SERVER_EVENTS.TOURNAMENT_GAME_ASSIGNMENT, (data) => {
    console.log('Tournament game assignment:', data);
    onTournamentGameAssignment?.(data);
  });

  socketManager.on(SERVER_EVENTS.TOURNAMENT_GAME_COMPLETE, (data) => {
    console.log('Tournament game complete:', data);
    onTournamentGameComplete?.(data);
  });

  socketManager.on(SERVER_EVENTS.TOURNAMENT_ROUND_COMPLETE, (data) => {
    console.log('Tournament round complete:', data);
    onTournamentRoundComplete?.(data);
  });

  socketManager.on(SERVER_EVENTS.TOURNAMENT_COMPLETE, (data) => {
    console.log('Tournament complete:', data);
    onTournamentComplete?.(data);
  });

  socketManager.on(SERVER_EVENTS.TOURNAMENT_LEFT, (data) => {
    console.log('Tournament left:', data);
    onTournamentLeft?.(data);
  });

  socketManager.on(SERVER_EVENTS.TOURNAMENT_CANCELLED, (data) => {
    console.log('Tournament cancelled:', data);
    onTournamentCancelled?.(data);
  });

  socketManager.on(SERVER_EVENTS.ACTIVE_TOURNAMENT_FOUND, (data) => {
    console.log('Active tournament found:', data);
    onActiveTournamentFound?.(data);
  });
}

/**
 * Game-related socket event handlers.
 *
 * Handles: positionUpdate, gameStart, startDraw, youDrew, playerDrew, teamsAnnounced,
 *          createUI, bidReceived, doneBidding, updateTurn, cardPlayed, trickComplete,
 *          handComplete, gameEnd, rainbow, destroyHands, abortGame, roomFull,
 *          playerDisconnected, playerReconnected, rejoinSuccess, rejoinFailed,
 *          actionRejected, stateSnapshot, spectatorsUpdated
 *
 * Each handler applies its event to GameState (the one writer of table
 * state; sequenced events reach it in seq order through SocketManager's
 * SeqGate) and to MyAction (my own bid/play is confirmed by its echo), keeps
 * the TableDirector's key current, then calls the view callback. Snapshots
 * (rejoin, restore, rejected actions, resyncs) go through
 * state/tableSync.applyTableSnapshot, in main.js's callbacks.
 */

import { SERVER_EVENTS } from '../constants/events.js';
import { getGameState, PHASE } from '../state/GameState.js';
import { getClientSession } from '../state/ClientSession.js';
import { getMyAction } from '../state/MyAction.js';
import { getTableDirector } from '../phaser/TableDirector.js';

/**
 * Register game event handlers.
 *
 * @param {SocketManager} socketManager - Socket manager instance
 * @param {Object} callbacks - UI callbacks for visual updates
 */
export function registerGameHandlers(socketManager, callbacks = {}) {
  const {
    // Setup phase
    onPositionUpdate,
    onGameStart,
    onStartDraw,
    onYouDrew,
    onPlayerDrew,
    onTeamsAnnounced,
    onCreateUI,
    // Bidding phase
    onBidReceived,
    onDoneBidding,
    // Playing phase
    onUpdateTurn,
    onCardPlayed,
    onTrickComplete,
    onHandComplete,
    // Game end
    onGameEnd,
    // Special events
    onRainbow,
    onDestroyHands,
    onAbortGame,
    onRoomFull,
    // Reconnection
    onPlayerDisconnected,
    onPlayerReconnected,
    onRejoinSuccess,
    onRejoinFailed,
    // Resignation & Lazy Mode
    onResignationAvailable,
    onPlayerResigned,
    onPlayerLazyMode,
    onPlayerActiveMode,
    onGameLogEntry,
    onLeftGame,
    onRestorePlayerState,
    // Acked actions and resyncs
    onActionRejected,
    onStateSnapshot,
    // Who is watching
    onSpectatorsUpdated,
  } = callbacks;

  const state = getGameState();
  const myAction = getMyAction();
  const director = getTableDirector();

  // The director's key follows the table: {gameId, handNo, deal, trickNo}
  const touched = () => {
    director.setKey({ gameId: state.gameId, handNo: state.handNo, deal: state.dealSeq ?? 0, trickNo: state.trickNo });
    director.noteChange();
  };
  const mine = (position) => !!position && position === state.position && !state.isSpectator;

  // ==================== SETUP PHASE ====================

  // Position assignment (player positions 1-4)
  socketManager.onGame(SERVER_EVENTS.POSITION_UPDATE, (data) => {
    console.log('📍 Position update:', data);

    // Store player data in state
    state.setPlayerData(data);

    // If position comes with this data
    if (data.yourPosition) {
      state.position = data.yourPosition;
      state._updatePlayerNames();
    }

    onPositionUpdate?.(data);
  });

  // Game start - receive hand, trump, dealer
  socketManager.onGame(SERVER_EVENTS.GAME_START, (data) => {
    console.log('🎮 Game start:', data);

    // A new deal: whatever I had pending belonged to the last one
    myAction.reset();
    state.applyDeal(data);

    // Persist the gameId for a reconnect: a seat's gameStart only (a
    // spectator's has no position; spectators re-spectate instead)
    getClientSession().noteDeal(data);
    touched();

    onGameStart?.(data);
  });

  // Start draw phase
  socketManager.onGame(SERVER_EVENTS.START_DRAW, (data) => {
    console.log('🎴 Start draw:', data);
    state.setPhase(PHASE.DRAW);
    state.stage = 'DRAWING';
    state.setHasDrawn(false);
    onStartDraw?.(data);
  });

  // Player drew a card (current player)
  socketManager.onGame(SERVER_EVENTS.YOU_DREW, (data) => {
    console.log('🃏 You drew:', data);
    state.setHasDrawn(true);
    onYouDrew?.(data);
  });

  // Another player drew a card
  socketManager.onGame(SERVER_EVENTS.PLAYER_DREW, (data) => {
    console.log('🃏 Player drew:', data);
    onPlayerDrew?.(data);
  });

  // Teams announced after draw
  socketManager.onGame(SERVER_EVENTS.TEAMS_ANNOUNCED, (data) => {
    console.log('🏆 Teams announced:', data);
    state.stage = 'TEAMS_ANNOUNCED';
    onTeamsAnnounced?.(data);
  });

  // Create game UI
  socketManager.onGame(SERVER_EVENTS.CREATE_UI, (data) => {
    console.log('🎨 Create UI');
    onCreateUI?.(data);
  });

  // ==================== BIDDING PHASE ====================

  // Bid received from any player
  socketManager.onGame(SERVER_EVENTS.BID_RECEIVED, (data) => {
    console.log('💰 Bid received:', data);
    state.applyBid(data);
    if (mine(data.position)) myAction.confirm('bid', data);
    touched();
    onBidReceived?.(data);
  });

  // Done bidding - transition to playing
  socketManager.onGame(SERVER_EVENTS.DONE_BIDDING, (data) => {
    console.log('🎯 Done bidding:', data);
    state.applyDoneBidding(data);
    touched();
    onDoneBidding?.(data);
  });

  // ==================== PLAYING PHASE ====================

  // Turn update
  socketManager.onGame(SERVER_EVENTS.UPDATE_TURN, (data) => {
    console.log('🔄 Update turn:', data);
    state.applyTurn(data);
    touched();
    onUpdateTurn?.(data);
  });

  // Card played by any player
  socketManager.onGame(SERVER_EVENTS.CARD_PLAYED, (data) => {
    console.log(`🃏 Card played: ${data.card?.rank} of ${data.card?.suit} by P${data.position}`);
    state.applyCardPlayed(data);
    // My own play's echo confirms it (the 4th card of a trick comes at once)
    if (mine(data.position)) myAction.confirm('play', data);
    touched();
    onCardPlayed?.(data);
  });

  // Trick complete
  socketManager.onGame(SERVER_EVENTS.TRICK_COMPLETE, (data) => {
    console.log('🏆 Trick complete, winner:', data.winner);
    // The counts are kept here (cli-8), never in the scene
    state.applyTrickComplete(data);
    touched();
    onTrickComplete?.(data);
  });

  // Hand complete
  socketManager.onGame(SERVER_EVENTS.HAND_COMPLETE, (data) => {
    console.log('🏁 Hand complete:', data);
    state.applyHandComplete(data);

    // Callback BEFORE the reset: it reads the hand's bids and tricks
    onHandComplete?.(data);

    // Reset for next hand (clears bids, tricks, etc.)
    state.resetForNewHand();
    touched();
  });

  // ==================== GAME END ====================

  socketManager.onGame(SERVER_EVENTS.GAME_END, (data) => {
    console.log('🎮 Game end:', data);

    myAction.reset();
    state.applyGameEnd(data);

    // Nothing to rejoin any more (onGameEnd -> the client session's endGame
    // clears the spectatingGameId too)
    socketManager.clearGameId();

    onGameEnd?.(data);
  });

  // ==================== SPECIAL EVENTS ====================

  // Rainbow hand detected
  socketManager.onGame(SERVER_EVENTS.RAINBOW, (data) => {
    console.log('🌈 Rainbow:', data);

    // Track rainbow for the player
    if (data.position === state.position) {
      state.teamRainbows++;
    } else if (state.isTeammate(data.position)) {
      state.teamRainbows++;
    } else {
      state.oppRainbows++;
    }

    onRainbow?.(data);
  });

  // Destroy hands (the all-zero redeal)
  socketManager.onGame(SERVER_EVENTS.DESTROY_HANDS, (data) => {
    console.log('🗑️ Destroy hands');
    myAction.reset();
    state.applyDestroyHands();
    touched();
    onDestroyHands?.(data);
  });

  // Game aborted
  socketManager.onGame(SERVER_EVENTS.ABORT_GAME, (data) => {
    console.log('⚠️ Game aborted:', data);

    // onAbortGame -> the client session's exitTable does the teardown, the
    // per-game state reset and the route out; the gameId goes first
    myAction.reset();
    socketManager.clearGameId();

    onAbortGame?.(data);
  });

  // Room full
  socketManager.on(SERVER_EVENTS.ROOM_FULL, (data) => {
    console.log('🚫 Room full:', data);
    onRoomFull?.(data);
  });

  // ==================== RECONNECTION ====================

  // Player disconnected
  socketManager.onGame(SERVER_EVENTS.PLAYER_DISCONNECTED, (data) => {
    console.log(`⚠️ Player ${data.username} at P${data.position} disconnected`);
    onPlayerDisconnected?.(data);
  });

  // Player reconnected
  socketManager.onGame(SERVER_EVENTS.PLAYER_RECONNECTED, (data) => {
    console.log(`🔄 Player ${data.username} at P${data.position} reconnected`);
    onPlayerReconnected?.(data);
  });

  // Rejoin success: the table comes back from its snapshot (onRejoinSuccess)
  socketManager.on(SERVER_EVENTS.REJOIN_SUCCESS, (data) => {
    console.log('✅ Rejoin success:', data);
    onRejoinSuccess?.(data);
  });

  // Rejoin failed
  socketManager.on(SERVER_EVENTS.REJOIN_FAILED, (data) => {
    console.log('❌ Rejoin failed:', data?.reason);

    // onRejoinFailed leaves the table (exitTable clears every gameId copy),
    // except for 'Already connected': this socket's seat is live
    if (data?.reason !== 'Already connected') {
      socketManager.clearGameId();
    }

    onRejoinFailed?.(data);
  });

  // ==================== ACKED ACTIONS & RESYNC ====================

  // My bid or play was refused: its snapshot is the truth (onActionRejected)
  socketManager.on(SERVER_EVENTS.ACTION_REJECTED, (data) => {
    console.log(`⛔ ${data?.action} rejected: ${data?.reason}`);
    myAction.reject(data || {});
    onActionRejected?.(data || {});
  });

  // The reply to requestSnapshot (a seq gap, an ack timeout, the liveness ping)
  socketManager.on(SERVER_EVENTS.STATE_SNAPSHOT, (data) => {
    onStateSnapshot?.(data || {});
  });

  // Who is watching (the spectator badge): the whole list, unsequenced
  socketManager.on(SERVER_EVENTS.SPECTATORS_UPDATED, (data) => {
    if (state.applySpectators(data)) onSpectatorsUpdated?.(state.renderModel().watching);
  });

  // ==================== RESIGNATION & LAZY MODE ====================

  // Resignation available (disconnected player's grace period expired)
  socketManager.onGame(SERVER_EVENTS.RESIGNATION_AVAILABLE, (data) => {
    console.log(`⏰ Resignation available for P${data.position} (${data.username})`);
    onResignationAvailable?.(data);
  });

  // Player resigned (bot taking over)
  socketManager.onGame(SERVER_EVENTS.PLAYER_RESIGNED, (data) => {
    console.log(`🔄 Player resigned: P${data.position} ${data.oldUsername} → ${data.botUsername}`);
    state.applySeatDisplay(data.position, { username: data.botUsername, pic: data.botPic });
    touched();
    onPlayerResigned?.(data);
  });

  // Player entered lazy mode
  socketManager.onGame(SERVER_EVENTS.PLAYER_LAZY_MODE, (data) => {
    console.log(`😴 Player entered lazy mode: P${data.position}`);
    if (mine(data.position)) {
      myAction.reset();
      state.applyMyLazy(true);
    }
    state.applySeatDisplay(data.position, { username: data.botUsername, pic: data.botPic });
    touched();
    onPlayerLazyMode?.(data);
  });

  // Player returned to active mode
  socketManager.onGame(SERVER_EVENTS.PLAYER_ACTIVE_MODE, (data) => {
    console.log(`🎮 Player returned to active: P${data.position}`);
    if (mine(data.position)) state.applyMyLazy(false);
    state.applySeatDisplay(data.position, { username: data.username, pic: data.avatarUrl || data.pic });
    touched();
    onPlayerActiveMode?.(data);
  });

  // Game log entry (system message broadcast)
  socketManager.onGame(SERVER_EVENTS.GAME_LOG_ENTRY, (data) => {
    onGameLogEntry?.(data);
  });

  // Player left game (via /leave command)
  socketManager.onGame(SERVER_EVENTS.LEFT_GAME, (data) => {
    console.log('🚪 Left game (lazy leave)');
    // Every gameId copy goes (here and in onLeftGame -> exitTable), or the
    // next reconnect would rejoin the left game
    myAction.reset();
    socketManager.clearGameId();
    onLeftGame?.(data);
  });

  // Restore player state (spectator → active player transition, or the
  // resync after a refused play)
  socketManager.onGame(SERVER_EVENTS.RESTORE_PLAYER_STATE, (data) => {
    console.log('🔄 Restoring player state from spectator mode');
    onRestorePlayerState?.(data);
  });
}

/**
 * Cleanup game handlers between games.
 *
 * @param {SocketManager} socketManager - Socket manager instance
 */
export function cleanupGameHandlers(socketManager) {
  socketManager.cleanupGameListeners();
}

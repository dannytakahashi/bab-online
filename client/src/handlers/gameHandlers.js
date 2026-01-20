/**
 * Game-related socket event handlers.
 *
 * Handles: positionUpdate, gameStart, startDraw, youDrew, playerDrew, teamsAnnounced,
 *          createUI, bidReceived, doneBidding, updateTurn, cardPlayed, trickComplete,
 *          handComplete, gameEnd, rainbow, destroyHands, abortGame, roomFull,
 *          playerDisconnected, playerReconnected, rejoinSuccess, rejoinFailed
 */

import { SERVER_EVENTS } from '../constants/events.js';
import { getGameState, PHASE } from '../state/GameState.js';

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
  } = callbacks;

  const state = getGameState();

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

    // Set position from data if provided
    if (data.position) {
      state.position = data.position;
    }

    // Store game info
    state.setGameInfo(data.gameId, data.currentHand, data.dealer);
    state.setTrump(data.trump);
    state.setCards(data.hand);
    state.setBidding(true);
    state.setPhase(PHASE.BIDDING);

    // Store in sessionStorage for reconnection
    if (data.gameId) {
      sessionStorage.setItem('gameId', data.gameId);
    }

    // Set socket game ID for cleanup
    socketManager.setGameId(data.gameId);

    // Update scores from data
    if (data.score1 !== undefined && data.score2 !== undefined) {
      if (state.position % 2 !== 0) {
        // Odd positions (1, 3) are Team 1
        state.setGameScores(data.score1, data.score2);
      } else {
        // Even positions (2, 4) are Team 2
        state.setGameScores(data.score2, data.score1);
      }
    }

    onGameStart?.(data);
  });

  // Start draw phase
  socketManager.onGame(SERVER_EVENTS.START_DRAW, (data) => {
    console.log('🎴 Start draw:', data);
    state.setPhase(PHASE.DRAW);
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

    // Record bid in state
    state.recordBid(data.position, data.bid);

    // Update multipliers if provided
    if (data.team1Mult !== undefined) {
      state.team1Mult = data.team1Mult;
    }
    if (data.team2Mult !== undefined) {
      state.team2Mult = data.team2Mult;
    }

    onBidReceived?.(data);
  });

  // Done bidding - transition to playing
  socketManager.onGame(SERVER_EVENTS.DONE_BIDDING, (data) => {
    console.log('🎯 Done bidding:', data);

    state.setBidding(false);
    state.setPhase(PHASE.PLAYING);

    // Reset play state
    state.playedCardIndex = 0;
    state.leadCard = null;
    state.leadPosition = null;
    state.trumpBroken = false;
    state.hasPlayedCard = false;
    state.playedCards = [];
    state.currentTrick = [];

    // Set first player from lead
    if (data.lead !== undefined) {
      state.setCurrentTurn(data.lead);
    }

    onDoneBidding?.(data);
  });

  // ==================== PLAYING PHASE ====================

  // Turn update
  socketManager.onGame(SERVER_EVENTS.UPDATE_TURN, (data) => {
    console.log('🔄 Update turn:', data);

    state.setCurrentTurn(data.currentTurn || data.turn);
    state.setHasPlayedCard(false);

    onUpdateTurn?.(data);
  });

  // Card played by any player
  socketManager.onGame(SERVER_EVENTS.CARD_PLAYED, (data) => {
    console.log(`🃏 Card played: ${data.card.rank} of ${data.card.suit} by P${data.position}`);

    // Track if this is the lead card
    if (state.playedCardIndex === 0) {
      state.leadCard = data.card;
      state.leadPosition = data.position;
    }

    // Update trump broken status
    if (data.trump !== undefined) {
      state.trumpBroken = data.trump;
    }
    if (data.trumpBroken !== undefined) {
      state.trumpBroken = data.trumpBroken;
    }

    // Add to played cards
    state.addPlayedCard(data.card, data.position);

    // Confirm optimistic play if it was our card
    state.confirmCardPlay();

    // Reset index if trick complete (4 cards)
    if (state.playedCardIndex >= 4) {
      state.playedCardIndex = 0;
    }

    onCardPlayed?.(data);
  });

  // Trick complete
  socketManager.onGame(SERVER_EVENTS.TRICK_COMPLETE, (data) => {
    console.log('🏆 Trick complete, winner:', data.winner);

    // Note: trick counts are updated in GameScene.handleTrickComplete
    // to avoid double-counting

    // Clear trick state
    state.clearTrick();

    onTrickComplete?.(data);
  });

  // Hand complete
  socketManager.onGame(SERVER_EVENTS.HAND_COMPLETE, (data) => {
    console.log('🏁 Hand complete:', data);

    // Update scores
    if (data.score) {
      if (state.position % 2 !== 0) {
        state.setGameScores(data.score.team1, data.score.team2);
      } else {
        state.setGameScores(data.score.team2, data.score.team1);
      }
    }

    // Reset for next hand
    state.resetForNewHand();

    onHandComplete?.(data);
  });

  // ==================== GAME END ====================

  socketManager.onGame(SERVER_EVENTS.GAME_END, (data) => {
    console.log('🎮 Game end:', data);

    state.setPhase(PHASE.ENDED);

    // Clear game from sessionStorage
    sessionStorage.removeItem('gameId');
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

  // Destroy hands (cleanup between hands)
  socketManager.onGame(SERVER_EVENTS.DESTROY_HANDS, (data) => {
    console.log('🗑️ Destroy hands');
    onDestroyHands?.(data);
  });

  // Game aborted
  socketManager.onGame(SERVER_EVENTS.ABORT_GAME, (data) => {
    console.log('⚠️ Game aborted:', data);

    state.reset();
    sessionStorage.removeItem('gameId');
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

  // Rejoin success
  socketManager.on(SERVER_EVENTS.REJOIN_SUCCESS, (data) => {
    console.log('✅ Rejoin success:', data);

    // Restore full game state
    state.restoreFromRejoin(data);

    // Update socket game ID
    socketManager.setGameId(data.gameId);

    onRejoinSuccess?.(data);
  });

  // Rejoin failed
  socketManager.on(SERVER_EVENTS.REJOIN_FAILED, (data) => {
    console.log('❌ Rejoin failed:', data.reason);

    // Clear stored game
    sessionStorage.removeItem('gameId');
    socketManager.clearGameId();

    onRejoinFailed?.(data);
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

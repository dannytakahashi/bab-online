/**
 * Client-side game state container with event emitter.
 *
 * Replaces 50+ global variables with structured state management.
 * Provides optimistic updates with rollback capability.
 */

import { team, rotate } from '../utils/positions.js';

// Game phases
export const PHASE = {
  NONE: 'none',
  LOBBY: 'lobby',
  DRAW: 'draw',
  BIDDING: 'bidding',
  PLAYING: 'playing',
  ENDED: 'ended',
};

/**
 * Client game state with event system.
 */
export class GameState {
  constructor() {
    this._listeners = new Map();
    this.reset();
  }

  /**
   * Reset all state to initial values.
   */
  reset() {
    // Player identity
    this.playerId = null;
    this.username = null;
    this.position = null;
    this.pic = null;

    // Game info
    this.gameId = null;
    this.phase = PHASE.NONE;
    this.currentHand = 0;
    this.dealer = null;

    // Trump
    this.trump = null;
    this.trumpBroken = false;

    // Turn management
    this.currentTurn = null;
    this.isBidding = false;

    // Card state
    this.myCards = [];
    this.playedCards = []; // Cards in current trick (data only: {card, position})

    // Trick state
    this.leadCard = null;
    this.leadPosition = null;
    this.currentTrick = []; // Same as playedCards, kept for compatibility
    this.playedCardIndex = 0; // Count of cards played in current trick (0-4)

    // Bids
    this.bids = {}; // { position: bid }
    this.teamBids = null;
    this.oppBids = null;
    this.team1Mult = 1;
    this.team2Mult = 1;

    // Scores
    this.teamTricks = 0;
    this.oppTricks = 0;
    this.teamScore = 0;
    this.oppScore = 0;
    this.teamRainbows = 0;
    this.oppRainbows = 0;

    // Trick history (for game log)
    this.teamTrickHistory = [];
    this.oppTrickHistory = [];

    // Players data - raw format from server
    // { position: [], socket: [], username: [{username}], pics: [] }
    this.playerData = null;

    // Players data - normalized format
    this.players = {}; // { position: { username, pic } }

    // Derived player names for easy access
    this.partnerName = null;
    this.opp1Name = null;
    this.opp2Name = null;

    // UI interaction flags
    this.hasPlayedCard = false; // Prevent double-play in a trick

    // Draw phase state
    this.hasDrawn = false;
    this.clickedCardPosition = null; // Store position of clicked card for draw animation

    // Bid state
    this.tempBids = []; // Bid history for bore button state

    // HSI values for all players at hand start (position → HSI)
    this.hsiValues = {};

    // Play positions for trick card coordinates (updated on resize)
    this.playPositions = {
      opponent1: { x: 0, y: 0 },
      opponent2: { x: 0, y: 0 },
      partner: { x: 0, y: 0 },
      self: { x: 0, y: 0 },
    };

    // Sprite references (for external access during resize)
    this.opponentCardSprites = { partner: [], opp1: [], opp2: [] };
    this.tableCardSprite = null;

    // Active chat bubbles by position key
    this.activeChatBubbles = {};

    // Rainbow positions received during bidding
    this.rainbows = [];

    // Pending data (for when events arrive before scene is ready)
    this._pendingRejoinData = null;
    this._pendingPositionData = null;
    this._pendingGameStartData = null;

    // Optimistic update state
    this._pendingCard = null;
    this._pendingBid = null;
    this._previousCards = null;

    this._emit('reset');
  }

  // ============================================
  // Event System
  // ============================================

  /**
   * Subscribe to state changes.
   * @param {string} event - Event name
   * @param {Function} callback - Handler function
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);

    // Return unsubscribe function
    return () => this.off(event, callback);
  }

  /**
   * Unsubscribe from state changes.
   * @param {string} event - Event name
   * @param {Function} callback - Handler function
   */
  off(event, callback) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  /**
   * Emit an event to all listeners.
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  _emit(event, data = null) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.forEach((callback) => {
        try {
          callback(data);
        } catch (err) {
          console.error(`Error in ${event} listener:`, err);
        }
      });
    }
  }

  // ============================================
  // State Updates
  // ============================================

  /**
   * Set player identity.
   */
  setPlayer(playerId, username, position, pic = null) {
    this.playerId = playerId;
    this.username = username;
    this.position = position;
    this.pic = pic;

    // Update derived player names if playerData is already set
    if (this.playerData) {
      this._updatePlayerNames();
    }

    this._emit('playerSet', { playerId, username, position, pic });
  }

  /**
   * Set game info.
   */
  setGameInfo(gameId, currentHand, dealer) {
    this.gameId = gameId;
    this.currentHand = currentHand;
    this.dealer = dealer;
    this._emit('gameInfoSet', { gameId, currentHand, dealer });
  }

  /**
   * Set game phase.
   */
  setPhase(phase) {
    const oldPhase = this.phase;
    this.phase = phase;
    this._emit('phaseChanged', { oldPhase, newPhase: phase });
  }

  /**
   * Set trump card.
   */
  setTrump(trump) {
    this.trump = trump;
    this._emit('trumpSet', trump);
  }

  /**
   * Set HSI values for all players at hand start.
   * @param {Object} hsiValues - { position: hsi } mapping
   */
  setHsiValues(hsiValues) {
    this.hsiValues = { ...hsiValues };
    this._emit('hsiValuesSet', this.hsiValues);
  }

  /**
   * Break trump.
   */
  breakTrump() {
    if (!this.trumpBroken) {
      this.trumpBroken = true;
      this._emit('trumpBroken');
    }
  }

  /**
   * Set current turn.
   */
  setCurrentTurn(position) {
    this.currentTurn = position;
    this._emit('turnChanged', position);
  }

  /**
   * Set bidding state.
   */
  setBidding(isBidding) {
    this.isBidding = isBidding;
    this._emit('biddingChanged', isBidding);
  }

  /**
   * Set player's hand.
   */
  setCards(cards) {
    this.myCards = [...cards];
    this._emit('handChanged', this.myCards);
  }

  /**
   * Record a bid.
   */
  recordBid(position, bid) {
    this.bids[position] = bid;
    this._updateTeamBids();
    this._emit('bidReceived', { position, bid });
  }

  /**
   * Update team bid summary.
   */
  _updateTeamBids() {
    const myTeam = this.position % 2; // 0 or 1
    const myBid = this.bids[this.position];
    const partnerBid = this.bids[team(this.position)];

    const oppPositions = myTeam === 1 ? [2, 4] : [1, 3];
    const opp1Bid = this.bids[oppPositions[0]];
    const opp2Bid = this.bids[oppPositions[1]];

    this.teamBids = `${myBid ?? '-'}/${partnerBid ?? '-'}`;
    this.oppBids = `${opp1Bid ?? '-'}/${opp2Bid ?? '-'}`;
  }

  /**
   * Set trick scores.
   */
  setTrickScores(teamTricks, oppTricks) {
    this.teamTricks = teamTricks;
    this.oppTricks = oppTricks;
    this._emit('trickScoresChanged', { teamTricks, oppTricks });
  }

  /**
   * Set game scores.
   */
  setGameScores(teamScore, oppScore) {
    this.teamScore = teamScore;
    this.oppScore = oppScore;
    this._emit('gameScoresChanged', { teamScore, oppScore });
  }

  /**
   * Record a card played in current trick.
   */
  addPlayedCard(card, position) {
    this.playedCards.push({ card, position });
    this.currentTrick.push({ card, position });
    this.playedCardIndex++;

    if (this.playedCards.length === 1) {
      this.leadCard = card;
      this.leadPosition = position;
    }

    this._emit('cardPlayed', { card, position, playedCardIndex: this.playedCardIndex });
  }

  /**
   * Clear current trick (after trick complete).
   */
  clearTrick() {
    this.playedCards = [];
    this.currentTrick = [];
    this.playedCardIndex = 0;
    this.leadCard = null;
    this.leadPosition = null;
    this.hasPlayedCard = false;
    this._emit('trickCleared');
  }

  /**
   * Set players data (normalized format).
   */
  setPlayers(players) {
    this.players = { ...players };
    this._emit('playersSet', this.players);
  }

  /**
   * Set raw player data from server (position/socket/username/pics arrays).
   * Also derives normalized players object and player names.
   */
  setPlayerData(data) {
    // Store raw format: { position: [], socket: [], username: [{username}], pics: [] }
    this.playerData = {
      position: data.positions || data.position,
      socket: data.sockets || data.socket,
      username: data.usernames || data.username,
      pics: data.pics,
    };

    // Derive normalized players object
    if (this.playerData.position && this.playerData.username) {
      this.players = {};
      this.playerData.position.forEach((pos, idx) => {
        this.players[pos] = {
          username: this.playerData.username[idx]?.username || this.playerData.username[idx],
          pic: this.playerData.pics?.[idx],
        };
      });
    }

    // Update derived player names if position is set
    if (this.position) {
      this._updatePlayerNames();
    }

    this._emit('playerDataSet', this.playerData);
  }

  /**
   * Update derived player names based on position and playerData.
   * Call this after both position and playerData are set.
   */
  _updatePlayerNames() {
    if (!this.playerData || !this.position) return;

    const posIdx = this.playerData.position.indexOf(this.position);
    if (posIdx === -1) return;

    // My username
    this.username = this.playerData.username[posIdx]?.username ||
      this.playerData.username[posIdx] ||
      this.username;

    // Partner (position +/- 2)
    const partnerPos = team(this.position);
    const partnerIdx = this.playerData.position.indexOf(partnerPos);
    this.partnerName = partnerIdx !== -1
      ? (this.playerData.username[partnerIdx]?.username || this.playerData.username[partnerIdx])
      : 'Partner';

    // Opponent 1 (next position clockwise)
    const opp1Pos = rotate(this.position);
    const opp1Idx = this.playerData.position.indexOf(opp1Pos);
    this.opp1Name = opp1Idx !== -1
      ? (this.playerData.username[opp1Idx]?.username || this.playerData.username[opp1Idx])
      : 'Opp1';

    // Opponent 2 (previous position clockwise)
    const opp2Pos = rotate(rotate(rotate(this.position)));
    const opp2Idx = this.playerData.position.indexOf(opp2Pos);
    this.opp2Name = opp2Idx !== -1
      ? (this.playerData.username[opp2Idx]?.username || this.playerData.username[opp2Idx])
      : 'Opp2';

    this._emit('playerNamesUpdated', {
      username: this.username,
      partnerName: this.partnerName,
      opp1Name: this.opp1Name,
      opp2Name: this.opp2Name,
    });
  }

  /**
   * Get player name by position (using playerData).
   */
  getPlayerNameByPosition(pos) {
    if (!this.playerData || !this.playerData.position) return `P${pos}`;
    const idx = this.playerData.position.indexOf(pos);
    if (idx === -1) return `P${pos}`;
    return this.playerData.username[idx]?.username ||
      this.playerData.username[idx] ||
      `P${pos}`;
  }

  /**
   * Mark that the player has played a card this trick.
   */
  setHasPlayedCard(value) {
    this.hasPlayedCard = value;
    this._emit('hasPlayedCardChanged', value);
  }

  /**
   * Mark that the player has drawn during draw phase.
   */
  setHasDrawn(value) {
    this.hasDrawn = value;
    this._emit('hasDrawnChanged', value);
  }

  /**
   * Set clicked card position for draw animation.
   */
  setClickedCardPosition(position) {
    this.clickedCardPosition = position;
  }

  /**
   * Update play positions for trick card animations.
   */
  updatePlayPositions(screenWidth, screenHeight) {
    const scaleFactorX = screenWidth / 1920;
    const scaleFactorY = screenHeight / 953;
    const playOffsetX = 80 * scaleFactorX;
    const playOffsetY = 80 * scaleFactorY;

    this.playPositions = {
      opponent1: { x: screenWidth / 2 - playOffsetX, y: screenHeight / 2 },
      opponent2: { x: screenWidth / 2 + playOffsetX, y: screenHeight / 2 },
      partner: { x: screenWidth / 2, y: screenHeight / 2 - playOffsetY },
      self: { x: screenWidth / 2, y: screenHeight / 2 + playOffsetY },
    };
    this._emit('playPositionsUpdated', this.playPositions);
  }

  /**
   * Add a bid to tempBids history (for bore button state).
   */
  addTempBid(bid) {
    this.tempBids.push(String(bid).toUpperCase());
    this._emit('tempBidsChanged', this.tempBids);
  }

  /**
   * Clear tempBids (on new hand).
   */
  clearTempBids() {
    this.tempBids = [];
    this._emit('tempBidsChanged', this.tempBids);
  }

  /**
   * Add a rainbow position.
   */
  addRainbow(position) {
    this.rainbows.push(position);
    this._emit('rainbowAdded', position);
  }

  /**
   * Clear rainbows (after processing).
   */
  clearRainbows() {
    this.rainbows = [];
  }

  /**
   * Get rainbows and clear them.
   */
  consumeRainbows() {
    const rainbows = [...this.rainbows];
    this.rainbows = [];
    return rainbows;
  }

  /**
   * Set pending rejoin data (when scene isn't ready yet).
   */
  setPendingRejoinData(data) {
    this._pendingRejoinData = data;
  }

  /**
   * Get and clear pending rejoin data.
   */
  consumePendingRejoinData() {
    const data = this._pendingRejoinData;
    this._pendingRejoinData = null;
    return data;
  }

  /**
   * Set pending position data (when scene isn't ready yet).
   */
  setPendingPositionData(data) {
    this._pendingPositionData = data;
  }

  /**
   * Get and clear pending position data.
   */
  consumePendingPositionData() {
    const data = this._pendingPositionData;
    this._pendingPositionData = null;
    return data;
  }

  /**
   * Set pending game start data (when scene isn't ready yet).
   */
  setPendingGameStartData(data) {
    this._pendingGameStartData = data;
  }

  /**
   * Get and clear pending game start data.
   */
  consumePendingGameStartData() {
    const data = this._pendingGameStartData;
    this._pendingGameStartData = null;
    return data;
  }

  /**
   * Check if there's any pending data to process.
   */
  hasPendingData() {
    return !!(this._pendingRejoinData || this._pendingPositionData || this._pendingGameStartData);
  }

  /**
   * Reset state for a new hand within the same game.
   */
  resetForNewHand() {
    // Clear trick-related state
    this.playedCards = [];
    this.currentTrick = [];
    this.playedCardIndex = 0;
    this.leadCard = null;
    this.leadPosition = null;
    this.trumpBroken = false;

    // Clear bid state
    this.bids = {};
    this.teamBids = null;
    this.oppBids = null;
    this.isBidding = true;
    this.tempBids = [];

    // Clear trick counts
    this.teamTricks = 0;
    this.oppTricks = 0;
    this.teamTrickHistory = [];
    this.oppTrickHistory = [];

    // Clear UI flags
    this.hasPlayedCard = false;
    this.hasDrawn = false;
    this.clickedCardPosition = null;

    // Clear rainbows
    this.rainbows = [];

    this._emit('newHandReset');
  }

  // ============================================
  // Optimistic Updates
  // ============================================

  /**
   * Optimistically play a card (instant UI feedback).
   * Call confirmCardPlay() on success or rollbackCardPlay() on failure.
   *
   * @param {Object} card - Card to play
   * @returns {boolean} Whether card was found and removed
   */
  optimisticPlayCard(card) {
    const index = this.myCards.findIndex(
      (c) => c.suit === card.suit && c.rank === card.rank
    );

    if (index === -1) {
      return false;
    }

    // Store for potential rollback
    this._previousCards = [...this.myCards];
    this._pendingCard = card;

    // Remove card
    this.myCards.splice(index, 1);
    this._emit('handChanged', this.myCards);

    return true;
  }

  /**
   * Confirm optimistic card play was accepted.
   */
  confirmCardPlay() {
    this._pendingCard = null;
    this._previousCards = null;
  }

  /**
   * Rollback optimistic card play (server rejected).
   */
  rollbackCardPlay() {
    if (this._previousCards) {
      this.myCards = this._previousCards;
      this._previousCards = null;
      this._pendingCard = null;
      this._emit('handChanged', this.myCards);
      this._emit('cardPlayRolledBack');
    }
  }

  /**
   * Optimistically record a bid.
   */
  optimisticBid(bid) {
    this._pendingBid = bid;
  }

  /**
   * Confirm bid was accepted.
   */
  confirmBid() {
    if (this._pendingBid !== null) {
      this.recordBid(this.position, this._pendingBid);
      this._pendingBid = null;
    }
  }

  /**
   * Rollback bid (server rejected).
   */
  rollbackBid() {
    this._pendingBid = null;
    this._emit('bidRolledBack');
  }

  /**
   * Check if there's a pending action.
   */
  hasPendingAction() {
    return this._pendingCard !== null || this._pendingBid !== null;
  }

  // ============================================
  // Queries
  // ============================================

  /**
   * Check if it's this player's turn.
   */
  isMyTurn() {
    return this.currentTurn === this.position;
  }

  /**
   * Get partner's position.
   */
  getPartnerPosition() {
    return team(this.position);
  }

  /**
   * Check if a position is on my team.
   */
  isTeammate(position) {
    return team(this.position) === position;
  }

  /**
   * Check if player is leading this trick.
   */
  isLeading() {
    return this.playedCards.length === 0;
  }

  /**
   * Get number of cards played in current trick.
   */
  getCardsInTrick() {
    return this.playedCards.length;
  }

  /**
   * Restore state from rejoin data.
   */
  restoreFromRejoin(data) {
    this.gameId = data.gameId;
    this.position = data.position;
    this.currentHand = data.currentHand;
    this.trump = data.trump;
    this.trumpBroken = data.trumpBroken || false;
    this.dealer = data.dealer;
    this.isBidding = data.isBidding !== undefined ? data.isBidding : (data.bidding || false);
    this.currentTurn = data.currentTurn;

    if (data.hand) {
      this.setCards(data.hand);
    }

    if (data.bids) {
      this.bids = { ...data.bids };
      this._updateTeamBids();
    }

    if (data.teamTricks !== undefined) {
      this.teamTricks = data.teamTricks;
      this.oppTricks = data.oppTricks;
    }

    if (data.teamScore !== undefined) {
      this.teamScore = data.teamScore;
      this.oppScore = data.oppScore;
    }

    // Restore scores from alternate format (score.team1/team2)
    if (data.score) {
      if (this.position % 2 !== 0) {
        // Odd position: team1 is my team
        this.teamScore = data.score.team1;
        this.oppScore = data.score.team2;
      } else {
        // Even position: team2 is my team
        this.teamScore = data.score.team2;
        this.oppScore = data.score.team1;
      }
    }

    // Restore played cards in current trick
    if (data.playedCards && data.playedCards.length > 0) {
      this.playedCardIndex = 0;
      this.playedCards = [];
      this.currentTrick = [];
      this.leadCard = null;
      this.leadPosition = null;

      data.playedCards.forEach((card, index) => {
        if (card) {
          const cardPosition = index + 1; // Convert to 1-4 position
          if (!this.leadCard) {
            this.leadCard = card;
            this.leadPosition = cardPosition;
          }
          this.playedCards.push({ card, position: cardPosition });
          this.currentTrick.push({ card, position: cardPosition });
          this.playedCardIndex++;
        }
      });
    }

    // Restore player data if provided
    if (data.players) {
      this.setPlayerData({
        positions: data.players.map((p) => p.position),
        sockets: data.players.map((p) => p.socketId),
        usernames: data.players.map((p) => ({ username: p.username })),
        pics: data.players.map((p) => p.pic),
      });
    }

    this.phase = data.isBidding || data.bidding ? PHASE.BIDDING : PHASE.PLAYING;

    this._emit('stateRestored', data);
  }

  /**
   * Get serializable state snapshot (for debugging).
   */
  toJSON() {
    return {
      playerId: this.playerId,
      username: this.username,
      position: this.position,
      phase: this.phase,
      currentHand: this.currentHand,
      trump: this.trump,
      trumpBroken: this.trumpBroken,
      currentTurn: this.currentTurn,
      isBidding: this.isBidding,
      myCards: this.myCards.length,
      playedCards: this.playedCards.length,
      bids: this.bids,
      teamTricks: this.teamTricks,
      oppTricks: this.oppTricks,
      teamScore: this.teamScore,
      oppScore: this.oppScore,
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the GameState singleton.
 */
export function getGameState() {
  if (!instance) {
    instance = new GameState();
  }
  return instance;
}

/**
 * Reset the singleton (for testing or game restart).
 */
export function resetGameState() {
  if (instance) {
    instance.reset();
  } else {
    instance = new GameState();
  }
  return instance;
}

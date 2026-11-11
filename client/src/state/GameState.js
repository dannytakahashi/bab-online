/**
 * Client-side game state container with event emitter.
 *
 * The ONE writer of table state (roadmap item 16): the socket handlers
 * (handlers/gameHandlers.js) apply each server event through the apply*
 * methods below, and every snapshot (rejoin, restore, spectate, a rejected
 * action, a resync) through applySnapshot. The scene never writes here; it
 * renders renderModel() (GameScene.render) or animates one event from it.
 * A pending bid or play is not table state: state/MyAction.js holds it.
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
    this.resetSession();
  }

  /**
   * Forget the session identity too (sign-out, forceLogout, a failed
   * restore), then reset the per-game state.
   */
  resetSession() {
    // Session identity: survives reset() (game end, abort, /leave)
    this.username = null;
    this.tournamentId = null;
    // Final tournament results seen from the game-end screen
    this.pendingTournamentResults = null;
    this.reset();
  }

  /**
   * Reset the per-game state to initial values. The session identity
   * (username, tournamentId) is kept: a tournament host who finishes a game
   * is still the host, and lobby ready state matches by username.
   */
  reset() {
    // Clear all event listeners to prevent stale callbacks
    this._listeners.clear();

    // Seat identity (per game)
    this.playerId = null;
    this.position = null;
    this.pic = null;
    this.isSpectator = false;

    // Game info
    this.gameId = null;
    this.lobbyId = null;
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
    this.isLazy = false; // Whether bot is playing for us (lazy mode)

    // Draw phase state
    this.hasDrawn = false;
    this.clickedCardPosition = null; // Store position of clicked card for draw animation

    // Bid state
    this.tempBids = []; // Bid history for bore button state

    // HSI values for all players at hand start (position → HSI)
    this.hsiValues = {};

    // Sprite references (for external access during resize)
    this.opponentCardSprites = { partner: [], opp1: [], opp2: [] };
    this.tableCardSprite = null;

    // Active chat bubbles by position key
    this.activeChatBubbles = {};

    // Rainbow positions received during bidding
    this.rainbows = [];

    // Table model (snapshot v2 shaped, kept by the appliers below)
    this.stage = null; // server stage name (v2), or derived from events
    this.handNo = 0;
    this.dealSeq = null; // the server's deal number (snapshot.deal.dealSeq; +1 per gameStart)
    this.trickNo = 0; // 1-based number of the trick in play
    this.seatCards = { 1: 0, 2: 0, 3: 0, 4: 0 }; // cards left per seat
    // Completed tricks of this hand, in order: [{winner, cards: [{position, card}]}].
    // Tricks a snapshot only counted are {winner: null, team: 1|2, cards: null}
    // (face-down stacks); tricks won after it keep their cards (face up)
    this.trickHistory = [];
    this.seats = []; // snapshot v2 seat records, when known
    this.resume = null;
    this._redealPending = false;
    // Bumped by every applied change (renderers compare it)
    this.version = 0;

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
    this.trickHistory = [];

    // The hand is over: nothing left to hold or play
    this.myCards = [];
    this._setHandSizeForAll(0);
    this.version++;

    // Clear UI flags
    this.hasPlayedCard = false;
    this.hasDrawn = false;
    this.clickedCardPosition = null;

    // Clear rainbows
    this.rainbows = [];

    this._emit('newHandReset');
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

  // ============================================
  // Event appliers (the socket handlers' only way in)
  // ============================================

  _changed() {
    this.version++;
  }

  /** The viewer's team is team 1 (seats 1/3; a spectator views from seat 1). */
  _myTeamIsOne() {
    return (this.position || 1) % 2 !== 0;
  }

  /** Team (1: seats 1/3, 2: seats 2/4) of a trick history entry. */
  static _trickTeam(t) {
    return t.team ?? (t.winner % 2 !== 0 ? 1 : 2);
  }

  /** Whether a kept history has exactly the snapshot's per-team trick counts. */
  _historyMatches(history, tricks) {
    if (!Array.isArray(history)) return false;
    const n1 = history.filter((t) => GameState._trickTeam(t) === 1).length;
    return n1 === (tricks?.team1 || 0) && history.length - n1 === (tricks?.team2 || 0);
  }

  /**
   * A snapshot's trickHistory ({winner, lead, cards in play order}) as the
   * history entries applyTrickComplete keeps ({winner, cards: [{position,
   * card}]}); null when the snapshot has none (an older server).
   */
  static _historyFromSnapshot(history) {
    if (!Array.isArray(history)) return null;
    return history.map((t) => ({
      winner: t.winner,
      cards: t.cards.map((card, k) => ({ position: ((t.lead - 1 + k) % 4) + 1, card: { suit: card.suit, rank: card.rank } })),
    }));
  }

  /** A snapshot's counted tricks, cards unknown: one entry per trick, by team. */
  static _unknownTricks(tricks) {
    const unknown = (team, n) => Array.from({ length: n }, () => ({ winner: null, team, cards: null }));
    return [...unknown(1, tricks?.team1 || 0), ...unknown(2, tricks?.team2 || 0)];
  }

  /** Per-team values {team1, team2} as [mine, theirs]. */
  _mine(pair) {
    if (!pair) return [0, 0];
    return this._myTeamIsOne() ? [pair.team1 || 0, pair.team2 || 0] : [pair.team2 || 0, pair.team1 || 0];
  }

  _setHandSizeForAll(n) {
    this.seatCards = { 1: n, 2: n, 3: n, 4: n };
  }

  _clearTrickState() {
    this.playedCards = [];
    this.currentTrick = [];
    this.playedCardIndex = 0;
    this.leadCard = null;
    this.leadPosition = null;
    this.hasPlayedCard = false;
  }

  /** gameStart: a new deal (a zero-bid redeal keeps the hand number). */
  applyDeal(data) {
    if (data.position) this.position = data.position;
    if (data.gameId) this.gameId = data.gameId;
    this.currentHand = data.currentHand ?? (data.hand?.length || 0);
    if (data.dealer !== undefined) this.dealer = data.dealer;
    if (!this._redealPending || !this.handNo) this.handNo = (this.handNo || 0) + 1;
    this._redealPending = false;
    // The server's deal number (snapshot deal.dealSeq): +1 per deal, a
    // redeal included (not the gameStart's seq)
    this.dealSeq = (this.dealSeq || 0) + 1;
    this.trump = data.trump || null;
    this.trumpBroken = false;
    this.myCards = Array.isArray(data.hand) ? [...data.hand] : [];
    this.isBidding = true;
    this.phase = PHASE.BIDDING;
    this.stage = 'BIDDING';
    this.currentTurn = null;
    this.bids = {};
    this.teamBids = null;
    this.oppBids = null;
    this.tempBids = [];
    this.team1Mult = 1;
    this.team2Mult = 1;
    this._clearTrickState();
    this.trickNo = 1;
    this.teamTricks = 0;
    this.oppTricks = 0;
    this.trickHistory = [];
    this.rainbows = [];
    this._setHandSizeForAll(this.currentHand);
    if (data.hsiValues) this.hsiValues = { ...data.hsiValues };
    if (data.score1 !== undefined && data.score2 !== undefined) {
      const [mine, theirs] = this._mine({ team1: data.score1, team2: data.score2 });
      this.teamScore = mine;
      this.oppScore = theirs;
    }
    if (Array.isArray(data.playerInfo) && data.playerInfo.length) {
      this.setPlayerData({
        positions: data.playerInfo.map((p) => p.position),
        sockets: data.players,
        usernames: data.playerInfo.map((p) => ({ username: p.username })),
        pics: data.playerInfo.map((p) => p.pic),
      });
    } else if (this.position) {
      this._updatePlayerNames();
    }
    this._changed();
    this._emit('handChanged', this.myCards);
  }

  /** bidReceived */
  applyBid(data) {
    if (data.position === undefined || data.bid === undefined) return;
    const bid = String(data.bid).toUpperCase();
    this.bids[data.position] = bid;
    this._updateTeamBids();
    this.tempBids.push(bid);
    if (data.team1Mult !== undefined) this.team1Mult = data.team1Mult;
    if (data.team2Mult !== undefined) this.team2Mult = data.team2Mult;
    this._changed();
    this._emit('bidReceived', { position: data.position, bid });
  }

  /** doneBidding: play opens at the lead. */
  applyDoneBidding(data) {
    this.isBidding = false;
    this.phase = PHASE.PLAYING;
    this.stage = 'PLAYING';
    this._clearTrickState();
    this.trumpBroken = false;
    this.trickNo = 1;
    this.tempBids = [];
    if (Array.isArray(data.bids)) {
      data.bids.forEach((b, i) => {
        if (b !== undefined && b !== null) this.bids[i + 1] = String(b).toUpperCase();
      });
      this._updateTeamBids();
    }
    if (data.lead !== undefined) this.currentTurn = data.lead;
    this._changed();
  }

  /** updateTurn */
  applyTurn(data) {
    const turn = data.currentTurn ?? data.turn;
    if (turn !== undefined) this.currentTurn = turn;
    this.hasPlayedCard = false;
    if (this.stage === 'TRICK_RESOLVING' || this.stage === 'DEALING') this.stage = this.isBidding ? 'BIDDING' : 'PLAYING';
    this._changed();
    this._emit('turnChanged', this.currentTurn);
  }

  /** cardPlayed (mine included: the card leaves my hand only now). */
  applyCardPlayed(data) {
    const { card, position } = data;
    if (!card || !position) return;
    if (this.playedCards.length >= 4) this._clearTrickState();
    if (this.playedCards.length === 0) {
      this.leadCard = card;
      this.leadPosition = position;
    }
    if (data.trump !== undefined) this.trumpBroken = !!data.trump;
    if (data.trumpBroken !== undefined) this.trumpBroken = !!data.trumpBroken;
    this.playedCards.push({ card, position });
    this.currentTrick.push({ card, position });
    this.playedCardIndex = this.playedCards.length % 4;
    if (this.seatCards[position] > 0) this.seatCards[position]--;
    if (position === this.position && !this.isSpectator) {
      const i = this.myCards.findIndex((c) => c.suit === card.suit && c.rank === card.rank);
      if (i !== -1) this.myCards.splice(i, 1);
      this.hasPlayedCard = true;
      this._emit('handChanged', this.myCards);
    }
    if (this.playedCards.length === 4) {
      this.stage = 'TRICK_RESOLVING';
      this.currentTurn = null;
    }
    this._changed();
    this._emit('cardPlayed', { card, position, playedCardIndex: this.playedCardIndex });
  }

  /** trickComplete: count it (cli-8: here, not in the scene) and open the next trick. */
  applyTrickComplete(data) {
    const winner = data.winner;
    const mineTeam = winner % 2 === (this.position || 1) % 2;
    if (mineTeam) this.teamTricks++;
    else this.oppTricks++;
    if (Array.isArray(this.trickHistory)) {
      this.trickHistory.push({ winner, cards: this.playedCards.map((p) => ({ position: p.position, card: p.card })) });
    }
    this._clearTrickState();
    this.trickNo = (this.trickNo || 1) + 1;
    // A hand's last trick carries resumeInMs: the hand resolves next
    this.stage = data.resumeInMs !== undefined ? 'HAND_RESOLVING' : 'PLAYING';
    this._changed();
    this._emit('trickScoresChanged', { teamTricks: this.teamTricks, oppTricks: this.oppTricks });
  }

  /** handComplete: the scores (the hand's bids and tricks reset with resetForNewHand). */
  applyHandComplete(data) {
    if (data.score) {
      const [mine, theirs] = this._mine(data.score);
      this.setGameScores(mine, theirs);
    }
    this.stage = 'HAND_RESOLVING';
    this._changed();
  }

  /** destroyHands: the all-zero redeal (its gameStart deals the same hand again). */
  applyDestroyHands() {
    this.myCards = [];
    this.bids = {};
    this.teamBids = null;
    this.oppBids = null;
    this.tempBids = [];
    this._clearTrickState();
    this._setHandSizeForAll(0);
    this._redealPending = true;
    this.stage = 'REDEAL';
    this._changed();
  }

  /** gameEnd */
  applyGameEnd(data) {
    if (data?.score) {
      const [mine, theirs] = this._mine(data.score);
      this.teamScore = mine;
      this.oppScore = theirs;
    }
    this.stage = 'ENDED';
    this.setPhase(PHASE.ENDED);
    this._changed();
  }

  /** playerLazyMode / playerActiveMode for my seat. */
  applyMyLazy(isLazy) {
    this.isLazy = !!isLazy;
    this._changed();
  }

  /**
   * Who a seat shows (playerLazyMode / playerResigned: the bot;
   * playerActiveMode: the owner again). playerData is what render() draws
   * the avatars from, so a re-render shows the seat as it is now, as a
   * fresh snapshot of it would.
   * @param {number} position
   * @param {Object} display - {username, pic}
   */
  applySeatDisplay(position, { username, pic } = {}) {
    if (!position || !username || !this.playerData?.position) return;
    const i = this.playerData.position.indexOf(position);
    if (i === -1) return;
    const names = [...(this.playerData.username || [])];
    const prev = names[i];
    names[i] = prev && typeof prev === 'object' ? { ...prev, username } : { username };
    const pics = [...(this.playerData.pics || [])];
    pics[i] = pic ?? null;
    this.playerData = { ...this.playerData, username: names, pics };
    if (this.players) this.players = { ...this.players, [position]: { username, pic: pic ?? null } };
    const seat = this.seats.find((s) => s.position === position);
    if (seat) seat.username = username;
    if (this.position) this._updatePlayerNames();
    this._changed();
  }

  // ============================================
  // Snapshots (the only restore path)
  // ============================================

  /**
   * Replace the table with a snapshot v2 (parsed, or snapshotFromLegacy of a
   * v1 payload). Kept: the session identity and the game log (main.js).
   * Won tricks: the snapshot's trickHistory (their cards: drawn face up as
   * before a reload), else the history this same deal already has when it
   * agrees on the per-team counts, else face-down placeholders (counts
   * only: an older server, a v1 payload).
   * @param {Object} snap
   * @param {Object} [opts]
   * @param {Array} [opts.players] - the v1 payload's players[] (pictures already folded)
   */
  applySnapshot(snap, { players = null } = {}) {
    if (!snap) return;
    const role = snap.viewer?.role || 'none';
    const sameDeal = snap.gameId === this.gameId && !!snap.deal && snap.deal.handNo === this.handNo &&
      (snap.deal.dealSeq ?? null) === (this.dealSeq ?? null);
    const prevHistory = this.trickHistory;

    if (snap.gameId) this.gameId = snap.gameId;
    this.stage = snap.stage || null;
    this.isSpectator = role === 'spectator';
    this.isLazy = role === 'lazyWatcher';
    if (snap.viewer?.position) this.position = snap.viewer.position;
    else if (this.isSpectator) this.position = 1;

    this._seatsToPlayerData(snap.seats || [], players);
    this.seats = Array.isArray(snap.seats) ? snap.seats.map((s) => ({ ...s })) : [];

    const deal = snap.deal;
    this.handNo = deal ? (deal.handNo || this.handNo || 1) : 0;
    this.dealSeq = deal ? (deal.dealSeq ?? null) : null;
    this.currentHand = deal?.handSize || 0;
    this.dealer = deal?.dealer ?? null;
    this._redealPending = snap.stage === 'REDEAL';

    this.trump = snap.trump || null;
    this.trumpBroken = !!snap.trumpBroken;
    this.myCards = Array.isArray(snap.hand) ? snap.hand.map((c) => ({ suit: c.suit, rank: c.rank })) : [];
    this.currentTurn = snap.turn?.position ?? null;
    this.isBidding = ['DEALING', 'BIDDING', 'REDEAL'].includes(snap.stage);
    if (deal) this.phase = this.isBidding ? PHASE.BIDDING : PHASE.PLAYING;
    else if (['CREATED', 'DRAWING', 'DRAW_RESOLVING'].includes(snap.stage)) this.phase = PHASE.DRAW;

    this.bids = {};
    const byPos = snap.bids?.byPosition || [];
    byPos.forEach((b, i) => {
      if (b !== null && b !== undefined) this.bids[i + 1] = String(b).toUpperCase();
    });
    if (Object.keys(this.bids).length) {
      this._updateTeamBids();
    } else {
      this.teamBids = null;
      this.oppBids = null;
    }
    const order = Array.isArray(snap.bids?.order) && snap.bids.order.length ? snap.bids.order : [1, 2, 3, 4];
    this.tempBids = this.isBidding ? order.map((p) => this.bids[p]).filter((b) => b !== undefined) : [];
    this.team1Mult = snap.bids?.mults?.team1 || 1;
    this.team2Mult = snap.bids?.mults?.team2 || 1;

    this._clearTrickState();
    const cards = Array.isArray(snap.trick?.cards) ? snap.trick.cards : [];
    for (const c of cards) {
      this.playedCards.push({ card: { ...c.card }, position: c.position });
      this.currentTrick.push({ card: { ...c.card }, position: c.position });
    }
    this.playedCardIndex = this.playedCards.length % 4;
    if (cards.length) {
      this.leadPosition = snap.trick.leadPosition ?? cards[0].position;
      this.leadCard = { ...cards[0].card };
    }
    this.hasPlayedCard = !this.isSpectator && !!this.position && cards.some((c) => c.position === this.position);

    const [teamTricks, oppTricks] = this._mine(snap.tricks);
    this.teamTricks = teamTricks;
    this.oppTricks = oppTricks;
    const total = teamTricks + oppTricks;
    this.trickNo = snap.trick?.number || (deal ? (this.isBidding ? 1 : total + 1) : 0);
    const served = GameState._historyFromSnapshot(snap.trickHistory);
    if (served && this._historyMatches(served, snap.tricks)) this.trickHistory = served;
    else if (sameDeal && this._historyMatches(prevHistory, snap.tricks)) this.trickHistory = prevHistory;
    else this.trickHistory = GameState._unknownTricks(snap.tricks);

    const [teamScore, oppScore] = this._mine(snap.score);
    this.teamScore = teamScore;
    this.oppScore = oppScore;
    const [teamRainbows, oppRainbows] = this._mine(snap.rainbows);
    this.teamRainbows = teamRainbows;
    this.oppRainbows = oppRainbows;

    this.hsiValues = {};
    if (Array.isArray(snap.hsi)) snap.hsi.forEach((v, i) => { if (typeof v === 'number') this.hsiValues[i + 1] = v; });

    this.seatCards = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const s of this.seats) this.seatCards[s.position] = s.cardsInHand || 0;
    this.resume = snap.resume || null;
    this._changed();
    this._emit('stateRestored', snap);
  }

  /** playerData (names, pictures) from the snapshot's seats; a v1 players[] wins for pictures. */
  _seatsToPlayerData(seats, players) {
    if (Array.isArray(players) && players.length) {
      this.setPlayerData({
        position: players.map((p) => p.position),
        sockets: players.map((p) => p.socketId),
        username: players.map((p) => ({ username: p.username, socketId: p.socketId })),
        pics: players.map((p) => p.pic),
      });
      return;
    }
    if (!Array.isArray(seats) || seats.length !== 4) {
      if (this.position && this.playerData) this._updatePlayerNames();
      return;
    }
    // A custom picture already held for the same username stays (gap
    // snapshots carry none: partial 'customPics')
    const held = {};
    if (this.playerData?.position) {
      this.playerData.position.forEach((pos, i) => {
        const name = this.playerData.username?.[i]?.username || this.playerData.username?.[i];
        if (name) held[name] = this.playerData.pics?.[i];
      });
    }
    const picFor = (s) => {
      if (s.avatarUrl) return s.avatarUrl;
      if (s.customPic) return s.customPic;
      if (s.hasCustomPic && typeof held[s.username] === 'string') return held[s.username];
      return s.pic ?? held[s.username] ?? null;
    };
    const oldSockets = this.playerData?.position
      ? Object.fromEntries(this.playerData.position.map((pos, i) => [pos, this.playerData.socket?.[i] ?? null]))
      : {};
    this.setPlayerData({
      position: seats.map((s) => s.position),
      sockets: seats.map((s) => oldSockets[s.position] ?? null),
      username: seats.map((s) => ({ username: s.username })),
      pics: seats.map(picFor),
    });
  }

  /**
   * The table as the scene draws it (snapshot v2 shaped). `pendingCard`:
   * my play in flight (MyAction): out of the hand, at my trick slot.
   */
  renderModel({ pendingCard = null, pendingBid = false } = {}) {
    const role = this.isSpectator ? 'spectator' : (this.isLazy ? 'lazyWatcher' : 'seat');
    const position = this.position || (this.isSpectator ? 1 : null);
    const same = (a, b) => a && b && a.suit === b.suit && a.rank === b.rank;
    const hand = this.isSpectator ? null : [...this.myCards];
    const trick = this.playedCards.map((p) => ({ position: p.position, card: { ...p.card } }));
    if (pendingCard && hand && !trick.some((c) => c.position === position)) {
      const i = hand.findIndex((c) => same(c, pendingCard));
      if (i !== -1) {
        hand.splice(i, 1);
        trick.push({ position, card: { ...pendingCard }, pending: true });
      }
    }
    const live = !!this.trump && this.handNo > 0 && !['ENDED', 'ABORTED'].includes(this.stage);
    const seatCards = { ...this.seatCards };
    if (hand && position) seatCards[position] = hand.length;
    return {
      gameId: this.gameId,
      stage: this.stage,
      live,
      viewer: { role, position, canAct: this.canAct({ pending: !!pendingCard || pendingBid }) },
      hand,
      handSize: this.currentHand,
      handNo: this.handNo,
      dealSeq: this.dealSeq,
      trickNo: this.trickNo,
      dealer: this.dealer,
      trump: this.trump,
      trumpBroken: this.trumpBroken,
      turn: this.currentTurn,
      isBidding: this.isBidding,
      bids: { ...this.bids },
      trick,
      leadPosition: this.leadPosition,
      tricks: { team: this.teamTricks, opp: this.oppTricks },
      history: Array.isArray(this.trickHistory)
        ? this.trickHistory.map((t) => ({ winner: t.winner, team: GameState._trickTeam(t), cards: t.cards ? t.cards.map((c) => ({ ...c })) : null }))
        : null,
      seatCards,
      score: { team: this.teamScore, opp: this.oppScore },
      hsi: position ? this.hsiValues[position] : undefined,
      playerData: this.playerData,
    };
  }

  /** My seat may bid / play now (and no action of mine is pending). */
  canAct({ pending = false } = {}) {
    if (pending || this.isSpectator || this.isLazy || !this.position) return false;
    if (this.currentTurn !== this.position) return false;
    if (this.stage && !['BIDDING', 'PLAYING'].includes(this.stage)) return false;
    if (this.isBidding) return this.bids[this.position] === undefined;
    return !this.hasPlayedCard;
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

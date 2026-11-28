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

import { team, seatsAround } from '../utils/positions.js';
import { gybForbidden } from '../rules/bids.js';
import { parseWatching } from './snapshotV2.js';
import { bidClockNow, clockFrom, parseBidClockEvent } from './bidClock.js';
import { isShoulder, validShoulder } from './shoulder.js';
import { helpNoticeSeat, tutorialTag } from './seatBadges.js';
import { teamPlayerDataOf } from './teamPlayerData.js';
import { parseRows, mergeRow, validRow } from './scorecard.js';
import { HAND_PROGRESSION } from '../constants/ranks.js';

export { teamPlayerDataOf };

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
    // Who-is-here observers (voice/voiceCompany.js): kept across reset(),
    // unlike _listeners, since the page's voice rule outlives every table
    this._companyObservers = new Set();
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

    // The game mode: null (the base game) or 'gyb', a Get Your Bid table
    // (owner 2026-11-24: three seats, no teams). Told by the lobby's start
    // (allPlayersReady.mode, setMode), each deal (gameStart.gyb) and the
    // `gyb` key beside every snapshot. At such a table `gyb` holds what the
    // team fields below cannot: each seat's score and exact bids (by
    // position - 1), the hands counted, the last hand's result
    // (handComplete.gyb) and the game's (gameEnd.gyb)
    this.mode = null;
    this.gyb = null;

    // The scorecard (owner 2026-11-27; state/scorecard.js): the server's
    // rows of this game's completed hands, or null while the server has
    // sent none (an older server: no Scorecard tab, no score-bar hint).
    // [] from the first deal's gameStart.scorecardRows; a handComplete
    // appends its scorecardRow; a snapshot or gameEnd brings them all
    this.scorecard = null;

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
    // The draw for deal so far (snapshot v2 `draw` shaped: {drawn: [{drawOrder,
    // username, card}], viewerDrawOrder}), from startDraw / playerDrew /
    // youDrew or a snapshot; null outside the draw. render() draws it.
    this.draw = null;

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
    // Tricks each seat won this hand ({1..4}; snapshot tricksByPosition):
    // null for both seats of a team whose winners are not known (a v1
    // snapshot that only counted the team's tricks); the seat pips then
    // show that team's count (ui/seatPlates.js)
    this.tricksByPosition = GameState._noSeatTricks();
    this.seats = []; // snapshot v2 seat records, when known
    // Who owns each seat ({1..4} -> username): set at seating and by every
    // snapshot (seat ownerUsername), never by a bot taking the seat over
    // (playerData shows the bot then). Voice maps a speaking peer to its
    // seat by it (voice/speakingSlot.js), so a lazy owner still lights up
    this.seatOwners = {};
    // Who is watching (spectatorsUpdated / snapshot.watching): the badge
    this.watching = { spectators: [], count: 0 };
    // The human seat owners for the voice rule (owner 2026-11-19: voice only
    // with another human; voice/voiceCompany.js): {1..4} -> owner username of
    // a seat that is not a native bot and whose owner is not gone (a lazy,
    // resigned, disconnected owner still counts). Set at seating
    // (positionUpdate.isBot) and by every snapshot (seats[].presence); a
    // seatLeft drops one. Before seating, a snapshot's human entrants not
    // left. humansKnown: seating or a snapshot said who is here
    this.humanOwners = {};
    this.entrantHumans = [];
    this.humansKnown = false;
    // A seat played by a native bot (controller 'bot': a lobby's Add Bot, a
    // tournament filler, a solo game; never a lazy or resign bot, which is a
    // human's seat): set at seating (positionUpdate.nativeBot; never isBot
    // alone, which a draw-phase leaver's resign bot has too) and by every
    // snapshot with seats (seats[].controller). Such a game has no /help
    // limit and shows none (state/assistHint.js helpIsUnlimited; server
    // assistState.isFreeHelpGame); native bots never leave, so within a game
    // it only turns true
    this.nativeBotSeat = false;
    this.resume = null;
    // A seat's running bid clock (bidClock / snapshot bidClock; state/bidClock.js):
    // {position, deadline (bidClockNow ms), durationMs} or null
    this.bidClock = null;
    // The avatar badges (state/seatBadges.js): {1..4} -> true. helpAsked: a
    // counted /help on that seat's open turn (the lightbulb; the live help
    // notice, until it bids or plays, or a snapshot's seats[].askedHelp);
    // tutorialSeats: its owner's tutorial is on (the graduation cap; the
    // live tutorial tag, or a snapshot's seats[].tutorial)
    this.helpAsked = {};
    this.tutorialSeats = {};
    // The over-the-shoulder view (state/shoulder.js): the seat a pure
    // spectator watches {position, paused}, or null (the plain table view).
    // While set, position is that seat (the table is drawn from it), myCards
    // its hand and hsiValues its HSI; isSpectator stays true (nothing acts).
    // shoulderHold: the seat kept while the table is paused (ShoulderWatch):
    // a snapshot without viewer.shoulder keeps it, its hand area paused
    this.shoulder = null;
    this.shoulderHold = null;
    // A tournament table (snapshot `tournament`): no shoulder view there
    this.tournamentTable = false;
    this._redealPending = false;
    // Bumped by every applied change (renderers compare it)
    this.version = 0;

    this._emit('reset');
    this._companyChanged();
  }

  // ============================================
  // Game mode (Get Your Bid)
  // ============================================

  /** Seats at this table: 4, or 3 at a Get Your Bid table. */
  get seatCount() {
    return this.mode === 'gyb' ? 3 : 4;
  }

  /** No teams (Get Your Bid): every other seat is an opponent. */
  get isSolo() {
    return this.mode === 'gyb';
  }

  /**
   * This game's mode: 'gyb' (a Get Your Bid table), anything else the base
   * game. Keeps the scores it already has for the same mode.
   */
  setMode(mode) {
    const next = mode === 'gyb' ? 'gyb' : null;
    if (next === this.mode) return;
    this.mode = next;
    this.gyb = next ? { scores: [0, 0, 0], made: [0, 0, 0], hands: 0, last: null, end: null } : null;
    if (this.position) this._updatePlayerNames();
    this._changed();
  }

  /** What a `gyb` payload says of the game so far (scores, exact bids, hands). */
  _applyGybTotals(g) {
    if (!g || typeof g !== 'object') return;
    this.setMode('gyb');
    const three = (a) => Array.isArray(a) && a.length === 3 && a.every((n) => Number.isFinite(n));
    if (three(g.scores)) this.gyb.scores = [...g.scores];
    if (three(g.made)) this.gyb.made = [...g.made];
    if (Number.isInteger(g.hands)) this.gyb.hands = g.hands;
    this._syncSoloScores();
  }

  /** At a Get Your Bid table teamScore is my seat's score and oppScore the best of the others. */
  _syncSoloScores() {
    if (!this.gyb) return;
    const me = this.position || 1;
    const others = this.gyb.scores.filter((_, i) => i + 1 !== me);
    this.teamScore = this.gyb.scores[me - 1] || 0;
    this.oppScore = others.length ? Math.max(...others) : 0;
  }

  /** At a Get Your Bid table teamTricks is my seat's tricks and oppTricks the others'. */
  _syncSoloTricks() {
    if (!this.isSolo) return;
    const me = this.position || 1;
    const by = this.tricksByPosition || {};
    let mine = 0;
    let theirs = 0;
    for (let p = 1; p <= 3; p++) {
      if (p === me) mine += by[p] || 0;
      else theirs += by[p] || 0;
    }
    this.teamTricks = mine;
    this.oppTricks = theirs;
  }

  /**
   * This deal's Forbidden Bid at a Get Your Bid table (rules/bids.js
   * gybForbidden; the server's GameState.gybForbidden): {position, bid} for
   * the last bidder (the dealer) once the other two have bid, on a hand of
   * 5 or more cards; else null.
   */
  gybForbidden() {
    return this.isSolo ? gybForbidden(this.bids, this.dealer, this.currentHand) : null;
  }

  // ============================================
  // Who is here (the voice rule)
  // ============================================

  /**
   * Observe changes of who is at this table (seat owners, entrants,
   * spectators, a reset). Survives reset().
   * @param {Function} fn
   * @returns {Function} unsubscribe
   */
  onCompanyChange(fn) {
    this._companyObservers.add(fn);
    return () => this._companyObservers.delete(fn);
  }

  _companyChanged() {
    if (!this._companyObservers) return;
    for (const fn of [...this._companyObservers]) {
      try {
        fn();
      } catch (err) {
        console.error('Error in company observer:', err);
      }
    }
  }

  /**
   * The other humans at this table (owner 2026-11-19, voice/voiceCompany.js):
   * human seat owners not gone (before seating: human entrants not left)
   * and the spectators, without my own name.
   * @param {{spectators?: boolean}} [opts] spectators false: the watchers
   *   do not count (a table with no casual voice, e.g. a tournament table,
   *   never admits a spectator into voice)
   * @returns {{known: boolean, names: Set<string>}} known: seating or a
   *   snapshot said who sits here (else only the spectators are known)
   */
  otherHumans({ spectators = true } = {}) {
    const names = new Set();
    for (const n of Object.values(this.humanOwners)) if (n) names.add(n);
    for (const n of this.entrantHumans) names.add(n);
    if (spectators) for (const w of this.watching?.spectators || []) if (w?.username) names.add(w.username);
    if (this.username) names.delete(this.username);
    return { known: this.humansKnown, names };
  }

  /**
   * seatLeft {gameId, position, username} (unsequenced, additive
   * 2026-11-19): that seat's owner left for good; another game's is ignored.
   * @returns {boolean} whether it was applied
   */
  applySeatLeft(data) {
    if (!data || !data.position || (data.gameId && this.gameId && data.gameId !== this.gameId)) return false;
    const pos = data.position;
    if (!(pos in this.humanOwners)) return false;
    if (data.username && this.humanOwners[pos] !== data.username) return false;
    delete this.humanOwners[pos];
    this.seats = this.seats.map((st) => (st.position === pos ? { ...st, presence: 'gone' } : st));
    this._changed();
    this._companyChanged();
    return true;
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
    if (gameId && this.gameId && gameId !== this.gameId) this.watching = { spectators: [], count: 0 };
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
    if (this.isSolo) {
      // no teams: my own bid, and the other two seats'
      const { opp1, opp2 } = seatsAround(this.position || 1, 3);
      this.teamBids = `${this.bids[this.position || 1] ?? '-'}`;
      this.oppBids = `${this.bids[opp1] ?? '-'}/${this.bids[opp2] ?? '-'}`;
      return;
    }
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

    // Partner (position +/- 2; none at a three-seat table)
    const around = seatsAround(this.position, this.seatCount);
    const partnerPos = around.partner;
    const partnerIdx = partnerPos ? this.playerData.position.indexOf(partnerPos) : -1;
    this.partnerName = partnerIdx !== -1
      ? (this.playerData.username[partnerIdx]?.username || this.playerData.username[partnerIdx])
      : (this.isSolo ? null : 'Partner');

    // Opponent 1 (next position clockwise)
    const opp1Pos = around.opp1;
    const opp1Idx = this.playerData.position.indexOf(opp1Pos);
    this.opp1Name = opp1Idx !== -1
      ? (this.playerData.username[opp1Idx]?.username || this.playerData.username[opp1Idx])
      : 'Opp1';

    // Opponent 2 (previous position clockwise)
    const opp2Pos = around.opp2;
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
   * A seat's player by the owner rule (owner 2026-11-25, people by player
   * names; iOS PlayersSlice.ownerName): a lazy or resigned seat's owner,
   * never the bot playing it (seatOwners), else the name the seat shows (a
   * native bot's persona). The per-seat labels read it: the watching pill and
   * its paused line, the seat-eye chip and seat badge, the spectator badge's
   * "watching <player>" rows, the watched seat's hints and its read-only bid
   * sheet. The avatars, their plates, a seat's profile and the log and
   * announcer lines of who played ("X bid N", "X won the trick") keep
   * getPlayerNameByPosition: they show who is playing.
   */
  getSeatOwnerName(pos) {
    const owner = this.seatOwners?.[pos];
    return typeof owner === 'string' && owner ? owner : this.getPlayerNameByPosition(pos);
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
   * The draw opens (startDraw): nobody has drawn. `teams`: a tournament
   * table's planned teams (startDraw.teams, already checked: ui/drawCopy
   * validTeams), so the draw is for first deal; null at a casual table.
   */
  beginDraw(teams = null) {
    this.draw = { drawn: [], viewerDrawOrder: null, teams: teams || null };
    this.setHasDrawn(false);
  }

  /** A draw (playerDrew), once per draw order. @returns {boolean} whether it was a new draw */
  applyPlayerDrew(data) {
    const order = Number(data?.drawOrder);
    if (!data?.username || !(order >= 1 && order <= 4)) return false;
    if (!this.draw) this.draw = { drawn: [], viewerDrawOrder: null, teams: null };
    if (this.draw.drawn.some((d) => d.drawOrder === order)) return false;
    this.draw.drawn.push({ drawOrder: order, username: data.username, card: data.card ? { suit: data.card.suit, rank: data.card.rank } : null });
    this.draw.drawn.sort((a, b) => a.drawOrder - b.drawOrder);
    return true;
  }

  /** My own draw (youDrew; the auto-draw sends it too). */
  applyYouDrew(data) {
    if (!this.draw) this.draw = { drawn: [], viewerDrawOrder: null, teams: null };
    if (data?.drawOrder) this.draw.viewerDrawOrder = data.drawOrder;
    this.setHasDrawn(true);
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
    this.tricksByPosition = GameState._noSeatTricks();

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
    this.bidClock = null;
    this.helpAsked = {};

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
    return this.isSolo ? null : team(this.position);
  }

  /**
   * Check if a position is on my team.
   */
  isTeammate(position) {
    return !this.isSolo && team(this.position) === position;
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
  static _historyFromSnapshot(history, seats = 4) {
    if (!Array.isArray(history)) return null;
    return history.map((t) => ({
      winner: t.winner,
      cards: t.cards.map((card, k) => ({ position: ((t.lead - 1 + k) % seats) + 1, card: { suit: card.suit, rank: card.rank } })),
    }));
  }

  /** A snapshot's counted tricks, cards unknown: one entry per trick, by team. */
  static _unknownTricks(tricks) {
    const unknown = (team, n) => Array.from({ length: n }, () => ({ winner: null, team, cards: null }));
    return [...unknown(1, tricks?.team1 || 0), ...unknown(2, tricks?.team2 || 0)];
  }

  /** Every seat at 0 tricks (a new hand). */
  static _noSeatTricks() {
    return { 1: 0, 2: 0, 3: 0, 4: 0 };
  }

  /**
   * Each seat's tricks for a snapshot, per team: the snapshot's
   * tricksByPosition when that team's two seats add up to its count (it is
   * the server's game.handTricks: authoritative; a v1 payload's zeros only
   * agree with a team that has none), else the winners in `history` when
   * every one of that team's tricks has a known winner, else null for both
   * seats (unknown: the pips show the team's count).
   */
  static _seatTricksFor(snap, history) {
    const out = {};
    const byPos = Array.isArray(snap.tricksByPosition) && snap.tricksByPosition.length === 4 &&
      snap.tricksByPosition.every((n) => Number.isInteger(n) && n >= 0)
      ? snap.tricksByPosition : null;
    for (const [teamNo, seats] of [[1, [1, 3]], [2, [2, 4]]]) {
      const count = snap.tricks?.[`team${teamNo}`] || 0;
      if (byPos && byPos[seats[0] - 1] + byPos[seats[1] - 1] === count) {
        for (const p of seats) out[p] = byPos[p - 1];
        continue;
      }
      const mine = (Array.isArray(history) ? history : []).filter((t) => GameState._trickTeam(t) === teamNo);
      const known = mine.length === count && mine.every((t) => seats.includes(t.winner));
      for (const p of seats) out[p] = known ? mine.filter((t) => t.winner === p).length : null;
    }
    return out;
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
    // the scorecard: a deal says how many rows the server has (its presence
    // is the feature); another game's deal starts a new card
    const otherGame = !!data.gameId && !!this.gameId && data.gameId !== this.gameId;
    if (otherGame) this.scorecard = null;
    if (Number.isInteger(data.scorecardRows)) {
      if (!this.scorecard) this.scorecard = [];
      // fewer rows here than the server has: one was missed (the next
      // snapshot brings it; the card shows what it has)
      this.scorecardBehind = this.scorecard.length < data.scorecardRows;
    }
    // a Get Your Bid table's deal says so, with the scores; another game's
    // deal without them is the base game
    if (data.gyb) this._applyGybTotals(data.gyb);
    else if (data.gameId && data.gameId !== this.gameId) this.setMode(null);
    // a watcher's deal: the watched seat's new hand (gameStart.shoulder)
    const sh = this.isSpectator && !this.isLazy ? validShoulder(data.shoulder) : null;
    if (sh) {
      this.shoulder = { position: sh.position, paused: false };
      this.shoulderHold = null;
      this.position = sh.position;
    }
    // another game (a tournament's next table): its own watchers
    if (data.gameId && this.gameId && data.gameId !== this.gameId) this.watching = { spectators: [], count: 0 };
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
    this.myCards = sh ? sh.hand.map((c) => ({ ...c })) : (Array.isArray(data.hand) ? [...data.hand] : []);
    this.isBidding = true;
    this.phase = PHASE.BIDDING;
    this.stage = 'BIDDING';
    this.currentTurn = null;
    this.bidClock = null;
    this.helpAsked = {};
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
    this.tricksByPosition = GameState._noSeatTricks();
    this.rainbows = [];
    this._setHandSizeForAll(this.currentHand);
    if (data.hsiValues) this.hsiValues = { ...data.hsiValues };
    // the watched seat's HSI only (spectator gameStarts carry no hsiValues)
    if (sh) this.hsiValues = sh.hsi !== null ? { [sh.position]: sh.hsi } : {};
    else if (isShoulder(this)) this.hsiValues = {};
    if (this.isSolo) {
      this._syncSoloScores();
    } else if (data.score1 !== undefined && data.score2 !== undefined) {
      const [mine, theirs] = this._mine({ team1: data.score1, team2: data.score2 });
      this.teamScore = mine;
      this.oppScore = theirs;
    }
    if (Array.isArray(data.playerInfo) && data.playerInfo.length) {
      // gameStart.players (seat socket ids) is only the voice glow's
      // fallback and goes with V1_REMOVALS #6: without it the ids
      // positionUpdate gave stay
      const oldSockets = this._socketsByPosition();
      this.setPlayerData({
        positions: data.playerInfo.map((p) => p.position),
        sockets: Array.isArray(data.players) ? data.players : data.playerInfo.map((p) => oldSockets[p.position] ?? null),
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
    // that seat's clock is over (the timeout's own bid 0 included)
    if (this.bidClock?.position === data.position) this.bidClock = null;
    // its turn is over: the lightbulb goes
    delete this.helpAsked[data.position];
    this._changed();
    this._emit('bidReceived', { position: data.position, bid });
  }

  /** doneBidding: play opens at the lead. */
  applyDoneBidding(data) {
    this.isBidding = false;
    this.bidClock = null;
    this.helpAsked = {};
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
    // the turn moved to another seat: the clock was the last seat's
    if (this.bidClock && this.bidClock.position !== this.currentTurn) this.bidClock = null;
    // (and its lightbulb: only the seat on turn keeps one)
    this._keepHelpOnly(this.currentTurn);
    this.hasPlayedCard = false;
    if (this.stage === 'TRICK_RESOLVING' || this.stage === 'DEALING') this.stage = this.isBidding ? 'BIDDING' : 'PLAYING';
    this._changed();
    this._emit('turnChanged', this.currentTurn);
  }

  /** cardPlayed (mine included: the card leaves my hand only now). */
  applyCardPlayed(data) {
    const { card, position } = data;
    if (!card || !position) return;
    const seats = this.seatCount;
    if (this.playedCards.length >= seats) this._clearTrickState();
    if (this.playedCards.length === 0) {
      this.leadCard = card;
      this.leadPosition = position;
    }
    if (data.trump !== undefined) this.trumpBroken = !!data.trump;
    if (data.trumpBroken !== undefined) this.trumpBroken = !!data.trumpBroken;
    this.playedCards.push({ card, position });
    this.currentTrick.push({ card, position });
    this.playedCardIndex = this.playedCards.length % seats;
    // its turn is over: the lightbulb goes
    delete this.helpAsked[position];
    if (this.seatCards[position] > 0) this.seatCards[position]--;
    // my own card, or the watched seat's (the shoulder view's hand)
    if (position === this.position && (!this.isSpectator || isShoulder(this))) {
      const i = this.myCards.findIndex((c) => c.suit === card.suit && c.rank === card.rank);
      if (i !== -1) this.myCards.splice(i, 1);
      this.hasPlayedCard = true;
      this._emit('handChanged', this.myCards);
    }
    if (this.playedCards.length === seats) {
      this.stage = 'TRICK_RESOLVING';
      this.currentTurn = null;
    }
    this._changed();
    this._emit('cardPlayed', { card, position, playedCardIndex: this.playedCardIndex });
  }

  /** trickComplete: count it (cli-8: here, not in the scene) and open the next trick. */
  applyTrickComplete(data) {
    const winner = data.winner;
    // (a Get Your Bid table: "mine" is my own seat's trick)
    const mineTeam = this.isSolo ? winner === (this.position || 1) : winner % 2 === (this.position || 1) % 2;
    if (mineTeam) this.teamTricks++;
    else this.oppTricks++;
    if (typeof this.tricksByPosition?.[winner] === 'number') this.tricksByPosition[winner]++;
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
    if (validRow(data.scorecardRow)) this.scorecard = mergeRow(this.scorecard || [], data.scorecardRow);
    if (data.gyb) {
      // a Get Your Bid hand: each seat's result and the new scores
      this._applyGybTotals({ scores: data.gyb.scores });
      this.gyb.last = data.gyb;
      this.gyb.hands = (this.gyb.hands || 0) + 1;
      for (const s of Array.isArray(data.gyb.seats) ? data.gyb.seats : []) {
        if (s && s.bid === s.took && s.position >= 1 && s.position <= 3) this.gyb.made[s.position - 1]++;
      }
      this.setGameScores(this.teamScore, this.oppScore);
    } else if (data.score) {
      const [mine, theirs] = this._mine(data.score);
      this.setGameScores(mine, theirs);
    }
    this.stage = 'HAND_RESOLVING';
    this.helpAsked = {};
    this._changed();
  }

  /** destroyHands: the all-zero redeal (its gameStart deals the same hand again). */
  applyDestroyHands() {
    this.myCards = [];
    this.bidClock = null;
    this.helpAsked = {};
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

  /**
   * The hand in play for the scorecard's last row (bids only), or null
   * between hands and before the first deal.
   */
  scorecardCurrent() {
    if (!['BIDDING', 'PLAYING', 'TRICK_RESOLVING', 'HAND_RESOLVING'].includes(this.stage) || !this.currentHand) return null;
    const handNo = HAND_PROGRESSION.indexOf(this.currentHand) + 1;
    const seats = this.mode === 'gyb' ? 3 : 4;
    const bids = Array.from({ length: seats }, (_, i) => {
      const b = this.bids?.[i + 1];
      return b === undefined || b === null ? null : String(b);
    });
    return { handNo: handNo || null, handSize: this.currentHand, trump: this.trump, dealer: this.dealer, bids };
  }

  /** gameEnd */
  applyGameEnd(data) {
    const rows = parseRows(data?.scorecard);
    if (rows) this.scorecard = rows;
    if (data?.gyb) {
      this._applyGybTotals(data.gyb);
      this.gyb.end = data.gyb;
    } else if (data?.score) {
      const [mine, theirs] = this._mine(data.score);
      this.teamScore = mine;
      this.oppScore = theirs;
    }
    this.stage = 'ENDED';
    this.bidClock = null;
    this.helpAsked = {};
    this.setPhase(PHASE.ENDED);
    this._changed();
  }

  /** playerLazyMode / playerActiveMode for my seat. */
  applyMyLazy(isLazy) {
    this.isLazy = !!isLazy;
    this._changed();
  }

  /**
   * playerData for team names and the score screen (owner rule: teams by
   * player names): each seat named by its owner (seatOwners: a lazy or
   * resigned seat's owner, never the bot playing it), else the name the
   * seat shows (a native bot's persona). The avatars keep playerData.
   * @returns {Object|null} { position, username: [{username}], ... } or playerData itself
   */
  get teamPlayerData() {
    return teamPlayerDataOf(this);
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

  /**
   * spectatorsUpdated {gameId, spectators, count}: the whole list (it is
   * unsequenced: the latest one is the truth). Another game's list, or a
   * malformed one, is ignored.
   * @returns {boolean} whether it was applied
   */
  applySpectators(data) {
    if (!data || (data.gameId && this.gameId && data.gameId !== this.gameId)) return false;
    const watching = parseWatching(data);
    if (!watching) return false;
    this.watching = watching;
    this._changed();
    this._companyChanged();
    return true;
  }

  /**
   * Who is here from a snapshot (the voice rule): 4 seats -> the owners of
   * the seats that are not native bots and not gone; no seats yet (the
   * draw) -> the human entrants not left. A snapshot with neither (a v1
   * payload) keeps what is known.
   */
  _humansFromSnapshot(snap) {
    if (Array.isArray(snap.seats) && snap.seats.length === 4) {
      this.humanOwners = {};
      for (const st of snap.seats) {
        if (!st?.position || typeof st.ownerUsername !== 'string' || !st.ownerUsername) continue;
        if (st.controller === 'bot' || st.presence === 'gone' || st.presence === 'none') continue;
        this.humanOwners[st.position] = st.ownerUsername;
      }
      this.entrantHumans = [];
      this.humansKnown = true;
      this.nativeBotSeat = snap.seats.some((st) => st?.controller === 'bot');
    } else if (Array.isArray(snap.entrants)) {
      this.humanOwners = {};
      this.nativeBotSeat = false;
      this.entrantHumans = snap.entrants
        .filter((e) => e && !e.isBot && e.presence !== 'left' && typeof e.username === 'string' && e.username)
        .map((e) => e.username);
      this.humansKnown = true;
    }
  }

  /**
   * bidClock (unsequenced, applied on arrival): `running` sets this seat's
   * clock, its deadline measured from now on this page's monotonic clock;
   * `stopped` clears it when it is that seat's. Another game's, or a
   * malformed one, is ignored (contract/README.md "Bid clock").
   * @param {Object} data
   * @param {number} [now] - bidClockNow() at receipt
   * @returns {boolean} whether it changed the state
   */
  applyBidClock(data, now = bidClockNow()) {
    const ev = parseBidClockEvent(data);
    if (!ev || (ev.gameId && this.gameId && ev.gameId !== this.gameId)) return false;
    if (ev.running) {
      this.bidClock = clockFrom(ev, now);
    } else {
      if (this.bidClock?.position !== ev.position) return false;
      this.bidClock = null;
    }
    this._changed();
    return true;
  }

  // ============================================
  // The avatar badges (state/seatBadges.js)
  // ============================================

  _keepHelpOnly(pos) {
    for (const p of Object.keys(this.helpAsked)) if (Number(p) !== pos) delete this.helpAsked[p];
  }

  /**
   * A live gameLogEntry: the help notice (`help {position}`) lights that
   * seat's lightbulb, the tutorial's tag (`tutorial {position, on}`) sets
   * its graduation cap. Never called for a snapshot's log: its stored tags
   * only style their rows (the snapshot's seats[] decide the badges, and a
   * replayed notice is not this turn's).
   * @returns {number|null} the seat whose badge changed, or null
   */
  applyLogEntry(data) {
    const tag = tutorialTag(data);
    if (tag) {
      if (!!this.tutorialSeats[tag.position] === tag.on) return null;
      if (tag.on) this.tutorialSeats[tag.position] = true;
      else delete this.tutorialSeats[tag.position];
      this._changed();
      return tag.position;
    }
    const pos = helpNoticeSeat(data);
    if (!pos || this.helpAsked[pos]) return null;
    this.helpAsked[pos] = true;
    this._changed();
    return pos;
  }

  /** A seat went lazy or was replaced (playerLazyMode, playerResigned): its lightbulb goes. */
  clearHelpAsked(position) {
    if (!this.helpAsked[position]) return false;
    delete this.helpAsked[position];
    this._changed();
    return true;
  }

  /** My socket dropped: the clock is not known any more (the rejoin snapshot brings it back if it still runs). */
  clearBidClock() {
    if (!this.bidClock) return false;
    this.bidClock = null;
    this._changed();
    return true;
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
  applySnapshot(snap, { players = null, gyb = null } = {}) {
    if (!snap) return;
    // The mode: a Get Your Bid table's snapshot comes with `gyb` beside it
    // (the carrier's key); another game's snapshot without one is the base
    // game; the same game's keeps what it is
    if (gyb) this.setMode('gyb');
    else if (!snap.gameId || snap.gameId !== this.gameId) this.setMode(null);
    const role = snap.viewer?.role || 'none';
    const sameDeal = snap.gameId === this.gameId && !!snap.deal && snap.deal.handNo === this.handNo &&
      (snap.deal.dealSeq ?? null) === (this.dealSeq ?? null);
    const prevHistory = this.trickHistory;

    const sameGame = !!snap.gameId && snap.gameId === this.gameId;
    // the scorecard: the snapshot's rows (parseSnapshotV2 kept the valid
    // ones); without them this game's card stays, another game has none
    if (Array.isArray(snap.scorecard)) {
      this.scorecard = snap.scorecard.map((r) => JSON.parse(JSON.stringify(r)));
      this.scorecardBehind = false;
    } else if (!sameGame) this.scorecard = null;
    if (snap.gameId) this.gameId = snap.gameId;
    this.stage = snap.stage || null;
    // who is watching: the snapshot's list; without one (an older server, a
    // v1 payload) this game's list stays, another game starts empty
    const watching = snap.watching ? parseWatching(snap.watching) : null;
    if (watching) this.watching = watching;
    else if (!sameGame) this.watching = { spectators: [], count: 0 };
    this.isSpectator = role === 'spectator';
    this.isLazy = role === 'lazyWatcher';
    if (snap.viewer?.position) this.position = snap.viewer.position;
    else if (this.isSpectator) this.position = 1;
    // the over-the-shoulder view: the snapshot's viewer.shoulder (the wire
    // keeps viewer.position null: the table is drawn from the watched seat
    // here); without one, a paused table keeps the held seat (no cards)
    this.tournamentTable = !!snap.tournament;
    const sh = this.isSpectator ? validShoulder(snap.viewer?.shoulder) : null;
    if (!this.isSpectator || !sameGame) this.shoulderHold = null;
    const hold = !sh && this.isSpectator ? this.shoulderHold : null;
    if (sh) {
      this.shoulder = { position: sh.position, paused: false };
      this.position = sh.position;
    } else if (hold) {
      this.shoulder = { position: hold, paused: true };
      this.position = hold;
    } else {
      this.shoulder = null;
    }

    this._seatsToPlayerData(snap.seats || [], players);
    this.seats = Array.isArray(snap.seats) ? snap.seats.map((s) => ({ ...s })) : [];
    // another game's native bot seats are not this one's (a snapshot with
    // seats says again below)
    if (!sameGame) this.nativeBotSeat = false;
    this._humansFromSnapshot(snap);

    const deal = snap.deal;
    this.handNo = deal ? (deal.handNo || this.handNo || 1) : 0;
    this.dealSeq = deal ? (deal.dealSeq ?? null) : null;
    this.currentHand = deal?.handSize || 0;
    this.dealer = deal?.dealer ?? null;
    this._redealPending = snap.stage === 'REDEAL';

    this.trump = snap.trump || null;
    this.trumpBroken = !!snap.trumpBroken;
    this.myCards = sh ? sh.hand.map((c) => ({ ...c }))
      : (Array.isArray(snap.hand) ? snap.hand.map((c) => ({ suit: c.suit, rank: c.rank })) : []);
    this.currentTurn = snap.turn?.position ?? null;
    this.isBidding = ['DEALING', 'BIDDING', 'REDEAL'].includes(snap.stage);
    if (deal) this.phase = this.isBidding ? PHASE.BIDDING : PHASE.PLAYING;
    else if (['CREATED', 'DRAWING', 'DRAW_RESOLVING'].includes(snap.stage)) this.phase = PHASE.DRAW;
    // the draw so far (a rejoin or a spectator mid-draw sees the cards drawn)
    if (['DRAWING', 'DRAW_RESOLVING'].includes(snap.stage) && snap.draw && Array.isArray(snap.draw.drawn)) {
      this.draw = {
        drawn: snap.draw.drawn
          .filter((d) => d && d.drawOrder >= 1 && d.drawOrder <= 4 && d.username)
          .map((d) => ({ drawOrder: d.drawOrder, username: d.username, card: d.card ? { suit: d.card.suit, rank: d.card.rank } : null }))
          .sort((a, b) => a.drawOrder - b.drawOrder),
        viewerDrawOrder: snap.draw.viewerDrawOrder ?? null,
        // a tournament table's planned teams (the parser kept only a good 2 x 2)
        teams: Array.isArray(snap.draw.teams) ? snap.draw.teams.map((t) => t.map((p) => ({ username: p.username, isBot: !!p.isBot }))) : null,
      };
      if (!this.isSpectator) this.hasDrawn = this.draw.viewerDrawOrder !== null;
    } else {
      this.draw = null;
    }

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
    this.playedCardIndex = this.playedCards.length % this.seatCount;
    if (cards.length) {
      this.leadPosition = snap.trick.leadPosition ?? cards[0].position;
      this.leadCard = { ...cards[0].card };
    }
    this.hasPlayedCard = (!this.isSpectator || !!sh) && !!this.position && cards.some((c) => c.position === this.position);

    const [teamTricks, oppTricks] = this._mine(snap.tricks);
    this.teamTricks = teamTricks;
    this.oppTricks = oppTricks;
    const total = teamTricks + oppTricks;
    this.trickNo = snap.trick?.number || (deal ? (this.isBidding ? 1 : total + 1) : 0);
    // (a Get Your Bid table's tricks hold three cards: gyb.trickHistory)
    const served = gyb ? GameState._historyFromSnapshot(gyb.trickHistory, 3) : GameState._historyFromSnapshot(snap.trickHistory);
    if (served && this._historyMatches(served, snap.tricks)) this.trickHistory = served;
    else if (sameDeal && this._historyMatches(prevHistory, snap.tricks)) this.trickHistory = prevHistory;
    else this.trickHistory = GameState._unknownTricks(snap.tricks);
    this.tricksByPosition = GameState._seatTricksFor(snap, this.trickHistory);

    const [teamScore, oppScore] = this._mine(snap.score);
    this.teamScore = teamScore;
    this.oppScore = oppScore;
    if (gyb) {
      // each seat for itself: my tricks and score, the others'
      this._applyGybTotals(gyb);
      this._syncSoloTricks();
    }
    const [teamRainbows, oppRainbows] = this._mine(snap.rainbows);
    this.teamRainbows = teamRainbows;
    this.oppRainbows = oppRainbows;

    this.hsiValues = {};
    if (Array.isArray(snap.hsi)) snap.hsi.forEach((v, i) => { if (typeof v === 'number') this.hsiValues[i + 1] = v; });
    if (sh && sh.hsi !== null) this.hsiValues[sh.position] = sh.hsi;

    this.seatCards = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const s of this.seats) this.seatCards[s.position] = s.cardsInHand || 0;
    this.resume = snap.resume || null;
    // the clock is in a snapshot only while it runs (inMs from receipt)
    this.bidClock = snap.bidClock ? clockFrom(snap.bidClock) : null;
    // the avatar badges: the seats say (absent = off; an older server sends neither)
    this.helpAsked = {};
    this.tutorialSeats = {};
    for (const st of this.seats) {
      if (st?.askedHelp === true) this.helpAsked[st.position] = true;
      if (st?.tutorial === true) this.tutorialSeats[st.position] = true;
    }
    this._changed();
    this._emit('stateRestored', snap);
    this._companyChanged();
  }

  // ============================================
  // The over-the-shoulder view (state/shoulder.js)
  // ============================================

  /**
   * Draw the table from seat `pos` (the watched seat, or seat 1 again):
   * the per-team values follow the viewer's side, the names their seats.
   */
  _reorient(pos) {
    const old = this.position || 1;
    this.position = pos;
    if (this.isSolo) {
      // no teams: "mine" follows the seat itself
      this._syncSoloTricks();
      this._syncSoloScores();
    } else if (old % 2 !== pos % 2) {
      [this.teamTricks, this.oppTricks] = [this.oppTricks, this.teamTricks];
      [this.teamScore, this.oppScore] = [this.oppScore, this.teamScore];
      [this.teamRainbows, this.oppRainbows] = [this.oppRainbows, this.teamRainbows];
    }
    if (Object.keys(this.bids).length) this._updateTeamBids();
    this._updatePlayerNames();
  }

  /**
   * Table view (the person's own stop; the server always does a stop, but
   * sends nothing from a paused table): the plain spectator view at once.
   * @returns {boolean} whether a seat was watched
   */
  applyShoulderStop() {
    this.shoulderHold = null;
    if (!this.shoulder) return false;
    this.shoulder = null;
    this.myCards = [];
    this.hsiValues = {};
    this.hasPlayedCard = false;
    if (this.isSpectator) this._reorient(1);
    this._changed();
    this._emit('handChanged', this.myCards);
    return true;
  }

  /**
   * The paused rule (ShoulderWatch): hold seat `pos` while the table is
   * paused, its hand area empty (no stale cards), drawn from that seat;
   * null: hold nothing (a reply or a snapshot shows what is served).
   */
  setShoulderHold(pos) {
    if (!pos || !this.isSpectator || this.isLazy) {
      this.shoulderHold = null;
      return;
    }
    this.shoulderHold = pos;
    this.shoulder = { position: pos, paused: true };
    this.myCards = [];
    this.hsiValues = {};
    this.hasPlayedCard = false;
    this._reorient(pos);
    this._changed();
    this._emit('handChanged', this.myCards);
  }

  /** {position -> seat socket id} from playerData (the voice glow's fallback). */
  _socketsByPosition() {
    return this.playerData?.position
      ? Object.fromEntries(this.playerData.position.map((pos, i) => [pos, this.playerData.socket?.[i] ?? null]))
      : {};
  }

  /**
   * positionUpdate {positions, usernames[{username}], sockets?, pics}: the
   * seating. My position is my username's seat (the seat socket id as a
   * fallback): it no longer needs playerAssigned (V1_REMOVALS #7) or
   * positionUpdate.sockets (#14). `yourPosition` wins when present. The
   * names seated here are the seats' owners.
   * @param {Object} data
   * @param {Object} [opts]
   * @param {string|null} [opts.socketId] - this page's socket id
   */
  applyPositionUpdate(data, { socketId = null } = {}) {
    const d = data || {};
    const positions = Array.isArray(d.positions) ? d.positions : [];
    const names = Array.isArray(d.usernames) ? d.usernames.map((u) => u?.username ?? u) : [];
    let mine = d.yourPosition || null;
    if (!mine && this.username) {
      const i = names.indexOf(this.username);
      if (i !== -1) mine = positions[i] || null;
    }
    if (!mine && socketId && Array.isArray(d.sockets)) {
      const i = d.sockets.indexOf(socketId);
      if (i !== -1) mine = positions[i] || null;
    }
    if (mine) this.position = mine;
    // Each seat's owner: positionUpdate.owners (additive 2026-11-26), else
    // the name the seat shows. A draw-phase leaver is seated as a resign bot:
    // usernames names the bot, owners the leaver (as a snapshot's
    // ownerUsername does), so the owner labels name the leaver here too
    // (getSeatOwnerName, teamPlayerData). A native bot's owner is null: its
    // persona, as before. A server without owners: usernames, as before
    const owners = Array.isArray(d.owners) ? d.owners : null;
    this.seatOwners = {};
    positions.forEach((pos, i) => {
      const owner = owners?.[i];
      if (typeof owner === 'string' && owner) this.seatOwners[pos] = owner;
      else if (typeof names[i] === 'string') this.seatOwners[pos] = names[i];
    });
    // The human seats (the voice rule): isBot[] per seat, else the bot:
    // prefix of the seat socket id (a server before isBot). A native bot
    // seat (/help has no limit): nativeBot[] (additive 2026-11-19), since
    // isBot is also true for a draw-phase leaver's resign bot; a server
    // before nativeBot: every bot seat, as before
    this.humanOwners = {};
    this.nativeBotSeat = false;
    positions.forEach((pos, i) => {
      if (typeof names[i] !== 'string') return;
      const bot = Array.isArray(d.isBot) && typeof d.isBot[i] === 'boolean'
        ? d.isBot[i]
        : typeof d.sockets?.[i] === 'string' && d.sockets[i].startsWith('bot:');
      if (!bot) {
        this.humanOwners[pos] = names[i];
        return;
      }
      const native = Array.isArray(d.nativeBot) ? d.nativeBot[i] === true : true;
      if (native) this.nativeBotSeat = true;
    });
    this.entrantHumans = [];
    if (positions.length) this.humansKnown = true;
    this.setPlayerData(d);
    this._companyChanged();
  }

  /** playerData (names, pictures) from the snapshot's seats; a v1 players[] wins for pictures. */
  _seatsToPlayerData(seats, players) {
    if (Array.isArray(seats) && seats.length) {
      const owners = {};
      for (const s of seats) {
        const owner = s?.ownerUsername ?? s?.username;
        if (s?.position && typeof owner === 'string') owners[s.position] = owner;
      }
      if (Object.keys(owners).length) this.seatOwners = owners;
    }
    if (Array.isArray(players) && players.length) {
      this.setPlayerData({
        position: players.map((p) => p.position),
        sockets: players.map((p) => p.socketId),
        username: players.map((p) => ({ username: p.username, socketId: p.socketId })),
        pics: players.map((p) => p.pic),
      });
      return;
    }
    if (!Array.isArray(seats) || seats.length !== this.seatCount) {
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
    const oldSockets = this._socketsByPosition();
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
    const shoulder = isShoulder(this);
    const hand = this.isSpectator && !shoulder ? null : [...this.myCards];
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
      // a Get Your Bid table: the mode, its seats' scores, this deal's Forbidden Bid
      mode: this.mode,
      seatCount: this.seatCount,
      gyb: this.gyb ? { scores: [...this.gyb.scores], made: [...this.gyb.made], hands: this.gyb.hands, forbidden: this.gybForbidden() } : null,
      stage: this.stage,
      live,
      viewer: {
        role, position, canAct: this.canAct({ pending: !!pendingCard || pendingBid }),
        // the watched seat (the over-the-shoulder view), only while watching
        ...(shoulder && { shoulder: { ...this.shoulder } }),
      },
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
      tricksByPosition: { ...this.tricksByPosition },
      history: Array.isArray(this.trickHistory)
        ? this.trickHistory.map((t) => ({ winner: t.winner, team: GameState._trickTeam(t), cards: t.cards ? t.cards.map((c) => ({ ...c })) : null }))
        : null,
      seatCards,
      score: { team: this.teamScore, opp: this.oppScore },
      hsi: position ? this.hsiValues[position] : undefined,
      playerData: this.playerData,
      draw: this.draw && ['DRAWING', 'DRAW_RESOLVING'].includes(this.stage)
        ? {
          drawn: this.draw.drawn.map((d) => ({ ...d, card: d.card ? { ...d.card } : null })),
          viewerDrawOrder: this.draw.viewerDrawOrder,
          hasDrawn: !!this.hasDrawn,
          teams: this.draw.teams ? this.draw.teams.map((t) => t.map((p) => ({ ...p }))) : null,
        }
        : null,
      watching: { spectators: this.watching.spectators.map((w) => ({ ...w })), count: this.watching.count },
      bidClock: this.bidClock ? { ...this.bidClock } : null,
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

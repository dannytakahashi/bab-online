/**
 * Encapsulates all state for a single game instance
 * Includes validation and debug logging
 *
 * Lifecycle: `_stage` is the authoritative game phase (see GamePhase.js) and
 * only changes through transition() / tryTransition() / terminate(). The
 * legacy `phase` / `bidding` fields are read-only projections for the wire.
 */
const {
    Phase,
    NOT_BIDDING,
    PRE_SEATING,
    isTerminal,
    isLegal,
    wirePhase,
    reportViolation,
    shouldCheckInvariants
} = require('./GamePhase');
const { gameLogger } = require('../utils/logger');

const IN_HAND_STAGES = new Set([
    Phase.DEALING, Phase.BIDDING, Phase.REDEAL, Phase.PLAYING,
    Phase.TRICK_RESOLVING, Phase.HAND_RESOLVING
]);

class GameState {
    constructor(gameId) {
        this.gameId = gameId;
        this.roomName = `game:${gameId}`;  // Socket.IO room name
        this.createdAt = Date.now();
        this._debugMode = process.env.NODE_ENV !== 'production';

        // Players: socketId → { username, position, pic }
        this.players = new Map();
        // Position lookup: position (1-4) → socketId
        this.positions = {};

        // Hands: socketId → array of cards
        this.hands = {};

        // Game progression
        this.currentHand = 12;     // Cards per player (12 down to 1)
        this.dealer = 1;           // Dealer position (rotates)

        // Lifecycle (authoritative phase; `phase`/`bidding` are getters)
        this._stage = Phase.CREATED;
        this.epoch = 0;            // bumped once when the game ends or aborts
        this._timers = new Map();  // key -> timeout (setTimer)
        this._pauses = new Set();  // in-flight pause() entries
        this._history = shouldCheckInvariants() ? [Phase.CREATED] : null;
        this._isSeatReachable = null;   // set by GameManager.createGame
        // Pre-seating participants: socketId -> {socketId, username, isBot,
        // presence: 'connected'|'disconnected'|'left'}. Filled by
        // GameManager.createGame, null once all four seats exist.
        this.entrants = null;
        this.currentTurn = 1;

        // Bidding state
        this.bids = {};            // position → bid value
        this.bidder = 2;           // First bidder position
        this.playerBids = [];      // Array of bid strings [pos1, pos2, pos3, pos4]
        this.team1Mult = 1;
        this.team2Mult = 1;

        // Trick play state
        this.leadPosition = 1;
        this.leadCard = null;
        this.playedCards = [];     // Cards played this trick [pos1Card, pos2Card, ...]
        this.playedCardsIndex = 0;
        this.trump = null;         // Trump card
        this.isTrumpBroken = false;
        this.cardIndex = 0;        // Total cards played in hand

        // Scoring
        this.tricks = { team1: 0, team2: 0 };
        this.score = { team1: 0, team2: 0 };
        this.rainbows = { team1: 0, team2: 0 };

        // Hand stats (for player profiles)
        this.handStats = { totalHands: 0, team1Sets: 0, team2Sets: 0 };

        // Per-player stats for final score screen
        // position (1-4) → { totalBids, totalTricks, setsCaused, totalHSI }
        this.playerStats = {
            1: { totalBids: 0, totalTricks: 0, setsCaused: 0, totalHSI: 0 },
            2: { totalBids: 0, totalTricks: 0, setsCaused: 0, totalHSI: 0 },
            3: { totalBids: 0, totalTricks: 0, setsCaused: 0, totalHSI: 0 },
            4: { totalBids: 0, totalTricks: 0, setsCaused: 0, totalHSI: 0 },
        };

        // Per-hand trick tracking (reset each hand) for determining set responsibility
        this.handTricks = { 1: 0, 2: 0, 3: 0, 4: 0 };

        // Draw phase
        this.drawCards = [];
        this.drawIDs = [];
        this.drawIndex = 0;

        // Disconnection tracking: position → { disconnectedAt, socketId }
        this.disconnectedPlayers = {};

        // Resignation tracking: position → { username, pic, resignedAt }
        this.resignedPlayers = {};

        // Lazy mode tracking: position → { botSocketId, botUsername, botPic, originalUsername, originalPic, originalSocketId, personality }
        this.lazyPlayers = {};

        // Assigned bot personality per position (persists across lazy/active cycles)
        this.assignedPersonality = {};

        // HSI values for current hand (position → hsi), stored for reconnection
        this.hsiValues = {};

        // Spectators: socketId → { username, pic }
        this.spectators = new Map();

        // Game log for reconnection restoration
        this.gameLog = [];
        this.maxLogEntries = 500;
    }

    // ========================================
    // Lifecycle (phase FSM)
    // ========================================

    /** Authoritative stage (GamePhase.Phase). Internal only — never on the wire. */
    get stage() {
        return this._stage;
    }

    /** Legacy wire phase: 'waiting' | 'drawing' | 'bidding' (never 'playing'). */
    get phase() {
        return wirePhase(this._stage);
    }

    set phase(value) {
        reportViolation('legacy-write', { field: 'phase', value, gameId: this.gameId });
    }

    /** Legacy wire flag: false only from the end of bidding to the next deal. */
    get bidding() {
        return !NOT_BIDDING.has(this._stage);
    }

    set bidding(value) {
        reportViolation('legacy-write', { field: 'bidding', value, gameId: this.gameId });
    }

    isTerminal() {
        return isTerminal(this._stage);
    }

    /** Before seats exist: a mapped socket may legitimately have no position. */
    isPreSeating() {
        return PRE_SEATING.has(this._stage);
    }

    /** 'bid' / 'play' while a turn can be taken, null otherwise. */
    actionTypeForTurn() {
        if (this._stage === Phase.BIDDING) return 'bid';
        if (this._stage === Phase.PLAYING) return 'play';
        return null;
    }

    acceptsTurnInput() {
        return this._stage === Phase.BIDDING || this._stage === Phase.PLAYING;
    }

    _enterStage(from, to) {
        this._stage = to;
        if (this._history) this._history.push(to);
        gameLogger.debug('phase', { gameId: this.gameId, from, to });
    }

    /**
     * Assert-and-apply a lifecycle edge. Every production call site reads
     * `if (!game.transition(F, T)) return;` — illegal calls throw under tests
     * and fail closed (logged, continuation stops) in production.
     */
    transition(from, to) {
        if (this._stage !== from) {
            reportViolation('illegal-from', { gameId: this.gameId, from, actual: this._stage, to });
            return false;
        }
        return this._applyTransition(from, to);
    }

    /**
     * Latch for legitimate races (several draw paths may complete the draw):
     * a stage mismatch quietly returns false. An illegal edge is still reported.
     */
    tryTransition(from, to) {
        if (this._stage !== from) {
            gameLogger.debug('tryTransition: stage moved on', { gameId: this.gameId, from, actual: this._stage, to });
            return false;
        }
        return this._applyTransition(from, to);
    }

    _applyTransition(from, to) {
        if (!isLegal(from, to)) {
            reportViolation('illegal-edge', { gameId: this.gameId, from, to });
            return false;
        }
        if (isTerminal(to)) {
            reportViolation('use-terminate', { gameId: this.gameId, from, to });
            return false;
        }
        this._enterStage(from, to);
        if (shouldCheckInvariants()) {
            const { errors } = this.validateGameState();
            if (errors.length > 0) {
                reportViolation('invariant', { gameId: this.gameId, stage: to, errors });
            }
        }
        return true;
    }

    canTransition(to) {
        return !this.isTerminal() && isLegal(this._stage, to);
    }

    /**
     * Move to ENDED or ABORTED (absorbing). The final event, if any, is
     * broadcast while the game is still live. Returns false if the game is
     * already terminal (so callers never double-resolve).
     * @param {Object|null} io
     * @param {string} to - Phase.ENDED or Phase.ABORTED
     * @param {string|null} [event] - final event broadcast to the room
     * @param {Object} [payload]
     */
    terminate(io, to, event = null, payload) {
        if (this.isTerminal()) return false;
        if (!isTerminal(to) || !isLegal(this._stage, to)) {
            reportViolation('illegal-terminate', { gameId: this.gameId, from: this._stage, to });
            return false;
        }
        // Steps below are synchronous: nothing can run between the final
        // event and the epoch bump / timer cancellation
        if (io && event) this.broadcast(io, event, payload);
        const from = this._stage;
        this._stage = to;
        if (this._history) this._history.push(to);
        this.epoch++;
        this._cancelAllTimers();
        gameLogger.info('Game terminated', { gameId: this.gameId, from, to, event });
        return true;
    }

    // ========================================
    // Epoch-guarded pauses and timers
    // ========================================

    /** @returns {Function} true while the game is still in this epoch and live */
    aliveCheck() {
        const e = this.epoch;
        return () => this.epoch === e && !this.isTerminal();
    }

    /**
     * Lifecycle pause. Resolves true after `ms` if the game is still in the
     * same epoch, false (immediately) when the game ends/aborts meanwhile or
     * is already terminal. Every lifecycle continuation reads
     * `if (!(await game.pause(ms))) return;`.
     * @returns {Promise<boolean>}
     */
    pause(ms) {
        if (this.isTerminal()) return Promise.resolve(false);
        const e = this.epoch;
        return new Promise((resolve) => {
            const entry = { timer: null, resolve };
            entry.timer = setTimeout(() => {
                this._pauses.delete(entry);
                resolve(this.epoch === e);
            }, ms);
            this._pauses.add(entry);
        });
    }

    /**
     * Named one-shot timer owned by this game (replaces any timer under the
     * same key). The callback is skipped if the game ended/aborted meanwhile;
     * sync throws and async rejections are logged, never uncaught.
     */
    setTimer(key, ms, fn) {
        this.clearTimer(key);
        if (this.isTerminal()) return false;
        const e = this.epoch;
        const timer = setTimeout(() => {
            this._timers.delete(key);
            if (this.epoch !== e || this.isTerminal()) return;
            Promise.resolve().then(fn).catch(err =>
                gameLogger.error('Game timer failed', { gameId: this.gameId, key, error: err.message, stack: err.stack })
            );
        }, ms);
        this._timers.set(key, timer);
        return true;
    }

    clearTimer(key) {
        const timer = this._timers.get(key);
        if (timer !== undefined) {
            clearTimeout(timer);
            this._timers.delete(key);
        }
    }

    hasTimer(key) {
        return this._timers.has(key);
    }

    get pendingTimerCount() {
        return this._timers.size + this._pauses.size;
    }

    _cancelAllTimers() {
        for (const timer of this._timers.values()) clearTimeout(timer);
        this._timers.clear();
        for (const entry of this._pauses) {
            clearTimeout(entry.timer);
            entry.resolve(false);
        }
        this._pauses.clear();
    }

    /** Test-only fixture helper: jump straight to a non-terminal stage. */
    forcePhase(p) {
        if (process.env.NODE_ENV !== 'test') throw new Error('forcePhase is test-only');
        if (!Phase[p] || isTerminal(p)) throw new Error(`forcePhase: invalid stage ${p}`);
        this._stage = p;
        if (this._history) this._history.push(p);
    }

    /**
     * The only writer of draw state. Takes the card at `index` (null = random,
     * clamped into the deck) for `socketId`.
     * @returns {{card: Object, drawOrder: number}|null} null when refused
     *   (not drawing, no deck, duplicate drawer, or 4 draws already in)
     */
    recordDraw(socketId, index) {
        if (this._stage !== Phase.DRAWING || !this.deck || this.deck.cards.length === 0) return null;
        if (this.drawIDs.includes(socketId) || this.drawIDs.length >= 4) return null;
        const n = this.deck.cards.length;
        let i = index == null ? Math.floor(Math.random() * n) : Math.floor(Number(index));
        if (!Number.isFinite(i)) i = 0;
        i = Math.max(0, Math.min(n - 1, i));
        const [card] = this.deck.cards.splice(i, 1);
        this.drawCards.push(card);
        this.drawIDs.push(socketId);
        this.drawIndex++;
        return { card, drawOrder: this.drawIndex };
    }

    addPlayer(socketId, username, position, pic, isBot = false) {
        this.players.set(socketId, { username, position, pic, isBot });
        this.positions[position] = socketId;
        // Seating is complete: pre-seating bookkeeping is over
        if (this.players.size === 4) this.entrants = null;
    }

    // ========================================
    // Entrants (before seats exist)
    // ========================================

    /** @param {Array<{socketId, username, isBot}>} list */
    initEntrants(list) {
        this.entrants = new Map();
        for (const e of list) {
            this.entrants.set(e.socketId, {
                socketId: e.socketId,
                username: e.username ?? null,
                isBot: !!e.isBot,
                presence: 'connected'
            });
        }
    }

    /** The entrant record for a socket (null once seated, or unknown). */
    entrant(socketId) {
        return this.entrants?.get(socketId) || null;
    }

    /** Idempotent; never downgrades a 'left' entrant. */
    markEntrantDisconnected(socketId) {
        const e = this.entrant(socketId);
        if (e && e.presence === 'connected') e.presence = 'disconnected';
        return e;
    }

    /** Idempotent. */
    markEntrantLeft(socketId) {
        const e = this.entrant(socketId);
        if (e) e.presence = 'left';
        return e;
    }

    /**
     * Check if a player is a bot
     * @param {string} socketId - Socket ID to check
     * @returns {boolean}
     */
    isBot(socketId) {
        const player = this.players.get(socketId);
        return player?.isBot === true;
    }

    /**
     * Get all bot players in the game
     * @returns {Array} - Array of { socketId, username, position, pic, isBot }
     */
    getBotPlayers() {
        const bots = [];
        for (const [socketId, player] of this.players.entries()) {
            if (player.isBot) {
                bots.push({ socketId, ...player });
            }
        }
        return bots;
    }

    removePlayer(socketId) {
        const player = this.players.get(socketId);
        if (player) {
            delete this.positions[player.position];
            this.players.delete(socketId);
        }
    }

    getPlayerByPosition(position) {
        const socketId = this.positions[position];
        if (!socketId) return null;
        return { socketId, ...this.players.get(socketId) };
    }

    getPositionBySocketId(socketId) {
        const player = this.players.get(socketId);
        return player ? player.position : null;
    }

    /**
     * Find a player by username
     * @param {string} username - Username to find
     * @returns {Object|null} - Player info with socketId, or null
     */
    getPlayerByUsername(username) {
        for (const [socketId, player] of this.players.entries()) {
            if (player.username === username) {
                return { socketId, ...player };
            }
        }
        return null;
    }

    /**
     * Mark a player as disconnected (for reconnection grace period)
     * @param {number} position - Player's position (1-4)
     */
    markPlayerDisconnected(position) {
        const socketId = this.positions[position];
        this.disconnectedPlayers[position] = {
            disconnectedAt: Date.now(),
            socketId
        };
        this.logAction('markPlayerDisconnected', { position, socketId });
    }

    /**
     * Clear disconnected status for a player (on reconnect)
     * @param {number} position - Player's position (1-4)
     */
    clearPlayerDisconnected(position) {
        delete this.disconnectedPlayers[position];
        this.logAction('clearPlayerDisconnected', { position });
    }

    /**
     * Get list of positions that have been disconnected
     * @returns {number[]} - Array of disconnected positions
     */
    getDisconnectedPlayers() {
        return Object.keys(this.disconnectedPlayers).map(Number);
    }

    /**
     * Check if a position is currently disconnected
     * @param {number} position - Player's position (1-4)
     * @returns {boolean}
     */
    isPlayerDisconnected(position) {
        return position in this.disconnectedPlayers;
    }

    /**
     * Update socket ID for a reconnecting player
     * @param {number} position - Player's position (1-4)
     * @param {string} newSocketId - New socket ID
     * @param {Server} io - Socket.IO server for room management
     * @returns {string|null} - Old socket ID, or null if position not found
     */
    updatePlayerSocket(position, newSocketId, io) {
        const oldSocketId = this.positions[position];
        if (!oldSocketId) return null;

        // Already at this socket — nothing to transfer
        if (oldSocketId === newSocketId) return oldSocketId;

        const player = this.players.get(oldSocketId);
        if (!player) return null;

        // Remove old socket from room
        if (io) {
            this.leaveRoom(io, oldSocketId);
        }

        // Transfer player data to new socket
        this.players.delete(oldSocketId);
        this.players.set(newSocketId, player);
        this.positions[position] = newSocketId;

        // Transfer hand to new socket
        if (this.hands[oldSocketId]) {
            this.hands[newSocketId] = this.hands[oldSocketId];
            delete this.hands[oldSocketId];
        }

        // Add new socket to room
        if (io) {
            this.joinToRoom(io, newSocketId);
        }

        this.logAction('updatePlayerSocket', { position, oldSocketId, newSocketId });
        return oldSocketId;
    }

    /**
     * Get current game state for a rejoining client
     * @param {string} socketId - Socket ID of the player
     * @returns {Object} - Game state object
     */
    getClientState(socketId) {
        const position = this.getPositionBySocketId(socketId);

        // Build player info array
        const playerInfo = [];
        for (let pos = 1; pos <= 4; pos++) {
            const player = this.getPlayerByPosition(pos);
            if (player) {
                playerInfo.push({
                    position: pos,
                    username: player.username,
                    pic: player.pic,
                    socketId: player.socketId
                });
            }
        }

        return {
            gameId: this.gameId,
            position,
            hand: this.getHand(socketId),
            trump: this.trump,
            currentHand: this.currentHand,
            dealer: this.dealer,
            phase: this.phase,
            bidding: this.bidding,
            currentTurn: this.currentTurn,
            bids: this.bids,
            playerBids: this.playerBids,
            tricks: this.tricks,
            score: this.score,
            playedCards: this.playedCards,
            leadPosition: this.leadPosition,
            isTrumpBroken: this.isTrumpBroken,
            players: playerInfo,
            gameLog: this.getGameLog(),
            hsiValues: this.hsiValues,
            resignedPositions: Object.keys(this.resignedPlayers).map(Number),
            lazyPositions: Object.keys(this.lazyPlayers).map(Number),
            isLazy: this.isLazy(position)
        };
    }

    setHand(socketId, cards) {
        this.hands[socketId] = [...cards];
    }

    getHand(socketId) {
        return this.hands[socketId] || [];
    }

    removeCardFromHand(socketId, card) {
        const hand = this.hands[socketId];
        if (!hand) return false;

        const index = hand.findIndex(c =>
            c.suit === card.suit && c.rank === card.rank
        );

        if (index === -1) return false;

        hand.splice(index, 1);
        return true;
    }

    recordBid(position, bid) {
        this.bids[position] = bid;
        this.playerBids[position - 1] = bid;

        // Track total bids for player stats
        // Bore bids (B, 2B, 3B, 4B) count as all tricks in the hand
        const bidStr = String(bid);
        const bidValue = bidStr.includes('B') ? this.currentHand : parseInt(bidStr, 10) || 0;
        if (this.playerStats[position]) {
            this.playerStats[position].totalBids += bidValue;
        }
    }

    /**
     * Add HSI value to a player's stats
     * @param {number} position - Player position (1-4)
     * @param {number} hsi - HSI value to add
     */
    addHSI(position, hsi) {
        if (this.playerStats[position]) {
            this.playerStats[position].totalHSI += hsi;
        }
    }

    getBidCount() {
        return Object.keys(this.bids).length;
    }

    allBidsIn() {
        return this.getBidCount() === 4;
    }

    resetForNewHand(newDealer, newHandSize) {
        this.hands = {};
        this.currentHand = newHandSize;
        this.dealer = newDealer;
        this.bidder = (newDealer % 4) + 1;
        this.currentTurn = this.bidder;

        this.bids = {};
        this.playerBids = [];
        this.team1Mult = 1;
        this.team2Mult = 1;

        this.playedCards = [];
        this.playedCardsIndex = 0;
        this.leadCard = null;
        this.trump = null;
        this.isTrumpBroken = false;
        this.cardIndex = 0;

        this.tricks = { team1: 0, team2: 0 };
        this.rainbows = { team1: 0, team2: 0 };

        // Reset per-hand trick tracking
        this.handTricks = { 1: 0, 2: 0, 3: 0, 4: 0 };
    }

    getSocketIds() {
        return Array.from(this.players.keys());
    }

    // ========================================
    // Resignation Methods
    // ========================================

    /**
     * Resign a player and replace them with a bot
     * @param {number} position - Player's position (1-4)
     * @param {string} botSocketId - Bot's socket ID
     * @param {string} botUsername - Bot's display name
     * @param {number} botPic - Bot's profile pic number
     */
    resignPlayer(position, botSocketId, botUsername, botPic) {
        const oldSocketId = this.positions[position];
        const oldPlayer = this.players.get(oldSocketId);
        if (!oldPlayer) return;

        // Store original player info for stat attribution
        this.resignedPlayers[position] = {
            username: oldPlayer.username,
            pic: oldPlayer.pic,
            resignedAt: Date.now(),
            originalSocketId: oldSocketId
        };

        // Replace player entry with bot data
        this.players.delete(oldSocketId);
        this.players.set(botSocketId, {
            username: botUsername,
            position,
            pic: botPic,
            isBot: true
        });
        this.positions[position] = botSocketId;

        // Transfer hand from old socketId to bot socketId
        if (this.hands[oldSocketId]) {
            this.hands[botSocketId] = this.hands[oldSocketId];
            delete this.hands[oldSocketId];
        }

        this.logAction('resignPlayer', { position, oldUsername: oldPlayer.username, botUsername });
    }

    /**
     * Get original player info for a position (for stat attribution)
     * @param {number} position - Player position (1-4)
     * @returns {Object} - { username, pic } of original human player
     */
    getOriginalPlayer(position) {
        if (this.resignedPlayers[position]) {
            return this.resignedPlayers[position];
        }
        // Lazy mode overwrites the player entry with the bot's name — return
        // the original human for stat/score attribution
        if (this.lazyPlayers[position]) {
            return {
                username: this.lazyPlayers[position].originalUsername,
                pic: this.lazyPlayers[position].originalPic
            };
        }
        return this.getPlayerByPosition(position);
    }

    /**
     * Check if a position has been resigned
     * @param {number} position - Player position (1-4)
     * @returns {boolean}
     */
    isResigned(position) {
        return position in this.resignedPlayers;
    }

    // ========================================
    // Lazy Mode Methods
    // ========================================

    /**
     * Enable lazy mode for a position (bot takes over temporarily)
     * @param {number} position - Player's position (1-4)
     * @param {string} botSocketId - Bot's virtual socket ID
     * @param {string} botUsername - Bot's display name
     * @param {number} botPic - Bot's profile pic number
     * @param {string} personality - Bot personality key
     */
    enableLazyMode(position, botSocketId, botUsername, botPic, personality) {
        const socketId = this.positions[position];
        const player = this.players.get(socketId);
        if (!player) return;

        this.lazyPlayers[position] = {
            botSocketId,
            botUsername,
            botPic,
            originalUsername: player.username,
            originalPic: player.pic,
            originalSocketId: socketId,
            personality
        };

        // Update the player entry to show bot name/pic
        player.username = botUsername;
        player.pic = botPic;

        // Store personality for reuse
        this.assignedPersonality[position] = personality;

        this.logAction('enableLazyMode', { position, botUsername });
    }

    /**
     * Disable lazy mode for a position (player takes back control)
     * @param {number} position - Player's position (1-4)
     */
    disableLazyMode(position) {
        const lazyInfo = this.lazyPlayers[position];
        if (!lazyInfo) return;

        // Restore original player info
        const socketId = this.positions[position];
        const player = this.players.get(socketId);
        if (player) {
            player.username = lazyInfo.originalUsername;
            player.pic = lazyInfo.originalPic;
        }

        delete this.lazyPlayers[position];

        this.logAction('disableLazyMode', { position, restoredUsername: lazyInfo.originalUsername });
    }

    /**
     * Check if a position is in lazy mode
     * @param {number} position - Player position (1-4)
     * @returns {boolean}
     */
    isLazy(position) {
        return position in this.lazyPlayers;
    }

    /**
     * Get the substitute bot info for a lazy position
     * @param {number} position - Player position (1-4)
     * @returns {Object|null} - { botSocketId, botUsername, botPic, personality } or null
     */
    getLazyBot(position) {
        return this.lazyPlayers[position] || null;
    }

    /**
     * Check if a socket belongs to an original player (for rejoin after /leave)
     * @param {string} username - Username to check
     * @returns {number|null} - Position if found in lazy/resigned players, null otherwise
     */
    getOriginalPlayerPosition(username) {
        // Check lazy players
        for (const [pos, info] of Object.entries(this.lazyPlayers)) {
            if (info.originalUsername === username) {
                return Number(pos);
            }
        }
        // Check resigned players
        for (const [pos, info] of Object.entries(this.resignedPlayers)) {
            if (info.username === username) {
                return Number(pos);
            }
        }
        return null;
    }

    // ========================================
    // Spectator Methods
    // ========================================

    /**
     * Add a spectator to the game
     * @param {string} socketId - Spectator's socket ID
     * @param {string} username - Spectator's username
     * @param {number|string} pic - Spectator's profile pic
     */
    addSpectator(socketId, username, pic) {
        this.spectators.set(socketId, { username, pic });
        this.logAction('addSpectator', { socketId, username });
    }

    /**
     * Remove a spectator from the game
     * @param {string} socketId - Spectator's socket ID
     */
    removeSpectator(socketId) {
        this.spectators.delete(socketId);
        this.logAction('removeSpectator', { socketId });
    }

    /**
     * Get all spectators
     * @returns {Array} - Array of { socketId, username, pic }
     */
    getSpectators() {
        const list = [];
        for (const [socketId, info] of this.spectators.entries()) {
            list.push({ socketId, ...info });
        }
        return list;
    }

    /**
     * Check if a socket is a spectator
     * @param {string} socketId - Socket ID to check
     * @returns {boolean}
     */
    isSpectator(socketId) {
        return this.spectators.has(socketId);
    }

    // ========================================
    // Game Log Methods
    // ========================================

    /**
     * Add an entry to the game log
     * @param {string} message - The log message
     * @param {number|null} playerPosition - Player position (1-4) or null for system
     * @param {string} type - Message type: 'system', 'chat', 'bid', 'trick', 'score', 'rainbow'
     */
    addLogEntry(message, playerPosition = null, type = 'system') {
        const entry = {
            message,
            playerPosition,
            type,
            timestamp: Date.now()
        };

        this.gameLog.push(entry);

        // Enforce max entries limit
        if (this.gameLog.length > this.maxLogEntries) {
            this.gameLog.shift();
        }

        this.logAction('addLogEntry', { message: message.slice(0, 50), type });
    }

    /**
     * Get the game log for client
     * @returns {Array} - Array of log entries
     */
    getGameLog() {
        return [...this.gameLog];
    }

    /**
     * Clear the game log
     */
    clearGameLog() {
        this.gameLog = [];
    }

    // ========================================
    // Room Management Methods
    // ========================================

    /**
     * Join all current players to the game room
     * Skips bots as they don't have real socket connections
     * @param {Server} io - Socket.IO server instance
     */
    joinAllToRoom(io) {
        for (const socketId of this.players.keys()) {
            // Skip bots
            if (this.isBot(socketId)) continue;
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                socket.join(this.roomName);
            }
        }
        this.logAction('joinAllToRoom', { roomName: this.roomName, playerCount: this.players.size });
    }

    /**
     * Join a single player to the game room
     * Skips bots as they don't have real socket connections
     * @param {Server} io - Socket.IO server instance
     * @param {string} socketId - Socket ID to join
     */
    joinToRoom(io, socketId) {
        // Skip bots
        if (this.isBot(socketId)) return;
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
            socket.join(this.roomName);
            this.logAction('joinToRoom', { roomName: this.roomName, socketId });
        }
    }

    /**
     * Remove a player from the game room
     * Skips bots as they don't have real socket connections
     * @param {Server} io - Socket.IO server instance
     * @param {string} socketId - Socket ID to remove
     */
    leaveRoom(io, socketId) {
        // Skip bots
        if (this.isBot(socketId)) return;
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
            socket.leave(this.roomName);
            this.logAction('leaveRoom', { roomName: this.roomName, socketId });
        }
    }

    /**
     * Remove all players from the game room
     * Skips bots as they don't have real socket connections
     * @param {Server} io - Socket.IO server instance
     */
    leaveAllFromRoom(io) {
        // Snapshot first: callers may mutate the maps afterwards
        const ids = [...this.players.keys(), ...this.spectators.keys()];
        for (const socketId of ids) {
            // Skip bots
            if (this.isBot(socketId)) continue;
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                socket.leave(this.roomName);
            }
        }
        this.logAction('leaveAllFromRoom', { roomName: this.roomName });
    }

    /**
     * Broadcast an event to all players in this game. Dropped once the game
     * is terminal (nothing is emitted from a dead game).
     * @param {Server} io - Socket.IO server instance
     * @param {string} event - Event name
     * @param {Object} data - Event data
     */
    broadcast(io, event, data) {
        if (this.isTerminal()) {
            gameLogger.debug('emit dropped: terminal', { gameId: this.gameId, event });
            return;
        }
        io.to(this.roomName).emit(event, data);
    }

    /**
     * Send an event to a specific player in the game
     * Skips bots as they don't have real socket connections
     * @param {Server} io - Socket.IO server instance
     * @param {string} socketId - Target socket ID
     * @param {string} event - Event name
     * @param {Object} data - Event data
     */
    sendToPlayer(io, socketId, event, data) {
        if (this.isTerminal()) {
            gameLogger.debug('emit dropped: terminal', { gameId: this.gameId, event });
            return;
        }
        // Skip bots - they don't have real socket connections
        if (this.isBot(socketId)) return;
        io.to(socketId).emit(event, data);
    }

    toJSON() {
        return {
            gameId: this.gameId,
            players: Array.from(this.players.entries()),
            positions: this.positions,
            currentHand: this.currentHand,
            currentTurn: this.currentTurn,
            phase: this.phase,
            bidding: this.bidding,
            stage: this._stage,     // internal only (not in getClientState)
            epoch: this.epoch,
            trump: this.trump,
            isTrumpBroken: this.isTrumpBroken,
            tricks: this.tricks,
            score: this.score,
            rainbows: this.rainbows
        };
    }

    // ========================================
    // Validation Methods
    // ========================================

    /**
     * Validate that it's a player's turn
     * @param {string} socketId - Socket ID of player
     * @returns {{ valid: boolean, error?: string }}
     */
    validateTurn(socketId) {
        const position = this.getPositionBySocketId(socketId);

        if (!position) {
            return { valid: false, error: 'Player not in game' };
        }

        if (position !== this.currentTurn) {
            return { valid: false, error: `Not your turn (current: ${this.currentTurn}, you: ${position})` };
        }

        return { valid: true };
    }

    /**
     * Validate a card play
     * @param {string} socketId - Socket ID of player
     * @param {Object} card - Card being played
     * @returns {{ valid: boolean, error?: string }}
     */
    validateCardPlay(socketId, card) {
        // Check turn
        const turnCheck = this.validateTurn(socketId);
        if (!turnCheck.valid) return turnCheck;

        // Cards are only accepted while a trick is open
        if (this._stage !== Phase.PLAYING) {
            return { valid: false, error: 'Cannot play cards during bidding' };
        }

        // Check card format
        if (!card || !card.suit || !card.rank) {
            return { valid: false, error: 'Invalid card format' };
        }

        // Check player has the card
        const hand = this.getHand(socketId);
        const hasCard = hand.some(c => c.suit === card.suit && c.rank === card.rank);
        if (!hasCard) {
            return { valid: false, error: 'Card not in hand' };
        }

        // Check trick not already complete
        if (this.playedCardsIndex >= 4) {
            return { valid: false, error: 'Trick already complete' };
        }

        return { valid: true };
    }

    /**
     * Validate a bid
     * @param {string} socketId - Socket ID of player
     * @param {*} bid - Bid value
     * @returns {{ valid: boolean, error?: string }}
     */
    validateBid(socketId, bid) {
        // Check turn
        const turnCheck = this.validateTurn(socketId);
        if (!turnCheck.valid) return turnCheck;

        // Check in bidding phase
        if (this._stage !== Phase.BIDDING) {
            return { valid: false, error: 'Not in bidding phase' };
        }

        // Check bid is valid type
        const validBids = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'B', '2B', '3B', '4B'];
        const bidStr = String(bid);
        if (!validBids.includes(bidStr) && typeof bid !== 'number') {
            return { valid: false, error: `Invalid bid value: ${bid}` };
        }

        // Check hasn't already bid
        const position = this.getPositionBySocketId(socketId);
        if (this.bids[position] !== undefined) {
            return { valid: false, error: 'Already bid' };
        }

        return { valid: true };
    }

    /**
     * Validate the game state against the invariants of its current stage.
     * Run on every transition when BAB_FSM_CHECK=1 (tests, chaos runs).
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validateGameState() {
        const errors = [];
        const stage = this._stage;
        const tt = this.tricks.team1 + this.tricks.team2;
        const seatHand = (pos) => this.hands[this.positions[pos]] || [];
        const teamShaped = (b) => !!b && typeof b.team1 === 'number' && typeof b.team2 === 'number';

        if (stage === Phase.CREATED) {
            return { valid: true, errors };
        }
        if (isTerminal(stage)) {
            const pending = this.pendingTimerCount || 0;
            if (pending !== 0) errors.push(`Terminal game has ${pending} pending timers`);
            return { valid: errors.length === 0, errors };
        }

        if (stage === Phase.DRAWING || stage === Phase.DRAW_RESOLVING) {
            if (new Set(this.drawIDs).size !== this.drawIDs.length) {
                errors.push(`Duplicate drawIDs: ${this.drawIDs.join(',')}`);
            }
            if (this.drawIDs.length !== this.drawCards.length || this.drawCards.length !== this.drawIndex) {
                errors.push(`Draw state mismatch: ids=${this.drawIDs.length} cards=${this.drawCards.length} index=${this.drawIndex}`);
            }
            if (this.drawIndex > 4) errors.push(`drawIndex ${this.drawIndex} > 4`);
            if (stage === Phase.DRAW_RESOLVING && this.drawIndex !== 4) {
                errors.push(`DRAW_RESOLVING with drawIndex ${this.drawIndex}`);
            }
            return { valid: errors.length === 0, errors };
        }

        // TEAMS_ANNOUNCED onward: four seats
        if (this.players.size !== 4) errors.push(`Expected 4 players, have ${this.players.size}`);
        for (let pos = 1; pos <= 4; pos++) {
            if (!this.positions[pos]) errors.push(`Position ${pos} not assigned`);
        }

        if (IN_HAND_STAGES.has(stage)) {
            if (tt > this.currentHand) errors.push(`Total tricks (${tt}) exceeds hand size (${this.currentHand})`);
            if (!(this.currentTurn >= 1 && this.currentTurn <= 4)) errors.push(`Invalid currentTurn: ${this.currentTurn}`);
            // The first deal enters DEALING before trump exists
            if (stage !== Phase.DEALING && !this.trump) errors.push(`No trump in ${stage}`);
        }

        switch (stage) {
            case Phase.BIDDING: {
                const n = this.playerBids.filter(b => b != null).length;
                if (n !== Object.keys(this.bids).length) errors.push(`playerBids (${n}) != bids (${Object.keys(this.bids).length})`);
                if (n >= 4) errors.push(`BIDDING with ${n} bids`);
                const expectedTurn = ((this.bidder - 1 + n) % 4) + 1;
                if (this.currentTurn !== expectedTurn) errors.push(`Bid turn ${this.currentTurn}, expected ${expectedTurn}`);
                for (let pos = 1; pos <= 4; pos++) {
                    if (seatHand(pos).length !== this.currentHand) {
                        errors.push(`Seat ${pos} holds ${seatHand(pos).length} cards, expected ${this.currentHand}`);
                    }
                }
                if (this.playedCardsIndex !== 0) errors.push(`playedCardsIndex ${this.playedCardsIndex} during bidding`);
                break;
            }
            case Phase.REDEAL:
                if (!teamShaped(this.bids) || this.bids.team1 !== 0 || this.bids.team2 !== 0) {
                    errors.push(`REDEAL with bids ${JSON.stringify(this.bids)}`);
                }
                break;
            case Phase.PLAYING: {
                if (!teamShaped(this.bids)) errors.push(`PLAYING with bids ${JSON.stringify(this.bids)}`);
                const pci = this.playedCardsIndex;
                if (!(pci >= 0 && pci <= 3)) errors.push(`playedCardsIndex ${pci} while PLAYING`);
                const played = this.playedCards.filter(c => c != null).length;
                if (played !== pci) errors.push(`${played} cards on the table, playedCardsIndex ${pci}`);
                if (this.cardIndex !== tt * 4 + pci) errors.push(`cardIndex ${this.cardIndex}, expected ${tt * 4 + pci}`);
                for (let pos = 1; pos <= 4; pos++) {
                    const expected = this.currentHand - tt - (this.playedCards[pos - 1] ? 1 : 0);
                    if (seatHand(pos).length !== expected) {
                        errors.push(`Seat ${pos} holds ${seatHand(pos).length} cards, expected ${expected}`);
                    }
                }
                if (pci > 0) {
                    const expectedTurn = ((this.leadPosition - 1 + pci) % 4) + 1;
                    if (this.currentTurn !== expectedTurn) errors.push(`Play turn ${this.currentTurn}, expected ${expectedTurn}`);
                }
                break;
            }
            case Phase.TRICK_RESOLVING:
                if (this.playedCardsIndex !== 4 || [0, 1, 2, 3].some(i => !this.playedCards[i])) {
                    errors.push(`TRICK_RESOLVING with ${this.playedCardsIndex} cards`);
                }
                break;
            case Phase.HAND_RESOLVING:
                for (let pos = 1; pos <= 4; pos++) {
                    if (seatHand(pos).length !== 0) errors.push(`Seat ${pos} still holds ${seatHand(pos).length} cards`);
                }
                if (tt !== this.currentHand) errors.push(`Hand resolved with ${tt} of ${this.currentHand} tricks`);
                if (this.playedCardsIndex !== 0) errors.push(`playedCardsIndex ${this.playedCardsIndex} after the last trick`);
                break;
            default:
                break;
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    // ========================================
    // Debug Logging
    // ========================================

    /**
     * Log a state change (only in debug mode)
     * @param {string} action - Action being performed
     * @param {Object} details - Additional details
     */
    logAction(action, details = {}) {
        if (this._debugMode) {
            console.log(`[Game ${this.gameId.slice(0, 8)}] ${action}`, details);
        }
    }

    /**
     * Log current game state summary
     */
    logState() {
        if (!this._debugMode) return;

        console.log(`[Game ${this.gameId.slice(0, 8)}] State:`, {
            phase: this.phase,
            stage: this._stage,
            epoch: this.epoch,
            hand: this.currentHand,
            turn: this.currentTurn,
            bidding: this.bidding,
            tricks: this.tricks,
            score: this.score,
            players: this.players.size
        });
    }

    /**
     * Log validation result
     * @param {string} action - Action that was validated
     * @param {{ valid: boolean, error?: string }} result - Validation result
     */
    logValidation(action, result) {
        if (this._debugMode && !result.valid) {
            console.warn(`[Game ${this.gameId.slice(0, 8)}] Validation failed for ${action}: ${result.error}`);
        }
    }
}

module.exports = GameState;

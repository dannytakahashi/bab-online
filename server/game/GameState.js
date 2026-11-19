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
const SeatState = require('./SeatState');
const {
    Controller,
    Presence,
    RECONNECT_GRACE_MS,
    isBotSocket,
    isLegalCreate,
    checkEdge,
    seatDisplay,
    validateSeats
} = SeatState;
const { buildSnapshotV2 } = require('./snapshotV2');
const pacing = require('./pacing');
const { isValidBid, isLegalPlay, firstLegalCard } = require('./rules');
// The persist store's change hooks (persist/hooks.js): passive, one null
// check while LIVE_PERSIST is off
const persistHooks = require('./persist/hooks');
const { defaultAssist, normalizeAssist } = require('./assistState');

/** game.resume.kind values (snapshot v2 resume.kind) */
const RESUME_KINDS = ['countdown', 'drawReveal', 'seating', 'teams', 'firstTurn', 'trick', 'hand'];

// Games inside restoreFrom (restoreSeats is legal only there) and games
// already restored (restoreFrom runs once, on a fresh GameState). Module
// state, not fields: a restore adds no keys to the game.
const RESTORING = new WeakSet();
const RESTORED = new WeakSet();

// Each game timer's callback and due time ({fn, at}, by key), so the
// reversible self-fence (suspend / unsuspend) can re-arm what it stopped.
// Module state, not a field: setTimer adds no key to the game.
const TIMER_META = new WeakMap();
const timerMeta = (game) => {
    let m = TIMER_META.get(game);
    if (!m) {
        m = new Map();
        TIMER_META.set(game, m);
    }
    return m;
};

// The stages a game is saved and restored in (persist/gameCodec.js): a
// dealt hand with a turn, a trick or a hand result on the table
const RESTORE_STAGES = new Set([Phase.BIDDING, Phase.PLAYING, Phase.TRICK_RESOLVING, Phase.HAND_RESOLVING]);

/** The seat socket a restored human seat is keyed by until its owner returns. */
const restoredSeatSocketId = (gameId, pos) => `restored:${gameId}:${pos}`;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype;

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

        // Seat index: seat socketId → { username, position, pic } (display
        // identity: the owner for a human seat, else the bot)
        this.players = new Map();
        // Position lookup: position (1-4) → seat socketId
        this.positions = {};

        // Hands: socketId → array of cards
        this.hands = {};

        // Game progression
        this.currentHand = 12;     // Cards per player (12 down to 1)
        this.dealer = 1;           // Dealer position (rotates)

        // Lifecycle (authoritative phase; `phase`/`bidding` are getters)
        this._stage = Phase.CREATED;
        this.epoch = 0;            // bumped once when the game ends or aborts
        // Broadcast sequence (contract/README.md R1-R5): +1 per room
        // broadcast and per deal (the gameStart batch). Not dealSeq.
        this.eventSeq = 0;
        this._timers = new Map();  // key -> timeout (setTimer)
        this._pauses = new Set();  // in-flight pause() entries
        // Server-timed hold in progress (hold / scheduleResume): {kind, at}
        // with `at` a server Date.now(); non-null exactly while one is open
        this.resume = null;
        this._history = shouldCheckInvariants() ? [Phase.CREATED] : null;
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
        // This deal's won tricks, in order: {winner, lead, cards} (cards in
        // play order from the lead). Written with the trick count
        // (resumeTrick) and reset with it, so a snapshot can show them
        this.trickHistory = [];
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
        // The name playerDrew showed for each draw, in draw order (snapshot v2)
        this.drawNames = [];

        // Seat records (SeatState.js): position -> who controls the seat and
        // whether its owner is present. `players` / `positions` above are the
        // derived index, written only by the seat transitions.
        this.seats = { 1: null, 2: null, 3: null, 4: null };
        // Position of the last room-wide resignationAvailable (single-slot
        // clients), or null
        this.offerPos = null;
        // The idle-seat offer at a tournament table (seatLifecycle.offerIdle):
        // {pos, turn} while the other present owners hold it, or null
        this.idleOffer = null;
        // The turn watchdog's clock: {pos, turn, deadline} of the turn it was
        // last armed for, so /lazy then /active resumes it (seatLifecycle.armAfk)
        this.afkClock = null;
        // The bid clock (socket/bidClock.js): {pos, turn, startAt, endAt,
        // durationMs, running, toppedUp} of the bid turn it was last armed
        // for, or null; and each seat's timeouts in a row ({pos: n}, the
        // strike rule). Both DERIVED: never saved, fresh after a restore
        this.bidClock = null;
        this.bidTimeouts = {};
        // /help per position (assistState.js): who asked, how many counted
        // uses, the turn of the last one. SAVED (gameCodec CODEC_V 2)
        this.assist = defaultAssist();
        this._seatHistory = this._history ? [] : null;

        // HSI values for current hand (position → hsi), stored for reconnection
        this.hsiValues = {};

        // Spectators: socketId → { username, pic }
        this.spectators = new Map();

        // Game log for reconnection restoration. A chat line also holds its
        // sender's username as `from` (internal: snapshotV2 maps each entry
        // to {message, type, position, at}, so it never reaches the wire;
        // the snapshot uses it to leave out chat the viewer has blocked).
        // logTotal counts every line ever added (the log keeps the last
        // maxLogEntries), so a writer can tell which lines are new.
        this.gameLog = [];
        this.maxLogEntries = 500;
        this.logTotal = 0;
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

    /** Identifies the open turn: changes with every bid, card and deal. */
    turnKey() {
        return `${this.dealSeq || 0}|${this._stage}|${this.currentTurn}|${this.getBidCount()}|${this.cardIndex}`;
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
        persistHooks.gameChanged(this);
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
        // Ended while suspended: nothing remembered or deferred runs
        if (this._suspended) this._suspended = null;
        this.resume = null;
        if (this.bidClock) this.bidClock.running = false;  // its timer is gone; nothing emitted
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
        if (this.isTerminal() || this.frozen) return Promise.resolve(false);
        const e = this.epoch;
        return new Promise((resolve) => {
            const entry = { timer: null, resolve, at: Date.now() + ms, left: null, fire: null };
            entry.fire = () => {
                // The store's self-fence check first ('on'): a pause that
                // fires into a just-suspended game waits for the thaw
                // (suspend() kept it in _pauses with 0 ms left)
                persistHooks.beforeRun(this);
                if (this._suspended) return;
                this._pauses.delete(entry);
                resolve(this.epoch === e);
            };
            // Suspended (self-fence): the wait starts when the game thaws
            if (this._suspended) entry.left = ms;
            else entry.timer = setTimeout(entry.fire, ms);
            this._pauses.add(entry);
        });
    }

    /**
     * Presentation hold for a linear lifecycle chain (server/game/pacing.js):
     * like pause(), and game.resume = {kind, at} while it runs.
     * `if (!(await game.hold(kind, ms))) return;`
     * @param {string} kind - one of RESUME_KINDS
     * @param {number} ms
     * @param {string} [traceKind=kind] - pacing.trace component
     * @returns {Promise<boolean>}
     */
    hold(kind, ms, traceKind = kind) {
        if (this.isTerminal() || this.frozen) return Promise.resolve(false);
        pacing.trace(traceKind, ms, this);
        this.resume = { kind, at: Date.now() + ms };
        if (this._suspended) this._suspended.resumeLeft = ms;
        return this.pause(ms).then((ok) => {
            if (this.resume && this.resume.kind === kind) this.resume = null;
            return ok;
        });
    }

    /**
     * Presentation hold that ends in a scheduled transition: the 'resume'
     * game timer runs `fn` after `ms` (skipped after end/abort; errors are
     * logged), and game.resume = {kind, at} until then. The caller returns
     * at once: the table state is authoritative throughout the hold, and
     * `fn` re-checks the stage it expects.
     * @returns {boolean} false if the game is terminal
     */
    scheduleResume(kind, ms, fn, traceKind = kind) {
        if (this.isTerminal() || this.frozen) return false;
        pacing.trace(traceKind, ms, this);
        this.resume = { kind, at: Date.now() + ms };
        if (this._suspended) this._suspended.resumeLeft = ms;
        return this.setTimer('resume', ms, () => {
            this.resume = null;
            return fn();
        });
    }

    /**
     * cardPlayed payload (both emit sites: gameHandlers.playCard and
     * BotController.processBotPlay). Call after the card is recorded. The
     * card that completes a trick carries resumeInMs (additive): how long
     * the server holds the full trick before trickComplete.
     */
    cardPlayedPayload(card, position) {
        // trumpBroken: the name both 1.1.0 (trumpBroken ?? trump) and web
        // read. The old `trump` Bool and `playerId` (a socket id no client
        // read) are gone (V1_REMOVALS #10)
        const payload = { card, position, trumpBroken: this.isTrumpBroken };
        if (this.playedCardsIndex === 4) payload.resumeInMs = pacing(this).TRICK_VIEW_MS;
        return payload;
    }

    /** {kind, inMs} of the open hold (inMs relative to `now`), or null. */
    resumeInfo(now = Date.now()) {
        return this.resume ? { kind: this.resume.kind, inMs: Math.max(0, Math.round(this.resume.at - now)) } : null;
    }

    /**
     * The running bid clock as snapshot v2 carries it ({position, inMs,
     * durationMs}, inMs relative to `now`), or null (none, still in its
     * pre-wait, or stopped).
     */
    bidClockInfo(now = Date.now()) {
        const c = this.bidClock;
        if (!c || !c.running || !this.hasTimer('bidClock')) return null;
        return { position: c.pos, inMs: Math.max(0, Math.round(c.endAt - now)), durationMs: c.durationMs };
    }

    /**
     * Named one-shot timer owned by this game (replaces any timer under the
     * same key). The callback is skipped if the game ended/aborted (or was
     * frozen) meanwhile; sync throws and async rejections are logged, never
     * uncaught. A run that throws marks the game tainted (markTainted: the
     * persist codec will not save it) and a clean run clears it.
     */
    setTimer(key, ms, fn) {
        this.clearTimer(key);
        if (this.isTerminal() || this.frozen) return false;
        // Suspended (self-fence): remembered, armed with its full time on
        // thaw (`since`: its time starts then, not at the suspension)
        if (this._suspended) {
            this._suspended.timers.set(key, { fn, ms, since: Date.now() });
            return true;
        }
        const e = this.epoch;
        const meta = timerMeta(this);
        const timer = setTimeout(() => {
            this._timers.delete(key);
            meta.delete(key);
            if (this.epoch !== e || this.isTerminal()) return;
            // The store's self-fence check first ('on'): a timer that fires
            // into a just-suspended game is remembered for the thaw instead
            persistHooks.beforeRun(this);
            if (this._suspended) {
                this._suspended.timers.set(key, { fn, ms: 0 });
                return;
            }
            Promise.resolve().then(fn).then(() => this.markTainted(false), (err) => {
                this.markTainted(true);
                gameLogger.error('Game timer failed', { gameId: this.gameId, key, error: err.message, stack: err.stack });
            });
        }, ms);
        this._timers.set(key, timer);
        meta.set(key, { fn, at: Date.now() + ms });
        return true;
    }

    clearTimer(key) {
        const timer = this._timers.get(key);
        if (timer !== undefined) {
            clearTimeout(timer);
            this._timers.delete(key);
        }
        TIMER_META.get(this)?.delete(key);
        if (this._suspended) this._suspended.timers.delete(key);
    }

    /** A timer is pending under `key` (one remembered by a suspension counts). */
    hasTimer(key) {
        return this._timers.has(key) || !!this._suspended?.timers.has(key);
    }

    get pendingTimerCount() {
        return this._timers.size + this._pauses.size + (this._suspended ? this._suspended.timers.size : 0);
    }

    _cancelAllTimers() {
        for (const timer of this._timers.values()) clearTimeout(timer);
        this._timers.clear();
        TIMER_META.get(this)?.clear();
        if (this._suspended) this._suspended.timers.clear();
        for (const entry of this._pauses) {
            clearTimeout(entry.timer);
            entry.resolve(false);
        }
        this._pauses.clear();
    }

    /**
     * The holder self-fence (deploy survival, plan 2.1; the persist store
     * calls it when its heartbeats stop being acknowledged): the game stops
     * in place, REVERSIBLY. Unlike freeze() the epoch stays, so every
     * captured continuation stays valid: each game timer and pause is
     * cancelled and remembered with what was left of it, the bots' pending
     * actions likewise (BotController.suspendGame), and from now on nothing
     * is emitted (broadcast, sendToPlayer, ... are no-ops: no seq is used;
     * the one exception is the store's pause / resume line, unsavedNotice),
     * no turn input is accepted (applyBid / checkPlay refuse as
     * not_your_turn), a seat command (/lazy, /active, /leave, forceResign)
     * waits for the thaw (seatLifecycle.holdForThaw, deferWhileSuspended),
     * a timer, pause or bot action started meanwhile is only remembered, an abort waits (gameLifecycle.abortGame defers it to
     * the thaw) and the codec refuses to save the game. Not terminal, not
     * frozen. unsuspend(io) puts it all back.
     * @returns {boolean} false if already suspended, frozen or terminal
     */
    suspend() {
        if (this._suspended || this.frozen || this.isTerminal()) return false;
        const now = Date.now();
        const timers = new Map();
        const meta = TIMER_META.get(this);
        for (const [key, timer] of this._timers) {
            clearTimeout(timer);
            const m = meta?.get(key);
            if (m) timers.set(key, { fn: m.fn, ms: Math.max(0, m.at - now) });
        }
        this._timers.clear();
        meta?.clear();
        for (const entry of this._pauses) {
            if (entry.timer === null) continue;
            clearTimeout(entry.timer);
            entry.timer = null;
            entry.left = Math.max(0, entry.at - now);
        }
        this._suspended = {
            at: now,
            timers,
            deferred: [],
            ends: false,   // a deferred abort is queued (abortOnThaw)
            resumeLeft: this.resume ? Math.max(0, this.resume.at - now) : null,
            bidClock: this.bidClock,
            afkClock: this.afkClock,
            // What the room was last told (presence and the resign offer):
            // nothing is emitted meanwhile, the thaw re-announces what changed
            // (seatLifecycle.afterSuspend)
            seats: new Map(this.seatList().map(seat => [seat.position, {
                absent: seat.presence === Presence.GRACE || seat.presence === Presence.RESIGNABLE,
                controller: seat.controller
            }])),
            offerPos: this.offerPos
        };
        require('./bot').botController.suspendGame(this.gameId);
        gameLogger.info('Game suspended', { gameId: this.gameId, stage: this._stage });
        return true;
    }

    /**
     * A system game-log line to the room (players, lazy watchers,
     * spectators) that is NOT kept: never added to gameLog, so it is in no
     * snapshot, no saved doc and no logTotal, and no persist hook runs. It
     * carries the next seq (++eventSeq, R1), exactly like the shutdown
     * notice to a frozen table (utils/shutdown.js noticeGames): every
     * client's gate applies it as the next event, and any later snapshot's
     * seq already counts it (a seq reused by the next broadcast would be
     * dropped as a duplicate, R2). Unlike broadcast it is sent while the
     * game is suspended (the self-fence notices are its only callers
     * there); never from a terminal game. Draws no RNG.
     * @param {Object} io
     * @param {string} message
     * @returns {boolean} true if sent
     */
    unsavedNotice(io, message) {
        if (!io || this.isTerminal()) return false;
        io.to(this.roomName).emit('gameLogEntry', { message, type: 'system', seq: ++this.eventSeq });
        return true;
    }

    /** True between suspend() and unsuspend() (the holder self-fence). */
    get isSuspended() {
        return !!this._suspended;
    }

    /**
     * Run `fn` when the game thaws (unsuspend) instead of now. Only while
     * suspended: returns false (and does nothing) otherwise. `ends`: `fn`
     * ends the game (gameLifecycle.abortGame's deferred abort), so the
     * thaw is no real resume (abortOnThaw; the store sends no resume line).
     * @param {Function} fn
     * @param {{ends?: boolean}} [opts]
     */
    deferWhileSuspended(fn, { ends = false } = {}) {
        if (!this._suspended) return false;
        this._suspended.deferred.push(fn);
        if (ends) this._suspended.ends = true;
        return true;
    }

    /**
     * True while suspended with a deferred abort queued (deferWhileSuspended
     * with ends): the thaw runs it straight after re-arming, so the table
     * does not really play on. Read it BEFORE unsuspend (false after).
     */
    get abortOnThaw() {
        return this._suspended?.ends === true;
    }

    /**
     * Undo suspend(): the game goes on as if the suspension had not lasted.
     * Every remembered timer, pause and bot action is armed again with
     * what was left of it (a timer started meanwhile with its full time),
     * in due order; the open hold's deadline (resume), the AFK clock and
     * the seats' grace deadlines move by the suspended time. The bid clock
     * is never re-armed from its raw timer: bidClock.afterSuspend runs
     * bidClock.onTurn (its same-turn resume, the clock's own deadline moved
     * by the suspended time), which arms it again and announces a running
     * clock anew (after a `stopped`: the clients' countdown ran on). The
     * human seats' presence that changed meanwhile, and the resign offer if
     * it moved, are announced again (seatLifecycle.afterSuspend: the room
     * heard nothing while suspended). What was deferred meanwhile (aborts,
     * held seat commands: deferWhileSuspended) runs last, in arrival order,
     * each in its own microtask after this returns (so after the store's
     * resume line). A game frozen or ended meanwhile just drops it all.
     * @param {Object} io
     * @returns {boolean} false if it was not suspended
     */
    unsuspend(io) {
        const s = this._suspended;
        if (!s) return false;
        this._suspended = null;
        const botController = require('./bot').botController;
        if (this.frozen || this.isTerminal()) {
            botController.resumeGame(this.gameId, { drop: true });
            return true;
        }
        const now = Date.now();
        const dt = Math.max(0, now - s.at);
        if (this.resume && s.resumeLeft != null) this.resume.at = now + s.resumeLeft;
        if (this.bidClock && this.bidClock === s.bidClock) {
            this.bidClock.startAt += dt;
            this.bidClock.endAt += dt;
        }
        if (this.afkClock && this.afkClock === s.afkClock) this.afkClock.deadline += dt;
        // A seat's grace is RECONNECT_GRACE_MS of unsuspended time: its
        // deadline and the absence it counts from move together, by the
        // suspended time it lived through (a grace begun while suspended,
        // armed with its full time now: from when it began)
        for (const seat of this.seatList()) {
            const grace = s.timers.get('grace:' + seat.position);
            if (seat.graceDeadline == null || !grace) continue;
            const shift = Math.max(0, now - (grace.since ?? s.at));
            seat.graceDeadline += shift;
            if (seat.absentSince != null) seat.absentSince += shift;
        }
        // Everything stopped, back in due order (ties: timers, pauses, bots)
        const due = [];
        for (const [key, t] of s.timers) {
            if (key !== 'bidClock') due.push({ ms: t.ms, arm: () => this.setTimer(key, t.ms, t.fn) });
        }
        for (const entry of this._pauses) {
            if (entry.timer !== null) continue;
            const ms = entry.left ?? 0;
            due.push({
                ms,
                arm: () => {
                    entry.at = Date.now() + ms;
                    entry.left = null;
                    entry.timer = setTimeout(entry.fire, ms);
                }
            });
        }
        for (const b of botController.resumeGame(this.gameId)) due.push(b);
        due.sort((a, b) => a.ms - b.ms);
        for (const d of due) d.arm();
        if (s.timers.has('bidClock')) require('../socket/bidClock').afterSuspend(io, this);
        // The presence changed meanwhile, and the resign offer if it moved, to
        // the room (a grace begun meanwhile: its owner dropped again). Not
        // when the deferred abort runs straight after (abortOnThaw)
        if (io && !s.ends) {
            const regraced = new Set();
            for (const [key, t] of s.timers) {
                if (key.startsWith('grace:') && t.since != null) regraced.add(Number(key.slice(6)));
            }
            require('../socket/seatLifecycle').afterSuspend(io, this, { seats: s.seats, offerPos: s.offerPos, regraced });
        }
        gameLogger.info('Game unsuspended', { gameId: this.gameId, stage: this._stage, ms: dt });
        // Changes made while suspended were not saved
        persistHooks.gameChanged(this);
        for (const fn of s.deferred) {
            Promise.resolve().then(fn).catch((err) =>
                gameLogger.error('Deferred action failed', { gameId: this.gameId, error: err.message, stack: err.stack }));
        }
        return true;
    }

    /**
     * Stop the game in place for a deploy handoff (deploy survival; nothing
     * calls it before the persist store lands): the epoch bumps (every
     * captured aliveCheck, pause and bot timer goes stale), every game timer
     * and pause is cancelled, resume is cleared, and from now on nothing is
     * emitted (broadcast, sendToPlayer, ...) and no timer, pause or hold can
     * start. Not terminal: the stage and the table stay as they are, for the
     * codec. Idempotent.
     *
     * ONE-WAY, for the handoff only (the doc was flushed and this process
     * gives the table up): there is no thaw, the codec refuses a frozen
     * game for good, and the epoch bump has already ended every in-flight
     * continuation (draw / seating / firstTurn holds resolve false) and the
     * resume, afk, grace and stall timers, so a frozen game cannot simply
     * run on. Never use it for the holder self-fence (plan 2.1: freeze while
     * heartbeats fail, thaw once ownership re-reads as ours): that is
     * suspend() / unsuspend(io) below, which keep the epoch. Freezing a
     * suspended game (suspended, then fenced) drops what it remembered.
     * @returns {boolean} false if already frozen or terminal
     */
    freeze() {
        if (this.frozen || this.isTerminal()) return false;
        this.frozen = true;
        this.epoch++;
        this._cancelAllTimers();
        if (this._suspended) {
            // Suspended, then fenced: nothing remembered ever runs
            this._suspended = null;
            require('./bot').botController.resumeGame(this.gameId, { drop: true });
        }
        this.resume = null;
        if (this.bidClock) this.bidClock.running = false;
        gameLogger.info('Game frozen', { gameId: this.gameId, stage: this._stage });
        return true;
    }

    /**
     * A run of this game's code threw (true: a game timer, a bot action or a
     * turn continuation; its state may be half-written) or one completed
     * cleanly (false). The persist codec refuses a tainted game, keeping
     * its last good doc. Set only on a change, so a game that never threw
     * never has the field.
     */
    markTainted(tainted) {
        if (tainted) this._tainted = true;
        else if (this._tainted) this._tainted = false;
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
     * clamped into the deck) for `socketId`. `username` is the name the
     * caller broadcasts in playerDrew (kept for snapshot v2).
     * @returns {{card: Object, drawOrder: number}|null} null when refused
     *   (not drawing, no deck, duplicate drawer, or 4 draws already in)
     */
    recordDraw(socketId, index, username = null) {
        if (this._stage !== Phase.DRAWING || !this.deck || this.deck.cards.length === 0) return null;
        if (this.drawIDs.includes(socketId) || this.drawIDs.length >= 4) return null;
        const n = this.deck.cards.length;
        let i = index == null ? Math.floor(Math.random() * n) : Math.floor(Number(index));
        if (!Number.isFinite(i)) i = 0;
        i = Math.max(0, Math.min(n - 1, i));
        const [card] = this.deck.cards.splice(i, 1);
        this.drawCards.push(card);
        this.drawIDs.push(socketId);
        this.drawNames.push(username);
        this.drawIndex++;
        return { card, drawOrder: this.drawIndex };
    }

    // ========================================
    // Seats (see SeatState.js)
    // ========================================

    /**
     * Seat a socket (handleDrawComplete and test fixtures). Thin wrapper over
     * createSeat: a bot gets a native bot seat, anyone else a connected
     * human seat.
     */
    addPlayer(socketId, username, position, pic, isBot = false) {
        if (isBot) {
            const { botController } = require('./bot');
            const b = botController.getBot(this.gameId, socketId);
            return this.createSeat(position, {
                controller: Controller.BOT,
                bot: { socketId, username, pic, personality: b?.personality ?? null }
            });
        }
        return this.createSeat(position, {
            controller: Controller.HUMAN,
            presence: Presence.CONNECTED,
            ownerUsername: username,
            ownerPic: pic,
            ownerSocketId: socketId
        });
    }

    // ---------- seat queries (callers must not mutate the records) ----------

    seat(pos) {
        return this.seats[pos] || null;
    }

    seatList() {
        const list = [];
        for (let pos = 1; pos <= 4; pos++) {
            if (this.seats[pos]) list.push(this.seats[pos]);
        }
        return list;
    }

    seatPresence(pos) {
        return this.seats[pos]?.presence ?? null;
    }

    seatController(pos) {
        return this.seats[pos]?.controller ?? null;
    }

    /** The position whose seat socket (positions/players/hands key) is `sid`. */
    seatBySocket(sid) {
        return this.players.get(sid)?.position ?? null;
    }

    /** The position whose owner's live socket is `sid`. */
    seatByOwnerSocket(sid) {
        if (sid == null) return null;
        for (const s of this.seatList()) {
            if (s.ownerSocketId === sid) return s.position;
        }
        return null;
    }

    /** The position owned by `username` (human, lazy or resigned). */
    seatByUsername(username) {
        if (username == null) return null;
        for (const s of this.seatList()) {
            if (s.ownerUsername === username) return s.position;
        }
        return null;
    }

    /** The seat's owner has a live socket attached (seat or watch view). */
    isHumanPresent(pos) {
        return this.seats[pos]?.presence === Presence.CONNECTED;
    }

    hasPresentHuman() {
        return this.seatList().some(s => s.presence === Presence.CONNECTED);
    }

    /** The owner is not here now but may still come back. */
    isReturnable(pos) {
        const p = this.seats[pos]?.presence;
        return p === Presence.GRACE || p === Presence.RESIGNABLE || p === Presence.AWAY;
    }

    /** Resignable seats, oldest resignableAt first. */
    resignablePositions() {
        return this.seatList()
            .filter(s => s.presence === Presence.RESIGNABLE)
            .sort((a, b) => (a.resignableAt - b.resignableAt) || (a.position - b.position))
            .map(s => s.position);
    }

    isBotControlled(pos) {
        const s = this.seats[pos];
        return !!s && s.controller !== Controller.HUMAN;
    }

    /** The legacy wire notion of "lazy" (lazyPositions / isLazy). */
    wireLazy(pos) {
        const s = this.seats[pos];
        if (!s) return false;
        return s.controller === Controller.LAZY_BOT ||
            (s.controller === Controller.RESIGN_BOT && s.presence === Presence.CONNECTED);
    }

    /** The human behind a seat (stats, tournament scoring); else the display entry. */
    getOriginalPlayer(position) {
        const s = this.seats[position];
        if (s?.ownerUsername) return { username: s.ownerUsername, pic: s.ownerPic };
        return this.getPlayerByPosition(position);
    }

    /** Internal per-seat presence projection (logs, chaos dumps). Never emitted. */
    presenceSummary() {
        return [1, 2, 3, 4].map((pos) => {
            const s = this.seats[pos];
            if (!s) return null;
            return {
                position: pos,
                controller: s.controller,
                presence: s.presence,
                owner: s.ownerUsername,
                ownerSocketId: s.ownerSocketId,
                ownerView: s.ownerView,
                seatSocketId: s.seatSocketId,
                bot: s.bot?.username ?? null,
                graceDeadline: s.graceDeadline,
                resignableAt: s.resignableAt,
                offer: this.offerPos === pos,
                idleOffer: this.idleOffer?.pos === pos
            };
        });
    }

    timerKeys() {
        const keys = Array.from(this._timers.keys());
        if (this._suspended) for (const k of this._suspended.timers.keys()) keys.push(k);
        return keys;
    }

    // ---------- seat transitions: the only writers of seats/positions/players ----------

    /** Write the derived index (positions / players) for a seat. */
    _indexSeat(pos) {
        const s = this.seats[pos];
        const d = seatDisplay(s);
        this.positions[pos] = s.seatSocketId;
        this.players.set(s.seatSocketId, { username: d.username, position: pos, pic: d.pic });
    }

    /** Move the seat (hand, index entry) to a new seat socket. */
    _rekeySeat(pos, newSid) {
        const s = this.seats[pos];
        const old = this.positions[pos];
        if (old !== undefined && old !== newSid) {
            if (this.hands[old]) {
                this.hands[newSid] = this.hands[old];
                delete this.hands[old];
            }
            this.players.delete(old);
        }
        this.positions[pos] = newSid;
        s.seatSocketId = newSid;
    }

    _afterSeat(pos, event) {
        const s = this.seats[pos];
        if (this._seatHistory) this._seatHistory.push(`${pos}:${event}:${s.controller}/${s.presence}`);
        this.logAction('seat', { position: pos, event, controller: s.controller, presence: s.presence });
        if (shouldCheckInvariants()) {
            const errors = validateSeats(this);
            if (errors.length > 0) reportViolation('seat-invariant', { gameId: this.gameId, pos, event, errors });
        }
        persistHooks.gameChanged(this);
    }

    /** Check an edge; report and return null when illegal. */
    _seatEdge(pos, event) {
        const seat = this.seats[pos];
        const r = checkEdge(seat, event);
        if (!r.ok) {
            reportViolation('seat-illegal', {
                gameId: this.gameId, pos, event,
                controller: seat?.controller ?? null, presence: seat?.presence ?? null
            });
            return null;
        }
        return r.to;
    }

    _applySeatEdge(pos, to) {
        const s = this.seats[pos];
        // The turn watchdog (seatLifecycle.armAfk) only runs for a connected
        // human: a controller change or the owner dropping ends it
        if (s.controller !== to.controller || to.presence !== Presence.CONNECTED) this.clearTimer('afk:' + pos);
        // The bid clock only runs for a human controller (presence does not
        // matter). Safety net: bidClock.onTurn emits the stop right after
        if (s.controller !== to.controller && this.bidClock && this.bidClock.pos === pos) this.clearTimer('bidClock');
        s.controller = to.controller;
        s.presence = to.presence;
    }

    _botRecord(bot) {
        return { socketId: bot.socketId, username: bot.username, pic: bot.pic ?? null, personality: bot.personality ?? null };
    }

    /**
     * Create the record for an empty seat. Legal starts: human/connected,
     * human/grace (needs init.onGraceExpire; the grace timer starts now),
     * bot/none, resignBot/gone (a draw-phase leaver). The 4th seat ends the
     * pre-seating phase (entrants = null).
     */
    createSeat(pos, init) {
        const controller = init.controller;
        const presence = init.presence ?? (controller === Controller.BOT ? Presence.NONE : Presence.CONNECTED);
        if (this.seats[pos] || !isLegalCreate(controller, presence)) {
            reportViolation('seat-illegal', {
                gameId: this.gameId, pos, event: 'create', controller, presence, occupied: !!this.seats[pos]
            });
            return false;
        }
        const now = Date.now();
        const human = controller === Controller.HUMAN;
        const seat = {
            position: pos,
            controller,
            presence,
            ownerUsername: controller === Controller.BOT ? null : (init.ownerUsername ?? null),
            ownerPic: controller === Controller.BOT ? null : (init.ownerPic ?? null),
            ownerSocketId: presence === Presence.CONNECTED ? init.ownerSocketId : null,
            ownerView: null,
            seatSocketId: human ? (init.ownerSocketId ?? init.seatSocketId) : init.bot.socketId,
            bot: human ? null : this._botRecord(init.bot),
            lastPersonality: human ? null : (init.bot.personality ?? null),
            absentSince: null,
            graceDeadline: null,
            resignableAt: null,
            resignedAt: null,
            leftAt: null
        };
        if (presence === Presence.GRACE) {
            seat.absentSince = now;
            seat.graceDeadline = now + RECONNECT_GRACE_MS;
        }
        if (controller === Controller.RESIGN_BOT) {
            seat.absentSince = now;
            seat.resignedAt = init.resignedAt ?? now;
            seat.leftAt = init.leftAt ?? now;
        }
        this.seats[pos] = seat;
        if (presence === Presence.GRACE) this.setTimer('grace:' + pos, RECONNECT_GRACE_MS, init.onGraceExpire || (() => {}));
        this._indexSeat(pos);
        if (this.seatList().length === 4) this.entrants = null;
        this._afterSeat(pos, 'create');
        return true;
    }

    /**
     * The owner's socket `sid` dropped. A no-op (null) unless `sid` is the
     * seat's current owner socket (a stale socket, or a second call).
     * Human seat -> grace (starts grace:<pos>); bot-controlled -> away.
     * @returns {string|null} the new presence
     */
    seatDisconnect(pos, sid, { onGraceExpire } = {}) {
        const seat = this.seats[pos];
        if (!seat || sid == null || sid !== seat.ownerSocketId) return null;
        const to = this._seatEdge(pos, 'disconnect');
        if (!to) return null;
        const now = Date.now();
        this._applySeatEdge(pos, to);
        seat.ownerSocketId = null;
        seat.ownerView = null;
        seat.absentSince = now;
        if (to.presence === Presence.GRACE) {
            seat.graceDeadline = now + RECONNECT_GRACE_MS;
            this.setTimer('grace:' + pos, RECONNECT_GRACE_MS, onGraceExpire || (() => {}));
        }
        this._indexSeat(pos);
        this._afterSeat(pos, 'disconnect');
        return to.presence;
    }

    /** human/grace -> human/resignable (its grace timer fired). */
    seatGraceExpired(pos) {
        const to = this._seatEdge(pos, 'graceExpired');
        if (!to) return false;
        const seat = this.seats[pos];
        this._applySeatEdge(pos, to);
        this.clearTimer('grace:' + pos);
        seat.resignableAt = Date.now();
        seat.graceDeadline = null;
        this._indexSeat(pos);
        this._afterSeat(pos, 'graceExpired');
        return true;
    }

    /**
     * The owner of a human seat is back on socket `sid` (from grace,
     * resignable, or connected on another socket: the newest socket owns
     * the seat). Clears its grace timer and the abandon timer.
     * @returns {string|null} the previous seat socket
     */
    seatReconnect(pos, sid) {
        const seat = this.seats[pos];
        if (seat && seat.presence === Presence.CONNECTED && sid === seat.ownerSocketId) {
            reportViolation('seat-illegal', { gameId: this.gameId, pos, event: 'reconnect', controller: seat.controller, presence: seat.presence, sameSocket: true });
            return null;
        }
        const to = this._seatEdge(pos, 'reconnect');
        if (!to) return null;
        const old = seat.seatSocketId;
        this._applySeatEdge(pos, to);
        this._rekeySeat(pos, sid);
        this.clearTimer('grace:' + pos);
        this.clearTimer('abandon');
        seat.ownerSocketId = sid;
        seat.absentSince = null;
        seat.graceDeadline = null;
        seat.resignableAt = null;
        this._indexSeat(pos);
        this._afterSeat(pos, 'reconnect');
        return old;
    }

    /**
     * The owner of a bot-controlled seat attaches socket `sid` to watch it
     * (rejoin / spectate). Clears the abandon timer.
     * @returns {string|null} the previous owner socket when it differs from
     *   `sid` (the caller demotes it)
     */
    seatWatch(pos, sid) {
        const to = this._seatEdge(pos, 'watch');
        if (!to) return null;
        const seat = this.seats[pos];
        const prev = seat.ownerSocketId;
        this._applySeatEdge(pos, to);
        this.clearTimer('abandon');
        seat.ownerSocketId = sid;
        seat.ownerView = 'watch';
        seat.absentSince = null;
        this._indexSeat(pos);
        this._afterSeat(pos, 'watch');
        return prev && prev !== sid ? prev : null;
    }

    /**
     * human/connected -> lazyBot/connected: `bot` plays the seat (now keyed
     * by its socket); the owner keeps watching from its own socket.
     * @returns {string|null} the old seat socket (the owner's)
     */
    seatGoLazy(pos, bot) {
        const to = this._seatEdge(pos, 'goLazy');
        if (!to) return null;
        const seat = this.seats[pos];
        const old = seat.seatSocketId;
        this._applySeatEdge(pos, to);
        this._rekeySeat(pos, bot.socketId);
        seat.bot = this._botRecord(bot);
        seat.ownerView = 'seat';
        seat.lastPersonality = seat.bot.personality;
        this._indexSeat(pos);
        this._afterSeat(pos, 'goLazy');
        return old;
    }

    /**
     * lazyBot|resignBot/connected -> human/connected, only from the owner
     * socket `sid`, which becomes the seat socket again.
     * @returns {{bot: Object, ownerView: string}|null} the released bot and
     *   the view the owner had
     */
    seatGoActive(pos, sid) {
        const seat = this.seats[pos];
        if (!seat || sid == null || sid !== seat.ownerSocketId) {
            reportViolation('seat-illegal', { gameId: this.gameId, pos, event: 'goActive', controller: seat?.controller ?? null, presence: seat?.presence ?? null, notOwner: true });
            return null;
        }
        const to = this._seatEdge(pos, 'goActive');
        if (!to) return null;
        const released = { bot: seat.bot, ownerView: seat.ownerView };
        this._applySeatEdge(pos, to);
        this._rekeySeat(pos, sid);
        seat.bot = null;
        seat.ownerView = null;
        seat.resignedAt = null;
        seat.absentSince = null;
        this._indexSeat(pos);
        this._afterSeat(pos, 'goActive');
        return released;
    }

    /**
     * human/resignable -> resignBot/away: `bot` takes the seat.
     * @returns {string|null} the old (dead) seat socket
     */
    seatResign(pos, bot) {
        const to = this._seatEdge(pos, 'resign');
        if (!to) return null;
        const seat = this.seats[pos];
        const old = seat.seatSocketId;
        this._applySeatEdge(pos, to);
        this._rekeySeat(pos, bot.socketId);
        seat.bot = this._botRecord(bot);
        seat.lastPersonality = seat.bot.personality;
        seat.resignedAt = Date.now();
        seat.resignableAt = null;
        seat.graceDeadline = null;
        this._indexSeat(pos);
        this._afterSeat(pos, 'resign');
        return old;
    }

    /** lazyBot|resignBot/{connected, away} -> gone: the owner left for good. */
    seatLeave(pos) {
        const to = this._seatEdge(pos, 'leave');
        if (!to) return false;
        const seat = this.seats[pos];
        const now = Date.now();
        this._applySeatEdge(pos, to);
        seat.ownerSocketId = null;
        seat.ownerView = null;
        seat.leftAt = now;
        if (seat.absentSince == null) seat.absentSince = now;
        this._indexSeat(pos);
        this._afterSeat(pos, 'leave');
        return true;
    }

    /**
     * Test-only fixture helper: put a seat straight into any state. Owner
     * fields not given keep the previous record's.
     */
    forceSeat(pos, init) {
        if (process.env.NODE_ENV !== 'test') throw new Error('forceSeat is test-only');
        const prev = this.seats[pos] || null;
        const controller = init.controller;
        const presence = init.presence ?? (controller === Controller.BOT ? Presence.NONE : Presence.CONNECTED);
        const human = controller === Controller.HUMAN;
        const now = Date.now();
        const pick = (k, dflt) => (k in init ? init[k] : dflt);
        const bot = human ? null : this._botRecord(init.bot);
        const seat = {
            position: pos,
            controller,
            presence,
            ownerUsername: controller === Controller.BOT ? null : pick('ownerUsername', prev?.ownerUsername ?? null),
            ownerPic: controller === Controller.BOT ? null : pick('ownerPic', prev?.ownerPic ?? null),
            ownerSocketId: presence === Presence.CONNECTED ? pick('ownerSocketId', prev?.ownerSocketId ?? null) : null,
            ownerView: presence === Presence.CONNECTED && !human ? pick('ownerView', 'seat') : null,
            seatSocketId: human ? pick('seatSocketId', init.ownerSocketId ?? prev?.seatSocketId) : bot.socketId,
            bot,
            lastPersonality: bot?.personality ?? prev?.lastPersonality ?? null,
            absentSince: pick('absentSince', presence === Presence.CONNECTED || presence === Presence.NONE ? null : now),
            graceDeadline: presence === Presence.GRACE ? pick('graceDeadline', now + RECONNECT_GRACE_MS) : null,
            resignableAt: presence === Presence.RESIGNABLE ? pick('resignableAt', now) : null,
            resignedAt: controller === Controller.RESIGN_BOT ? pick('resignedAt', now) : null,
            leftAt: presence === Presence.GONE ? pick('leftAt', now) : null
        };
        if (prev && prev.seatSocketId !== seat.seatSocketId) this._rekeySeat(pos, seat.seatSocketId);
        this.seats[pos] = seat;
        if (presence === Presence.GRACE) {
            this.setTimer('grace:' + pos, RECONNECT_GRACE_MS, init.onGraceExpire || (() => {}));
        } else {
            this.clearTimer('grace:' + pos);
        }
        this._indexSeat(pos);
        if (this.seatList().length === 4) this.entrants = null;
        this._afterSeat(pos, 'force');
        return seat;
    }

    // ========================================
    // Restore (deploy survival: server/game/persist/gameCodec.js hydrate)
    // ========================================

    /**
     * The one writer of a restored game: fills this FRESH game (just
     * constructed: CREATED, no seats, nothing broadcast) from a saved
     * state, the codec's `state` (gameCodec.js; already version-checked
     * and JSON-shaped), and enters `stage` directly (one of the four
     * restore stages). Next to forcePhase / forceSeat the only other
     * stage writer outside transition / terminate. The seats go through
     * restoreSeats (humans in a fresh reconnect grace, keyed by
     * restored:<gameId>:<pos>), then each seat's hand is keyed by its seat
     * socket. Nothing is emitted and no timer but the grace timers starts.
     * Called anywhere else (a game that already ran, a second restore)
     * it is a reported violation and changes nothing.
     * @param {string} stage
     * @param {Object} state - gameCodec state
     * @param {Object} [opts]
     * @param {Array} [opts.log] - game log entries (the last maxLogEntries are kept)
     * @param {number} [opts.logTotal]
     * @param {number} [opts.eventSeq] - the broadcast sequence to continue from
     * @param {number} [opts.now]
     * @param {Function} [opts.onGraceExpire] - (pos) => void, a human seat's grace ran out
     * @returns {boolean} false when refused
     */
    restoreFrom(stage, state, { log = [], logTotal = null, eventSeq = 0, now = Date.now(), onGraceExpire = null } = {}) {
        const fresh = this._stage === Phase.CREATED && this.eventSeq === 0 && this.seatList().length === 0 &&
            !this.frozen && !RESTORED.has(this) && !RESTORING.has(this);
        if (!fresh) {
            reportViolation('restore-outside', { gameId: this.gameId, what: 'restoreFrom', stage: this._stage });
            return false;
        }
        if (!RESTORE_STAGES.has(stage) || !state || typeof state !== 'object') {
            reportViolation('restore-stage', { gameId: this.gameId, stage });
            return false;
        }
        RESTORING.add(this);
        try {
            const card = (c) => (c ? { suit: c.suit, rank: c.rank } : null);
            const cards = (list) => (Array.isArray(list) ? list.map(card) : []);
            // Arrays that live play fills by index (recordBid, applyPlay):
            // rebuilt with the same holes, so `length` and iteration match
            const sparse = (list, map = (v) => v) => {
                const out = [];
                (Array.isArray(list) ? list : []).forEach((v, i) => { if (v != null) out[i] = map(v); });
                return out;
            };
            const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

            this.createdAt = state.createdAt;
            this.dealSeq = state.dealSeq;
            this.currentHand = state.currentHand;
            this.dealer = state.dealer;
            this.bidder = state.bidder;
            this.bids = clone(state.bids);
            this.playerBids = sparse(state.playerBids);
            this.team1Mult = state.team1Mult;
            this.team2Mult = state.team2Mult;
            this.currentTurn = state.currentTurn;
            this.leadPosition = state.leadPosition;
            this.leadCard = card(state.leadCard);
            this.playedCards = sparse(state.playedCards, card);
            this.playedCardsIndex = state.playedCardsIndex;
            this.trump = card(state.trump);
            this.isTrumpBroken = !!state.isTrumpBroken;
            this.cardIndex = state.cardIndex;
            this.tricks = clone(state.tricks);
            this.trickHistory = (state.trickHistory || []).map(t => ({ winner: t.winner, lead: t.lead, cards: cards(t.cards) }));
            this.score = clone(state.score);
            this.rainbows = clone(state.rainbows);
            this.handStats = clone(state.handStats);
            this.playerStats = clone(state.playerStats);
            this.handTricks = clone(state.handTricks);
            this.hsiValues = clone(state.hsiValues) || {};
            // A CODEC_V 1 doc has none: every seat starts with no /help use
            this.assist = normalizeAssist(state.assist);
            this.gameLog = (Array.isArray(log) ? log : []).slice(-this.maxLogEntries).map(e => ({ ...e }));
            if (logTotal != null) this.logTotal = logTotal;
            this.eventSeq = eventSeq;

            if (!this.restoreSeats(state.seats, { now, onGraceExpire, order: state.seatOrder })) return false;
            this.hands = {};
            for (let pos = 1; pos <= 4; pos++) {
                const hand = state.hands?.[pos];
                if (Array.isArray(hand)) this.hands[this.positions[pos]] = cards(hand);
            }

            const from = this._stage;
            this._stage = stage;
            if (this._history) this._history.push(stage);
            RESTORED.add(this);
            gameLogger.debug('phase', { gameId: this.gameId, from, to: stage, restored: true });
            if (shouldCheckInvariants()) {
                const { errors } = this.validateGameState();
                if (errors.length > 0) reportViolation('invariant', { gameId: this.gameId, stage, errors, restored: true });
            }
            return true;
        } finally {
            RESTORING.delete(this);
        }
    }

    /**
     * Create all four seats of a game being restored (only from
     * restoreFrom; anywhere else it is a reported violation). Each record
     * is the codec's {controller, presence, ownerUsername, ownerPic, bot,
     * lastPersonality, resignedAt, leftAt, gone}; nobody is connected
     * after a restore:
     *   human (any presence)   -> human/grace: a fresh graceDeadline and
     *                             its grace:<pos> timer, keyed by
     *                             restored:<gameId>:<pos> (seatReconnect
     *                             re-keys the hand to the real socket)
     *   lazyBot / resignBot    -> away, or gone when the owner had left
     *   bot                    -> bot/none
     * The players index is built in `order` (positions, as the live
     * game's index was: the deal hands out cards in that order), else 1-4.
     * Runs validateSeats; any error is a reported violation (false).
     * @param {Object} records - {1..4: record}
     * @param {{now?: number, onGraceExpire?: Function, order?: number[]}} [opts]
     * @returns {boolean}
     */
    restoreSeats(records, { now = Date.now(), onGraceExpire = null, order = null } = {}) {
        if (!RESTORING.has(this) || this.seatList().length !== 0) {
            reportViolation('restore-outside', { gameId: this.gameId, what: 'restoreSeats', stage: this._stage });
            return false;
        }
        for (let pos = 1; pos <= 4; pos++) {
            const r = records?.[pos];
            const botOk = r && (r.controller === Controller.HUMAN || (r.bot && isBotSocket(r.bot.socketId)));
            if (!r || !SeatState.LEGAL[r.controller] || !botOk) {
                reportViolation('restore-seat', { gameId: this.gameId, pos, controller: r?.controller ?? null });
                return false;
            }
        }
        const isOrder = Array.isArray(order) && order.length === 4 && [1, 2, 3, 4].every(p => order.includes(p));
        for (const pos of isOrder ? order : [1, 2, 3, 4]) {
            const r = records[pos];
            const controller = r.controller;
            const human = controller === Controller.HUMAN;
            const native = controller === Controller.BOT;
            const gone = !human && !native && (r.gone === true || r.presence === Presence.GONE);
            let presence = Presence.NONE;
            if (human) presence = Presence.GRACE;
            else if (!native) presence = gone ? Presence.GONE : Presence.AWAY;
            const bot = human ? null : this._botRecord(r.bot);
            const seat = {
                position: pos,
                controller,
                presence,
                ownerUsername: native ? null : (r.ownerUsername ?? null),
                ownerPic: native ? null : (r.ownerPic ?? null),
                ownerSocketId: null,
                ownerView: null,
                seatSocketId: human ? restoredSeatSocketId(this.gameId, pos) : bot.socketId,
                bot,
                lastPersonality: r.lastPersonality ?? null,
                absentSince: native ? null : now,
                graceDeadline: human ? now + RECONNECT_GRACE_MS : null,
                resignableAt: null,
                resignedAt: r.resignedAt ?? null,
                leftAt: gone ? (r.leftAt ?? now) : (r.leftAt ?? null)
            };
            this.seats[pos] = seat;
            if (human) {
                const expire = typeof onGraceExpire === 'function' ? () => onGraceExpire(pos) : () => {};
                this.setTimer('grace:' + pos, RECONNECT_GRACE_MS, expire);
            }
            this._indexSeat(pos);
            if (this._seatHistory) this._seatHistory.push(`${pos}:restore:${seat.controller}/${seat.presence}`);
        }
        this.entrants = null;
        this.logAction('seat', { event: 'restore' });
        const errors = validateSeats(this);
        if (errors.length > 0) {
            reportViolation('seat-invariant', { gameId: this.gameId, event: 'restore', errors });
            return false;
        }
        return true;
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

    /** A 'bot:' socket (bots have no real socket connection). */
    isBot(socketId) {
        return isBotSocket(socketId);
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
     * The legacy (cc865b4) client-state projection of the game for seat
     * socket `socketId`. Not sent since V1_REMOVALS #9 (2026-11-12): the
     * snapshot carriers send {snapshot} plus a few v1 keys
     * (snapshotHandlers.carrierFor). Kept as the seat model's legacy
     * projection for tests (SeatState, wireProjection, wireCompat's cc865b4
     * comparison).
     * @param {string} socketId - Socket ID of the player
     * @returns {Object} - Game state object
     */
    getClientState(socketId) {
        const position = this.seatBySocket(socketId);

        // Build player info array (no socket ids: V1_REMOVALS #14)
        const playerInfo = [];
        for (let pos = 1; pos <= 4; pos++) {
            const player = this.getPlayerByPosition(pos);
            if (player) {
                playerInfo.push({
                    position: pos,
                    username: player.username,
                    pic: player.pic
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
            resignedPositions: this.seatList().filter(st => st.controller === Controller.RESIGN_BOT).map(st => st.position),
            lazyPositions: this.seatList().filter(st => this.wireLazy(st.position)).map(st => st.position),
            isLazy: position ? this.wireLazy(position) : false
        };
    }

    /**
     * Table snapshot v2 for the receiving socket `socketId` (see
     * snapshotV2.js and contract/README.md). Pure, no socket ids.
     */
    getSnapshotV2(socketId, opts) {
        return buildSnapshotV2(this, socketId, opts);
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
        this.trickHistory = [];
        this.rainbows = { team1: 0, team2: 0 };

        // Reset per-hand trick tracking
        this.handTricks = { 1: 0, 2: 0, 3: 0, 4: 0 };
    }

    getSocketIds() {
        return Array.from(this.players.keys());
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

    /**
     * Who is watching (the table's spectator badge; owner, 2026-11-11): the
     * ONE membership rule behind the list and count the badge shows
     * (spectatorsUpdated, snapshot v2 `watching`). Pure spectators
     * (`this.spectators`), one entry per
     * username in join order, without anyone who owns a seat here (a
     * lazy, resigned or /leave'd owner watching from another socket or tab
     * is at their seat already) or is a pre-seating entrant. A lazy owner's
     * watch socket is mapped (playerGames), never in `this.spectators`.
     * The older `spectatorCount` fields (the spectatorJoined notice and full
     * state, snapshot v2 spectatorCount, inProgressGames) keep their
     * cc865b4 meaning, the spectator SOCKET count (`this.spectators.size`,
     * which an owner's demoted socket or second tab is part of): their
     * values are pinned by wireCompat.test.js, and ambient demand reads it.
     * @returns {Array<{username: string, pic: (number|string|null)}>}
     */
    spectatorList() {
        const seated = new Set();
        for (const s of this.seatList()) if (s.ownerUsername) seated.add(s.ownerUsername);
        if (this.entrants) {
            for (const e of this.entrants.values()) if (!e.isBot && e.username) seated.add(e.username);
        }
        const seen = new Set();
        const list = [];
        for (const info of this.spectators.values()) {
            const name = info.username;
            if (!name || seated.has(name) || seen.has(name)) continue;
            seen.add(name);
            list.push({ username: name, pic: info.pic ?? null });
        }
        return list;
    }

    /** spectatorList().length: the people watching. */
    spectatorCount() {
        return this.spectatorList().length;
    }

    // ========================================
    // Game Log Methods
    // ========================================

    /**
     * Add an entry to the game log
     * @param {string} message - The log message
     * @param {number|null} playerPosition - Player position (1-4) or null for system
     * @param {string} type - Message type: 'system', 'chat', 'bid', 'trick', 'score', 'rainbow'
     * @param {Object} [meta]
     * @param {string} [meta.from] - a chat line's sender (the username its
     *   chatMessage broadcast carried). Internal, never on the wire.
     * @param {{position: number, bid: number, took: number}} [meta.fault] -
     *   a hand's fault line (gameHandlers.handleHandComplete): on the wire
     *   in the snapshot's log item (optional `fault`)
     */
    addLogEntry(message, playerPosition = null, type = 'system', { from, fault } = {}) {
        const entry = {
            message,
            playerPosition,
            type,
            timestamp: Date.now()
        };
        if (typeof from === 'string') entry.from = from;
        if (fault && typeof fault === 'object') entry.fault = { position: fault.position, bid: fault.bid, took: fault.took };

        this.gameLog.push(entry);
        this.logTotal++;

        // Enforce max entries limit
        if (this.gameLog.length > this.maxLogEntries) {
            this.gameLog.shift();
        }

        this.logAction('addLogEntry', { message: message.slice(0, 50), type });
        persistHooks.gameChanged(this);
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

    /**
     * An admin rename or merge moved the account `oldName` to `newName`:
     * the chat lines it sent here carry `newName` as their internal `from`
     * from now on, as its blockers' lists do, so their snapshots keep
     * leaving those lines out (snapshotV2 hideChatFrom). The visible text
     * keeps the name the line was sent under.
     * @returns {number} lines re-pointed
     */
    renameChatSender(oldName, newName) {
        let n = 0;
        for (const e of this.gameLog) {
            if (e.type === 'chat' && e.from === oldName) {
                e.from = newName;
                n++;
            }
        }
        return n;
    }

    /**
     * An account was deleted: drop the chat lines it sent here (a chat
     * line whose internal `from` is `username`, player or spectator).
     * System, bid, trick and score lines stay, and so do the lines of a
     * bot persona (never an account name). The caller has the persist
     * store write the whole log again (liveStore.scrubChat).
     * @returns {number} lines removed
     */
    scrubChatFrom(username) {
        let n = 0;
        for (let i = this.gameLog.length - 1; i >= 0; i--) {
            const e = this.gameLog[i];
            if (e.type === 'chat' && e.from === username) {
                this.gameLog.splice(i, 1);
                n++;
            }
        }
        return n;
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
     * True (and logged at debug) when nothing may be emitted from this game:
     * it is terminal, frozen for a handoff (freeze()) or suspended (the
     * holder self-fence: suspend()).
     */
    _emitsDropped(event) {
        if (this.isTerminal()) {
            gameLogger.debug('emit dropped: terminal', { gameId: this.gameId, event });
            return true;
        }
        if (this.frozen) {
            gameLogger.debug('emit dropped: frozen', { gameId: this.gameId, event });
            return true;
        }
        if (this._suspended) {
            gameLogger.debug('emit dropped: suspended', { gameId: this.gameId, event });
            return true;
        }
        return false;
    }

    /**
     * Broadcast an event to all players in this game. Dropped once the game
     * is terminal (nothing is emitted from a dead game) or frozen.
     * @param {Server} io - Socket.IO server instance
     * @param {string} event - Event name
     * @param {Object} data - Event data
     */
    broadcast(io, event, data) {
        if (this._emitsDropped(event)) return;
        // Every room broadcast carries the game's next sequence number
        // (additive top-level `seq`; contract/README.md R1-R5). A shallow
        // copy: nested values are the same references as before.
        const seq = this.nextSeq();
        io.to(this.roomName).emit(event, isPlainObject(data) ? { ...data, seq } : data);
    }

    /**
     * A sequenced room broadcast to everyone in the room BUT `socket`
     * (socket.to(room)). It bumps the seq like broadcast, so the excluded
     * socket must get a snapshot built AFTER it (snapshot.seq then covers
     * it), else its next room event is a gap. Used for the spectatorJoined
     * notice (V1_REMOVALS #8): the joiner gets its own full state instead.
     */
    broadcastExcept(socket, event, data) {
        if (this._emitsDropped(event)) return;
        const seq = this.nextSeq();
        socket.to(this.roomName).emit(event, isPlainObject(data) ? { ...data, seq } : data);
    }

    /**
     * An UNSEQUENCED room emit (no seq, no bump): only for an event whose
     * schema entry says `seq: false` and whose payload is the whole
     * absolute state (spectatorsUpdated). A sequenced event the App Store
     * build does not listen to would open a seq gap there (its gate would
     * resync on every one). Dropped once the game is terminal, like
     * broadcast.
     */
    emitUnsequenced(io, event, data) {
        if (this._emitsDropped(event)) return;
        io.to(this.roomName).emit(event, data);
    }

    /**
     * Next broadcast sequence number. Bumped once per room broadcast (here)
     * and once per deal (dealHand, before the gameStart batch); private
     * sends never bump it.
     */
    nextSeq() {
        const seq = ++this.eventSeq;
        persistHooks.gameChanged(this);
        return seq;
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
        if (this._emitsDropped(event)) return;
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
            eventSeq: this.eventSeq,
            trump: this.trump,
            isTrumpBroken: this.isTrumpBroken,
            tricks: this.tricks,
            score: this.score,
            rainbows: this.rainbows,
            seats: this.presenceSummary()   // internal only (never emitted)
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

        // Check the bid fits this hand (rules.isValidBid: numbers up to the
        // hand size, so '13' only on the 13-card hand; bore levels in order)
        const bidStr = String(bid).toUpperCase();
        if (!isValidBid(bidStr, this.playerBids, this.currentHand)) {
            return { valid: false, error: `Invalid bid value: ${bid}` };
        }

        // Check hasn't already bid
        const position = this.getPositionBySocketId(socketId);
        if (this.bids[position] !== undefined) {
            return { valid: false, error: 'Already bid' };
        }

        return { valid: true };
    }

    // ========================================
    // Applying bids and plays (the ONE path for humans and bots)
    // ========================================

    /**
     * Validate and record a bid for the seat at `position`. The human
     * playerBid handler and BotController.processBotBid both bid through
     * here, so their checks cannot drift. The caller logs, broadcasts and
     * advances the turn.
     * @returns {{ok: true, bid: string} | {ok: false, reason: 'not_your_turn'|'already_bid'|'invalid_bid', bid?: string}}
     *   reason is the actionRejected reason
     */
    applyBid(position, bid) {
        // Before the deal currentTurn holds the constructor default
        if (this._stage !== Phase.BIDDING || position !== this.currentTurn || this._suspended) return { ok: false, reason: 'not_your_turn' };
        if (this.playerBids[position - 1] != null) return { ok: false, reason: 'already_bid' };
        const bidStr = String(bid).toUpperCase();
        if (!isValidBid(bidStr, this.playerBids, this.currentHand)) return { ok: false, reason: 'invalid_bid', bid: bidStr };
        this.recordBid(position, bidStr);
        return { ok: true, bid: bidStr };
    }

    /** The open trick as rules.isLegalPlay reads it, for the seat at `position`. */
    trickFor(position) {
        return {
            leadCard: this.leadCard,
            isLeading: this.playedCardsIndex === 0,
            trump: this.trump,
            trumpBroken: this.isTrumpBroken,
            position,
            leadPosition: this.leadPosition
        };
    }

    /**
     * May the seat at `position` play `card` now? No state changes.
     * @param {string} [socketId] - the seat socket (default: the seat's)
     * @returns {{ok: true} | {ok: false, reason: 'not_your_turn'|'invalid_play'|'already_played'|'illegal_card', error?: string}}
     *   reason is the actionRejected reason
     */
    checkPlay(position, card, socketId = this.positions[position]) {
        // Only in PLAYING: during TRICK_RESOLVING currentTurn has already
        // rotated to the leader while the trick is still on the table
        if (this._stage !== Phase.PLAYING || position !== this.currentTurn || this._suspended) return { ok: false, reason: 'not_your_turn' };
        const check = this.validateCardPlay(socketId, card);
        if (!check.valid) return { ok: false, reason: 'invalid_play', error: check.error };
        if (this.playedCards[position - 1]) return { ok: false, reason: 'already_played' };
        if (!isLegalPlay(card, this.getHand(socketId), this.trickFor(position))) return { ok: false, reason: 'illegal_card' };
        return { ok: true };
    }

    /** The first legal card in the seat's hand (hand order), or null. */
    firstLegalCard(position) {
        return firstLegalCard(this.getHand(this.positions[position]), this.trickFor(position));
    }

    /**
     * Validate and apply a card play for the seat at `position` (the human
     * playCard handler and BotController.processBotPlay both play through
     * here): checkPlay, then the card leaves the hand and goes on the table.
     * The caller broadcasts cardPlayed, notifies the bots and advances the
     * turn.
     * @param {string} [socketId] - the seat socket (default: the seat's)
     * @returns {{ok: true} | {ok: false, reason: string, error?: string}}
     */
    applyPlay(position, card, socketId = this.positions[position]) {
        const check = this.checkPlay(position, card, socketId);
        if (!check.ok) {
            if (check.reason === 'illegal_card') {
                // A refused card goes to the end of the hand, as before this
                // path was shared (the recorded fixtures' snapshots pin it)
                if (this.removeCardFromHand(socketId, card)) {
                    this.getHand(socketId).push(card);
                    // The hand's order is saved (persist codec) and the
                    // refusal broadcasts nothing: tell the live store
                    persistHooks.gameChanged(this);
                }
            }
            return check;
        }
        if (!this.removeCardFromHand(socketId, card)) return { ok: false, reason: 'invalid_play', error: 'Card not in hand' };

        if (this.playedCardsIndex === 0) {
            this.leadCard = card;
            this.leadPosition = position;
        }
        this.playedCards[position - 1] = card;
        this.playedCardsIndex++;
        this.cardIndex++;
        if (card.suit === this.trump.suit || card.suit === 'joker') {
            this.isTrumpBroken = true;
        }
        return { ok: true };
    }

    /**
     * Validate the game state against the invariants of its current stage.
     * Run on every transition when BAB_FSM_CHECK=1 (tests, chaos runs).
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validateGameState() {
        const errors = [...this._stageErrors(), ...validateSeats(this)];
        return { valid: errors.length === 0, errors };
    }

    /** Per-stage invariants (seat invariants live in SeatState.validateSeats). */
    _stageErrors() {
        const errors = [];
        const stage = this._stage;
        const tt = this.tricks.team1 + this.tricks.team2;
        const seatHand = (pos) => this.hands[this.positions[pos]] || [];
        const teamShaped = (b) => !!b && typeof b.team1 === 'number' && typeof b.team2 === 'number';

        if (stage === Phase.CREATED) {
            return errors;
        }
        if (isTerminal(stage)) {
            const pending = this.pendingTimerCount || 0;
            if (pending !== 0) errors.push(`Terminal game has ${pending} pending timers`);
            return errors;
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
            return errors;
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

        return errors;
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
module.exports.RESUME_KINDS = RESUME_KINDS;
module.exports.RESTORE_STAGES = RESTORE_STAGES;
module.exports.restoredSeatSocketId = restoredSeatSocketId;

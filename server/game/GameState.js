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
const {
    Controller,
    Presence,
    RECONNECT_GRACE_MS,
    isBotSocket,
    isLegalCreate,
    checkEdge,
    seatDisplay,
    validateSeats
} = require('./SeatState');
const { buildSnapshotV2 } = require('./snapshotV2');
const pacing = require('./pacing');
const { isValidBid } = require('./rules');

/** game.resume.kind values (snapshot v2 resume.kind) */
const RESUME_KINDS = ['countdown', 'drawReveal', 'seating', 'teams', 'firstTurn', 'trick', 'hand'];

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
        this._seatHistory = this._history ? [] : null;

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
        this.resume = null;
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
     * Presentation hold for a linear lifecycle chain (server/game/pacing.js):
     * like pause(), and game.resume = {kind, at} while it runs.
     * `if (!(await game.hold(kind, ms))) return;`
     * @param {string} kind - one of RESUME_KINDS
     * @param {number} ms
     * @param {string} [traceKind=kind] - pacing.trace component
     * @returns {Promise<boolean>}
     */
    hold(kind, ms, traceKind = kind) {
        if (this.isTerminal()) return Promise.resolve(false);
        pacing.trace(traceKind, ms, this);
        this.resume = { kind, at: Date.now() + ms };
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
        if (this.isTerminal()) return false;
        pacing.trace(traceKind, ms, this);
        this.resume = { kind, at: Date.now() + ms };
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
    cardPlayedPayload(playerId, card, position) {
        const payload = { playerId, card, position, trump: this.isTrumpBroken };
        if (this.playedCardsIndex === 4) payload.resumeInMs = pacing(this).TRICK_VIEW_MS;
        return payload;
    }

    /** {kind, inMs} of the open hold (inMs relative to `now`), or null. */
    resumeInfo(now = Date.now()) {
        return this.resume ? { kind: this.resume.kind, inMs: Math.max(0, Math.round(this.resume.at - now)) } : null;
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
                offer: this.offerPos === pos
            };
        });
    }

    timerKeys() {
        return Array.from(this._timers.keys());
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
        // Reserved for a future turn watchdog: a controller change ends it
        if (s.controller !== to.controller) this.clearTimer('afk:' + pos);
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
     * Get current game state for a rejoining client
     * @param {string} socketId - Socket ID of the player
     * @returns {Object} - Game state object
     */
    getClientState(socketId) {
        const position = this.seatBySocket(socketId);

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
        // Every room broadcast carries the game's next sequence number
        // (additive top-level `seq`; contract/README.md R1-R5). A shallow
        // copy: nested values are the same references as before.
        const seq = this.nextSeq();
        io.to(this.roomName).emit(event, isPlainObject(data) ? { ...data, seq } : data);
    }

    /**
     * Next broadcast sequence number. Bumped once per room broadcast (here)
     * and once per deal (dealHand, before the gameStart batch); private
     * sends never bump it.
     */
    nextSeq() {
        return ++this.eventSeq;
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

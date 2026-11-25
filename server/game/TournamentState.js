/**
 * Encapsulates all state for a single tournament instance.
 * Manages tournament lifecycle: lobby → round_active → between_rounds → complete.
 */

const { v4: uuidv4 } = require('uuid');
const { safeTimeout } = require('../utils/safeTimer');
// The persist store's change hook (persist/hooks.js, through _changed)
const persistHooks = require('./persist/hooks');

class TournamentState {
    constructor(tournamentId, name, creatorSocketId, creatorUsername) {
        this.tournamentId = tournamentId;
        this.roomName = `tournament:${tournamentId}`;
        this.name = name || `${creatorUsername}'s Tournament`;
        this.createdBy = creatorSocketId;
        this.creatorUsername = creatorUsername;
        this.createdAt = Date.now();

        // Phase: 'lobby' | 'starting' (a round start is in flight) |
        // 'round_active' | 'between_rounds' | 'complete'
        this.phase = 'lobby';
        // Lifecycle generation, like GameState.epoch: bumped by every round
        // start (beginStart) and once more when the tournament is deleted
        // (retire). An async round start captures it and stops at its next
        // await if it changed, so a cancelled / deleted tournament never
        // gets tables, assignments or allPlayersReady.
        this.epoch = 0;
        this.retired = false;
        this.currentRound = 0; // 0 = not started, 1-4 = round number
        this.totalRounds = 4;

        // Players: socketId → { username, pic, ready }
        this.players = new Map();
        this.readyPlayers = new Set();

        // Chat messages (capped)
        this.messages = [];
        this.maxMessages = 100;

        // Spectators: socketId → { username, pic }
        this.spectators = new Map();

        // Rounds data
        this.rounds = [];

        // Scoreboard: username → { totalScore, roundScores: [r1..r4], roundDetails: [...] }
        this.scoreboard = {};

        // Between rounds: when Begin may start with only the ready members
        // (socket/tournamentLiveness.js armReadyDeadline; null: not yet).
        // Only a completed round sets a new one, so a rolled-back start keeps it
        this.readyDeadlineAt = null;
        // This between-rounds wait already handed the host role on: past the
        // deadline the next idle spell starts the round instead of a second
        // hand-off (tournamentLiveness; reset with each new deadline)
        this.handedOffThisWait = false;
        // When the last round completed (phase 'complete'; null before): the
        // start of the results window (deploy survival saves it)
        this.completedAt = null;
        // key → handle ('readyDeadline', 'hostIdle'); all cleared on every
        // round start and on retire, so none outlives its phase
        this.timers = new Map();
        // The tournament voice room (server/voice/tournamentVoice.js): the
        // members on the tournament lobby screen with the cap tournamentVoice,
        // socketId -> {username, order}; never saved (members enter again)
        this.voiceRoom = { order: 0, members: new Map() };

        this._debugMode = process.env.NODE_ENV !== 'production';
    }

    // ========================================
    // Player Management
    // ========================================

    addPlayer(socketId, username, pic) {
        this.players.set(socketId, { username, pic, ready: false, connected: true });
        // Initialize scoreboard entry
        if (!this.scoreboard[username]) {
            this.scoreboard[username] = {
                totalScore: 0,
                roundScores: [],
                roundDetails: []
            };
        }
        this.logAction('addPlayer', { socketId, username });
        this._changed();
    }

    /**
     * Mark a player disconnected without removing them — keeps their scores and
     * lets them reattach with a new socket. Returns the player or null.
     */
    markPlayerDisconnected(socketId) {
        const player = this.players.get(socketId);
        if (!player) return null;

        player.connected = false;
        player.ready = false;
        this.readyPlayers.delete(socketId);

        this.logAction('markPlayerDisconnected', { socketId, username: player.username });
        return player;
    }

    /**
     * Re-key an existing player entry (matched by username) to a new socket.
     * Used when a player reconnects mid-tournament.
     * @returns {{ oldSocketId: string } | null}
     */
    reattachPlayerByUsername(username, newSocketId) {
        for (const [oldSocketId, player] of this.players.entries()) {
            if (player.username === username) {
                if (oldSocketId === newSocketId) {
                    player.connected = true;
                    this.recoverCreatorIfDisconnected();
                    this._changed();
                    return { oldSocketId };
                }
                this.players.delete(oldSocketId);
                this.readyPlayers.delete(oldSocketId);
                player.connected = true;
                player.ready = false;
                this.players.set(newSocketId, player);
                const wasCreator = this.createdBy === oldSocketId;
                if (wasCreator) {
                    this.createdBy = newSocketId;
                }
                // A restored tournament's ghost is back (deploy survival
                // PR 6; never set otherwise)
                if (this.restored) {
                    require('./persist/restoreTournament').noteReattach(this, {
                        wasGhost: oldSocketId.startsWith(`restored:${this.tournamentId}:`),
                        isCreator: wasCreator
                    });
                }
                this.recoverCreatorIfDisconnected();
                this.logAction('reattachPlayer', { username, oldSocketId, newSocketId });
                this._changed();
                return { oldSocketId };
            }
        }
        return null;
    }

    /**
     * If the creator role is stuck on a disconnected/missing socket (e.g.
     * everyone dropped at once, so no transfer happened at disconnect time),
     * hand it to a connected player so Begin/Cancel work again.
     */
    recoverCreatorIfDisconnected() {
        const creatorEntry = this.players.get(this.createdBy);
        if (!creatorEntry || creatorEntry.connected === false) {
            // A restored tournament's host grace (deploy survival PR 6): a
            // ghost host keeps the role until it ends (restoreTournament)
            if (creatorEntry && this.restored?.hostGraceUntil != null && Date.now() < this.restored.hostGraceUntil) return;
            this.transferCreator();
        }
    }

    getConnectedPlayerCount() {
        let count = 0;
        for (const [, player] of this.players) {
            if (player.connected !== false) count++;
        }
        return count;
    }

    removePlayer(socketId) {
        const player = this.players.get(socketId);
        if (!player) return null;

        this.players.delete(socketId);
        this.readyPlayers.delete(socketId);

        this.logAction('removePlayer', { socketId, username: player.username });
        this._changed();
        return player;
    }

    getPlayerBySocketId(socketId) {
        return this.players.get(socketId) || null;
    }

    getPlayerByUsername(username) {
        for (const [socketId, player] of this.players.entries()) {
            if (player.username === username) {
                return { socketId, ...player };
            }
        }
        return null;
    }

    getHumanPlayerCount() {
        return this.players.size;
    }

    setReady(socketId) {
        const player = this.players.get(socketId);
        if (!player) return false;
        player.ready = true;
        this.readyPlayers.add(socketId);
        return true;
    }

    unsetReady(socketId) {
        const player = this.players.get(socketId);
        if (!player) return false;
        player.ready = false;
        this.readyPlayers.delete(socketId);
        return true;
    }

    allPlayersReady() {
        // Disconnected players don't block readiness — they're excluded from
        // round pairings until they reattach.
        let connected = 0;
        for (const [socketId, player] of this.players.entries()) {
            if (player.connected === false) continue;
            connected++;
            if (!this.readyPlayers.has(socketId)) return false;
        }
        return connected > 0;
    }

    resetAllReady() {
        this.readyPlayers.clear();
        for (const [, player] of this.players) {
            player.ready = false;
        }
    }

    /**
     * Transfer creator role to next human player.
     * @param {Object} [opts]
     * @param {boolean} [opts.preferReady] - a ready connected player first
     *   (the idle-host hand-off: the new host can begin at once)
     * @returns {{ socketId: string, username: string } | null} New creator, or null if no humans remain
     */
    transferCreator(opts = {}) {
        const next = this._transferCreator(opts);
        this._changed();
        return next;
    }

    _transferCreator({ preferReady = false } = {}) {
        if (preferReady) {
            for (const [socketId, player] of this.players.entries()) {
                if (socketId !== this.createdBy && player.connected !== false && this.readyPlayers.has(socketId)) {
                    this.createdBy = socketId;
                    this.creatorUsername = player.username;
                    this.logAction('transferCreator', { newCreator: player.username, preferReady });
                    return { socketId, username: player.username };
                }
            }
        }
        // Prefer a connected player that isn't the current creator
        for (const [socketId, player] of this.players.entries()) {
            if (socketId !== this.createdBy && player.connected !== false) {
                this.createdBy = socketId;
                this.creatorUsername = player.username;
                this.logAction('transferCreator', { newCreator: player.username });
                return { socketId, username: player.username };
            }
        }
        // Fall back to any other player
        for (const [socketId, player] of this.players.entries()) {
            if (socketId !== this.createdBy) {
                this.createdBy = socketId;
                this.creatorUsername = player.username;
                this.logAction('transferCreator', { newCreator: player.username });
                return { socketId, username: player.username };
            }
        }
        // Only one or zero players left
        if (this.players.size === 1) {
            const [socketId, player] = this.players.entries().next().value;
            this.createdBy = socketId;
            this.creatorUsername = player.username;
            return { socketId, username: player.username };
        }
        return null;
    }

    // ========================================
    // Round Management
    // ========================================

    /** A round start begins: phase 'starting', new generation. @returns {number} the epoch */
    beginStart() {
        this.phase = 'starting';
        this.epoch++;
        this.clearTimers();
        this._changed();
        return this.epoch;
    }

    /** True while no newer start or deletion superseded generation `epoch`. */
    isLive(epoch) {
        return !this.retired && this.epoch === epoch;
    }

    /** Deleted (cancel, cleanup, abandonment): every captured epoch goes stale. */
    retire() {
        if (this.retired) return;
        this.retired = true;
        this.epoch++;
        this.clearTimers();
        this.logAction('retire', { epoch: this.epoch });
    }

    // ---------- timers (lobby / between-rounds liveness) ----------

    setTimer(key, ms, fn) {
        this.clearTimer(key);
        const handle = safeTimeout(() => {
            this.timers.delete(key);
            if (this.retired) return;
            fn();
        }, ms, `tournament:${key}`);
        if (handle.unref) handle.unref();
        this.timers.set(key, handle);
    }

    clearTimer(key) {
        const handle = this.timers.get(key);
        if (handle) {
            clearTimeout(handle);
            this.timers.delete(key);
        }
    }

    hasTimer(key) {
        return this.timers.has(key);
    }

    clearTimers() {
        for (const handle of this.timers.values()) clearTimeout(handle);
        this.timers.clear();
    }

    // ---------- between-rounds ready deadline ----------

    /** Past the ready deadline: Begin may start with the ready members only. */
    readyDeadlinePassed(now = Date.now()) {
        return this.phase === 'between_rounds' && this.readyDeadlineAt != null && now >= this.readyDeadlineAt;
    }

    /**
     * May the host begin the next phase now: every connected member ready,
     * or (between rounds, past the deadline) always: the host plays, the
     * ready members play and the rest sit the round out (owner 2026-11-15).
     */
    canBegin() {
        if (this.allPlayersReady()) return true;
        return this.readyDeadlinePassed() && this.players.get(this.createdBy)?.connected !== false;
    }

    /** Connected members who are not ready (they sit out a round begun now). */
    notReadyUsernames() {
        const names = [];
        for (const [socketId, player] of this.players) {
            if (player.connected !== false && !this.readyPlayers.has(socketId)) names.push(player.username);
        }
        return names;
    }

    startRound(roundNumber) {
        this.currentRound = roundNumber;
        this.phase = 'round_active';

        const roundData = {
            roundNumber,
            games: new Map(), // gameId → { humanPlayers: [], botCount, status }
            completedGames: new Set()
        };
        this.rounds.push(roundData);

        this.logAction('startRound', { roundNumber });
        this._changed();
        return roundData;
    }

    /**
     * Who partnered whom in the rounds so far (tournamentPartners.addRound
     * over every table's `teams`, in round order): {counts, last}. A table
     * saved without teams (before partner rotation) or that never seated
     * (dropGameTeams) adds nothing.
     */
    partnerHistory() {
        const { emptyHistory, addRound } = require('./tournamentPartners');
        const history = emptyHistory();
        for (const round of this.rounds) {
            for (const game of round.games.values()) {
                if (Array.isArray(game.teams)) addRound(history, game.teams);
            }
        }
        return history;
    }

    /**
     * Each round's tables and teams so far, for the clients' round pairings
     * and "Partners so far" (owner 2026-11-25): one entry per round in
     * `rounds`, {roundNumber, tables: [{gameId, teams}]} with the tables
     * that kept their planned `teams` (usernames, null for a bot; a table
     * that never seated dropped them: dropGameTeams). `planned` (the round
     * just planned: {roundNumber, tables: [{gameId: null, teams}]}) replaces
     * or adds that round's entry. Derived from the saved round entries, so
     * it survives a deploy handoff unchanged.
     */
    pairings({ planned = null } = {}) {
        const list = this.rounds.map((round) => {
            const tables = [];
            for (const [gameId, game] of round.games) {
                if (!Array.isArray(game.teams)) continue;
                tables.push({ gameId, teams: game.teams.map((t) => [t[0] ?? null, t[1] ?? null]) });
            }
            return { roundNumber: round.roundNumber, tables };
        });
        if (planned) {
            const i = list.findIndex((r) => r.roundNumber === planned.roundNumber);
            if (i >= 0) list[i] = planned; else list.push(planned);
        }
        return list;
    }

    /**
     * pairings() for the wire, or null when no table anywhere has two
     * members (the lobby phase, a 1-member tournament: their payloads stay
     * as they were).
     */
    pairingsWire(opts) {
        const list = this.pairings(opts);
        const shown = list.some((r) => r.tables.some((t) => t.teams.flat().filter(Boolean).length >= 2));
        return shown ? list : null;
    }

    /** `{pairings}` to spread into a tournament event's payload, or {} (pairingsWire is null). */
    pairingsField(opts) {
        const pairings = this.pairingsWire(opts);
        return pairings ? { pairings } : {};
    }

    getCurrentRound() {
        if (this.rounds.length === 0) return null;
        return this.rounds[this.rounds.length - 1];
    }

    /**
     * @param {Array<[string|null, string|null]>} [teams] - the table's two
     *   teams by username (null: a bot), as planned (tournamentPartners);
     *   read back by partnerHistory
     */
    addGameToRound(gameId, humanPlayers, botCount, teams = null) {
        const round = this.getCurrentRound();
        if (!round) return;

        const entry = {
            humanPlayers,
            botCount,
            status: 'active'
        };
        if (teams) entry.teams = teams;
        round.games.set(gameId, entry);
        this.logAction('addGameToRound', { gameId, humanCount: humanPlayers.length, botCount });
        this._changed();
    }

    /**
     * Record a player's score for the current round.
     */
    recordPlayerRoundScore(username, details) {
        if (!this.scoreboard[username]) {
            this.scoreboard[username] = {
                totalScore: 0,
                roundScores: [],
                roundDetails: []
            };
        }

        const entry = this.scoreboard[username];
        const roundScore = details.teamScore;
        const roundIdx = (details.roundNumber || this.currentRound) - 1;

        // Index by round number (padding missed rounds with 0) so scoreboard
        // columns stay aligned for players who missed a round or joined late.
        if (roundIdx >= 0) {
            if (entry.roundScores[roundIdx] !== undefined) {
                this.logAction('recordPlayerRoundScore:duplicate', { username, roundIdx });
                return;
            }
            while (entry.roundScores.length < roundIdx) {
                entry.roundScores.push(0);
            }
            entry.roundScores[roundIdx] = roundScore;
        } else {
            entry.roundScores.push(roundScore);
        }
        entry.roundDetails.push(details);
        entry.totalScore += roundScore;

        this.logAction('recordPlayerRoundScore', { username, roundScore, totalScore: entry.totalScore });
        this._changed();
    }

    /** The round a game was created in (null if it is not one of ours). */
    roundOfGame(gameId) {
        for (let i = this.rounds.length - 1; i >= 0; i--) {
            if (this.rounds[i].games.has(gameId)) return this.rounds[i];
        }
        return null;
    }

    /**
     * A table that never seated (aborted before its draw finished: the
     * countdown, or a pre-deal table scored after a restore) partnered
     * nobody: its planned teams leave the round entry, so partnerHistory
     * skips it (and the saved doc has none).
     */
    dropGameTeams(gameId) {
        const entry = this.roundOfGame(gameId)?.games.get(gameId);
        if (!entry || !entry.teams) return;
        delete entry.teams;
        this._changed();
    }

    markGameComplete(gameId) {
        const round = this.roundOfGame(gameId) || this.getCurrentRound();
        if (!round) return;

        const gameData = round.games.get(gameId);
        if (gameData) {
            gameData.status = 'complete';
        }
        round.completedGames.add(gameId);

        this.logAction('markGameComplete', {
            gameId,
            completedCount: round.completedGames.size,
            totalGames: round.games.size
        });
        this._changed();
    }

    isRoundComplete() {
        const round = this.getCurrentRound();
        if (!round) return false;
        return round.completedGames.size === round.games.size;
    }

    completeRound() {
        this.scoreMissedRound(this.getCurrentRound()?.roundNumber ?? this.currentRound);
        if (this.currentRound >= this.totalRounds) {
            this.phase = 'complete';
            this.completedAt = Date.now();
        } else {
            this.phase = 'between_rounds';
            this.resetAllReady();
        }
        // A new wait: armReadyDeadline sets its deadline right after
        this.readyDeadlineAt = null;
        this.handedOffThisWait = false;
        this.logAction('completeRound', { round: this.currentRound, phase: this.phase });
        this._changed();
    }

    /**
     * Owner 2026-11-15: a member with no score for `roundNumber` (sat out,
     * disconnected, at no table) scores the round's lowest recorded score,
     * 0 when nobody scored. So sitting out never beats playing.
     */
    scoreMissedRound(roundNumber) {
        const idx = roundNumber - 1;
        if (idx < 0) return;
        const recorded = Object.values(this.scoreboard)
            .map(e => e.roundScores[idx])
            .filter(v => typeof v === 'number');
        const lowest = recorded.length > 0 ? Math.min(...recorded) : 0;
        for (const [, player] of this.players) {
            const entry = this.scoreboard[player.username];
            if (entry && typeof entry.roundScores[idx] === 'number') continue;
            this.recordPlayerRoundScore(player.username, { roundNumber, teamScore: lowest, missed: true });
        }
    }

    isTournamentComplete() {
        return this.phase === 'complete';
    }

    /**
     * Get scoreboard sorted by totalScore descending.
     */
    getScoreboard() {
        const entries = Object.entries(this.scoreboard)
            .map(([username, data]) => ({
                username,
                ...data
            }))
            .sort((a, b) => b.totalScore - a.totalScore || a.username.localeCompare(b.username));

        return entries;
    }

    /**
     * All entrants tied for the top score (co-winners on a tie).
     * @returns {string[]} usernames
     */
    getWinners() {
        const scoreboard = this.getScoreboard();
        if (scoreboard.length === 0) return [];

        // Only current members can win — scoreboard entries persist for
        // players who quit, and a no-show's 0 can beat real (negative) totals
        const memberNames = new Set();
        for (const [, player] of this.players) {
            memberNames.add(player.username);
        }
        const eligible = scoreboard.filter(e => memberNames.has(e.username));
        const pool = eligible.length > 0 ? eligible : scoreboard;

        const top = pool[0].totalScore;
        return pool.filter(e => e.totalScore === top).map(e => e.username);
    }

    // ========================================
    // Spectator Methods
    // ========================================

    addSpectator(socketId, username, pic) {
        this.spectators.set(socketId, { username, pic });
    }

    removeSpectator(socketId) {
        this.spectators.delete(socketId);
    }

    isSpectator(socketId) {
        return this.spectators.has(socketId);
    }

    // ========================================
    // Chat Methods
    // ========================================

    addMessage(username, message, isSpectator = false) {
        const chatMessage = {
            username,
            message,
            isSpectator,
            timestamp: Date.now()
        };
        this.messages.push(chatMessage);
        if (this.messages.length > this.maxMessages) {
            this.messages.shift();
        }
        this._changed();
        return chatMessage;
    }

    /**
     * An account was deleted: drop every chat line it sent here, as a
     * player or a spectator (by username). System lines are never stored.
     * @returns {number} lines removed
     */
    scrubChatFrom(username) {
        const before = this.messages.length;
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i].username === username) this.messages.splice(i, 1);
        }
        const removed = before - this.messages.length;
        if (removed > 0) this._changed();
        return removed;
    }

    /**
     * Tell the persist store this tournament changed (persist/hooks.js):
     * every mutator here calls it, broadcast does, and so does code that
     * writes a field directly (tournamentHandlers' phase rollbacks,
     * tournamentLiveness' ready deadline and hand-off flag). Passive: it
     * only marks the tournament dirty.
     */
    _changed() {
        persistHooks.tournamentChanged(this);
    }

    // ========================================
    // Room Management
    // ========================================

    broadcast(io, event, data) {
        io.to(this.roomName).emit(event, data);
        this._changed();
    }

    joinToRoom(io, socketId) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
            socket.join(this.roomName);
        }
    }

    leaveRoom(io, socketId) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
            socket.leave(this.roomName);
        }
    }

    // ========================================
    // Active Games (for spectating during rounds)
    // ========================================

    getActiveGames() {
        const round = this.getCurrentRound();
        if (!round) return [];

        const games = [];
        for (const [gameId, gameData] of round.games) {
            games.push({
                gameId,
                humanPlayers: gameData.humanPlayers,
                botCount: gameData.botCount,
                status: gameData.status
            });
        }
        return games;
    }

    // ========================================
    // Client State (for reconnection/joining)
    // ========================================

    getClientState() {
        const players = [];
        // A restored member's synthetic id (restored:<tid>:<username>, deploy
        // survival PR 6) never goes on the wire: away:<username> until it
        // reattaches (unique per row, never a socket, like play again's
        // away:<uuid> rows; iOS keys its rows by socketId)
        const prefix = `restored:${this.tournamentId}:`;
        const wire = (sid) => (this.restored && typeof sid === 'string' && sid.startsWith(prefix) ? `away:${sid.slice(prefix.length)}` : sid);
        for (const [socketId, player] of this.players.entries()) {
            players.push({
                socketId: wire(socketId),
                username: player.username,
                pic: player.pic,
                ready: player.ready,
                connected: player.connected !== false,
                isCreator: socketId === this.createdBy
            });
        }

        const state = {
            tournamentId: this.tournamentId,
            name: this.name,
            phase: this.phase,
            currentRound: this.currentRound,
            totalRounds: this.totalRounds,
            players,
            messages: this.messages,
            scoreboard: this.getScoreboard(),
            activeGames: this.getActiveGames(),
            creatorUsername: this.creatorUsername,
            creatorSocketId: wire(this.createdBy)
        };

        // Additive (2026-11-15): Begin may start with the ready members
        if (this.phase === 'between_rounds') {
            state.readyDeadlinePassed = this.readyDeadlinePassed();
        }

        // Returning to a finished tournament must show the same (co-)winners
        // the tournamentComplete broadcast announced
        if (this.phase === 'complete') {
            state.winners = this.getWinners();
        }

        // Additive (2026-11-25): each round's pairings so far
        Object.assign(state, this.pairingsField());

        return state;
    }

    // ========================================
    // Player Distribution Algorithm
    // ========================================

    /**
     * Distribute players into games of 4, filling gaps with bots.
     * @param {string[]} shuffledUsernames - Shuffled array of usernames
     * @returns {Array<{ humans: string[], botCount: number }>}
     */
    static distributePlayersIntoGames(shuffledUsernames) {
        const n = shuffledUsernames.length;

        if (n === 0) return [];

        if (n < 4) {
            // 1-3 players: one game with bots filling
            return [{ humans: [...shuffledUsernames], botCount: 4 - n }];
        }

        const remainder = n % 4;
        const results = [];

        if (remainder === 0) {
            // Perfect division
            for (let i = 0; i < n; i += 4) {
                results.push({
                    humans: shuffledUsernames.slice(i, i + 4),
                    botCount: 0
                });
            }
        } else if (remainder === 1) {
            // Take 5 players → make 2 games (3+1bot, 2+2bots). Rest fill full games.
            const fullGameCount = Math.floor(n / 4) - 1;
            let idx = 0;

            for (let i = 0; i < fullGameCount; i++) {
                results.push({
                    humans: shuffledUsernames.slice(idx, idx + 4),
                    botCount: 0
                });
                idx += 4;
            }

            // Split remaining 5 into (3 + 1 bot) and (2 + 2 bots)
            results.push({
                humans: shuffledUsernames.slice(idx, idx + 3),
                botCount: 1
            });
            idx += 3;
            results.push({
                humans: shuffledUsernames.slice(idx, idx + 2),
                botCount: 2
            });
        } else if (remainder === 2) {
            // floor(n/4) full games + 1 game (2 humans + 2 bots)
            const fullGameCount = Math.floor(n / 4);
            let idx = 0;

            for (let i = 0; i < fullGameCount; i++) {
                results.push({
                    humans: shuffledUsernames.slice(idx, idx + 4),
                    botCount: 0
                });
                idx += 4;
            }

            results.push({
                humans: shuffledUsernames.slice(idx, idx + 2),
                botCount: 2
            });
        } else if (remainder === 3) {
            // floor(n/4) full games + 1 game (3 humans + 1 bot)
            const fullGameCount = Math.floor(n / 4);
            let idx = 0;

            for (let i = 0; i < fullGameCount; i++) {
                results.push({
                    humans: shuffledUsernames.slice(idx, idx + 4),
                    botCount: 0
                });
                idx += 4;
            }

            results.push({
                humans: shuffledUsernames.slice(idx, idx + 3),
                botCount: 1
            });
        }

        return results;
    }

    // ========================================
    // Debug Logging
    // ========================================

    logAction(action, details = {}) {
        if (this._debugMode) {
            console.log(`[Tournament ${this.tournamentId.slice(0, 8)}] ${action}`, details);
        }
    }
}

module.exports = TournamentState;

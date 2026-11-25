/**
 * Cut for a buck (2026-11-25): the orchestration of a tournament's finale.
 * The pure engine is server/game/cutForABuck.js; the spec's section 3.
 *
 * After the last table's result (broadcastRoundOutcome, both callers, right
 * after completeRound): maybeStart. The cut runs only when CUT_FOR_A_BUCK is
 * not off, at least 2 members are connected and at least one of them sent
 * the clientHello cap cutForABuck; otherwise the tournament completes as it
 * always did (finishTournament with cut null: the same events, byte for
 * byte). With it:
 *
 *   gather   phase 'cut', cutForABuckStart {candidates, startsInMs,
 *            deckCount}, a system line, lobbiesUpdated; CUT_GATHER_MS
 *            (pacing) for people to come back from their score screens
 *   begin    the participants are the members connected then (in member
 *            order; sat-out members included); fewer than 2, or none with
 *            the cap: "Not enough players for Cut for a buck." and the
 *            tournament completes with no cut
 *   round    cutForABuckRound {round, participants, alive, deckCount,
 *            reshuffled, closesInMs}; a participant still in who is
 *            disconnected, on a socket without the cap, or away
 *            (CUT_AWAY_STRIKES timeouts in a row, until a draw of their own
 *            or a return to the lobby) is drawn for at once (auto: true);
 *            the rest have CUT_DRAW_MS, then are drawn for (a strike each)
 *   draw     c2s cutForABuckDraw {round, slot|null}: cutForABuckDrew
 *            {round, username, slot, auto} (never the card); anything out
 *            of turn (no tournament, another phase or stage, a stale
 *            round, not a player still in, a repeat, a spectator) is dropped
 *            silently with a debug log
 *   reveal   when everyone still in has drawn: cutForABuckReveal {round,
 *            draws, eliminated, redraw, alive, nextInMs}; the members and
 *            spectators without the cap get the round as a private system
 *            line; CUT_REVEAL_MS, then the next round
 *   winner   one player left: cutForABuckWinner {winner, participants,
 *            rounds} and "<winner> won Cut for a buck."; CUT_WINNER_MS, then
 *            finishTournament with the result (tournamentComplete gains
 *            cutForABuck)
 *
 * Presence: a disconnect auto-draws an open draw (memberDisconnected); a
 * leave takes the player out (memberLeft: cutForABuckLeft, then a reveal or
 * the winner as it falls); the host's Cancel ends the cut early and
 * completes the tournament (cancel); the last member leaving completes it
 * first (tournamentHandlers.leaveTournament). deleteTournamentIfAbandoned
 * holds while phase is 'cut'. tournamentComplete goes out exactly once.
 *
 * Every timer is the tournament's 'cut' timer (t.setTimer: cleared by
 * retire) and runs only while the tournament is registered, its epoch
 * unchanged, not frozen (the deploy handoff) and still in phase 'cut'.
 *
 * Knobs: CUT_FOR_A_BUCK=off (off/false/0/disabled/no, read at each start:
 * the kill switch), CUT_DRAW_MS (default 15000, at least 1000 outside
 * tests, read at each arm), CUT_MAX_ROUNDS (default 100, read at each round:
 * past it a uniformly random player still in wins, with an error log; a
 * runaway guard nothing reaches in practice).
 */

'use strict';

const gameManager = require('../game/GameManager');
const pacing = require('../game/pacing');
const clientInfo = require('./clientInfo');
const { socketLogger } = require('../utils/logger');
const { CutEngine, DECK_SIZE, decksFor } = require('../game/cutForABuck');
const { systemLine } = require('./tournamentLiveness');

const CAP = 'cutForABuck';
const CUT_AWAY_STRIKES = 2;
const DEFAULT_DRAW_MS = 15000;
const DEFAULT_MAX_ROUNDS = 100;
const TIMER = 'cut';
const OFF = new Set(['off', 'false', '0', 'disabled', 'no']);

const START_LINE = 'Cut for a buck! Everyone still here draws a card. The lowest card is out, round after round, until one player is left.';
const NOT_ENOUGH_LINE = 'Not enough players for Cut for a buck.';
const RESTORE_LINE = 'Cut for a buck continues in 30 s after a server update.';

const isTest = () => process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

/** The kill switch (read at each start). */
function enabled() {
    return !OFF.has(String(process.env.CUT_FOR_A_BUCK ?? '').trim().toLowerCase());
}

/** The draw window (read at each arm). */
function drawMs() {
    const raw = process.env.CUT_DRAW_MS;
    const n = raw === undefined || raw === '' ? DEFAULT_DRAW_MS : Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_DRAW_MS;
    return isTest() ? n : Math.max(1000, n);
}

function maxRounds() {
    const n = Number(process.env.CUT_MAX_ROUNDS);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_ROUNDS;
}

// Tests: a fixed first deck, shuffle and slot RNG for every new engine
let engineOptions = {};
function setEngineOptionsForTests(opts = {}) {
    if (!isTest()) throw new Error('setEngineOptionsForTests is test-only');
    engineOptions = { ...opts };
}

const handlers = () => require('./tournamentHandlers');
const lifecycle = () => require('./gameLifecycle');

/** "al", "al and cy", "al, bo and cy" */
function joinNames(names) {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const SUIT_SYMBOL = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
const RANK_WORD = { J: 'jacks', Q: 'queens', K: 'kings', A: 'aces', HI: 'HI jokers', LO: 'LO jokers' };

/** "9♥", "10♣", "HI joker" */
function cardText(card) {
    if (card.suit === 'joker') return `${card.rank} joker`;
    return `${card.rank}${SUIT_SYMBOL[card.suit] || ''}`;
}
const rankPlural = (rank) => RANK_WORD[rank] || `${rank}s`;

/** Registered, the same generation, not handed off, still cutting. */
function live(t, epoch) {
    return !!t && !t.retired && !t.frozen && t.epoch === epoch && t.phase === 'cut' && !!t.cut &&
        gameManager.getTournamentById(t.tournamentId) === t;
}

/** Members connected on a live socket, in member order: [{socketId, username}] */
function present(io, t) {
    const out = [];
    for (const [socketId, p] of t.players) {
        if (p.connected === false || !p.username) continue;
        if (!io?.sockets?.sockets?.get(socketId)) continue;
        out.push({ socketId, username: p.username });
    }
    return out;
}

const hasCap = (io, socketId) => clientInfo.socketHasCap(io, socketId, CAP);

/** The member entry of `username` (socketId, connected), or null. */
const memberOf = (t, username) => t.getPlayerByUsername(username);

function arm(io, t, ms, fn) {
    const epoch = t.epoch;
    t.cut.endsAt = Date.now() + ms;
    t.setTimer(TIMER, ms, () => {
        if (!live(t, epoch)) return;
        try {
            fn();
        } catch (err) {
            socketLogger.error('Cut for a buck step failed', { tournamentId: t.tournamentId, error: err.message, stack: err.stack });
        }
    });
}

/**
 * Private system lines to the room's sockets without the cap (members and
 * spectators): they show the round as chat (never stored).
 */
function legacyLines(io, t, lines) {
    if (!lines.length) return;
    const targets = [];
    for (const [sid, p] of t.players) {
        if (p.connected === false || !io?.sockets?.sockets?.get(sid) || hasCap(io, sid)) continue;
        targets.push(sid);
    }
    for (const [sid] of t.spectators) {
        if (!io?.sockets?.sockets?.get(sid) || hasCap(io, sid)) continue;
        targets.push(sid);
    }
    for (const sid of targets) {
        for (const line of lines) io.to(sid).emit('tournamentMessage', systemLine(line));
    }
}

function roomLine(io, t, line) {
    t.broadcast(io, 'tournamentMessage', systemLine(line));
}

// ==================== start ====================

/**
 * broadcastRoundOutcome, the last round complete (phase 'complete' from
 * completeRound): start the gather, or not. Synchronous, before any emit.
 * @returns {boolean} true: the cut started (the caller sends nothing more)
 */
function maybeStart(io, t) {
    if (!t || t.phase !== 'complete' || t.retired || t.frozen) return false;
    if (!enabled()) return false;
    const here = present(io, t);
    if (here.length < 2 || !here.some((m) => hasCap(io, m.socketId))) return false;
    startGather(io, t, here.map((m) => m.username));
    return true;
}

function startGather(io, t, candidates) {
    const ms = pacing().CUT_GATHER_MS;
    t.phase = 'cut';
    t.completedAt = null;
    t.cut = { stage: 'gather', candidates, engine: null, strikes: {}, lastReveal: null, result: null, endsAt: null, restoreLine: false };
    t._changed();
    t.broadcast(io, 'cutForABuckStart', { candidates: [...candidates], startsInMs: ms, deckCount: DECK_SIZE * decksFor(candidates.length) });
    roomLine(io, t, START_LINE);
    lifecycle().emitLobbiesUpdated(io);
    arm(io, t, ms, () => beginCut(io, t));
    socketLogger.info('Cut for a buck: gather', { tournamentId: t.tournamentId, candidates: candidates.length });
}

/** The gather ended: fix the participants, then the first round. */
function beginCut(io, t) {
    const here = present(io, t);
    if (here.length < 2 || !here.some((m) => hasCap(io, m.socketId))) {
        roomLine(io, t, NOT_ENOUGH_LINE);
        finish(io, t, null);
        return;
    }
    const participants = here.map((m) => m.username);
    t.cut.engine = new CutEngine(participants, engineOptions);
    t.cut.stage = 'drawing';
    const missed = Array.from(t.players.values(), (p) => p.username).filter((u) => u && !participants.includes(u));
    let line = `Cut for a buck: ${participants.length} players.`;
    if (missed.length) line += ` ${joinNames(missed)} ${missed.length === 1 ? 'was' : 'were'} not back in time.`;
    roomLine(io, t, line);
    socketLogger.info('Cut for a buck: begins', { tournamentId: t.tournamentId, participants: participants.length, missed: missed.length });
    openRound(io, t);
}

// ==================== rounds ====================

/** Draw at once for this player at a round's open? */
function autoAtOpen(io, t, username) {
    const m = memberOf(t, username);
    if (!m || m.connected === false || !io?.sockets?.sockets?.get(m.socketId)) return true;
    if (!hasCap(io, m.socketId)) return true;
    return (t.cut.strikes[username] || 0) >= CUT_AWAY_STRIKES;
}

function openRound(io, t) {
    const e = t.cut.engine;
    if (e.round >= maxRounds()) {
        socketLogger.error('Cut for a buck: round cap reached, a random winner', { tournamentId: t.tournamentId, rounds: e.round, alive: e.alive.size });
        e.forceWinner();
        declareWinner(io, t);
        return;
    }
    const r = e.openRound();
    t.cut.stage = 'drawing';
    const ms = drawMs();
    t.broadcast(io, 'cutForABuckRound', {
        round: r.round, participants: [...e.participants], alive: r.alive, deckCount: r.deckCount, reshuffled: r.reshuffled, closesInMs: ms
    });
    if (r.reshuffled) legacyLines(io, t, ['Reshuffling: the deck ran out.']);
    arm(io, t, ms, () => closeRound(io, t));
    for (const u of r.alive) {
        if (t.cut?.stage !== 'drawing' || e.round !== r.round || !e.open) break;
        if (autoAtOpen(io, t, u)) autoDraw(io, t, u);
    }
    t._changed();
}

/** The server draws for `username` (auto). @returns {boolean} drawn */
function autoDraw(io, t, username, { strike = false } = {}) {
    const e = t.cut?.engine;
    if (!e || t.cut.stage !== 'drawing') return false;
    const d = e.draw(username, null, { auto: true });
    if (!d) return false;
    if (strike) t.cut.strikes[username] = (t.cut.strikes[username] || 0) + 1;
    t.broadcast(io, 'cutForABuckDrew', { round: e.round, username, slot: d.slot, auto: true });
    if (d.allDrawn) reveal(io, t);
    return true;
}

/** The draw window closed: everyone still to draw is drawn for (a strike each). */
function closeRound(io, t) {
    const e = t.cut.engine;
    if (t.cut.stage !== 'drawing' || !e.open) return;
    const waiting = e.waitingFor();
    if (waiting.length === 0) {
        reveal(io, t);
        return;
    }
    for (const u of waiting) autoDraw(io, t, u, { strike: true });
}

/** Legacy chat lines for a reveal. */
function revealLines(res) {
    const lines = [];
    if (res.redraw) {
        lines.push(`Round ${res.round}: everyone tied on ${rankPlural(res.draws[0].card.rank)}, so draw again.`);
        return lines;
    }
    const cards = res.draws.map((d) => `${d.username} ${cardText(d.card)}`).join(', ');
    const out = res.eliminated;
    lines.push(`Round ${res.round}: ${cards}. ${joinNames(out)} ${out.length === 1 ? 'is' : 'are'} out.`);
    return lines;
}

function reveal(io, t) {
    const e = t.cut.engine;
    t.clearTimer(TIMER);
    const res = e.resolve();
    t.cut.lastReveal = { round: res.round, draws: res.draws, eliminated: res.eliminated, redraw: res.redraw };
    const ms = res.winner ? pacing().CUT_WINNER_MS : pacing().CUT_REVEAL_MS;
    t.cut.stage = res.winner ? 'winner' : 'reveal';
    t.broadcast(io, 'cutForABuckReveal', {
        round: res.round,
        draws: res.draws.map((d) => ({ username: d.username, slot: d.slot, card: { suit: d.card.suit, rank: d.card.rank } })),
        eliminated: [...res.eliminated],
        redraw: res.redraw,
        alive: [...res.alive],
        nextInMs: ms
    });
    legacyLines(io, t, revealLines(res));
    t._changed();
    if (res.winner) {
        declareWinner(io, t);
    } else {
        arm(io, t, ms, () => openRound(io, t));
    }
}

function declareWinner(io, t) {
    const e = t.cut.engine;
    const result = { winner: e.winner, participants: [...e.participants], rounds: e.round };
    t.cut.stage = 'winner';
    t.cut.result = result;
    t._changed();
    t.broadcast(io, 'cutForABuckWinner', { winner: result.winner, participants: [...result.participants], rounds: result.rounds });
    roomLine(io, t, `${result.winner} won Cut for a buck.`);
    socketLogger.info('Cut for a buck: winner', { tournamentId: t.tournamentId, rounds: result.rounds, participants: result.participants.length });
    arm(io, t, pacing().CUT_WINNER_MS, () => finish(io, t, result));
}

/** Complete the tournament (once: only from phase 'cut'). */
function finish(io, t, result) {
    if (!t || t.phase !== 'cut') return Promise.resolve(false);
    t.clearTimer(TIMER);
    return handlers().finishTournament(io, t, { cut: result || null, fromCut: true })
        .then(() => true)
        .catch((err) => {
            socketLogger.error('Cut for a buck: finish failed', { tournamentId: t.tournamentId, error: err.message });
            return false;
        });
}

// ==================== c2s ====================

/** c2s cutForABuckDraw {round, slot|null} (Joi-validated). */
function draw(socket, io, data) {
    const drop = (why) => {
        socketLogger.debug('cutForABuckDraw dropped', { socketId: socket.id, why });
    };
    const t = gameManager.getPlayerTournament(socket.id);
    if (!t) return drop('not a member');
    if (t.phase !== 'cut' || !t.cut) return drop('phase');
    if (t.cut.stage !== 'drawing') return drop('stage');
    const e = t.cut.engine;
    if (!e || !e.open || data?.round !== e.round) return drop('round');
    const username = t.players.get(socket.id)?.username;
    if (!username || !e.alive.has(username)) return drop('not alive');
    const d = e.draw(username, data.slot ?? null);
    if (!d) return drop('repeat');
    delete t.cut.strikes[username];
    t.broadcast(io, 'cutForABuckDrew', { round: e.round, username, slot: d.slot, auto: false });
    require('./tournamentLiveness').noteActivity(io, t, socket.id);
    if (d.allDrawn) reveal(io, t);
    t._changed();
}

// ==================== presence ====================

/** A member's socket dropped (queueHandlers.handleDisconnect): an open draw is drawn for now. */
function memberDisconnected(io, t, username) {
    if (!t || t.phase !== 'cut' || !t.cut || t.cut.stage !== 'drawing' || !username) return false;
    const e = t.cut.engine;
    if (!e || !e.open || !e.alive.has(username) || e.pending.has(username)) return false;
    return autoDraw(io, t, username);
}

/**
 * A member left the tournament during the cut (tournamentHandlers
 * leaveTournament, after the leave): out of the cut (cutForABuckLeft),
 * then the winner (one left) or the reveal (everyone left has drawn).
 */
function memberLeft(io, t, username) {
    if (!t || t.phase !== 'cut' || !t.cut || !username) return false;
    const e = t.cut.engine;
    if (!e || !e.alive.has(username)) return false;
    const freed = e.undraw(username);
    e.remove(username);
    t.broadcast(io, 'cutForABuckLeft', {
        round: e.round, username, alive: e.aliveList(), ...(freed !== null ? { freedSlot: freed } : {})
    });
    t._changed();
    if (t.cut.stage === 'winner') return true;
    if (e.winner) {
        t.clearTimer(TIMER);
        e.cancelRound();
        declareWinner(io, t);
    } else if (t.cut.stage === 'drawing' && e.allDrawn()) {
        reveal(io, t);
    }
    return true;
}

/**
 * The host's cancelTournament during the cut (any stage): the cut ends and
 * the tournament completes with no cut result ("<host> ended Cut for a
 * buck." first). Also the last member leaving ({line: false}).
 */
function cancel(io, t, hostName, { line = true } = {}) {
    if (!t || t.phase !== 'cut') return Promise.resolve(false);
    t.clearTimer(TIMER);
    if (line) roomLine(io, t, `${hostName || 'The host'} ended Cut for a buck.`);
    socketLogger.info(line ? 'Cut for a buck: ended by the host' : 'Cut for a buck: the last member left', { tournamentId: t.tournamentId, stage: t.cut?.stage });
    return finish(io, t, null);
}

/**
 * The member is back on the tournament lobby screen (joinTournament's
 * reattach, returnToTournament): its away strikes end; a restored cut's
 * "continues" line goes out once, at the first member back.
 */
function noteBack(io, t, username) {
    if (!t || t.phase !== 'cut' || !t.cut) return;
    if (username) delete t.cut.strikes[username];
    if (t.cut.restoreLine) {
        t.cut.restoreLine = false;
        roomLine(io, t, RESTORE_LINE);
    }
}

// ==================== deploy survival ====================

/**
 * A restored tournament in phase 'cut' (persist/restoreTournament
 * adoptTournament): after `leadInMs` the gather's begin (participants: the
 * members back by then), the winner again, or the interrupted round redrawn.
 */
function afterRestore(io, t, leadInMs) {
    if (!t || t.phase !== 'cut' || !t.cut) return;
    t.cut.restoreLine = true;
    if (t.cut.stage !== 'gather') t.cut.stage = t.cut.engine?.winner ? 'winner' : 'reveal';
    arm(io, t, leadInMs, () => {
        if (t.cut.stage === 'gather') return beginCut(io, t);
        if (t.cut.engine.winner) return declareWinner(io, t);
        return openRound(io, t);
    });
}

/** The pending cards of every live cut (tests: the secrecy guard). */
function _pendingCardsForTests() {
    const out = [];
    for (const t of gameManager.tournaments.values()) {
        const e = t.cut?.engine;
        if (!e || !e.open) continue;
        const revealed = [...e.table.values()].flat();
        for (const d of t.cut.lastReveal?.draws || []) revealed.push(d.card);
        out.push({ tournamentId: t.tournamentId, cards: e.pendingCards(), revealed });
    }
    return out;
}

module.exports = {
    CAP,
    CUT_AWAY_STRIKES,
    START_LINE,
    NOT_ENOUGH_LINE,
    RESTORE_LINE,
    enabled,
    drawMs,
    maxRounds,
    maybeStart,
    beginCut,
    openRound,
    closeRound,
    reveal,
    draw,
    memberDisconnected,
    memberLeft,
    cancel,
    noteBack,
    afterRestore,
    cardText,
    revealLines,
    joinNames,
    setEngineOptionsForTests,
    _pendingCardsForTests
};

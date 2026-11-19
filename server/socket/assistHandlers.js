/**
 * /help (plan H2c, sections 4.2-4.3; owner answers 2026-11-18): a seat
 * owner asks for the bid or card a Mary bot would choose in their seat, with
 * the reasons (server/game/assist: seatView -> advise -> explain). Carried
 * by chatMessage: `/help` (chatHandlers.ownerCommand) and the exact line
 * `?help` (any case, surrounding spaces ignored), the only way shipped iOS
 * builds can ask (they refuse unknown / commands on the device). Neither is
 * ever broadcast, filtered or logged as chat; "?help me" and "help!" are
 * ordinary chat.
 *
 * Flow (every reply is private to the asking socket):
 *  1. Guards, each a reply that is never counted or announced: a
 *     bot-controlled seat (lazy, resigned: "Type /active first"), the
 *     tournament switch (ASSIST_IN_TOURNAMENTS, on: /help is allowed at
 *     tournament tables and counts there too), the rate limit (rateLimiter
 *     key `assist`, 4 per 10 s per socket), no open turn ("Nothing to
 *     suggest right now."), and off-turn the status line (explain.status:
 *     who is on turn, the bid so far).
 *  2. The answer: one per (seat, game.turnKey()) in a module WeakMap cache
 *     (at most CACHE_PER_GAME per game), so a re-ask costs nothing. A play
 *     the search would look at spends a token of a process-wide bucket
 *     (BUDGET_PER_SEC searched answers a second); without one the answer is
 *     rules only ("Quick suggestion"; never cached; /health assist.quick).
 *     The search reports its own errors to a local logger (hand sizes only,
 *     never a card), never to SEARCH.errors or the bots' log. Anything that
 *     throws is "No suggestion this time." and not counted.
 *  3. Counting (game.assist[pos], server/game/assistState.js, SAVED): a
 *     forced move (one legal card) is answered but not counted; a re-ask on
 *     the turn already counted (a.lastHelpKey, also after a restore) is
 *     answered from the cache and not counted. A record that belongs to
 *     someone else is reset first (the defensive reset). The counter moves
 *     BEFORE the notice's addLogEntry, whose persist hook saves the game.
 *  4. The reply: a socket with the clientHello cap `assist` gets the private
 *     s2c `assistHint` (unsequenced); any other socket gets the answer as a
 *     private gameLogEntry {type: 'system'} line (copy.render 'line'), plus
 *     a second line only for the warning on the last free use. Private
 *     lines are never stored in game.gameLog, so no snapshot has them.
 *  5. The notice, on every counted use (so at most once per turn): the room
 *     line "<name> used /help." (stored and broadcast like any system line),
 *     which on the use that crosses the threshold reads "<name> used /help.
 *     This game now counts as bot-assisted for <name>." Names only, never a
 *     team number or "your team" / "opponents".
 *
 * Never touches the turn: no timer, no afk clock, no bid clock (a running
 * bid clock keeps its deadline; its timeout bid of 0 is not a /help use).
 * Pure reads of the game except the counter and the notice.
 *
 * Spectators get "/help is for players only." (a seat owner watching as a
 * spectator gets chatHandlers' line for its seat instead: a bot holds it,
 * /active first) and entrants (the draw, before seats exist) "Suggestions
 * are available once the game starts.", for /help and ?help alike. Lines
 * that tell a player to wait never name /help: shipped iOS builds can only
 * ask with ?help. At the end of a finished game each player the game counted as
 * bot-assisted for gets one private line (gameEndLines).
 */

'use strict';

const { Controller } = require('../game/SeatState');
const { seatView } = require('../game/assist/seatView');
const { advise, searchEligible } = require('../game/assist/advise');
const { explain, status } = require('../game/assist/explain');
const { render, clip, TEXT_MAX } = require('../game/assist/copy');
const { ASSIST_FREE_HELP, defaultAssistSeat, isAssistedSeat, helpUses } = require('../game/assistState');
const rateLimiter = require('./rateLimiter');
const { socketHasCap } = require('./clientInfo');
const { gameLogger } = require('../utils/logger');

/** /help at tournament tables (owner 2026-11-18: allowed, and counted there too). */
const ASSIST_IN_TOURNAMENTS = true;
/** Cached answers kept per game (one per seat and turn; old turns drop out first). */
const CACHE_PER_GAME = 8;
/** Searched answers per second, process-wide; above it, rules only. */
const BUDGET_PER_SEC = 60;
/** The clientHello cap of a client that renders assistHint. */
const CAP = 'assist';

const ordinal = (n) => {
    const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th';
    return `${n}${s}`;
};

/** Every line a player can see from this module (names filled in by the callers). */
const TEXT = Object.freeze({
    botSeat: 'A bot is playing your seat. Type /active first.',
    tournament: '/help isn\'t available in tournament games.',
    rateLimited: 'One moment: try again in a few seconds.',
    nothing: 'Nothing to suggest right now.',
    error: 'No suggestion this time.',
    spectator: '/help is for players only.',
    entrant: 'Suggestions are available once the game starts.',
    warning: `That's your ${ordinal(ASSIST_FREE_HELP)} free /help. The next one makes this game count as bot-assisted for you: it goes in your bot-game stats, not the human leaderboard.`,
    notice: (name) => `${name} used /help.`,
    crossedNote: 'This game now counts as bot-assisted for you.',
    crossed: (name) => `${name} used /help. This game now counts as bot-assisted for ${name}.`,
    gameEnd: (uses) => `This game counted as bot-assisted for you (${uses} /help uses), so it's in your bot-game stats.`
});

// ------------------------------------------------------------ module state

/** game -> Map(`${pos}|${turnKey}` -> {decision, e}); dies with the game. */
let cache = new WeakMap();
/** Process counters for /health (counts only). */
const counters = { answered: 0, quick: 0, errors: 0 };

/**
 * A token bucket: `perSec` tokens a second, refilling continuously, at most
 * `perSec` banked. `now` is injectable for tests.
 */
function createBudget({ perSec = BUDGET_PER_SEC, now = () => Date.now() } = {}) {
    let tokens = perSec;
    let last = now();
    return {
        take() {
            const t = now();
            tokens = Math.min(perSec, tokens + Math.max(0, t - last) * perSec / 1000);
            last = t;
            if (tokens >= 1) {
                tokens -= 1;
                return true;
            }
            return false;
        }
    };
}
let budget = createBudget();

function cached(game, key) {
    return cache.get(game)?.get(key) || null;
}

function remember(game, key, answer) {
    let m = cache.get(game);
    if (!m) cache.set(game, (m = new Map()));
    m.set(key, answer);
    while (m.size > CACHE_PER_GAME) m.delete(m.keys().next().value);
}

// ------------------------------------------------------------ delivery

const hasCap = (io, sid) => socketHasCap(io, sid, CAP);

/** One private, unstored system line (never in game.gameLog, so never in a snapshot). */
function sendLine(io, game, sid, message) {
    game.sendToPlayer(io, sid, 'gameLogEntry', { message: clip(message, TEXT_MAX), type: 'system' });
}

/** What the asking seat's counters say, for the hint and the line tail. */
function tally(game, pos) {
    const owner = pos ? game.seat(pos)?.ownerUsername : null;
    const a = pos ? game.assist?.[pos] : null;
    const uses = helpUses(a, owner);
    return { uses, freeUses: ASSIST_FREE_HELP, assisted: isAssistedSeat(a, owner) };
}

/** A reply with no suggestion (a refusal, the status line): never counted. */
function sendStatus(io, game, sid, pos, text) {
    if (hasCap(io, sid)) {
        game.sendToPlayer(io, sid, 'assistHint', {
            v: 1,
            source: 'help',
            kind: 'status',
            turnKey: game.turnKey(),
            headline: clip(text, TEXT_MAX),
            reasons: [],
            ...tally(game, pos),
            counted: false
        });
    } else {
        sendLine(io, game, sid, text);
    }
}

function hintPayload(game, key, { decision, e }, t, counted, note) {
    const p = {
        v: 1,
        source: 'help',
        kind: decision.kind,
        turnKey: key,
        headline: clip(e.headline, TEXT_MAX),
        reasons: e.reasons.map((r) => clip(r, TEXT_MAX)),
        ...t,
        counted,
        details: e.details.map((d) => clip(d, TEXT_MAX)),
        confidence: e.confidence,
        suggest: decision.kind === 'bid' ? { bid: decision.bid } : { card: { suit: decision.card.suit, rank: decision.card.rank } },
        codes: e.codes.slice()
    };
    if (note) p.note = clip(note, TEXT_MAX);
    return p;
}

// ------------------------------------------------------------ entry points

const isTournament = (game) => {
    const gm = require('../game/GameManager');
    return gm.tournamentGames.has(game.gameId);
};

/** Is `message` the ?help keyword (the exact line, any case)? */
function isHelpKeyword(message) {
    return typeof message === 'string' && message.trim().toLowerCase() === '?help';
}

/** Is `command` (trimmed, lower case) a /help command ("/help", "/help <anything>")? */
function isHelpCommand(command) {
    return command === '/help' || command.startsWith('/help ');
}

/**
 * /help or ?help from any game socket (chatHandlers.resolveSender's role):
 * a seat owner is answered (help), a spectator or entrant gets its line.
 * `spectatorLine` replaces "players only" for a spectator whose recorded
 * user owns a seat here (chatHandlers.helpRequest).
 */
function request(socket, io, { game, role, pos }, { spectatorLine = null } = {}) {
    if (role === 'owner') help(socket, io, game, pos);
    else if (role === 'entrant') sendStatus(io, game, socket.id, null, TEXT.entrant);
    else sendStatus(io, game, socket.id, null, spectatorLine || TEXT.spectator);
}

/**
 * /help from the owner socket of seat `pos`.
 * @returns {string} what happened (for tests and logs): 'botSeat' |
 *   'tournament' | 'rateLimited' | 'nothing' | 'status' | 'error' |
 *   'forced' | 'again' | 'counted'
 */
function help(socket, io, game, pos) {
    const sid = socket.id;
    const seat = game.seat(pos);
    if (!seat || seat.controller !== Controller.HUMAN) {
        sendStatus(io, game, sid, pos, TEXT.botSeat);
        return 'botSeat';
    }
    if (!ASSIST_IN_TOURNAMENTS && isTournament(game)) {
        sendStatus(io, game, sid, pos, TEXT.tournament);
        return 'tournament';
    }
    if (!rateLimiter.check(sid, 'assist')) {
        sendStatus(io, game, sid, pos, TEXT.rateLimited);
        return 'rateLimited';
    }
    if (!game.acceptsTurnInput()) {
        sendStatus(io, game, sid, pos, TEXT.nothing);
        return 'nothing';
    }

    const key = game.turnKey();
    const cacheKey = `${pos}|${key}`;
    let answer = cached(game, cacheKey);
    if (!answer) {
        try {
            const view = seatView(game, pos);
            if (!view) {
                sendStatus(io, game, sid, pos, TEXT.nothing);
                return 'nothing';
            }
            if (view.currentTurn !== pos) {
                sendStatus(io, game, sid, pos, status(view));
                return 'status';
            }
            const full = !(view.stage === 'play' && searchEligible(view)) || budget.take();
            const onError = (err, cardsInHand, handSize) => gameLogger.warn('/help search error', {
                gameId: game.gameId, cardsInHand, handSize, error: err && err.name
            });
            const decision = advise(view, { budget: full ? 'full' : 'rules', onError });
            if (!decision) {
                sendStatus(io, game, sid, pos, TEXT.nothing);
                return 'nothing';
            }
            if (decision.source === 'quick') counters.quick++;
            answer = { decision, e: explain(decision, view, { mode: 'help' }) };
            if (decision.source !== 'quick') remember(game, cacheKey, answer);
        } catch (err) {
            counters.errors++;
            gameLogger.error('/help failed', { gameId: game.gameId, position: pos, error: err && err.message });
            sendStatus(io, game, sid, pos, TEXT.error);
            return 'error';
        }
    }
    counters.answered++;

    // Count (before the notice: its addLogEntry persists the counter)
    const owner = seat.ownerUsername;
    const forced = answer.decision.forced;
    let counted = false;
    if (!forced) {
        // game.assist is built by the GameState constructor and restoreFrom
        let a = game.assist[pos];
        if (!a || a.user !== owner) a = game.assist[pos] = { ...defaultAssistSeat(), user: owner };
        if (a.lastHelpKey !== key) {
            a.help++;
            a.lastHelpKey = key;
            counted = true;
        }
    }
    const t = tally(game, pos);
    const warn = counted && t.uses === ASSIST_FREE_HELP;
    const crossed = counted && t.uses === ASSIST_FREE_HELP + 1;

    // Reply
    if (hasCap(io, sid)) {
        const note = warn ? TEXT.warning : crossed ? TEXT.crossedNote : null;
        game.sendToPlayer(io, sid, 'assistHint', hintPayload(game, key, answer, t, counted, note));
    } else {
        sendLine(io, game, sid, render(answer.e, { style: 'line', uses: t.uses, freeUses: t.freeUses, counted: !forced }));
        if (warn) sendLine(io, game, sid, TEXT.warning);
    }

    // Notice (counted uses only)
    if (counted) {
        const message = crossed ? TEXT.crossed(owner) : TEXT.notice(owner);
        game.addLogEntry(message, null, 'system');
        game.broadcast(io, 'gameLogEntry', { message, type: 'system' });
    }
    return forced ? 'forced' : counted ? 'counted' : 'again';
}

/**
 * At the end of a finished game (before gameEnd): one private line to each
 * player the game counted as bot-assisted for, at their owner socket.
 */
function gameEndLines(io, game) {
    for (let pos = 1; pos <= 4; pos++) {
        const seat = game.seat(pos);
        const owner = seat?.ownerUsername;
        const a = game.assist?.[pos];
        if (!seat?.ownerSocketId || !isAssistedSeat(a, owner)) continue;
        sendLine(io, game, seat.ownerSocketId, TEXT.gameEnd(a.help));
    }
}

/** /health `assist`: process counts since boot (no names, no ids). */
function assistHealth() {
    return { answered: counters.answered, quick: counters.quick, errors: counters.errors };
}

/** Tests only: a fresh cache, budget (optionally {perSec, now}) and counters. */
function _resetForTests(budgetOpts) {
    cache = new WeakMap();
    budget = createBudget(budgetOpts);
    counters.answered = 0;
    counters.quick = 0;
    counters.errors = 0;
}

module.exports = {
    TEXT,
    ASSIST_IN_TOURNAMENTS,
    CACHE_PER_GAME,
    BUDGET_PER_SEC,
    CAP,
    isHelpKeyword,
    isHelpCommand,
    request,
    help,
    gameEndLines,
    assistHealth,
    createBudget,
    _resetForTests
};

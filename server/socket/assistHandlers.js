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
 * bot-assisted for gets one private line (gameEndLines): a win went to their
 * bot-game stats, a loss or tie stayed in their human stats (owner
 * 2026-11-21; profileHandlers.buildGameEndRecord).
 *
 * A game with a native bot seat (assistState.isFreeHelpGame: lobby Add Bot,
 * tournament filler, solo; never a lazy or resign bot), owner 2026-11-19
 * "Unlimited, keep notice": /help has no limit there, since the game is in
 * the bot-game stats anyway, and players see nothing about free uses or
 * limits (owner wording rule: "say nothing"). The counter and the notice
 * "<name> used /help." stay (same counting, re-ask and forced rules); the
 * plain-text answer has no count tail ("(Not counted.)" only for an answer
 * not counted), there is no warning, no crossing note or notice, no
 * end-of-game line, assisted is never true on the wire, and the hint and
 * snapshot carry the additive `unlimited: true`. Recording is unchanged:
 * profileHandlers.buildGameEndRecord still marks a player with more than 3
 * counted uses as bot-assisted (assistedTeams, statsDeltas.assist).
 *
 * The tutorial (the LEAN scope of 2026-11-19 with the fade-out;
 * docs/claude/assist.md, The tutorial): `/tutorial` toggles, `/tutorial
 * on|off` sets, `/tutorial keep` (the welcome tip's Keep) only acknowledges
 * it and `/tutorial close` (its ✕) dismisses an auto-start; all through
 * chatMessage. While on and the seat's owner socket has the cap `tutorial`,
 * tutorTick (after every updateTurn, in a setImmediate: the turn event is
 * never delayed) pushes on each of the seat's own non-forced decisions the
 * same answer /help gives (same cache, source 'tutorial', never counted, no
 * room notice) and the rule tips of server/game/assist/curriculum.js (one
 * per own decision, one between two of them, each topic once per game:
 * game.assist[pos].tips); from the end of the 2-card hand the advice fades
 * out to the tricky choices (curriculum.showAdvice). A new account's first
 * game starts with it on (autoStart: users.tutorial 'pending', the
 * clientHello cap `tutorial`, not a tournament). Turning it on makes the
 * game bot-assisted for the player (tutorialEver), except an auto-start
 * turned off before the seat's first own decision.
 */

'use strict';

const { Controller, Presence } = require('../game/SeatState');
const { seatView } = require('../game/assist/seatView');
const { advise, searchEligible } = require('../game/assist/advise');
const { explain, status } = require('../game/assist/explain');
const { render, clip, TEXT_MAX } = require('../game/assist/copy');
const curriculum = require('../game/assist/curriculum');
const { ASSIST_FREE_HELP, defaultAssistSeat, isAssistedSeat, usedTutorial, isFreeHelpGame, isBotStatsGame, seatOutcome, assistTally } = require('../game/assistState');
const { HAND_PROGRESSION } = require('../game/rules');
const persistHooks = require('../game/persist/hooks');
const rateLimiter = require('./rateLimiter');
const { socketHasCap } = require('./clientInfo');
const { gameLogger } = require('../utils/logger');
const { safeImmediate } = require('../utils/safeTimer');
// lazy: shoulderView requires GameManager (the over-the-shoulder view's
// watchers get the watched seat's hints, mirrorHint)
const shoulderView = () => require('./shoulderView');

/** /help at tournament tables (owner 2026-11-18: allowed, and counted there too). */
const ASSIST_IN_TOURNAMENTS = true;
/** Cached answers kept per game (one per seat and turn; old turns drop out first). */
const CACHE_PER_GAME = 8;
/** Searched answers per second, process-wide; above it, rules only. */
const BUDGET_PER_SEC = 60;
/** The clientHello cap of a client that renders assistHint. */
const CAP = 'assist';
/** The clientHello cap of a client that renders tutorial tips (kind tip, actions) and assistState; only it is auto-started. */
const TUTORIAL_CAP = 'tutorial';

const ordinal = (n) => {
    const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th';
    return `${n}${s}`;
};

/**
 * Where a bot-assisted game's stats go (owner 2026-11-21: only a win moves
 * them to the bot-game stats; assistState.assistedSeatMoves). The web
 * (client/src/state/tutorial.js CONFIRM_MESSAGE) and iOS
 * (TutorialRules.confirmMessage, UIFixture.assistWarning) hold the same words.
 */
const STATS_RULE = 'a win goes in your bot-game stats, a loss or tie stays in your human stats.';
/** The game-end line's second sentence, by assistState.seatOutcome. */
const OUTCOME_LINE = Object.freeze({
    won: 'You won, so it\'s in your bot-game stats.',
    lost: 'You lost, so it stays in your human stats.',
    tied: 'It was a tie, so it stays in your human stats.'
});

/** Every line a player can see from this module (names filled in by the callers). */
const TEXT = Object.freeze({
    botSeat: 'A bot is playing your seat. Type /active first.',
    tournament: '/help isn\'t available in tournament games.',
    rateLimited: 'One moment: try again in a few seconds.',
    nothing: 'Nothing to suggest right now.',
    error: 'No suggestion this time.',
    spectator: '/help is for players only.',
    entrant: 'Suggestions are available once the game starts.',
    warning: `That's your ${ordinal(ASSIST_FREE_HELP)} free /help. The next one makes this game count as bot-assisted for you: ${STATS_RULE}`,
    notice: (name) => `${name} used /help.`,
    crossedNote: 'This game now counts as bot-assisted for you.',
    crossed: (name) => `${name} used /help. This game now counts as bot-assisted for ${name}.`,
    gameEnd: (uses, outcome) => `This game counted as bot-assisted for you (${uses} /help uses). ${OUTCOME_LINE[outcome]}`,
    // The tutorial
    tutorialSpectator: '/tutorial is for players only.',
    tutorialEntrant: 'The tutorial can be turned on once the game starts.',
    tutorialUsage: 'Type /tutorial on or /tutorial off.',
    tutorialAlreadyOn: 'The tutorial is already on.',
    tutorialAlreadyOff: 'The tutorial is already off.',
    tutorialOff: 'Tips off. /help still works any time.',
    tutorialOnNotice: (name, free) => (free ? `${name} turned on the tutorial.` : `${name} turned on the tutorial. This game counts as bot-assisted for ${name}.`),
    tutorialAutoNotice: (name) => `${name} is playing with the tutorial.`,
    tutorialCountsNotice: (name) => `This game now counts as bot-assisted for ${name}.`,
    tutorialOffNotice: (name) => `${name} turned off the tutorial.`,
    tipLine: (text) => `Tip: ${text}`,
    gameEndTutorial: (outcome) => `This game counted as bot-assisted for you (you played with the tutorial). ${OUTCOME_LINE[outcome]}`
});

// ------------------------------------------------------------ module state

/** game -> Map(`${pos}|${turnKey}` -> {decision, e}); dies with the game. */
let cache = new WeakMap();
/**
 * The tutor's per-seat window (DERIVED, never saved: a restore starts it
 * empty, so at worst one tip window is reopened): game -> {pos: {lastKey,
 * windowUsed, graduateUnsent}}. lastKey: the turnKey the seat was last
 * ticked at; windowUsed: a rule tip was shown since the seat's last own
 * decision (only that decision reopens it, never a hand end);
 * graduateUnsent: T.graduate's bit was set at the end of the 2-card hand
 * while the seat could not be told (away, lazy, no cap): the next tick
 * with a socket that has the cap sends it.
 */
let tutor = new WeakMap();
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
const hasTutorialCap = (io, sid) => socketHasCap(io, sid, TUTORIAL_CAP);

/** One private, unstored system line (never in game.gameLog, so never in a snapshot). */
function sendLine(io, game, sid, message) {
    game.sendToPlayer(io, sid, 'gameLogEntry', { message: clip(message, TEXT_MAX), type: 'system' });
}

/**
 * What the asking seat's counters say, for the hint and the line tail
 * (+ unlimited: true in a game with a native bot seat, isFreeHelpGame).
 */
function tally(game, pos) {
    const owner = pos ? game.seat(pos)?.ownerUsername : null;
    const a = pos ? game.assist?.[pos] : null;
    return assistTally(a, owner, isFreeHelpGame(game));
}

/** A reply with no suggestion (a refusal, the status line): never counted. */
function sendStatus(io, game, sid, pos, text, source = 'help') {
    if (hasCap(io, sid)) {
        game.sendToPlayer(io, sid, 'assistHint', {
            v: 1,
            source,
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

function hintPayload(game, key, { decision, e }, t, counted, note, source = 'help') {
    const p = {
        v: 1,
        source,
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

/** Is `command` (trimmed, lower case) a /tutorial command ("/tutorial", "/tutorial <word>")? */
function isTutorialCommand(command) {
    return command === '/tutorial' || command.startsWith('/tutorial ');
}

/**
 * /help or ?help (or, with `tutorial`, a /tutorial command) from any game
 * socket (chatHandlers.resolveSender's role): a seat owner is answered, a
 * spectator or entrant gets its line. `spectatorLine` replaces "players
 * only" for a spectator whose recorded user owns a seat here
 * (chatHandlers.helpRequest).
 */
function request(socket, io, { game, role, pos }, { spectatorLine = null, tutorial = null } = {}) {
    if (tutorial) {
        if (role === 'owner') tutorialCommand(socket, io, game, pos, tutorial);
        else if (role === 'entrant') sendStatus(io, game, socket.id, null, TEXT.tutorialEntrant, 'tutorial');
        else sendStatus(io, game, socket.id, null, spectatorLine || TEXT.tutorialSpectator, 'tutorial');
        return;
    }
    if (role === 'owner') help(socket, io, game, pos);
    else if (role === 'entrant') sendStatus(io, game, socket.id, null, TEXT.entrant);
    else sendStatus(io, game, socket.id, null, spectatorLine || TEXT.spectator);
}

/**
 * The answer for seat `pos` on the current turn: from the cache (one per
 * seat and turnKey, shared by /help and the tutorial), else advise() +
 * explain() (a searched play takes a token of the budget, else rules only:
 * a Quick suggestion, never cached).
 * @returns {{answer: {decision, e}}|{status: 'nothing'|'status'|'error', text: string}}
 */
function computeAnswer(game, pos) {
    const key = game.turnKey();
    const cacheKey = `${pos}|${key}`;
    const hit = cached(game, cacheKey);
    if (hit) return { answer: hit };
    try {
        const view = seatView(game, pos);
        if (!view) return { status: 'nothing', text: TEXT.nothing };
        if (view.currentTurn !== pos) return { status: 'status', text: status(view) };
        const full = !(view.stage === 'play' && searchEligible(view)) || budget.take();
        const onError = (err, cardsInHand, handSize) => gameLogger.warn('/help search error', {
            gameId: game.gameId, cardsInHand, handSize, error: err && err.name
        });
        const decision = advise(view, { budget: full ? 'full' : 'rules', onError });
        if (!decision) return { status: 'nothing', text: TEXT.nothing };
        if (decision.source === 'quick') counters.quick++;
        const answer = { decision, e: explain(decision, view, { mode: 'help' }) };
        if (decision.source !== 'quick') remember(game, cacheKey, answer);
        return { answer };
    } catch (err) {
        counters.errors++;
        gameLogger.error('/help failed', { gameId: game.gameId, position: pos, error: err && err.message });
        return { status: 'error', text: TEXT.error };
    }
}

/** The seat's own record, reset first when it belongs to someone else (the defensive reset). */
function ownRecord(game, pos) {
    const owner = game.seat(pos).ownerUsername;
    // game.assist is built by the GameState constructor and restoreFrom
    let a = game.assist[pos];
    if (!a || a.user !== owner) a = game.assist[pos] = { ...defaultAssistSeat(), user: owner };
    return a;
}

/**
 * /help from the owner socket of seat `pos`.
 * @returns {string} what happened (for tests and logs): 'botSeat' |
 *   'tournament' | 'rateLimited' | 'nothing' | 'status' | 'error' |
 *   'forced' | 'again' | 'tutorial' | 'counted'
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
    const got = computeAnswer(game, pos);
    if (!got.answer) {
        sendStatus(io, game, sid, pos, got.text);
        return got.status;
    }
    const answer = got.answer;
    counters.answered++;

    // Count (before the notice: its addLogEntry persists the counter). While
    // the tutorial is on the game is bot-assisted for the seat already, and
    // its advice is pushed anyway: /help is answered but never counted
    const owner = seat.ownerUsername;
    const forced = answer.decision.forced;
    const owned = game.assist[pos] && game.assist[pos].user === owner ? game.assist[pos] : null;
    const tutorialOn = !!owned && owned.tutorial === true;
    let counted = false;
    if (!forced && !tutorialOn) {
        const a = ownRecord(game, pos);
        if (a.lastHelpKey !== key) {
            a.help++;
            a.lastHelpKey = key;
            counted = true;
        }
    }
    const t = tally(game, pos);
    // A game with a native bot seat: no limit shown (no warning, no
    // crossing); a seat the tutorial already made bot-assisted neither
    const viaTutorial = usedTutorial(game.assist[pos], owner);
    const warn = counted && !t.unlimited && !viaTutorial && t.uses === ASSIST_FREE_HELP;
    const crossed = counted && !t.unlimited && !viaTutorial && t.uses === ASSIST_FREE_HELP + 1;

    // Reply
    const note = warn ? TEXT.warning : crossed ? TEXT.crossedNote : null;
    const hint = hintPayload(game, key, answer, t, counted, note);
    if (hasCap(io, sid)) {
        game.sendToPlayer(io, sid, 'assistHint', hint);
    } else {
        sendLine(io, game, sid, render(answer.e, { style: 'line', uses: t.uses, freeUses: t.freeUses, counted: !forced && !tutorialOn, unlimited: !!t.unlimited }));
        if (warn) sendLine(io, game, sid, TEXT.warning);
    }
    // The seat's over-the-shoulder watchers (cap shoulderView): the same
    // answer with watched: pos, without the asker's note
    shoulderView().mirrorHint(io, game, pos, hint);

    // Notice (counted uses only)
    if (counted) {
        // help {position} (additive 2026-11-23, owner: the gray line was hard
        // to see): clients draw the notice in the suggestion's gold
        const message = crossed ? TEXT.crossed(owner) : TEXT.notice(owner);
        const help = { position: pos };
        game.addLogEntry(message, null, 'system', { help });
        game.broadcast(io, 'gameLogEntry', { message, type: 'system', help });
        sendAssistState(io, game, pos);
    }
    return forced ? 'forced' : tutorialOn ? 'tutorial' : counted ? 'counted' : 'again';
}

// ------------------------------------------------------------ the tutorial

/** Post a stored, broadcast room system line (names only). */
function roomLine(io, game, message) {
    game.addLogEntry(message, null, 'system');
    game.broadcast(io, 'gameLogEntry', { message, type: 'system' });
}

/**
 * s2c assistState to the seat owner's socket (only a socket with the cap
 * `tutorial`): {tutorial, auto, uses, freeUses, assisted, unlimited?}.
 * On every change and after a rejoin or restorePlayerState.
 */
function sendAssistState(io, game, pos, sid = null) {
    const seat = game.seat(pos);
    const to = sid || seat?.ownerSocketId;
    if (!seat || !to || !hasTutorialCap(io, to)) return;
    const owner = seat.ownerUsername;
    const a = game.assist?.[pos];
    const own = !!a && a.user === owner;
    game.sendToPlayer(io, to, 'assistState', {
        tutorial: own && a.tutorial === true,
        auto: own && a.tutorial === true && a.auto === true,
        ...tally(game, pos)
    });
}

/** One tip to the seat's socket: an assistHint kind tip (cap `tutorial`) or the private line "Tip: ...". */
function sendTip(io, game, sid, pos, tip, { actions = null, line = null } = {}) {
    const p = {
        v: 1,
        source: 'tutorial',
        kind: 'tip',
        turnKey: game.turnKey(),
        headline: clip(tip.title, TEXT_MAX),
        reasons: [clip(tip.text, TEXT_MAX)],
        ...tally(game, pos),
        counted: false,
        tipId: tip.id
    };
    if (actions) p.actions = actions;
    if (hasTutorialCap(io, sid)) {
        game.sendToPlayer(io, sid, 'assistHint', p);
    } else {
        sendLine(io, game, sid, TEXT.tipLine(line || tip.text));
    }
    // A rule tip goes to the seat's over-the-shoulder watchers too; the
    // system tips (T.welcome, T.graduate, T.done) speak to the player
    // about their tutorial, so they stay the player's
    if (!curriculum.SYSTEM_TIPS[tip.id]) shoulderView().mirrorHint(io, game, pos, p);
}

/** The tutorial's advice: the /help answer, source tutorial, never counted. */
function sendAdvice(io, game, sid, pos, answer) {
    const t = tally(game, pos);
    const hint = hintPayload(game, game.turnKey(), answer, t, false, null, 'tutorial');
    if (hasCap(io, sid)) {
        game.sendToPlayer(io, sid, 'assistHint', hint);
    } else {
        // No count tail: the tutorial's advice is never counted
        sendLine(io, game, sid, render(answer.e, { style: 'line' }));
    }
    shoulderView().mirrorHint(io, game, pos, hint);
}

function tutorSeat(game, pos) {
    let m = tutor.get(game);
    if (!m) tutor.set(game, (m = {}));
    return m[pos] || (m[pos] = { lastKey: null, windowUsed: false, graduateUnsent: false });
}

/** Is the tutorial on in seat `pos`'s record (its owner's own record), whoever plays the seat now? */
function tutorialRecordOn(game, pos) {
    const seat = game.seat(pos);
    const a = game.assist?.[pos];
    return !!seat && !!seat.ownerUsername && !!a && a.tutorial === true && a.user === seat.ownerUsername;
}

/** Is the tutorial on for seat `pos` (its owner's own record, a human seat)? */
function tutorialOn(game, pos) {
    return tutorialRecordOn(game, pos) && game.seat(pos).controller === Controller.HUMAN;
}

/**
 * The socket the tutor may push to for seat `pos`: the owner socket of a
 * human seat with the tutorial on, and only one with the cap `tutorial`
 * (an app without it, e.g. a shipped iOS build that took the seat over by
 * a rejoin, renders no tip and cannot send /tutorial off: its pushes pause
 * until a socket with the cap owns the seat again). Null otherwise.
 */
function tutorSocket(io, game, pos) {
    if (!tutorialOn(game, pos)) return null;
    const sid = game.seat(pos).ownerSocketId;
    return sid && hasTutorialCap(io, sid) ? sid : null;
}

const anyTutorial = (game) => !!game.assist && [1, 2, 3, 4].some((p) => game.assist[p] && game.assist[p].tutorial === true);

/**
 * The welcome tip (once per game: its bit) to a capable socket, with the
 * actions Keep / Turn off; a plain-text client gets the line variant.
 * @returns {boolean} sent
 */
function welcome(io, game, pos, sid) {
    const a = game.assist[pos];
    if (curriculum.has(a.tips, 'T.welcome') || !hasTutorialCap(io, sid)) return false;
    const tip = curriculum.systemTip('T.welcome');
    sendTip(io, game, sid, pos, tip, { actions: ['keep', 'off'], line: curriculum.systemTip('T.welcome', { line: true }).text });
    a.tips = curriculum.withTip(a.tips, 'T.welcome');
    return true;
}

/**
 * One tutor step for seat `pos` at the current turn. Its own decision: the
 * first one sets tutorialEver (an auto-start: "This game now counts as
 * bot-assisted for <name>." in a human-only game), then at most one rule
 * tip and the advice (unless the fade-out hides it; a forced move gets
 * nothing). Someone else's turn: at most one rule tip per window. Once per
 * turnKey; `rejoin` (a rejoin, /active, a restored game's rejoin) pushes
 * this turn's advice only, never a rule tip (a tip of a turn the seat was
 * away for, or of a turn a restore lost the window of, shows at a later
 * decision instead: so a decision never gets two).
 */
function tickSeat(io, game, pos, { rejoin = false } = {}) {
    // Away (its rejoin re-pushes), lazy, or a socket without the cap: nothing
    const sid = tutorSocket(io, game, pos);
    if (!sid) return;
    const seat = game.seat(pos);
    const key = game.turnKey();
    const st = tutorSeat(game, pos);
    const fresh = st.lastKey !== key;
    if (!fresh && !rejoin) return;
    st.lastKey = key;
    const a = game.assist[pos];
    const before = a.tips;
    let changed = false;
    welcome(io, game, pos, sid);
    if (st.graduateUnsent) {
        // The graduation this seat missed at the end of the 2-card hand
        st.graduateUnsent = false;
        sendTip(io, game, sid, pos, curriculum.systemTip('T.graduate'));
    }
    const view = seatView(game, pos);
    const own = !!view && view.currentTurn === pos &&
        (view.stage === 'bid' ? view.playerBids[pos - 1] == null : !view.playedCards[pos - 1]);
    if (own) {
        if (!a.tutorialEver) {
            a.tutorialEver = true;
            changed = true;
            if (!isFreeHelpGame(game)) roomLine(io, game, TEXT.tutorialCountsNotice(seat.ownerUsername));
            sendAssistState(io, game, pos);
        }
        const got = computeAnswer(game, pos);
        if (got.answer && !got.answer.decision.forced) {
            const { decision, e } = got.answer;
            let advice;
            if (fresh && !rejoin) {
                const r = curriculum.decisionStep({ view, decision, e, tips: a.tips });
                if (r.tip) sendTip(io, game, sid, pos, r.tip);
                a.tips = r.tips;
                st.windowUsed = false;
                advice = r.advice;
            } else {
                advice = curriculum.showAdvice(view, decision, e, curriculum.isGraduated(a.tips));
            }
            if (advice) sendAdvice(io, game, sid, pos, got.answer);
        }
    } else if (fresh && !rejoin && view) {
        const r = curriculum.betweenStep({ view, tips: a.tips, windowUsed: st.windowUsed });
        if (r.tip) sendTip(io, game, sid, pos, r.tip);
        a.tips = r.tips;
        st.windowUsed = r.windowUsed;
    }
    if (changed || a.tips !== before) persistHooks.gameChanged(game);
}

/**
 * After every updateTurn (gameHandlers.triggerBotIfNeeded): one tutor step
 * for each tutorial seat, in a setImmediate so the turn event goes out
 * first; skipped if the turn moved meanwhile. Nothing at all (not even the
 * setImmediate) when no seat has the tutorial on.
 */
function tutorTick(io, game) {
    if (!anyTutorial(game)) return;
    const key = game.turnKey();
    safeImmediate(() => {
        try {
            if (game.isTerminal() || !game.acceptsTurnInput() || game.turnKey() !== key) return;
            for (let pos = 1; pos <= 4; pos++) tickSeat(io, game, pos);
        } catch (err) {
            counters.errors++;
            gameLogger.error('/tutorial failed', { gameId: game.gameId, error: err && err.message });
        }
    }, 'tutorTick');
}

/**
 * The owner of seat `pos` is back on `socket` (rejoinSuccess,
 * restorePlayerState): its assistState, and if the tutorial is on and it is
 * the seat's open turn, this turn's advice again (a turn it missed while
 * away gets its full step).
 */
function afterRejoin(io, game, pos, socket) {
    try {
        sendAssistState(io, game, pos, socket.id);
        if (!tutorialOn(game, pos) || !game.acceptsTurnInput() || game.seat(pos).ownerSocketId !== socket.id) return;
        tickSeat(io, game, pos, { rejoin: true });
    } catch (err) {
        counters.errors++;
        gameLogger.error('/tutorial failed', { gameId: game.gameId, position: pos, error: err && err.message });
    }
}

/**
 * The account flag (users.tutorial: 'pending' from sign-up, 'done' after a
 * finished game, 'dismissed'): fire-and-forget, plus the owner socket's
 * socket.data.tutorialFlag. Only a 'pending' account changes.
 */
function setAccountFlag(io, usernames, value) {
    const names = usernames.filter(Boolean);
    if (!names.length) return;
    try {
        const users = require('../database').getUsersCollection?.();
        if (users) {
            Promise.resolve(users.updateMany({ username: { $in: names }, tutorial: 'pending' }, { $set: { tutorial: value } }))
                .catch((err) => gameLogger.warn('users.tutorial write failed', { error: err && err.message }));
        }
    } catch (err) {
        gameLogger.warn('users.tutorial write failed', { error: err && err.message });
    }
    const gm = require('../game/GameManager');
    for (const name of names) {
        const sid = (gm.currentUsers || []).find((u) => u.username === name)?.socketId;
        const sock = sid ? io?.sockets?.sockets?.get(sid) : null;
        if (sock && sock.data && sock.data.tutorialFlag === 'pending') sock.data.tutorialFlag = value;
    }
}

/** The tutorial goes on for seat `pos` (manual, or `auto`: the auto-start). */
function turnOn(io, game, pos, { auto = false } = {}) {
    const seat = game.seat(pos);
    const owner = seat.ownerUsername;
    const a = ownRecord(game, pos);
    a.tutorial = true;
    a.auto = auto;
    if (!auto) a.tutorialEver = true;
    // The room line persists the record (addLogEntry's hook)
    roomLine(io, game, auto ? TEXT.tutorialAutoNotice(owner) : TEXT.tutorialOnNotice(owner, isFreeHelpGame(game)));
    sendAssistState(io, game, pos);
    // At the table now: the welcome tip, then this turn's step (an
    // auto-start's welcome waits for the first turn: the table is not up)
    if (!auto && seat.ownerSocketId) {
        welcome(io, game, pos, seat.ownerSocketId);
        persistHooks.gameChanged(game);
        if (game.acceptsTurnInput()) {
            tutorSeat(game, pos).lastKey = null;
            tickSeat(io, game, pos);
        }
    }
}

/** The tutorial goes off for seat `pos` (tutorialEver stays: the game stays assisted). */
function turnOff(io, game, pos, sid) {
    const seat = game.seat(pos);
    const owner = seat.ownerUsername;
    const a = ownRecord(game, pos);
    const wasAuto = a.auto;
    a.tutorial = false;
    a.auto = false;
    sendStatus(io, game, sid, pos, TEXT.tutorialOff, 'tutorial');
    roomLine(io, game, TEXT.tutorialOffNotice(owner));
    sendAssistState(io, game, pos);
    if (wasAuto) setAccountFlag(io, [owner], 'dismissed');
}

/**
 * /tutorial from the owner socket of seat `pos`: '/tutorial' toggles,
 * '/tutorial on' / '/tutorial off' set, '/tutorial keep' (the welcome
 * tip's Keep) acknowledges it (silent; the account stays as it is, so a
 * kept auto-start in a game that is then left or aborted still
 * auto-starts the next one), '/tutorial close' (the welcome's ✕: silent;
 * while auto-started the account is marked dismissed, plan 5.2, so no
 * later game auto-starts; the tutorial stays on). Refused like /help at a
 * bot-controlled seat; allowed at tournament tables (never auto-started
 * there).
 * @param {string} command - trimmed, lower case
 * @returns {string} 'botSeat' | 'rateLimited' | 'usage' | 'already' | 'on' | 'off' | 'keep' | 'close'
 */
function tutorialCommand(socket, io, game, pos, command) {
    const sid = socket.id;
    const seat = game.seat(pos);
    if (!seat || seat.controller !== Controller.HUMAN) {
        sendStatus(io, game, sid, pos, TEXT.botSeat, 'tutorial');
        return 'botSeat';
    }
    const arg = command.slice('/tutorial'.length).trim();
    const on = tutorialOn(game, pos);
    if (arg === 'keep') return 'keep';
    if (arg === 'close') {
        // Once: the socket's flag turns 'dismissed' with the write
        if (on && game.assist[pos].auto && socket.data?.tutorialFlag === 'pending') setAccountFlag(io, [seat.ownerUsername], 'dismissed');
        return 'close';
    }
    if (arg !== '' && arg !== 'on' && arg !== 'off') {
        sendStatus(io, game, sid, pos, TEXT.tutorialUsage, 'tutorial');
        return 'usage';
    }
    if (!rateLimiter.check(sid, 'assist')) {
        sendStatus(io, game, sid, pos, TEXT.rateLimited, 'tutorial');
        return 'rateLimited';
    }
    const want = arg === '' ? !on : arg === 'on';
    if (want === on) {
        sendStatus(io, game, sid, pos, on ? TEXT.tutorialAlreadyOn : TEXT.tutorialAlreadyOff, 'tutorial');
        return 'already';
    }
    if (want) turnOn(io, game, pos);
    else turnOff(io, game, pos, sid);
    return want ? 'on' : 'off';
}

/**
 * handleDrawComplete, before the first deal: a connected human seat whose
 * owner socket's account is new (socket.data.tutorialFlag 'pending', from
 * sign-up / sign-in / restore) and has the cap `tutorial` starts with the
 * tutorial on (a.auto), never at a tournament table.
 */
function autoStart(io, game) {
    if (isTournament(game)) return;
    for (let pos = 1; pos <= 4; pos++) {
        const seat = game.seat(pos);
        if (!seat || seat.controller !== Controller.HUMAN || !seat.ownerSocketId) continue;
        const sock = io?.sockets?.sockets?.get(seat.ownerSocketId);
        if (!sock || sock.data?.tutorialFlag !== 'pending' || !hasTutorialCap(io, seat.ownerSocketId)) continue;
        if (tutorialOn(game, pos)) continue;
        turnOn(io, game, pos, { auto: true });
    }
}

/**
 * After handComplete (and its fault lines): T.handScore after hands 1-3
 * and T.graduate after the 2-card hand, to each tutorial seat the tutor
 * can push to. The tip window stays as it is (only the seat's own decision
 * reopens it: plan 5.3, one rule tip between two decisions). T.graduate's
 * bit is set at the end of the 2-card hand for EVERY seat whose record has
 * the tutorial on (away, lazy or without the cap too), so the fade-out
 * starts anyway; such a seat is sent the tip at its next tick with a
 * capable socket (graduateUnsent). A missed T.handScore is not caught up
 * (its numbers belong to that hand).
 */
function tutorHandEnd(io, game) {
    if (!anyTutorial(game)) return;
    try {
        let changed = false;
        for (let pos = 1; pos <= 4; pos++) {
            if (!tutorialRecordOn(game, pos)) continue;
            const a = game.assist[pos];
            const sid = tutorSocket(io, game, pos);
            if (!sid) {
                if (game.currentHand === curriculum.GRADUATE_AFTER && !curriculum.isGraduated(a.tips)) {
                    a.tips = curriculum.withTip(a.tips, 'T.graduate');
                    tutorSeat(game, pos).graduateUnsent = true;
                    changed = true;
                }
                continue;
            }
            const names = {};
            for (let p = 1; p <= 4; p++) names[p] = game.getPlayerByPosition(p)?.username || null;
            const facts = {
                handIndex: HAND_PROGRESSION.indexOf(game.currentHand) + 1,
                handSize: game.currentHand,
                position: pos,
                names,
                bids: { team1: game.bids.team1, team2: game.bids.team2 },
                tricks: { team1: game.tricks.team1, team2: game.tricks.team2 },
                mults: { team1: game.team1Mult, team2: game.team2Mult }
            };
            for (const tip of curriculum.handEndTips(facts, a.tips)) {
                sendTip(io, game, sid, pos, tip);
                a.tips = curriculum.withTip(a.tips, tip.bitId);
                changed = true;
            }
        }
        if (changed) persistHooks.gameChanged(game);
    } catch (err) {
        counters.errors++;
        gameLogger.error('/tutorial failed', { gameId: game.gameId, error: err && err.message });
    }
}

/**
 * At the end of a finished game (before gameEnd): one private line to each
 * player the game counted as bot-assisted for, at their owner socket, saying
 * where its stats went (owner 2026-11-21: a win in the bot-game stats, a
 * loss or tie in the human stats; assistState.assistedSeatMoves, as
 * profileHandlers.buildGameEndRecord decides), and T.done to each seat with
 * the tutorial on.
 */
function gameEndLines(io, game) {
    for (let pos = 1; pos <= 4; pos++) {
        const sid = tutorSocket(io, game, pos);
        if (!sid) continue;
        const a = game.assist[pos];
        if (curriculum.has(a.tips, 'T.done')) continue;
        sendTip(io, game, sid, pos, curriculum.systemTip('T.done'));
        a.tips = curriculum.withTip(a.tips, 'T.done');
    }
    // A game with a native bot seat: say nothing (the record still marks it)
    if (isFreeHelpGame(game)) return;
    // A resign bot at the end makes it a bot game for everyone anyway: a
    // loss is in the bot-game stats too, so only a win's line is true there
    const botGame = isBotStatsGame(game);
    for (let pos = 1; pos <= 4; pos++) {
        const seat = game.seat(pos);
        const owner = seat?.ownerUsername;
        const a = game.assist?.[pos];
        if (!seat?.ownerSocketId || !isAssistedSeat(a, owner)) continue;
        const outcome = seatOutcome(game, pos);
        if (botGame && outcome !== 'won') continue;
        sendLine(io, game, seat.ownerSocketId, usedTutorial(a, owner) ? TEXT.gameEndTutorial(outcome) : TEXT.gameEnd(a.help, outcome));
    }
}

/**
 * A FINISHED game (after its gameEnd): every seat owner still at the table
 * at the end (presence connected: playing, or lazy / resigned and back
 * watching) whose account is still 'pending' becomes 'done', tutorial or
 * not. An owner who had left (/leave: gone), dropped (grace, resignable)
 * or was force-resigned and is still away did not finish a game and keeps
 * 'pending'; so does every seat of an aborted game.
 */
function gameFinished(io, game) {
    const names = [];
    for (const seat of game.seatList()) {
        if (seat && seat.ownerUsername && seat.presence === Presence.CONNECTED) names.push(seat.ownerUsername);
    }
    setAccountFlag(io, names, 'done');
}

/** /health `assist`: process counts since boot (no names, no ids). */
function assistHealth() {
    return { answered: counters.answered, quick: counters.quick, errors: counters.errors };
}

/** Tests only: a fresh cache, tutor state, budget (optionally {perSec, now}) and counters. */
function _resetForTests(budgetOpts) {
    cache = new WeakMap();
    tutor = new WeakMap();
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
    TUTORIAL_CAP,
    isHelpKeyword,
    isHelpCommand,
    isTutorialCommand,
    request,
    help,
    tutorialCommand,
    autoStart,
    tutorTick,
    tutorHandEnd,
    afterRejoin,
    sendAssistState,
    gameEndLines,
    gameFinished,
    assistHealth,
    createBudget,
    _resetForTests
};

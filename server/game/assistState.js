/**
 * game.assist (plan section 8, D16): one record per position (1-4), the
 * only /help state a game keeps. SAVED (gameCodec CODEC_V 2), keyed by
 * position and the owner's username, never by socket:
 *
 *   user          the seat owner the counters belong to (null: none yet).
 *                 /help resets the record when the seat's owner is
 *                 someone else (the defensive reset, plan 4.2 step 4)
 *   help          counted /help uses this game (forced moves, status
 *                 lines, refusals and a re-ask on the same turn are not
 *                 counted)
 *   lastHelpKey   the game.turnKey() of the last counted use, so a re-ask
 *                 on that turn (also after a restore) is not counted again
 *   tutorial      the tutorial is on for this seat now (/tutorial,
 *                 the auto-start; server/socket/assistHandlers.js)
 *   auto          it was turned on by the auto-start (a new account's
 *                 first game), not by the player; false again once off
 *   tutorialEver  the tutorial was on at one of this seat's own decisions
 *                 (or turned on by hand): the game counts as bot-assisted
 *                 for the owner (plan D12; an auto-start turned off before
 *                 the seat's first own decision never sets it)
 *   tips          bitmask of the tutorial tips shown this game
 *                 (server/game/assist/curriculum.js TIP bits: each topic
 *                 once per game)
 *
 * Every write to a record must reach the persist store: /help increments
 * before its notice's addLogEntry (whose hook marks the game dirty); a
 * change that posts no line calls persistHooks.gameChanged(game) itself.
 *
 * Not here (module state, never saved, rebuilt on a miss): the advice
 * cache, the searched-answer budget, the tutorial's tip queue.
 *
 * Dependency-free (GameState requires it).
 */

'use strict';

const POSITIONS = [1, 2, 3, 4];

/**
 * Free counted /help uses per player per game (plan D10, owner
 * 2026-11-18): the next one makes the game bot-assisted for that player
 * (since 2026-11-21 only a WIN goes to their bot-game bucket, a loss or tie
 * stays in their human stats: assistedSeatMoves, profileHandlers.buildGameEndRecord).
 * In a game with a native bot seat (isFreeHelpGame) players see no limit,
 * but the record still marks a player past it (owner 2026-11-19).
 * Change it only with the owner.
 */
const ASSIST_FREE_HELP = 3;

/** The record's keys, in order (gameCodec SAVED.assistSeat). */
const ASSIST_SEAT_KEYS = Object.freeze(['user', 'help', 'lastHelpKey', 'tutorial', 'auto', 'tutorialEver', 'tips']);

/** A fresh record: nobody has asked. */
function defaultAssistSeat() {
    return { user: null, help: 0, lastHelpKey: null, tutorial: false, auto: false, tutorialEver: false, tips: 0 };
}

/** A fresh game.assist: {1..4: defaultAssistSeat()}. */
function defaultAssist() {
    const out = {};
    for (const pos of POSITIONS) out[pos] = defaultAssistSeat();
    return out;
}

const str = (v) => (typeof v === 'string' ? v : null);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

/**
 * One record as saved and as restored: exactly ASSIST_SEAT_KEYS, each of
 * its type (anything else, or a missing key, is the default).
 */
function normalizeAssistSeat(a) {
    if (!a || typeof a !== 'object') return defaultAssistSeat();
    return {
        user: str(a.user),
        help: count(a.help),
        lastHelpKey: str(a.lastHelpKey),
        tutorial: a.tutorial === true,
        auto: a.auto === true,
        tutorialEver: a.tutorialEver === true,
        tips: count(a.tips)
    };
}

/**
 * A whole game.assist as saved and as restored: all four positions (a
 * missing one, or no assist at all as in a CODEC_V 1 doc, is the default),
 * other keys dropped.
 */
function normalizeAssist(assist) {
    const src = assist && typeof assist === 'object' ? assist : {};
    const out = {};
    for (const pos of POSITIONS) out[pos] = normalizeAssistSeat(src[pos]);
    return out;
}

/**
 * Has the seat owner `owner` made this game bot-assisted for themselves
 * (more than ASSIST_FREE_HELP counted /help uses, or the tutorial:
 * a.tutorialEver)? A record that belongs to someone else (a.user is not the
 * owner) never counts.
 * @param {Object|null|undefined} a - one game.assist record
 * @param {string|null|undefined} owner - the seat's ownerUsername
 */
function isAssistedSeat(a, owner) {
    return !!a && !!owner && a.user === owner && (a.help > ASSIST_FREE_HELP || a.tutorialEver === true);
}

/** Did `owner` play with the tutorial in record `a` (a.tutorialEver, their own record)? */
function usedTutorial(a, owner) {
    return !!a && !!owner && a.user === owner && a.tutorialEver === true;
}

/** The counted /help uses of `owner` in record `a` (0 for someone else's record). */
function helpUses(a, owner) {
    return a && owner && a.user === owner ? a.help : 0;
}

/**
 * Is /help free and unlimited in `game` (owner 2026-11-19, "Unlimited, keep
 * notice")? True when a NATIVE bot holds a seat (controller 'bot': a lobby's
 * Add Bot, a tournament filler, a solo game): such a game already goes to
 * the bot-game stats bucket (profileHandlers.buildGameEndRecord, withBots),
 * so /help cannot move anyone's stats there. A lazy or resign bot never
 * counts (lazyBot is reversible; both are a human's seat). Native bot seats
 * are seated at the start and never leave, so this never turns false later
 * in a game. There: no free count on the wire or in any line, no warning,
 * no crossing, no end-of-game line, never assisted on the wire; the counter
 * and the room notice "<name> used /help." stay, and the game-end record
 * still marks more than ASSIST_FREE_HELP uses (profileHandlers, unchanged).
 * @param {Object|null|undefined} game - a GameState (or anything with seatList())
 */
function isFreeHelpGame(game) {
    if (!game || typeof game.seatList !== 'function') return false;
    // 'bot' is SeatState's Controller.BOT (not required: this file stays dependency-free)
    return game.seatList().some((s) => s && s.controller === 'bot');
}

/** Seat controllers that make a finished game a bot game for every owner (profileHandlers, statsScope.js). */
const BOT_GAME_CONTROLLERS = Object.freeze(new Set(['bot', 'resignBot']));

/**
 * Does `game` go to every owner's bot-game stats anyway (a native bot or a
 * resign bot holds a seat at the end; lazy bots never count)? Then /help and
 * the tutorial move nobody's stats (profileHandlers.buildGameEndRecord:
 * bucket 'botStats').
 * @param {Object|null|undefined} game - a GameState (or anything with seatList())
 */
function isBotStatsGame(game) {
    if (!game || typeof game.seatList !== 'function') return false;
    return game.seatList().some((s) => s && BOT_GAME_CONTROLLERS.has(s.controller));
}

/**
 * How a finished game ended for the seat at `position`, by the final team
 * scores (team 1 = seats 1 and 3, team 2 = seats 2 and 4; equal scores are a
 * tie), as profileHandlers.seatStatsDelta credits wins / losses / draws.
 * @param {Object} game - a finished game (game.score {team1, team2})
 * @param {number} position - 1-4
 * @returns {'won'|'lost'|'tied'}
 */
function seatOutcome(game, position) {
    const t1 = game?.score?.team1;
    const t2 = game?.score?.team2;
    if (t1 === t2) return 'tied';
    const isTeam1 = position === 1 || position === 3;
    return (t1 > t2) === isTeam1 ? 'won' : 'lost';
}

/**
 * Owner 2026-11-21 ("only move their stats to a bot game if they win! It's
 * not perfect because it could still improve their score, but it seems like
 * a better incentive"): does the bot-assisted seat at `position` (the caller
 * checked isAssistedSeat) take this finished game to its owner's bot-game
 * stats? Only when the seat's team WON; a loss or a tie stays in the
 * player's human stats like any human game, so /help or the tutorial can no
 * longer move a losing game out of the human leaderboard.
 * @param {Object} game - a finished game
 * @param {number} position - 1-4
 */
function assistedSeatMoves(game, position) {
    return seatOutcome(game, position) === 'won';
}

/**
 * What `owner`'s record says, as the wire sends it: assistHint's uses /
 * freeUses / assisted and snapshot v2's viewer.assist (2026-11-19). In a
 * free-help game (`unlimited`, isFreeHelpGame) `assisted` is always false
 * and the additive `unlimited: true` is added; otherwise there is no
 * `unlimited` key, so the payload is the one it was before.
 * @param {Object|null|undefined} a - one game.assist record
 * @param {string|null|undefined} owner - the seat's ownerUsername
 * @param {boolean} [unlimited] - isFreeHelpGame(game)
 * @returns {{uses: number, freeUses: number, assisted: boolean, unlimited?: true}}
 */
function assistTally(a, owner, unlimited = false) {
    if (unlimited) return { uses: helpUses(a, owner), freeUses: ASSIST_FREE_HELP, assisted: false, unlimited: true };
    return { uses: helpUses(a, owner), freeUses: ASSIST_FREE_HELP, assisted: isAssistedSeat(a, owner) };
}

/**
 * The tutorial's state of `owner`'s record as snapshot v2's viewer.assist
 * adds it (2026-11-19, additive): `tutorial: true` (+ `auto: true` when the
 * auto-start turned it on) only while it is on, else nothing, so a game
 * without the tutorial keeps the payload it had.
 */
function tutorialTally(a, owner) {
    if (!a || !owner || a.user !== owner || a.tutorial !== true) return {};
    return a.auto === true ? { tutorial: true, auto: true } : { tutorial: true };
}

module.exports = {
    ASSIST_FREE_HELP,
    isAssistedSeat,
    usedTutorial,
    tutorialTally,
    isFreeHelpGame,
    isBotStatsGame,
    seatOutcome,
    assistedSeatMoves,
    helpUses,
    assistTally,
    ASSIST_SEAT_KEYS,
    defaultAssistSeat,
    defaultAssist,
    normalizeAssistSeat,
    normalizeAssist
};

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
 *   tutorial, auto, tutorialEver, tips
 *                 reserved for the tutorial (plan H5): saved now with their
 *                 defaults so that PR needs no second codec bump. Nothing
 *                 writes them yet
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

module.exports = {
    ASSIST_SEAT_KEYS,
    defaultAssistSeat,
    defaultAssist,
    normalizeAssistSeat,
    normalizeAssist
};

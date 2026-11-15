/**
 * Username rules for NEW sign-ups (owner, 2026-11-11). Existing accounts keep
 * their names ("Alan T", "JoAnn Jameson", anything older that breaks these
 * rules), and every other path (sign-in, restoreSession, profile lookups,
 * merges) stays an exact match on the stored name.
 *
 *   - 3 to 20 characters
 *   - ASCII letters, digits, space, underscore, hyphen, period
 *   - starts with a letter or digit; no space at either end, no double space
 *   - no emoji, so nobody can take a bot's name: every bot is shown as
 *     "🤖 <persona>" (BotController.createBot callers: ambient, lobby,
 *     tournament and seat bots) or "🤖 Bot N" in a lobby
 *   - not a reserved name (RESERVED_NAMES, isReservedName): nothing that
 *     reads as the server, its staff or a bot ("System", "Adm1n", "Bot 2")
 *
 * Uniqueness ignores case and surrounding whitespace ("alan T" is taken
 * when "Alan T" exists): findNameClash.
 */

const { handleSpellings } = require('./profanityFilter');

const MIN_LENGTH = 3;
const MAX_LENGTH = 20;

const ALLOWED = /^[A-Za-z0-9 _.-]+$/;
const STARTS_OK = /^[A-Za-z0-9]/;
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/u;
const BOT_PREFIX = '\u{1F916}'; // 🤖

// Names that would pass for the server, its staff or a bot. A new name is
// refused when, spelled as the profanity filter reads a handle (any case,
// leetspeak undone, separators, digits and repeated letters dropped), it is
// one of these or several run together: "System", "ADMIN", "Adm1n",
// "Bot 2", "Official_Support", "BabOnline Staff". A name that merely
// contains one passes ("Bobcat", "Model", "Babs", "Systems Guy"). Bot
// persona names (Mary, Sharon, ...) are ordinary first names and stay free:
// a bot always shows as "🤖 Mary". "population" is the leaderboard's
// average row (profileHandlers, isPopulation).
const RESERVED_NAMES = [
    'system', 'admin', 'administrator', 'moderator', 'mod', 'babonline', 'bab',
    'server', 'support', 'official', 'staff', 'bot', 'null', 'undefined',
    'population',
];
const fold = (s) => s.replace(/(.)\1+/g, '$1');
const RESERVED = new RegExp(`^(?:${RESERVED_NAMES.map(fold).join('|')})+$`);

/**
 * Is `name` a reserved name (above)? Existing accounts are never checked:
 * only checkNewUsername (sign-up, admin rename) asks.
 * @param {string} name
 * @returns {boolean}
 */
function isReservedName(name) {
    return handleSpellings(name).joined.some(spelling => RESERVED.test(fold(spelling)));
}

const MESSAGES = Object.freeze({
    empty: 'Please choose a username.',
    edgeSpace: "Usernames can't start or end with a space.",
    botPrefix: 'Names starting with 🤖 are reserved for bots.',
    emoji: "Usernames can't contain emoji.",
    characters: 'Usernames can use only letters (A-Z), numbers, spaces, and _ - .',
    tooShort: `Usernames must be at least ${MIN_LENGTH} characters.`,
    tooLong: `Usernames can be at most ${MAX_LENGTH} characters.`,
    start: 'Usernames must start with a letter or number.',
    doubleSpace: "Usernames can't have two spaces in a row.",
    taken: 'That name is taken.',
    reserved: 'That name is reserved. Please choose another.',
});

/**
 * Check a name someone wants to register.
 * @param {*} name - as sent (the web client trims it; iOS 1.1.0 sends it as typed)
 * @returns {{ok: true} | {ok: false, reason: string, message: string}}
 */
function checkNewUsername(name) {
    const fail = (reason) => ({ ok: false, reason, message: MESSAGES[reason] });
    if (typeof name !== 'string' || name.trim() === '') return fail('empty');
    if (name.trimStart().startsWith(BOT_PREFIX)) return fail('botPrefix');
    if (name !== name.trim()) return fail('edgeSpace');
    if (EMOJI.test(name)) return fail('emoji');
    if (!ALLOWED.test(name)) return fail('characters');
    if (name.length < MIN_LENGTH) return fail('tooShort');
    if (name.length > MAX_LENGTH) return fail('tooLong');
    if (!STARTS_OK.test(name)) return fail('start');
    if (name.includes('  ')) return fail('doubleSpace');
    if (isReservedName(name)) return fail('reserved');
    return { ok: true };
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The stored account a new name collides with, ignoring case and any
 * whitespace around the stored name: an exact match first (so a merged
 * tombstone keeps its redirect message), then an anchored, escaped,
 * case-insensitive regex (works on Mongo and memoryDb; the users collection
 * is small, so no index or migration).
 * @param {Object} usersCollection
 * @param {string} name - a name checkNewUsername accepted
 * @returns {Promise<{username: string, mergedInto?: string, exact: boolean}|null>}
 */
async function findNameClash(usersCollection, name) {
    // renamedAt: a rename's redirect never names its new name here (authHandlers, takenMessage)
    const projection = { projection: { username: 1, mergedInto: 1, renamedAt: 1, targetRenamedAt: 1 } };
    const exact = await usersCollection.findOne({ username: name }, projection);
    if (exact) return { ...exact, exact: true };
    const similar = await usersCollection.findOne(
        { username: { $regex: `^\\s*${escapeRegex(name)}\\s*$`, $options: 'i' } },
        projection
    );
    // Exactness is the stored name's, not which query found it: a concurrent
    // sign-up can insert `name` between the two lookups (realMongo (b)), and
    // that is still the same name, not a case variant
    return similar ? { ...similar, exact: similar.username === name } : null;
}

/**
 * The sign-up refusal for a clash with `existing` that is not an exact
 * merged tombstone (authHandlers keeps that redirect message). A case
 * variant names the account that exists (the kept one for a tombstone).
 */
function takenMessage(name, existing) {
    if (existing.exact) return MESSAGES.taken;
    // A rename's old name (or a merged one a rename re-pointed) is shown as
    // itself: the new name is told only to the account's owner
    // (authHandlers.hidesNewName)
    const shown = existing.mergedInto && !existing.renamedAt && !existing.targetRenamedAt ? existing.mergedInto : existing.username;
    return `That name is taken: "${shown}" already exists, and capital letters don't make a different name.`;
}

module.exports = {
    MIN_LENGTH,
    MAX_LENGTH,
    MESSAGES,
    RESERVED_NAMES,
    checkNewUsername,
    isReservedName,
    findNameClash,
    takenMessage,
};

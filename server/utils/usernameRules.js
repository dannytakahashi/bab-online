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
 *
 * Uniqueness ignores case and surrounding whitespace ("alan T" is taken
 * when "Alan T" exists): findNameClash.
 */

const MIN_LENGTH = 3;
const MAX_LENGTH = 20;

const ALLOWED = /^[A-Za-z0-9 _.-]+$/;
const STARTS_OK = /^[A-Za-z0-9]/;
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/u;
const BOT_PREFIX = '\u{1F916}'; // 🤖

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
    const projection = { projection: { username: 1, mergedInto: 1 } };
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
    const shown = existing.mergedInto || existing.username;
    return `That name is taken: "${shown}" already exists, and capital letters don't make a different name.`;
}

module.exports = {
    MIN_LENGTH,
    MAX_LENGTH,
    MESSAGES,
    checkNewUsername,
    findNameClash,
    takenMessage,
};

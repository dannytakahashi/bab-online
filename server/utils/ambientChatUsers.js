/**
 * Who sees the ambient bots' main-room chatter (server/demo/ambientBots.js).
 * Owner, 2026-11-12: the bot lines are there for App Review (Guideline
 * 2.1(a): reviewers must see other users' chats), so only the review
 * account sees them; real players keep a main-room chat of humans only.
 *
 *   AMBIENT_CHAT_USERS unset or blank   the default, DEFAULT_USERS (test1)
 *   AMBIENT_CHAT_USERS=alice,Bob        those usernames (case-insensitive)
 *   AMBIENT_CHAT_USERS=*                everyone (the behavior before this)
 *   AMBIENT_CHAT_USERS=none             nobody
 *
 * Only the main-room chat lines are filtered. The ambient bot-vs-bot game
 * stays listed and spectatable for everyone, and its bots' in-game chat goes
 * to the game's room as before. No dependencies; read on every call (never
 * cached), like server/utils/upgradeGateSwitch.js.
 */

'use strict';

const DEFAULT_USERS = 'test1';

/** { all: true } | { all: false, names: Set<lowercase username> } */
function ambientChatAudience(env = process.env) {
    const raw = String(env.AMBIENT_CHAT_USERS ?? '').trim();
    const value = raw === '' ? DEFAULT_USERS : raw;
    if (value.toLowerCase() === 'none') return { all: false, names: new Set() };
    const names = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (names.includes('*')) return { all: true };
    return { all: false, names: new Set(names) };
}

/** Does `username` see the ambient main-room chatter? */
function seesAmbientChat(username, env = process.env) {
    const audience = ambientChatAudience(env);
    if (audience.all) return true;
    return typeof username === 'string' && audience.names.has(username.toLowerCase());
}

module.exports = { ambientChatAudience, seesAmbientChat, DEFAULT_USERS };

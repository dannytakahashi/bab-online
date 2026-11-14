/**
 * Who sees the ambient bot activity (server/demo/ambientBots.js): the bots'
 * main-room chatter (owner, 2026-11-12) and, since 2026-11-14 ("making the
 * bot demo game only appear for test1 (like we did for the bot chats)"),
 * the bot-vs-bot demo game too. Both are there for App Review (Guideline
 * 2.1(a): reviewers must see other users' chats and games), so only the
 * review account sees them; real players keep a main room of humans only.
 *
 *   AMBIENT_CHAT_USERS unset or blank   the default, DEFAULT_USERS (test1)
 *   AMBIENT_CHAT_USERS=alice,Bob        those usernames (case-insensitive)
 *   AMBIENT_CHAT_USERS=*                everyone (the behavior before this)
 *   AMBIENT_CHAT_USERS=none             nobody
 *
 * One audience for both (the env name is kept for compatibility): the chat
 * lines (seesAmbientChat) and the demo game (seesAmbientGame: listed in
 * mainRoomJoined / lobbiesUpdated, spectatable, counted as demand for it).
 * The demo game's own in-game bot chat goes to its room, whose members are
 * that audience. No dependencies; read on every call (never cached), like
 * server/utils/upgradeGateSwitch.js.
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

/** Does `username` see the ambient demo game (listed, spectatable)? Same audience. */
function seesAmbientGame(username, env = process.env) {
    return seesAmbientChat(username, env);
}

module.exports = {
    ambientChatAudience,
    // The same audience under its general name (chat lines and demo game)
    ambientAudience: ambientChatAudience,
    seesAmbientChat,
    seesAmbientGame,
    DEFAULT_USERS
};

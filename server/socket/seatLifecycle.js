/**
 * Seat lifecycle orchestration: who controls each seat and whether its
 * owner is present.
 */

const { botController, personalities } = require('../game/bot');
const { PERSONALITY_LIST, getDisplayName } = personalities;

/**
 * Pick a bot personality whose name is not already at the table: not used by
 * any bot registered for the game (lobby, tournament, ambient, resign and
 * lazy bots) and not shown as any seat's name. `preferred` (the seat's last
 * personality) is reused only while it is still free.
 * @param {GameState} game
 * @param {string|null} [preferred]
 * @returns {string} personality key
 */
function pickBotPersonality(game, preferred = null) {
    const used = new Set();
    for (const bot of botController.getGameBots(game.gameId)) {
        if (bot.personality) used.add(bot.personality);
    }
    const names = new Set();
    for (let pos = 1; pos <= 4; pos++) {
        const player = game.getPlayerByPosition(pos);
        if (player) names.add(player.username);
    }
    for (const p of PERSONALITY_LIST) {
        if (names.has(`🤖 ${getDisplayName(p)}`)) used.add(p);
    }
    const free = PERSONALITY_LIST.filter(p => !used.has(p));
    // 5 personalities, at most 3 other seats: never empty in practice
    const pool = free.length > 0 ? free : PERSONALITY_LIST;
    if (preferred && pool.includes(preferred)) return preferred;
    return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = {
    pickBotPersonality
};

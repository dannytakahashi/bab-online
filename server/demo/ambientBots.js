/**
 * Ambient activity for an otherwise-empty server.
 *
 * Keeps one bot-vs-bot game running at all times (it appears in the main
 * room's in-progress list and can be spectated, with the bots chatting via
 * their personality hooks) and seeds the main-room chat with messages from
 * the bot personas so the room is never empty.
 *
 * Why: a new player — or an App Store reviewer (Guideline 2.1(a) requires
 * that reviewers can see other users' chats and other users playing) — who
 * signs in at a quiet hour should still find a live game to watch and chat
 * messages to interact with (long-press report/block needs a target).
 *
 * Enabled by default in production; disable with AMBIENT_BOTS=false.
 * Enable in development with AMBIENT_BOTS=true.
 */

const gameManager = require('../game/GameManager');
const Deck = require('../game/Deck');
const { botController, personalities } = require('../game/bot');
const { PERSONALITY_LIST, getDisplayName } = personalities;
const { logger } = require('../utils/logger');

const CHECK_INTERVAL_MS = 15 * 1000;        // poll cadence
const RESTART_DELAY_MS = 30 * 1000;         // pause between games (keep the gap short)
const MAX_GAME_AGE_MS = 90 * 60 * 1000;     // recycle a wedged game
const CHAT_IDLE_MS = 30 * 60 * 1000;        // post bot chatter when room is quiet this long
const MAX_MESSAGES = 50;                    // mirrors GameManager.MAX_MAIN_ROOM_MESSAGES

// Bot personas keep the 🤖 prefix everywhere — ambient chatter is visibly
// bot-authored, consistent with how bots appear in games.
const SEED_MESSAGES = [
    { username: '🤖 Mary', message: 'Anyone up for a game? Starting a table now' },
    { username: '🤖 Danny', message: 'gl everyone, feeling a 3-bid kind of day' },
    { username: '🤖 Sharon', message: 'You can watch our game from the games list — tap Spectate' },
    { username: '🤖 Mike', message: 'I never get set. Watch and learn' },
    { username: '🤖 Zach', message: 'Mike got set twice last game, do not listen to him' },
];

// Idle chatter must be timeless — anything temporal ("new game starting")
// belongs in announceGameVisible, where it's actually true
const ROTATING_MESSAGES = [
    { username: '🤖 Mike', message: 'Bidding board on the 13 hand again. No regrets' },
    { username: '🤖 Sharon', message: 'A conservative 2 bid never hurt anyone' },
    { username: '🤖 Danny', message: 'Rainbow bonus on the 4-card hand, count it' },
    { username: '🤖 Zach', message: 'Our table is pretty much always running — tap Spectate to watch' },
];

const GAME_START_MESSAGES = [
    { username: '🤖 Mary', message: 'New game starting — come watch!' },
    { username: '🤖 Danny', message: 'Cards are dealt, new game underway — spectators welcome' },
    { username: '🤖 Mike', message: 'Fresh game just started. Come watch me not get set' },
];

let intervalHandle = null;
let currentGameId = null;
let currentGameStartedAt = 0;
let currentGameAnnounced = false;
let nextGameAt = 0;
let rotationIndex = 0;
let startIndex = 0;

/**
 * Ambient activity runs in production unless explicitly disabled, and in
 * development only when explicitly enabled.
 */
function shouldEnable(env = process.env) {
    if (env.AMBIENT_BOTS === 'false') return false;
    if (env.AMBIENT_BOTS === 'true') return true;
    return env.NODE_ENV === 'production';
}

/**
 * Seed the main-room chat history if it's empty (fresh server start),
 * back-dated so it reads as recent activity rather than a wall of
 * same-second messages.
 */
function seedMainRoomChat() {
    if (gameManager.mainRoomMessages.length > 0) return false;

    const now = Date.now();
    SEED_MESSAGES.forEach((m, i) => {
        gameManager.mainRoomMessages.push({
            username: m.username,
            message: m.message,
            timestamp: now - (SEED_MESSAGES.length - i) * 7 * 60 * 1000
        });
    });
    return true;
}

/**
 * Post a rotating bot message when the room has been quiet for a while,
 * so the chat always has recent content.
 */
function maybePostChat(io) {
    const messages = gameManager.mainRoomMessages;
    const last = messages[messages.length - 1];
    if (last && Date.now() - last.timestamp < CHAT_IDLE_MS) return false;

    const m = ROTATING_MESSAGES[rotationIndex % ROTATING_MESSAGES.length];
    rotationIndex++;

    const chatMessage = { username: m.username, message: m.message, timestamp: Date.now() };
    messages.push(chatMessage);
    if (messages.length > MAX_MESSAGES) {
        messages.shift();
    }
    io.to('mainRoom').emit('mainRoomMessage', chatMessage);
    return true;
}

/**
 * Once the new game leaves the draw phase it shows up in the main room's
 * in-progress list (handleDrawComplete broadcasts lobbiesUpdated) — that is
 * the moment a "new game starting" chat message is actually true.
 */
function announceGameVisible(io) {
    const m = GAME_START_MESSAGES[startIndex % GAME_START_MESSAGES.length];
    startIndex++;

    const chatMessage = { username: m.username, message: m.message, timestamp: Date.now() };
    gameManager.mainRoomMessages.push(chatMessage);
    if (gameManager.mainRoomMessages.length > MAX_MESSAGES) {
        gameManager.mainRoomMessages.shift();
    }
    io.to('mainRoom').emit('mainRoomMessage', chatMessage);
}

/**
 * Start a fresh 4-bot game. Same flow as tournament bot seats: create and
 * register bots, then kick off the draw phase — processBotDraw chains into
 * handleDrawComplete and the bots play the game to completion on their own.
 */
function startBotGame(io) {
    const bots = [];
    const usedPersonalities = [];
    for (let i = 0; i < 4; i++) {
        const available = PERSONALITY_LIST.filter(p => !usedPersonalities.includes(p));
        const personality = available[Math.floor(Math.random() * available.length)];
        usedPersonalities.push(personality);
        bots.push(botController.createBot(`🤖 ${getDisplayName(personality)}`, personality));
    }

    const game = gameManager.createGame(bots.map(b => b.socketId));
    game.isDemo = true;
    for (const bot of bots) {
        botController.registerBot(game.gameId, bot);
    }

    game.deck = new Deck();
    game.deck.shuffle();
    game.phase = 'drawing';

    let drawOrder = 0;
    for (const bot of bots) {
        drawOrder++;
        botController.scheduleBotDraw(io, game, bot.socketId, drawOrder);
    }

    currentGameId = game.gameId;
    currentGameStartedAt = Date.now();
    currentGameAnnounced = false;
    logger.info('Ambient bot game started', { gameId: game.gameId });
    return game;
}

/**
 * Keep exactly one ambient game alive: start a new one shortly after the
 * previous ends, and recycle a game that has somehow wedged.
 */
function tick(io) {
    maybePostChat(io);

    if (currentGameId) {
        const game = gameManager.getGameById(currentGameId);
        if (!game) {
            // Finished normally (endGame removed it) — schedule the next one
            currentGameId = null;
            nextGameAt = Date.now() + RESTART_DELAY_MS;
            return;
        }
        if (!currentGameAnnounced && game.phase !== 'drawing' && game.phase !== 'waiting') {
            currentGameAnnounced = true;
            announceGameVisible(io);
        }
        if (Date.now() - currentGameStartedAt > MAX_GAME_AGE_MS) {
            logger.warn('Ambient bot game exceeded max age, recycling', { gameId: currentGameId });
            botController.cleanupGame(currentGameId);
            game.leaveAllFromRoom(io);
            gameManager.abortGame(currentGameId);
            currentGameId = null;
            nextGameAt = Date.now() + RESTART_DELAY_MS;
        }
        return;
    }

    if (Date.now() >= nextGameAt) {
        startBotGame(io);
    }
}

/**
 * Entry point — call once at server startup.
 */
function startAmbientActivity(io) {
    if (intervalHandle) return;

    seedMainRoomChat();
    startBotGame(io);

    intervalHandle = setInterval(() => {
        try {
            tick(io);
        } catch (error) {
            logger.error('Ambient activity tick failed', { error: error.message, stack: error.stack });
        }
    }, CHECK_INTERVAL_MS);
    if (intervalHandle.unref) intervalHandle.unref();

    logger.info('Ambient bot activity enabled');
}

function stopAmbientActivity() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
}

module.exports = {
    startAmbientActivity,
    stopAmbientActivity,
    shouldEnable,
    // exported for tests
    seedMainRoomChat,
    maybePostChat,
    announceGameVisible,
    startBotGame,
    tick
};

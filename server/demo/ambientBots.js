/**
 * Ambient activity for an otherwise-empty server.
 *
 * Keeps one bot-vs-bot game running while someone could see it (it appears
 * in the main room's in-progress list and can be spectated, with the bots
 * chatting via their personality hooks) and seeds the main-room chat with
 * messages from the bot personas so the room is never empty.
 *
 * On demand (owner, 2026-11-11): a game starts as soon as a signed-in player
 * enters the main room (GameManager.onMainRoomJoin; it is listed ~0.1 s
 * later, AMBIENT_PREGAME) and keeps being replaced while someone is in the
 * main room or watching it. Once nobody has been for AMBIENT_IDLE_MS (10
 * min) the running game plays to its end and no new one starts; idleness
 * never aborts a game. Only a wedged game (MAX_GAME_AGE_MS) is recycled.
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
const { botController, personalities } = require('../game/bot');
const { PERSONALITY_LIST, getDisplayName } = personalities;
const { logger } = require('../utils/logger');
const { abortGame, beginDraw } = require('../socket/gameLifecycle');

const pacing = require('../game/pacing');

// Poll cadence and the pause between games: pacing.js AMBIENT_CHECK_MS /
// AMBIENT_RESTART_MS
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
let wakeHandle = null;          // the 0 ms start after a main-room join
let unsubscribeJoin = null;
let ioRef = null;
let lastDemandAt = 0;           // last time someone was in the main room or watching
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

    // No startDraw: there is nobody at the table to show it to
    beginDraw(io, game, { announce: false });

    currentGameId = game.gameId;
    currentGameStartedAt = Date.now();
    currentGameAnnounced = false;
    logger.info('Ambient bot game started', { gameId: game.gameId });
    return game;
}

/**
 * Is anyone who could see the ambient game around: a signed-in player in
 * the main room (every member is a registered socket; gated 1.0.0 sockets
 * never join) or a spectator of the current ambient game?
 */
function someoneWatching() {
    if (gameManager.mainRoomSocketIds.size > 0) return true;
    const game = currentGameId ? gameManager.getGameById(currentGameId) : null;
    return !!(game && game.spectators && game.spectators.size > 0);
}

/** Someone was around within the last AMBIENT_IDLE_MS. */
function inDemand(now = Date.now()) {
    return lastDemandAt > 0 && now - lastDemandAt < pacing().AMBIENT_IDLE_MS;
}

/**
 * A signed-in player entered the main room: refresh the demand window and,
 * when no game is running or about to restart, start one now (on the next
 * turn of the event loop, outside GameManager.joinMainRoom).
 */
function noteMainRoomJoin() {
    lastDemandAt = Date.now();
    if (!intervalHandle || !ioRef || currentGameId || wakeHandle) return;
    if (Date.now() < nextGameAt) return; // a restart is pending; the poll starts it
    wakeHandle = setTimeout(() => {
        wakeHandle = null;
        safeTick(ioRef);
    }, 0);
    if (wakeHandle.unref) wakeHandle.unref();
}

/**
 * Keep one ambient game alive while it is in demand: start one when someone
 * is around, start the next shortly after the previous ends (or go idle
 * when nobody has been around for AMBIENT_IDLE_MS), and recycle a game that
 * has somehow wedged.
 */
function tick(io) {
    maybePostChat(io);
    const now = Date.now();
    if (someoneWatching()) lastDemandAt = now;

    if (currentGameId) {
        const game = gameManager.getGameById(currentGameId);
        if (!game) {
            // Finished normally (endGame removed it): the next one, or idle
            currentGameId = null;
            if (inDemand(now)) {
                nextGameAt = now + pacing().AMBIENT_RESTART_MS;
            } else {
                nextGameAt = 0;
                logger.info('Ambient bot games idle (nobody in the main room)');
            }
            return;
        }
        if (!currentGameAnnounced && game.phase !== 'drawing' && game.phase !== 'waiting') {
            currentGameAnnounced = true;
            announceGameVisible(io);
        }
        if (Date.now() - currentGameStartedAt > MAX_GAME_AGE_MS) {
            logger.warn('Ambient bot game exceeded max age, recycling', { gameId: currentGameId });
            // Spectators get abortGame and are taken out of the room
            abortGame(io, game, 'Game recycled').catch(err =>
                logger.error('Ambient recycle failed', { gameId: game.gameId, error: err.message })
            );
            currentGameId = null;
            nextGameAt = Date.now() + pacing().AMBIENT_RESTART_MS;
        }
        return;
    }

    if (inDemand(now) && now >= nextGameAt) {
        startBotGame(io);
    }
}

function safeTick(io) {
    try {
        tick(io);
    } catch (error) {
        logger.error('Ambient activity tick failed', { error: error.message, stack: error.stack });
    }
}

/**
 * Entry point — call once at server startup. Seeds the chat; the first game
 * starts when someone enters the main room (or is already there).
 */
function startAmbientActivity(io) {
    if (intervalHandle) return;

    ioRef = io;
    seedMainRoomChat();
    unsubscribeJoin = gameManager.onMainRoomJoin(() => {
        try {
            noteMainRoomJoin();
        } catch (error) {
            logger.error('Ambient main-room hook failed', { error: error.message });
        }
    });

    intervalHandle = setInterval(() => safeTick(io), pacing().AMBIENT_CHECK_MS);
    if (intervalHandle.unref) intervalHandle.unref();
    // Already someone in the main room (a restart of the activity): start now
    safeTick(io);

    logger.info('Ambient bot activity enabled (on demand)');
}

function stopAmbientActivity() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
    if (wakeHandle) {
        clearTimeout(wakeHandle);
        wakeHandle = null;
    }
    if (unsubscribeJoin) {
        unsubscribeJoin();
        unsubscribeJoin = null;
    }
    ioRef = null;
    lastDemandAt = 0;
    nextGameAt = 0;
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
    tick,
    noteMainRoomJoin,
    inDemand
};

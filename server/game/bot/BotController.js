/**
 * BotController singleton - manages all active bots and coordinates their actions.
 * Handles scheduling bot turns, processing bot actions, and cleanup.
 */

const BotPlayer = require('./BotPlayer');
const { gameLogger } = require('../../utils/logger');
const { safeTimeout } = require('../../utils/safeTimer');
const persistHooks = require('../persist/hooks');
const { Phase } = require('../GamePhase');
const pacing = require('../pacing');
const { safeBid: fallbackBid, HAND_PROGRESSION, nextHandSize } = require('../rules');

const PLAY_STAGES = [Phase.PLAYING, Phase.TRICK_RESOLVING, Phase.HAND_RESOLVING];

/**
 * "he sends a boy" (owner request, 2026-11-16): a player ruffs a non-trump
 * lead with a 2 or 3 of trump, the first trump of the trick, while it could
 * still be over-trumped (2026-11-20: canBeOverTrumped), and an opposing
 * bot remarks on it. Rare: `chance` per eligible ruff, at most once every
 * `cooldownTricks` tricks per game.
 */
const SENT_A_BOY = Object.freeze({
    message: 'he sends a boy',
    ranks: Object.freeze(['2', '3']),
    chance: 0.35,
    cooldownTricks: 3,
});

/**
 * "alls we gotta do is not be stupid" (owner request, 2026-11-16): the final
 * hand of the game is dealt with one team ahead by `minLead` points or more,
 * and a bot on that team says it. `chance` per game, at most once per game
 * (an all-zero redeal of the final hand does not roll again).
 */
const NOT_BE_STUPID = Object.freeze({
    message: 'alls we gotta do is not be stupid',
    minLead: 50, // owner 2026-11-16 ("maybe 50pts?")
    chance: 0.6,
});

/** The last deal of the game: the end of HAND_PROGRESSION (nothing is dealt after it). */
const isFinalHand = (handSize) => HAND_PROGRESSION.includes(handSize) && nextHandSize(handSize) === 0;

const isTrumpCard = (card, trump) => !!card && (card.suit === 'joker' || card.suit === trump.suit);

/** A trump suit's ranks, low to high (the jokers rank above every one of them). */
const TRUMP_RANKS = Object.freeze(['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']);

/**
 * Whether the card just played at `position` (already on the table:
 * GameState.applyPlay ran) is a small plain trump that is the first trump
 * over a non-trump lead, i.e. a cheap ruff that is winning the trick for now,
 * and one that could still be over-trumped (canBeOverTrumped). Public state
 * only.
 */
function isSentABoy(game, card, position) {
    const trump = game.trump;
    if (!trump || !card || card.suit !== trump.suit || !SENT_A_BOY.ranks.includes(String(card.rank))) return false;
    if (game.playedCardsIndex < 2 || !game.leadCard || isTrumpCard(game.leadCard, trump)) return false;
    if (!game.playedCards.every((c, i) => i === position - 1 || !isTrumpCard(c, trump))) return false;
    return canBeOverTrumped(game, card, position);
}

/**
 * Could the ruff at `position` still be over-trumped in this trick (owner
 * 2026-11-20: "he sends a boy" only "when there's a chance for it to get
 * over trumped")? From what the table has seen only, never a hand:
 *   - an opponent of the ruffer (seat parity: a partner topping it is no
 *     over-trump) has yet to play to this trick, so never on a trick's last
 *     card;
 *   - and not every such opponent has shown out of trump this hand (a
 *     non-trump played to a trump or joker lead, GameState.trickHistory);
 *   - and a higher trump is unaccounted for: a higher rank of the trump suit
 *     or a joker not yet played this hand and not the turned-up trump card.
 */
function canBeOverTrumped(game, card, position) {
    const trump = game.trump;
    const toPlay = [1, 2, 3, 4].filter((p) => p % 2 !== position % 2 && !(game.playedCards || [])[p - 1]);
    if (toPlay.length === 0) return false;
    const tricks = Array.isArray(game.trickHistory) ? game.trickHistory : [];
    const showedOutOfTrump = (p) => tricks.some((t) => {
        const cards = Array.isArray(t && t.cards) ? t.cards : [];
        if (!cards[0] || !isTrumpCard(cards[0], trump)) return false;
        const c = cards[(p - t.lead + 4) % 4];
        return !!c && !isTrumpCard(c, trump);
    });
    if (toPlay.every(showedOutOfTrump)) return false;
    const seen = new Set();
    const see = (c) => { if (c) seen.add(`${c.rank}|${c.suit}`); };
    for (const t of tricks) if (t && Array.isArray(t.cards)) t.cards.forEach(see);
    (game.playedCards || []).forEach(see);
    see(trump);
    const at = TRUMP_RANKS.indexOf(String(card.rank));
    const higher = [...TRUMP_RANKS.slice(at + 1).map((r) => `${r}|${trump.suit}`), 'LO|joker', 'HI|joker'];
    return higher.some((k) => !seen.has(k));
}

/**
 * A deterministic roll in [0, 1) from the game id and the play: unpredictable
 * at the table (a random uuid per game) without drawing from Math.random, so
 * the seeded runs (sim, contract and iOS fixtures: the deck shuffles from the
 * same stream there) keep their RNG stream. FNV-1a 32-bit.
 */
function playRoll(game, salt) {
    const key = `${game.gameId}|${game.currentHand}|${game.cardIndex}|${salt}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h / 0x100000000;
}

class BotController {
    constructor() {
        // Map of gameId -> Map of socketId -> BotPlayer
        this.gamesBots = new Map();

        // Track pending timeouts for cleanup
        this.pendingActions = new Map();
        // key -> {gameId, at, arm(ms)} of each pending timeout (what
        // suspendGame needs to put it back), and gameId -> Map(key -> {ms,
        // arm}) of the actions held while that game is suspended (the
        // holder self-fence: GameState.suspend / unsuspend)
        this.pendingMeta = new Map();
        this.suspended = new Map();

        // Bot bids/plays replaced by the fallback since startup (noteFallback)
        this.fallbacks = { bid: 0, play: 0 };

        // gameId -> tricks completed since a bot last said "he sends a boy"
        // (absent: never, so the next one may)
        this.sentABoyTricks = new Map();

        // gameIds whose final deal was already considered for "alls we gotta
        // do is not be stupid" (said or not: once per game)
        this.notBeStupidGames = new Set();

        // Roll for the table quips: (game, salt) -> [0, 1); tests replace it
        this.chatRoll = playRoll;
    }

    /**
     * Contract state passed into card-play decisions: team bids, tricks taken
     * so far, raw player bids (for bore detection), and multipliers.
     * @param {Object} game - GameState
     * @returns {Object}
     */
    buildPlayContext(game) {
        // game.bids is position-keyed during bidding and only takes its
        // {team1, team2} shape once bidding completes; outside the play
        // stages pass null so strategy falls back to contract-blind play
        // rather than misreading the field
        const inPlay = PLAY_STAGES.includes(game.stage);
        return {
            playerBids: game.playerBids,
            bids: inPlay ? game.bids : null,
            tricks: game.tricks,
            team1Mult: game.team1Mult,
            team2Mult: game.team2Mult
        };
    }

    /**
     * Create a new bot for a lobby
     * @param {string} username - Bot name (default: "Mary")
     * @returns {BotPlayer}
     */
    createBot(username = '🤖 Mary', personality = 'mary') {
        return new BotPlayer(username, personality);
    }

    /**
     * Register a bot for a game
     * @param {string} gameId
     * @param {BotPlayer} bot
     */
    registerBot(gameId, bot) {
        if (!this.gamesBots.has(gameId)) {
            this.gamesBots.set(gameId, new Map());
        }
        this.gamesBots.get(gameId).set(bot.socketId, bot);
        bot.gameId = gameId;
        gameLogger.debug('Bot registered for game', { gameId, botSocketId: bot.socketId, botName: bot.username });
    }

    /**
     * Get bot by socketId within a game
     * @param {string} gameId
     * @param {string} socketId
     * @returns {BotPlayer|null}
     */
    getBot(gameId, socketId) {
        const gameBots = this.gamesBots.get(gameId);
        return gameBots?.get(socketId) || null;
    }

    /**
     * Get all bots in a game
     * @param {string} gameId
     * @returns {Array<BotPlayer>}
     */
    getGameBots(gameId) {
        const gameBots = this.gamesBots.get(gameId);
        return gameBots ? Array.from(gameBots.values()) : [];
    }

    /**
     * Check if a socketId is a bot
     * @param {string} socketId
     * @returns {boolean}
     */
    isBot(socketId) {
        return BotPlayer.isBot(socketId);
    }

    /**
     * Which think-time range a bot action uses (no RNG; read at schedule
     * time, which is always at or after the event that opened the turn):
     * bid 'firstBid' | 'bid'; play 'afterBidding' | 'afterTrick' (any lead
     * after a trick, the forced last card included) | 'forced' (a follow
     * with the bot's last card) | 'follow'.
     *
     * Every kind depends on PUBLIC state only, so think time is never a
     * tempo tell. In particular 'forced' is NOT "exactly one legal card":
     * under follow-suit that almost always means a singleton in the led
     * suit, and a fast play would tell the table the bot just went void.
     * Only the hand's last card (everyone can see the bot holds one) is
     * quick.
     */
    actionKind(game, actionType, bot) {
        if (actionType === 'bid') return game.getBidCount() === 0 ? 'firstBid' : 'bid';
        if (actionType !== 'play') return null;
        if (game.playedCardsIndex === 0) return game.cardIndex === 0 ? 'afterBidding' : 'afterTrick';
        const hand = game.getHand(bot.socketId) || [];
        return hand.length === 1 ? 'forced' : 'follow';
    }

    /**
     * Schedule a bot action with delay
     * @param {Object} io - Socket.IO server
     * @param {Object} game - GameState
     * @param {string} actionType - 'draw', 'bid', or 'play'
     * @param {Function} actionHandler - Function to call for action
     */
    scheduleBotAction(io, game, actionType, actionHandler) {
        const currentPosition = game.currentTurn;
        const player = game.getPlayerByPosition(currentPosition);

        if (!player || !this.isBot(player.socketId)) {
            return;
        }

        const bot = this.getBot(game.gameId, player.socketId);
        if (!bot) {
            gameLogger.warn('Bot not found for scheduled action', {
                gameId: game.gameId,
                socketId: player.socketId,
                position: currentPosition
            });
            return;
        }

        const kind = this.actionKind(game, actionType, bot);
        const delay = bot.getActionDelay(actionType, { kind, game });
        pacing.trace(`${actionType === 'bid' ? 'botBid' : 'botPlay'}:${kind}`, delay, game);
        const actionKey = `${game.gameId}:${player.socketId}:${actionType}`;

        const epoch = game.epoch;
        // (replaces any pending action under the same key)
        this._arm(game, actionKey, delay, () => {
            // Never act into a game that ended/aborted after scheduling
            if (game.epoch !== epoch || game.isTerminal()) return;
            // ...or for a seat this bot no longer controls (/active, a new
            // lazy bot) or after the bot was released
            if (game.positions[currentPosition] !== bot.socketId || !this.getBot(game.gameId, bot.socketId)) return;
            // Contain failures: an uncaughtException here would exit the
            // whole server (see utils/shutdown.js), dropping every game
            // A throw may leave the game half-written: tainted (the persist
            // codec keeps its last good doc) until a run completes cleanly
            try {
                actionHandler(io, game, bot);
                game.markTainted?.(false);
            } catch (err) {
                game.markTainted?.(true);
                gameLogger.error('Bot action failed', { gameId: game.gameId, actionType, error: err.message, stack: err.stack });
            }
        });
    }

    /**
     * Arm the pending timeout `actionKey` of `game`'s bots (replacing one
     * under the same key): `run` after `delay` ms. While the game is
     * suspended it is only held (suspendGame), armed when the game thaws.
     * @param {string|null} [label] - a safeTimeout label (null: plain setTimeout)
     */
    _arm(game, actionKey, delay, run, label = null) {
        const prev = this.pendingActions.get(actionKey);
        if (prev !== undefined) clearTimeout(prev);
        this.pendingMeta.delete(actionKey);
        const gameId = game.gameId;
        const arm = (ms) => {
            const fire = () => {
                // The store's self-fence check first ('on'): if it suspends
                // the game now, suspendGame has just held this action (0 ms
                // left) for the thaw
                persistHooks.beforeRun(game);
                const held = this.suspended.get(gameId);
                if (held) {
                    if (!held.has(actionKey)) held.set(actionKey, { ms: 0, arm });
                    return undefined;
                }
                this.pendingActions.delete(actionKey);
                this.pendingMeta.delete(actionKey);
                return run();
            };
            this.pendingActions.set(actionKey, label ? safeTimeout(fire, ms, label) : setTimeout(fire, ms));
            this.pendingMeta.set(actionKey, { gameId, at: Date.now() + ms, arm });
        };
        const held = this.suspended.get(gameId);
        if (held) {
            held.set(actionKey, { ms: delay, arm });
            return;
        }
        arm(delay);
    }

    /**
     * The game is suspended (GameState.suspend): its bots' pending timeouts
     * stop and are held with what was left of each; new ones are held too
     * until resumeGame.
     */
    suspendGame(gameId) {
        if (this.suspended.has(gameId)) return;
        const held = new Map();
        const now = Date.now();
        const prefix = `${gameId}:`;
        for (const [key, timeoutId] of this.pendingActions) {
            if (!key.startsWith(prefix)) continue;
            clearTimeout(timeoutId);
            const m = this.pendingMeta.get(key);
            if (m) held.set(key, { ms: Math.max(0, m.at - now), arm: m.arm });
            this.pendingActions.delete(key);
            this.pendingMeta.delete(key);
        }
        this.suspended.set(gameId, held);
    }

    /**
     * The game thaws (GameState.unsuspend): the held timeouts, as
     * [{ms, arm()}] for the caller to arm in due order. `drop`: discard
     * them (the game was frozen or ended meanwhile).
     * @returns {Array<{ms: number, arm: Function}>}
     */
    resumeGame(gameId, { drop = false } = {}) {
        const held = this.suspended.get(gameId);
        this.suspended.delete(gameId);
        if (!held || drop) return [];
        return Array.from(held.values(), (h) => ({ ms: h.ms, arm: () => h.arm(h.ms) }));
    }

    /**
     * Schedule bot draw action
     * @param {Object} io - Socket.IO server
     * @param {Object} game - GameState
     * @param {string} botSocketId - Bot's socket ID
     * @param {number} drawOrder - Order in which bot draws (1-4)
     */
    scheduleBotDraw(io, game, botSocketId, drawOrder) {
        const bot = this.getBot(game.gameId, botSocketId);
        if (!bot) return;

        // Stagger draws based on order
        const baseDelay = drawOrder * pacing(game).BOT_DRAW_STAGGER_MS;
        const delay = baseDelay + bot.getActionDelay('draw', { game });
        pacing.trace('botDraw', delay, game);

        const actionKey = `${game.gameId}:${botSocketId}:draw`;

        // (replaces any previously scheduled draw for this bot)
        const epoch = game.epoch;
        this._arm(game, actionKey, delay, () => {
            if (game.epoch !== epoch || game.isTerminal()) return;
            try {
                this.processBotDraw(io, game, bot);
            } catch (err) {
                gameLogger.error('Bot draw failed', { gameId: game.gameId, error: err.message, stack: err.stack });
            }
        });
    }

    /**
     * Process bot draw action
     * @param {Object} io - Socket.IO server
     * @param {Object} game - GameState
     * @param {BotPlayer} bot - Bot player
     */
    processBotDraw(io, game, bot) {
        if (game.stage !== Phase.DRAWING || !game.deck) return;

        const d = game.recordDraw(bot.socketId, bot.decideDraw(game.deck.cards.length), bot.username);
        if (!d) return;
        const { card, drawOrder } = d;

        gameLogger.debug('Bot drew card', {
            botName: bot.username,
            card: `${card.rank} of ${card.suit}`,
            gameId: game.gameId
        });

        // Broadcast to all players
        game.broadcast(io, 'playerDrew', { username: bot.username, card, drawOrder });

        // Check if all players have drawn - trigger draw completion
        if (game.drawIndex === 4) {
            // Use lazy require to avoid circular dependency
            const { handleDrawComplete } = require('../../socket/gameHandlers');
            handleDrawComplete(io, game).catch(err =>
                gameLogger.error('handleDrawComplete failed', { gameId: game.gameId, error: err.message, stack: err.stack })
            );
        }
    }

    /**
     * Process bot bid action
     * @param {Object} io - Socket.IO server
     * @param {Object} game - GameState
     * @param {BotPlayer} bot - Bot player
     * @returns {boolean} - true if the bid was made; false if the game state
     *   no longer allows it (callers must NOT advance the turn on false)
     */
    processBotBid(io, game, bot) {
        if (game.stage !== Phase.BIDDING || game.currentTurn !== bot.position) {
            gameLogger.warn('Bot bid skipped: stale game state', {
                gameId: game.gameId, botName: bot.username,
                stage: game.stage, currentTurn: game.currentTurn, botPosition: bot.position
            });
            return false;
        }

        // Already recorded (a watchdog retry after the post-bid step failed):
        // stale state, not a bad choice, so no fallback
        if (game.playerBids[bot.position - 1] != null) {
            gameLogger.warn('Bot bid skipped: already bid', {
                gameId: game.gameId, botName: bot.username, position: bot.position
            });
            return false;
        }

        const hand = game.getHand(bot.socketId);
        const gameContext = {
            teamScore: (bot.position === 1 || bot.position === 3) ? game.score.team1 : game.score.team2,
            oppScore: (bot.position === 1 || bot.position === 3) ? game.score.team2 : game.score.team1,
            currentHandSize: game.currentHand
        };
        let chosen;
        let failure = null;
        try {
            chosen = bot.decideBid(hand, game.trump, game.playerBids, game.currentHand, gameContext);
        } catch (err) {
            failure = { error: err.message, stack: err.stack };
        }

        // Same checks as a human bid (GameState.applyBid); a refused or
        // missing bid falls back to the safe bid so the table never waits
        let result = failure ? null : game.applyBid(bot.position, chosen);
        if (!result || !result.ok) {
            this.noteFallback('bid', game, bot, { chosen, reason: result ? result.reason : 'strategy_threw', ...failure });
            result = game.applyBid(bot.position, fallbackBid(game.playerBids));
            if (!result.ok) {
                gameLogger.error('Bot safe bid refused', { gameId: game.gameId, position: bot.position, stage: game.stage, reason: result.reason });
                return false;
            }
        }
        const bid = result.bid;

        gameLogger.debug('Bot bidding', {
            botName: bot.username,
            position: bot.position,
            bid,
            gameId: game.gameId
        });

        game.addLogEntry(`${bot.username} bid ${bid}.`, bot.position, 'bid');

        game.broadcast(io, 'bidReceived', {
            bid,
            position: bot.position,
            bidArray: game.playerBids
        });

        // Let the caller handle post-bid logic (turn advancement, etc.)
        return true;
    }

    /**
     * Process bot card play action
     * @param {Object} io - Socket.IO server
     * @param {Object} game - GameState
     * @param {BotPlayer} bot - Bot player
     * @returns {boolean} - true if a card was played; false if the game state
     *   no longer allows it (callers must NOT advance the turn on false)
     */
    processBotPlay(io, game, bot) {
        if (game.stage !== Phase.PLAYING || game.currentTurn !== bot.position) {
            gameLogger.warn('Bot play skipped: stale game state', {
                gameId: game.gameId, botName: bot.username,
                stage: game.stage, currentTurn: game.currentTurn, botPosition: bot.position
            });
            return false;
        }

        // The game may have moved on while this action sat on a timer (e.g.
        // forceResign during trick resolution) — never inject a 5th card or
        // overwrite an occupied slot
        if (game.playedCardsIndex >= 4 || game.playedCards[bot.position - 1] != null) {
            gameLogger.warn('Bot play skipped: trick already full or slot occupied', {
                gameId: game.gameId, botName: bot.username, position: bot.position,
                playedCardsIndex: game.playedCardsIndex
            });
            return false;
        }

        const hand = game.getHand(bot.socketId);
        if (!hand || hand.length === 0) {
            gameLogger.warn('Bot play skipped: empty hand', {
                gameId: game.gameId, botName: bot.username, position: bot.position
            });
            return false;
        }

        let card = null;
        let failure = null;
        try {
            card = bot.decideCard(
                hand,
                game.playedCards,
                game.leadCard,
                game.leadPosition,
                game.trump,
                game.isTrumpBroken,
                game.currentHand,
                this.buildPlayContext(game)
            );
        } catch (err) {
            failure = { error: err.message, stack: err.stack };
        }

        // Same checks as a human play (GameState.checkPlay: in hand, follow
        // suit, trump lead, HI joker); a refused or missing card falls back
        // to the first legal card in hand order
        const check = failure ? null : (card ? game.checkPlay(bot.position, card, bot.socketId) : { ok: false, reason: 'no_card' });
        if (!check || !check.ok) {
            this.noteFallback('play', game, bot, {
                chosen: card && card.suit ? `${card.rank} of ${card.suit}` : card,
                reason: check ? check.reason : 'strategy_threw',
                ...(check && check.error && { error: check.error }),
                ...failure
            });
            card = game.firstLegalCard(bot.position);
        }
        const result = card ? game.applyPlay(bot.position, card, bot.socketId) : { ok: false, reason: 'no_legal_card' };
        if (!result.ok) {
            gameLogger.error('Bot fallback play refused', { gameId: game.gameId, position: bot.position, stage: game.stage, reason: result.reason, error: result.error });
            return false;
        }

        gameLogger.debug('Bot playing card', {
            botName: bot.username,
            position: bot.position,
            card: `${card.rank} of ${card.suit}`,
            gameId: game.gameId
        });

        game.broadcast(io, 'cardPlayed', game.cardPlayedPayload(card, bot.position));

        // Notify all bots about this card play
        this.notifyCardPlayed(game.gameId, card, bot.position, game.trump, game.leadPosition);
        this.handleCardPlayedChat(io, game, card, bot.position);

        // Let the caller handle post-play logic (turn advancement, trick completion, etc.)
        return true;
    }

    /**
     * A bot's own bid/play was refused or its strategy threw: log it loudly
     * (the caller then bids rules.safeBid / plays the first legal card) and count
     * it, so a broken strategy shows up in the logs and in `fallbacks`.
     * @param {'bid'|'play'} kind
     */
    noteFallback(kind, game, bot, detail) {
        this.fallbacks[kind]++;
        gameLogger.error(kind === 'bid' ? 'Bot bid refused, bidding the safe bid' : 'Bot play refused, playing the first legal card', {
            gameId: game.gameId,
            position: bot.position,
            botName: bot.username,
            stage: game.stage,
            handSize: game.currentHand,
            count: this.fallbacks[kind],
            ...detail
        });
    }

    /**
     * Reset all bot memory for a new hand
     * @param {string} gameId
     * @param {number} handSize - Cards per player
     * @param {Object} trump - Trump card
     */
    resetBotMemory(gameId, handSize, trump) {
        const gameBots = this.gamesBots.get(gameId);
        if (!gameBots) return;

        for (const bot of gameBots.values()) {
            bot.resetCardMemory(handSize, trump);
        }
    }

    /**
     * Notify all bots in a game that a card was played
     * @param {string} gameId
     * @param {Object} card - Card played
     * @param {number} position - Position of player who played
     * @param {Object} trump - Trump card
     * @param {number} [leadPosition] - Position that led the current trick
     */
    notifyCardPlayed(gameId, card, position, trump, leadPosition) {
        const gameBots = this.gamesBots.get(gameId);
        if (!gameBots) return;

        for (const bot of gameBots.values()) {
            bot.recordCardPlayed(card, position, trump, leadPosition);
        }
    }

    /**
     * Notify all bots in a game that a trick is complete
     * @param {string} gameId
     */
    notifyTrickComplete(gameId) {
        const gameBots = this.gamesBots.get(gameId);
        if (!gameBots) return;

        for (const bot of gameBots.values()) {
            bot.advanceTrick();
        }
        if (this.sentABoyTricks.has(gameId)) {
            this.sentABoyTricks.set(gameId, this.sentABoyTricks.get(gameId) + 1);
        }
    }

    // ==================== PERSONALITY HOOKS ====================

    /**
     * Send a chat message from a bot with a natural delay
     * @param {Object} io - Socket.IO server
     * @param {Object} game - GameState
     * @param {BotPlayer} bot - Bot sending the message
     * @param {string} message - Chat message text
     */
    sendBotChat(io, game, bot, message, delayMs = null) {
        const delay = delayMs !== null ? delayMs : pacing.fromRange(pacing(game).BOT_CHAT, Math.random());
        // Unique key per message so queued messages don't orphan each other's
        // timers; cleanupGame clears by gameId prefix either way
        this.chatSeq = (this.chatSeq || 0) + 1;
        const actionKey = `${game.gameId}:${bot.socketId}:chat:${this.chatSeq}`;

        const epoch = game.epoch;
        this._arm(game, actionKey, delay, () => {
            if (game.epoch !== epoch || game.isTerminal()) return;
            // A bot released meanwhile (/active) says nothing more
            if (!this.getBot(game.gameId, bot.socketId)) return;
            // `from` is the bot persona ('🤖 …'), never an account: a check
            // of chat senders against `users` must skip it (isBotName)
            game.addLogEntry(`${bot.username}: ${message}`, bot.position, 'chat', { from: bot.username });
            game.broadcast(io, 'chatMessage', {
                position: bot.position,
                message,
                username: bot.username,
                // same shape as human chat
                isSpectator: false
            });
        }, 'botChat');
    }

    /**
     * Called after trump is revealed at the start of each hand.
     * Sharon reacts to clubs and diamonds trump.
     * @param {Object} io - Socket.IO server
     * @param {Object} game - GameState
     */
    handleTrumpRevealed(io, game) {
        const bots = this.getGameBots(game.gameId);
        for (const bot of bots) {
            if (bot.personality === 'sharon') {
                if (game.trump.suit === 'clubs') {
                    this.sendBotChat(io, game, bot, "puppy's feet", pacing(game).BOT_TRUMP_QUIP_MS);
                } else if (game.trump.suit === 'diamonds') {
                    this.sendBotChat(io, game, bot, "diamonds are a girl's best friend", pacing(game).BOT_TRUMP_QUIP_MS);
                }
            }
        }
    }

    /**
     * Called after every card play (human playCard and processBotPlay), once
     * the card is on the table. When the play is a cheap ruff (isSentABoy),
     * one bot on the other team sometimes says "he sends a boy":
     * SENT_A_BOY.chance per ruff, not within SENT_A_BOY.cooldownTricks tricks
     * of the last one in this game. Only bots this game registered and that
     * still hold their seat speak. Never throws: the human playCard path
     * still has to advance the turn after it.
     * @param {Object} io - Socket.IO server
     * @param {Object} game - GameState
     * @param {Object} card - the card just played
     * @param {number} position - who played it (1-4)
     */
    handleCardPlayedChat(io, game, card, position) {
        try {
            this.sentABoyChat(io, game, card, position);
        } catch (err) {
            gameLogger.error('Bot table chat failed', { gameId: game.gameId, error: err.message, stack: err.stack });
        }
    }

    sentABoyChat(io, game, card, position) {
        if (!isSentABoy(game, card, position)) return;
        const since = this.sentABoyTricks.get(game.gameId);
        if (since !== undefined && since < SENT_A_BOY.cooldownTricks) return;
        const opponents = this.getGameBots(game.gameId).filter((b) =>
            b.position && b.position % 2 !== position % 2 && game.positions[b.position] === b.socketId);
        if (opponents.length === 0) return;
        if (this.chatRoll(game, 'sentABoy') >= SENT_A_BOY.chance) return;
        const speaker = opponents[Math.min(opponents.length - 1, Math.floor(this.chatRoll(game, 'sentABoy:who') * opponents.length))];
        this.sentABoyTricks.set(game.gameId, 0);
        this.sendBotChat(io, game, speaker, SENT_A_BOY.message,
            pacing.fromRange(pacing(game).BOT_CHAT, this.chatRoll(game, 'sentABoy:delay')));
    }

    /**
     * Called by dealHand after every deal (each hand and the all-zero
     * redeal), once the hands are out. On the game's final hand, when one
     * team leads by NOT_BE_STUPID.minLead or more, one bot of the leading
     * team that still holds its seat sometimes says "alls we gotta do is not
     * be stupid": NOT_BE_STUPID.chance, decided once per game (a redeal of
     * the final hand does not roll again). Never throws: the deal still has
     * to open the bidding after it.
     * @param {Object} io - Socket.IO server
     * @param {Object} game - GameState
     */
    handleHandDealtChat(io, game) {
        try {
            this.notBeStupidChat(io, game);
        } catch (err) {
            gameLogger.error('Bot table chat failed', { gameId: game.gameId, error: err.message, stack: err.stack });
        }
    }

    notBeStupidChat(io, game) {
        if (!isFinalHand(game.currentHand) || this.notBeStupidGames.has(game.gameId)) return;
        this.notBeStupidGames.add(game.gameId);
        const lead = game.score.team1 - game.score.team2;
        if (Math.abs(lead) < NOT_BE_STUPID.minLead) return;
        // team1 sits at the odd seats
        const parity = lead > 0 ? 1 : 0;
        const leaders = this.getGameBots(game.gameId).filter((b) =>
            b.position && b.position % 2 === parity && game.positions[b.position] === b.socketId);
        if (leaders.length === 0) return;
        if (this.chatRoll(game, 'notBeStupid') >= NOT_BE_STUPID.chance) return;
        const speaker = leaders[Math.min(leaders.length - 1, Math.floor(this.chatRoll(game, 'notBeStupid:who') * leaders.length))];
        this.sendBotChat(io, game, speaker, NOT_BE_STUPID.message,
            pacing.fromRange(pacing(game).BOT_CHAT, this.chatRoll(game, 'notBeStupid:delay')));
    }

    /**
     * Called after hand scoring is calculated.
     * Mike reacts when his team gets set. Zach reacts when set but he made his bid.
     * Danny reacts when opponents sandbag (win 2+ tricks over their bid).
     * @param {Object} io - Socket.IO server
     * @param {Object} game - GameState
     */
    handleHandCompleteChat(io, game) {
        const bots = this.getGameBots(game.gameId);

        // Helper: get numeric bid value, treating bore bids as 0
        const getNumericBid = (bidStr) => {
            const s = String(bidStr);
            return s.includes('B') ? 0 : parseInt(s, 10) || 0;
        };

        for (const bot of bots) {
            const isTeam1 = bot.position === 1 || bot.position === 3;
            const teamTricks = isTeam1 ? game.tricks.team1 : game.tricks.team2;
            const teamBid = isTeam1 ? game.bids.team1 : game.bids.team2;
            const teamWasSet = teamTricks < teamBid;

            if (!teamWasSet) continue;

            const partnerPosition = bot.position === 1 ? 3 : bot.position === 3 ? 1 : bot.position === 2 ? 4 : 2;
            const botBidStr = game.playerBids[bot.position - 1];
            const partnerBidStr = game.playerBids[partnerPosition - 1];
            const hasBore = String(botBidStr).includes('B') || String(partnerBidStr).includes('B');

            if (bot.personality === 'mike' && !hasBore) {
                // Mike says "I thought I bid X" where X would have avoided the set
                const partnerBidValue = getNumericBid(partnerBidStr);
                const safeBid = Math.max(0, teamTricks - partnerBidValue);
                this.sendBotChat(io, game, bot, `I thought I bid ${safeBid}`);
            }

            if (bot.personality === 'zach' && !hasBore) {
                // Zach says "well at least I got my X" if he personally made his bid
                const zachBidValue = getNumericBid(botBidStr);
                const zachTricks = game.handTricks[bot.position] || 0;
                if (zachTricks >= zachBidValue && zachBidValue > 0) {
                    this.sendBotChat(io, game, bot, `well at least I got my ${zachBidValue}`);
                }
            }
        }

        // Danny reacts when opponents sandbag (win 2+ tricks over their bid)
        for (const bot of bots) {
            if (bot.personality !== 'danny') continue;

            const isTeam1 = bot.position === 1 || bot.position === 3;
            const oppTricks = isTeam1 ? game.tricks.team2 : game.tricks.team1;
            const oppBid = isTeam1 ? game.bids.team2 : game.bids.team1;

            if (oppTricks >= oppBid + 2) {
                this.sendBotChat(io, game, bot, 'you sandbaggers');
            }
        }
    }

    /**
     * Update Zach's partner history after a hand completes.
     * @param {Object} game - GameState
     */
    updatePartnerHistory(game) {
        const bots = this.getGameBots(game.gameId);

        for (const bot of bots) {
            if (bot.personality !== 'zach') continue;

            const partnerPosition = bot.position === 1 ? 3 : bot.position === 3 ? 1 : bot.position === 2 ? 4 : 2;
            const partnerBidStr = String(game.playerBids[partnerPosition - 1]);
            // Skip bore hands entirely: logging a successful bore as "bid 0,
            // took N" would poison the over/under-bid signal Zach adapts to
            if (partnerBidStr.includes('B')) continue;
            const partnerBidValue = parseInt(partnerBidStr, 10) || 0;
            const partnerTricks = game.handTricks[partnerPosition] || 0;

            bot.recordPartnerHand(partnerBidValue, partnerTricks);
        }
    }

    /**
     * Cancel every pending timer (bid, play, draw, chat) for one bot
     * @param {string} gameId
     * @param {string} botSocketId
     */
    cancelBotActions(gameId, botSocketId) {
        const prefix = `${gameId}:${botSocketId}:`;
        for (const [key, timeoutId] of this.pendingActions) {
            if (key.startsWith(prefix)) {
                clearTimeout(timeoutId);
                this.pendingActions.delete(key);
                this.pendingMeta.delete(key);
            }
        }
        const held = this.suspended.get(gameId);
        if (held) for (const key of Array.from(held.keys())) if (key.startsWith(prefix)) held.delete(key);
    }

    /**
     * Release one bot from a game (a lazy bot after /active): cancels all its
     * timers and removes it from the registry
     * @param {string} gameId
     * @param {string} botSocketId
     */
    unregisterBot(gameId, botSocketId) {
        this.cancelBotActions(gameId, botSocketId);
        this.gamesBots.get(gameId)?.delete(botSocketId);
    }

    /**
     * Cleanup bots when a game ends
     * @param {string} gameId
     */
    cleanupGame(gameId) {
        // Clear any pending actions for this game, even if its bot registry
        // is already gone (timers can outlive a partial cleanup)
        for (const [key, timeoutId] of this.pendingActions) {
            if (key.startsWith(`${gameId}:`)) {
                clearTimeout(timeoutId);
                this.pendingActions.delete(key);
                this.pendingMeta.delete(key);
            }
        }
        this.suspended.delete(gameId);
        this.sentABoyTricks.delete(gameId);
        this.notBeStupidGames.delete(gameId);
        const gameBots = this.gamesBots.get(gameId);
        if (gameBots) {
            this.gamesBots.delete(gameId);
            gameLogger.debug('Cleaned up bots for game', { gameId });
        }
    }

    /**
     * Clear all bots (for testing)
     */
    clearAll() {
        for (const [gameId] of this.gamesBots) {
            this.cleanupGame(gameId);
        }
        this.gamesBots.clear();
        this.sentABoyTricks.clear();
        this.notBeStupidGames.clear();
        for (const [, timeoutId] of this.pendingActions) {
            clearTimeout(timeoutId);
        }
        this.pendingActions.clear();
        this.pendingMeta.clear();
        this.suspended.clear();
    }

    /**
     * Tests only: back to a fresh process's state (testUtils/persistHarness.js
     * restart): every pending bid/play/draw/chat timer cancelled, no bot
     * registered, the fallback counts and the chat sequence at zero, the
     * "he sends a boy" cooldowns forgotten (clearAll) and the quip roll
     * back to its default (a Jest mock installed on it stays, as
     * GameManager._resetForTests keeps spies). Jest only (JEST_WORKER_ID),
     * as GameManager._resetForTests.
     */
    _resetForTests() {
        if (process.env.JEST_WORKER_ID === undefined) throw new Error('_resetForTests is for Jest only');
        this.clearAll();
        this.fallbacks = { bid: 0, play: 0 };
        delete this.chatSeq;
        if (this.chatRoll?._isMockFunction !== true) this.chatRoll = playRoll;
    }
}

// Singleton instance
const botController = new BotController();

module.exports = botController;

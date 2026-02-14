/**
 * BotController singleton - manages all active bots and coordinates their actions.
 * Handles scheduling bot turns, processing bot actions, and cleanup.
 */

const BotPlayer = require('./BotPlayer');
const { gameLogger } = require('../../utils/logger');

class BotController {
    constructor() {
        // Map of gameId -> Map of socketId -> BotPlayer
        this.gamesBots = new Map();

        // Track pending timeouts for cleanup
        this.pendingActions = new Map();
    }

    /**
     * Create a new bot for a lobby
     * @param {string} username - Bot name (default: "Mary")
     * @returns {BotPlayer}
     */
    createBot(username = 'Mary') {
        return new BotPlayer(username);
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

        const delay = bot.getActionDelay(actionType);
        const actionKey = `${game.gameId}:${player.socketId}:${actionType}`;

        // Clear any existing pending action
        if (this.pendingActions.has(actionKey)) {
            clearTimeout(this.pendingActions.get(actionKey));
        }

        const timeoutId = setTimeout(() => {
            this.pendingActions.delete(actionKey);
            actionHandler(io, game, bot);
        }, delay);

        this.pendingActions.set(actionKey, timeoutId);
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
        const baseDelay = drawOrder * 800;
        const delay = baseDelay + bot.getActionDelay('draw');

        const actionKey = `${game.gameId}:${botSocketId}:draw`;

        const timeoutId = setTimeout(() => {
            this.pendingActions.delete(actionKey);
            this.processBotDraw(io, game, bot);
        }, delay);

        this.pendingActions.set(actionKey, timeoutId);
    }

    /**
     * Process bot draw action
     * @param {Object} io - Socket.IO server
     * @param {Object} game - GameState
     * @param {BotPlayer} bot - Bot player
     */
    processBotDraw(io, game, bot) {
        if (game.phase !== 'drawing') return;

        const remaining = game.deck.cards.length;
        if (remaining === 0) return;

        const drawIndex = bot.decideDraw(remaining);
        const card = game.deck.cards[drawIndex];

        game.drawCards.push(card);
        game.drawIDs.push(bot.socketId);
        game.deck.cards.splice(drawIndex, 1);

        gameLogger.debug('Bot drew card', {
            botName: bot.username,
            card: `${card.rank} of ${card.suit}`,
            gameId: game.gameId
        });

        // Broadcast to all players
        game.broadcast(io, 'playerDrew', {
            username: bot.username,
            card,
            drawOrder: game.drawIndex + 1,
            socketId: bot.socketId
        });

        game.drawIndex++;

        // Check if all players have drawn - trigger draw completion
        if (game.drawIndex === 4) {
            // Use lazy require to avoid circular dependency
            const { handleDrawComplete } = require('../../socket/gameHandlers');
            handleDrawComplete(io, game);
        }
    }

    /**
     * Process bot bid action
     * @param {Object} io - Socket.IO server
     * @param {Object} game - GameState
     * @param {BotPlayer} bot - Bot player
     */
    processBotBid(io, game, bot) {
        if (!game.bidding || game.currentTurn !== bot.position) return;

        const hand = game.getHand(bot.socketId);
        const gameContext = {
            teamScore: (bot.position === 1 || bot.position === 3) ? game.score.team1 : game.score.team2,
            oppScore: (bot.position === 1 || bot.position === 3) ? game.score.team2 : game.score.team1,
            currentHandSize: game.currentHand
        };
        const bid = bot.decideBid(hand, game.trump, game.playerBids, game.currentHand, gameContext);

        gameLogger.debug('Bot bidding', {
            botName: bot.username,
            position: bot.position,
            bid,
            gameId: game.gameId
        });

        // Record bid (same as playerBid handler)
        game.recordBid(bot.position, bid);
        game.addLogEntry(`${bot.username} bid ${bid}.`, bot.position, 'bid');

        game.broadcast(io, 'bidReceived', {
            bid,
            position: bot.position,
            bidArray: game.playerBids
        });

        // Let the caller handle post-bid logic (turn advancement, etc.)
    }

    /**
     * Process bot card play action
     * @param {Object} io - Socket.IO server
     * @param {Object} game - GameState
     * @param {BotPlayer} bot - Bot player
     */
    processBotPlay(io, game, bot) {
        if (game.bidding || game.currentTurn !== bot.position) return;

        const hand = game.getHand(bot.socketId);
        if (!hand || hand.length === 0) return;

        const card = bot.decideCard(
            hand,
            game.playedCards,
            game.leadCard,
            game.leadPosition,
            game.trump,
            game.isTrumpBroken,
            game.currentHand
        );

        gameLogger.debug('Bot playing card', {
            botName: bot.username,
            position: bot.position,
            card: `${card.rank} of ${card.suit}`,
            gameId: game.gameId
        });

        // Remove card from hand
        game.removeCardFromHand(bot.socketId, card);

        // Record lead card if leading
        const isLeading = game.playedCardsIndex === 0;
        if (isLeading) {
            game.leadCard = card;
            game.leadPosition = bot.position;
        }

        // Record played card
        game.playedCards[bot.position - 1] = card;
        game.playedCardsIndex++;
        game.cardIndex++;

        // Check if trump is broken
        if (card.suit === game.trump.suit || card.suit === 'joker') {
            game.isTrumpBroken = true;
        }

        game.broadcast(io, 'cardPlayed', {
            playerId: bot.socketId,
            card,
            position: bot.position,
            trump: game.isTrumpBroken
        });

        // Notify all bots about this card play
        this.notifyCardPlayed(game.gameId, card, bot.position, game.trump);

        // Let the caller handle post-play logic (turn advancement, trick completion, etc.)
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
     */
    notifyCardPlayed(gameId, card, position, trump) {
        const gameBots = this.gamesBots.get(gameId);
        if (!gameBots) return;

        for (const bot of gameBots.values()) {
            bot.recordCardPlayed(card, position, trump);
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
    }

    /**
     * Cleanup bots when a game ends
     * @param {string} gameId
     */
    cleanupGame(gameId) {
        const gameBots = this.gamesBots.get(gameId);
        if (gameBots) {
            for (const [socketId] of gameBots) {
                // Clear any pending actions
                for (const [key, timeoutId] of this.pendingActions) {
                    if (key.startsWith(`${gameId}:`)) {
                        clearTimeout(timeoutId);
                        this.pendingActions.delete(key);
                    }
                }
            }
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
        for (const [, timeoutId] of this.pendingActions) {
            clearTimeout(timeoutId);
        }
        this.pendingActions.clear();
    }
}

// Singleton instance
const botController = new BotController();

module.exports = botController;

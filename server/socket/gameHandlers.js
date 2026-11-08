/**
 * Game play socket event handlers
 */

const gameManager = require('../game/GameManager');
const Deck = require('../game/Deck');
const { recordGameStats, getUserProfilePic } = require('./profileHandlers');
const {
    rotatePosition,
    isRainbow,
    isLegalMove,
    isTrumpTight,
    determineWinner,
    findHighestBidder,
    calculateMultiplier,
    determineDrawPosition,
    calculateHSI,
    isValidBid,
    BID_RANKS
} = require('../game/rules');
const { gameLogger } = require('../utils/logger');
const { Phase, reportViolation } = require('../game/GamePhase');
const { botController, personalities } = require('../game/bot');
const { PERSONALITY_LIST } = personalities;
const { cancelAbortTimer, startReconnectGraceTimer } = require('./queueHandlers');
const { abortGame, emitLobbiesUpdated } = require('./gameLifecycle');

const logContinuationError = (what, game) => (err) =>
    gameLogger.error(`${what} failed`, { gameId: game.gameId, error: err.message, stack: err.stack });

/**
 * Tell the sender its action was refused (instead of failing silently) so a
 * client can resync rather than freeze. Clients that predate this event just
 * ignore it.
 */
function rejectAction(socket, game, action, reason, extra = {}) {
    gameLogger.warn('Action rejected', { action, reason, gameId: game.gameId, socketId: socket.id, ...extra });
    socket.emit('actionRejected', { action, reason });
}

/**
 * Check if the current turn is a bot and schedule their action
 * @param {Object} io - Socket.IO server
 * @param {Object} game - GameState
 * @param {string} actionType - 'bid' or 'play'
 */
function triggerBotIfNeeded(io, game, actionType) {
    const currentPlayer = game.getPlayerByPosition(game.currentTurn);
    if (!currentPlayer) return;

    const isBot = game.isBot(currentPlayer.socketId);
    const isLazy = game.isLazy(game.currentTurn);

    if (!isBot && !isLazy) {
        return;
    }

    if (isLazy && !isBot) {
        // Lazy mode: find the substitute bot and use it to play
        const lazyInfo = game.getLazyBot(game.currentTurn);
        if (!lazyInfo) return;
        const bot = botController.getBot(game.gameId, lazyInfo.botSocketId);
        if (!bot) return;

        // The bot needs to use the player's hand (still keyed by player's socketId)
        const playerSocketId = currentPlayer.socketId;
        const delayMs = bot.getActionDelay(actionType);

        // One pending lazy action per seat, owned by the game: it never fires
        // after the game ends/aborts, and /active clears it
        game.setTimer('lazy:' + bot.position, delayMs, () => {
          // Contain failures to this one action (setTimer also logs throws)
          try {
            // Re-validate before acting: the game may have moved on during the
            // delay (turn advanced, trick resolved, /active, game ended). A
            // stale write here corrupts playedCards and wedges the game.
            if (!gameManager.getGameById(game.gameId)) return;
            // Only act in the stage this action was scheduled for (no hand
            // before the deal, no plays while a trick or hand is resolving)
            if (actionType === 'bid' ? game.stage !== Phase.BIDDING : game.stage !== Phase.PLAYING) return;
            if (!game.isLazy(bot.position)) return;
            if (game.currentTurn !== bot.position) return;

            if (actionType === 'bid') {
                if (game.playerBids[bot.position - 1] != null) return;

                // Use player's hand for bot decision
                const hand = game.getHand(playerSocketId);
                const gameContext = {
                    teamScore: (bot.position === 1 || bot.position === 3) ? game.score.team1 : game.score.team2,
                    oppScore: (bot.position === 1 || bot.position === 3) ? game.score.team2 : game.score.team1,
                    currentHandSize: game.currentHand
                };
                const bid = bot.decideBid(hand, game.trump, game.playerBids, game.currentHand, gameContext);
                game.recordBid(bot.position, bid);
                game.addLogEntry(`${currentPlayer.username} bid ${bid}.`, bot.position, 'bid');
                game.broadcast(io, 'bidReceived', { bid, position: bot.position, bidArray: game.playerBids });
                game.currentTurn = rotatePosition(game.currentTurn);
                handlePostBid(io, game).catch(logContinuationError('handlePostBid', game));
            } else if (actionType === 'play') {
                if (game.playedCardsIndex >= 4) return;
                if (game.playedCards[bot.position - 1]) return;

                const hand = game.getHand(playerSocketId);
                if (!hand || hand.length === 0) return;
                const card = bot.decideCard(hand, game.playedCards, game.leadCard, game.leadPosition, game.trump, game.isTrumpBroken, game.currentHand, botController.buildPlayContext(game));
                game.removeCardFromHand(playerSocketId, card);
                const isLeading = game.playedCardsIndex === 0;
                if (isLeading) {
                    game.leadCard = card;
                    game.leadPosition = bot.position;
                }
                game.playedCards[bot.position - 1] = card;
                game.playedCardsIndex++;
                game.cardIndex++;
                if (card.suit === game.trump.suit || card.suit === 'joker') {
                    game.isTrumpBroken = true;
                }
                game.broadcast(io, 'cardPlayed', { playerId: playerSocketId, card, position: bot.position, trump: game.isTrumpBroken });
                botController.notifyCardPlayed(game.gameId, card, bot.position, game.trump, game.leadPosition);
                game.currentTurn = rotatePosition(game.currentTurn);
                handlePostPlay(io, game).catch(logContinuationError('handlePostPlay', game));
            }
          } catch (err) {
            gameLogger.error('Lazy-bot action failed', { gameId: game.gameId, actionType, error: err.message, stack: err.stack });
          }
        });
        return;
    }

    // Normal bot action
    if (actionType === 'bid') {
        botController.scheduleBotAction(io, game, 'bid', (io, game, bot) => {
            // Only advance the turn if the bid actually happened — advancing
            // after a stale-state bail wedges the game on a phantom turn
            if (!botController.processBotBid(io, game, bot)) return;
            game.currentTurn = rotatePosition(game.currentTurn);
            handlePostBid(io, game).catch(logContinuationError('handlePostBid', game));
        });
    } else if (actionType === 'play') {
        botController.scheduleBotAction(io, game, 'play', (io, game, bot) => {
            if (!botController.processBotPlay(io, game, bot)) return;
            game.currentTurn = rotatePosition(game.currentTurn);
            handlePostPlay(io, game).catch(logContinuationError('handlePostPlay', game));
        });
    }
}

/**
 * Handle logic after a bid is made (check if all bids done, trigger next bot)
 */
async function handlePostBid(io, game) {
    if (game.stage !== Phase.BIDDING) return;

    // Check if all bids are in
    if (game.getBidCount() === 4) {
        // Calculate team bids
        const bids = game.playerBids;
        game.bids = {
            team1: (BID_RANKS[bids[0]] || 0) + (BID_RANKS[bids[2]] || 0),
            team2: (BID_RANKS[bids[1]] || 0) + (BID_RANKS[bids[3]] || 0)
        };

        // Multipliers apply whenever a bore was bid — even when the summed bid
        // doesn't exceed the hand size (e.g. 'B' + '0' on the 13-card hand)
        game.team1Mult = calculateMultiplier(bids[0], bids[2]);
        game.team2Mult = calculateMultiplier(bids[1], bids[3]);

        // Cap bids at hand size
        if (game.bids.team1 > game.currentHand) {
            game.bids.team1 = game.currentHand;
        }
        if (game.bids.team2 > game.currentHand) {
            game.bids.team2 = game.currentHand;
        }

        gameLogger.debug('Bidding complete', { team1: game.bids.team1, team2: game.bids.team2, gameId: game.gameId });

        // Check for zero bids (redeal) BEFORE doneBidding: clients treat
        // doneBidding as "enter play", so sending it first flashes the play
        // phase for a hand that is about to be torn down
        if (game.bids.team1 === 0 && game.bids.team2 === 0) {
            if (!game.transition(Phase.BIDDING, Phase.REDEAL)) return;
            gameLogger.info('Zero bids, redealing', { gameId: game.gameId });
            const redealMsg = 'All bids were zero. Redealing.';
            game.addLogEntry(redealMsg, null, 'system');
            game.broadcast(io, 'gameLogEntry', { message: redealMsg, type: 'system' });
            game.broadcast(io, 'destroyHands', {});
            if (!game.transition(Phase.REDEAL, Phase.DEALING)) return;
            await dealHand(game, io, { dealer: game.dealer, handSize: game.currentHand });
            return;
        }

        const lead = findHighestBidder(game.bidder, bids) + 1;

        if (!game.transition(Phase.BIDDING, Phase.PLAYING)) return;
        game.broadcast(io, 'doneBidding', { bids, lead });

        game.currentTurn = lead;
        game.leadPosition = lead;

        // Check for rainbows after bidding (only on 4-card hands)
        if (game.currentHand === 4) {
            const socketIds = game.getSocketIds();
            for (const socketId of socketIds) {
                const hand = game.getHand(socketId);
                if (isRainbow(hand, game.trump)) {
                    const position = game.getPositionBySocketId(socketId);
                    const player = game.getPlayerByPosition(position);
                    gameLogger.info('Rainbow hand detected', { socketId, position, gameId: game.gameId });
                    game.broadcast(io, 'rainbow', { position });
                    game.addLogEntry(`${player.username} has a rainbow!`, position, 'rainbow');

                    if (position === 1 || position === 3) {
                        game.rainbows.team1 += 1;
                    } else {
                        game.rainbows.team2 += 1;
                    }
                }
            }
        }
    }

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });

    // Trigger next bot if needed (bidding done: the lead may be a bot)
    triggerBotIfNeeded(io, game, game.stage === Phase.BIDDING ? 'bid' : 'play');
}

/**
 * Handle logic after a card is played (check for trick complete, trigger next bot)
 */
async function handlePostPlay(io, game) {
    if (game.stage !== Phase.PLAYING) return;

    // Check if trick is complete
    if (game.playedCardsIndex === 4) {
        // TRICK_RESOLVING rejects plays and makes a second resolution a no-op
        if (!game.transition(Phase.PLAYING, Phase.TRICK_RESOLVING)) return;

        if (!(await game.pause(2000))) return;

        // Re-validate after the pause: if the trick array was corrupted by a
        // stale action, log loudly instead of crashing the whole game loop
        const trickCards = game.playedCards.slice(0, 4);
        if (game.playedCardsIndex !== 4 || trickCards.length < 4 || trickCards.some(c => !c)) {
            gameLogger.error('Trick state invalid after resolution delay, skipping', {
                gameId: game.gameId,
                playedCardsIndex: game.playedCardsIndex,
                playedCards: game.playedCards
            });
            return;
        }

        const winner = determineWinner(game.playedCards, game.leadPosition, game.trump);

        if (winner === 1 || winner === 3) {
            game.tricks.team1++;
        } else {
            game.tricks.team2++;
        }

        // Track tricks for player stats
        if (game.playerStats && game.playerStats[winner]) {
            game.playerStats[winner].totalTricks++;
        }
        // Track tricks for this hand (used for set responsibility)
        if (game.handTricks) {
            game.handTricks[winner]++;
        }

        // Add trick winner to game log
        const winnerPlayer = game.getPlayerByPosition(winner);
        game.addLogEntry(`Trick won by ${winnerPlayer.username}.`, winner, 'trick');

        gameLogger.debug('Trick complete', { winner, team1Tricks: game.tricks.team1, team2Tricks: game.tricks.team2, gameId: game.gameId });

        game.currentTurn = winner;

        game.broadcast(io, 'trickComplete', { winner });

        // Notify bots that the trick is complete
        botController.notifyTrickComplete(game.gameId);

        game.playedCards = [];
        game.playedCardsIndex = 0;

        // Check if hand is complete
        if (game.cardIndex === game.currentHand * 4) {
            if (!game.transition(Phase.TRICK_RESOLVING, Phase.HAND_RESOLVING)) return;
            if (!(await game.pause(2000))) return; // Brief pause after last trick stacks
            await handleHandComplete(game, io);
            return;
        }
        if (!game.transition(Phase.TRICK_RESOLVING, Phase.PLAYING)) return;
    }

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });

    // Trigger next bot if needed
    triggerBotIfNeeded(io, game, 'play');
}

async function draw(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    if (!game) return;

    // recordDraw refuses out-of-phase, duplicate and 5th draws
    const d = game.recordDraw(socket.id, data && data.num);
    if (!d) return;
    const { card, drawOrder } = d;

    gameLogger.debug('Player drew card', { socketId: socket.id, card: `${card.rank} of ${card.suit}` });

    // Get username for this player
    const user = gameManager.getUserBySocketId(socket.id);
    const username = user?.username || 'Player';

    // Tell the drawing player their card
    socket.emit('youDrew', { card, drawOrder });

    // Broadcast to all players that someone drew (so they can see it)
    game.broadcast(io, 'playerDrew', {
        username,
        card,
        drawOrder,
        socketId: socket.id
    });

    // Check if all players have drawn
    if (game.drawIndex === 4) {
        await handleDrawComplete(io, game);
    }
}

/**
 * Auto-draw a random card for a socket that left or disconnected before
 * drawing. Broadcasts playerDrew; the caller decides whether this draw
 * completed the phase (game.drawIndex === 4).
 * @returns {boolean} true if a card was drawn
 */
function autoDraw(io, game, socketId, username) {
    const d = game.recordDraw(socketId, null);
    if (d) {
        game.broadcast(io, 'playerDrew', { username, card: d.card, drawOrder: d.drawOrder, socketId });
    }
    return !!d;
}

/**
 * Handle draw phase completion - assign positions and start game
 * Called when all 4 players (human or bot) have drawn. Every draw path may
 * call it; the DRAWING -> DRAW_RESOLVING latch makes it run exactly once.
 */
async function handleDrawComplete(io, game) {
    if (game.drawIDs.length !== 4 || !game.tryTransition(Phase.DRAWING, Phase.DRAW_RESOLVING)) return;
    const alive = game.aliveCheck();

    // Fetch saved profile pics for all players
    const pics = [];
    const usedPics = new Set();
    for (let i = 0; i < game.drawIDs.length; i++) {
        const playerId = game.drawIDs[i];
        const isBot = gameManager.isBot(playerId);
        let pic;

        if (isBot) {
            // Bots get random pics
            do {
                pic = Math.floor(Math.random() * 82) + 1;
            } while (usedPics.has(pic));
        } else {
            // Human players - fetch saved profile pic
            const user = gameManager.getUserBySocketId(playerId);
            pic = await getUserProfilePic(user?.username);
            const isCustomPic = typeof pic === 'string' && pic.startsWith('data:image');

            // Only check for duplicates on numbered pics (custom pics are always unique)
            if (!isCustomPic) {
                while (usedPics.has(pic)) {
                    pic = Math.floor(Math.random() * 82) + 1;
                }
            }
        }

        usedPics.add(pic);
        pics.push(pic);
    }
    // Aborted while the profile pics loaded
    if (!alive()) return;

    // Assign positions based on cards drawn
    const positions = [];
    for (let i = 0; i < game.drawIDs.length; i++) {
        const playerId = game.drawIDs[i];
        const position = determineDrawPosition(game.drawCards[i], game.drawCards);
        positions.push(position);

        // Get username - check if bot first, then user lookup
        const isBot = gameManager.isBot(playerId);
        let username = 'Player';
        if (isBot) {
            // Look up real personality name from BotController
            const bot = botController.getBot(game.gameId, playerId);
            username = bot?.username || 'Bot';
        } else {
            const user = gameManager.getUserBySocketId(playerId);
            username = user?.username || game._pendingUsernames?.[playerId] || 'Player';
        }

        game.addPlayer(playerId, username, position, pics[i], isBot);

        // Update bot position in controller
        if (isBot) {
            const bot = botController.getBot(game.gameId, playerId);
            if (bot) {
                bot.position = position;
                bot.pic = pics[i];
            }
        }

        // Only emit to human players still at the table (a draw-phase leaver
        // is back in the main room and must not pick up a seat position)
        if (!isBot && !game._drawPhaseDisconnects?.[playerId]?.left) {
            game.sendToPlayer(io, playerId, 'playerAssigned', { playerId, position });
        }
    }

    // Players who left or disconnected during the draw now hold seats.
    // Leavers are gone for good, so a bot takes the seat now (as if resigned)
    // and the table never waits on them. Disconnects get the normal reconnect
    // grace timer, after which the others are offered a bot replacement.
    const drawPhaseDisconnects = [];
    let seatedBotForLeaver = false;
    if (game._drawPhaseDisconnects) {
        for (const [socketId, info] of Object.entries(game._drawPhaseDisconnects)) {
            const pos = game.getPositionBySocketId(socketId);
            if (!pos) continue;
            if (info.left) {
                const bot = replaceSeatWithBot(game, pos);
                seatedBotForLeaver = true;
                const msg = `${bot.username} is taking over for ${info.username}.`;
                game.addLogEntry(msg, null, 'system');
                game.broadcast(io, 'gameLogEntry', { message: msg, type: 'system' });
            } else {
                game.markPlayerDisconnected(pos);
                drawPhaseDisconnects.push({ position: pos, username: info.username });
            }
        }
        delete game._drawPhaseDisconnects;
        delete game._pendingUsernames;
    }

    // Every human left during the draw: nobody to play for, abort (same rule
    // as /leave once the game is under way). All-bot demo games never get here.
    if (seatedBotForLeaver && Array.from(game.players.values()).every(p => p.isBot)) {
        gameLogger.warn('All humans left during draw, aborting game', { gameId: game.gameId });
        await abortGame(io, game, 'All players left');
        return;
    }

    // Build all arrays in position order (1, 2, 3, 4) for consistency
    const orderedPositions = [];
    const orderedSockets = [];
    const orderedUsernames = [];
    const orderedPics = [];
    for (let pos = 1; pos <= 4; pos++) {
        const player = game.getPlayerByPosition(pos);
        if (player) {
            orderedPositions.push(pos);
            orderedSockets.push(player.socketId);
            orderedUsernames.push({
                username: player.username,
                socketId: player.socketId
            });
            orderedPics.push(player.pic);
        }
    }

    if (!(await game.pause(1000))) return;

    game.broadcast(io, 'positionUpdate', {
        positions: orderedPositions,
        sockets: orderedSockets,
        usernames: orderedUsernames,
        pics: orderedPics
    });

    // Now that seats have positions, show draw-phase disconnects on the
    // table and start their reconnect grace period. Skip anyone who rejoined
    // during the delays above (they already got playerReconnected).
    const stillDisconnected = drawPhaseDisconnects.filter(dc => game.isPlayerDisconnected(dc.position));
    for (const dc of stillDisconnected) {
        game.broadcast(io, 'playerDisconnected', dc);
    }
    if (stillDisconnected.length > 0) {
        startReconnectGraceTimer(io, game.gameId);
    }

    // Set active game for all human players (enables cross-browser
    // reconnection). Resolved per seat now, not from the pre-delay snapshot:
    // bots have no user document, and a seat that was resigned or /leave'd
    // meanwhile must not have its human's activeGameId re-armed.
    const written = [];
    for (let pos = 1; pos <= 4; pos++) {
        const player = game.getPlayerByPosition(pos);
        if (!player || game.isResigned(pos)) continue;
        let username;
        if (game.isLazy(pos)) {
            if (game.lazyPlayers[pos].permanentLeave) continue;
            username = game.lazyPlayers[pos].originalUsername;
        } else {
            if (player.isBot || gameManager.isBot(player.socketId)) continue;
            username = player.username;
        }
        if (!alive()) break;
        await gameManager.setActiveGame(username, game.gameId);
        written.push(username);
    }
    // Aborted mid-loop: the abort's own clear may have run before one of
    // these writes landed, so re-clear (scoped to this game) what we wrote
    if (!alive()) {
        await Promise.all(written.map(u =>
            gameManager.clearActiveGame(u, game.gameId).catch(logContinuationError('clearActiveGame', game))
        ));
        return;
    }

    // Announce teams (positions 1&3 vs 2&4)
    const team1Player1 = game.getPlayerByPosition(1);
    const team1Player2 = game.getPlayerByPosition(3);
    const team2Player1 = game.getPlayerByPosition(2);
    const team2Player2 = game.getPlayerByPosition(4);

    if (!(await game.pause(1000))) return;

    if (!game.transition(Phase.DRAW_RESOLVING, Phase.TEAMS_ANNOUNCED)) return;
    game.broadcast(io, 'teamsAnnounced', {
        team1: [team1Player1?.username || 'Player 1', team1Player2?.username || 'Player 3'],
        team2: [team2Player1?.username || 'Player 2', team2Player2?.username || 'Player 4']
    });

    // Wait for team announcement to be seen (3 seconds)
    if (!(await game.pause(3000))) return;

    if (!game.transition(Phase.TEAMS_ANNOUNCED, Phase.DEALING)) return;

    // Reset draw state
    game.drawCards = [];
    game.drawIndex = 0;
    game.drawIDs = [];
    game.deck = null;

    // Notify main room that a new in-progress game is available to spectate
    emitLobbiesUpdated(io);

    // createUI must come BEFORE gameStart (client expects this order)
    game.broadcast(io, 'createUI', {});

    // Add game start message to log
    game.addLogEntry('Game started!', null, 'system');

    // Deal the first hand (emits gameStart to each player)
    await dealHand(game, io, { dealer: game.dealer, handSize: game.currentHand, firstHand: true });
}

/**
 * Deal a hand and open its bidding. Used for the first hand (after the team
 * announcement), every following hand, and the all-zero redeal.
 * Wire order: gameStart (each seat) -> gameStart (spectators) ->
 * [1s pause on the first hand] -> updateTurn.
 * @param {Object} opts
 * @param {number} opts.dealer - dealer position for this hand
 * @param {number} opts.handSize - cards per player
 * @param {boolean} [opts.firstHand=false] - pause 1s before the first updateTurn
 */
async function dealHand(game, io, { dealer, handSize, firstHand = false }) {
    if (game.stage !== Phase.DEALING) {
        reportViolation('deal-wrong-stage', { gameId: game.gameId, stage: game.stage });
        return;
    }
    // Hand 1 passes (1, 12), which equals the constructor defaults (bidder 2)
    game.resetForNewHand(dealer, handSize);

    // Initialize new deck and deal
    const deck = new Deck();
    deck.shuffle();

    const socketIds = game.getSocketIds();
    for (const socketId of socketIds) {
        const hand = deck.draw(game.currentHand);
        game.setHand(socketId, hand);
    }

    game.trump = deck.drawOne();

    // Reset bot memory for new hand and trigger personality reactions to trump
    botController.resetBotMemory(game.gameId, game.currentHand, game.trump);
    botController.handleTrumpRevealed(io, game);

    // Calculate HSI for each player's hand and add to their stats
    const hsiValues = {};
    for (const socketId of socketIds) {
        const hand = game.getHand(socketId);
        const position = game.getPositionBySocketId(socketId);
        const hsi = calculateHSI(hand, game.trump);
        game.addHSI(position, hsi);
        hsiValues[position] = hsi;
    }

    // Store HSI values on game state for reconnection
    game.hsiValues = hsiValues;

    // Build current player info (reflects bot takeovers via lazy/resign)
    const playerInfo = [];
    for (let pos = 1; pos <= 4; pos++) {
        const p = game.getPlayerByPosition(pos);
        if (p) {
            playerInfo.push({ position: pos, username: p.username, pic: p.pic });
        }
    }

    // Send the hand to every seat (each gets their own hand and position).
    // A seat whose socket no longer maps to this game (a /leave'd lazy
    // human, now in the main room) gets nothing.
    for (const socketId of socketIds) {
        if (game.isBot(socketId)) continue;
        if (game._isSeatReachable && !game._isSeatReachable(socketId)) continue;
        const playerPosition = game.getPositionBySocketId(socketId);
        game.sendToPlayer(io, socketId, 'gameStart', {
            gameId: game.gameId,
            players: socketIds,
            hand: game.getHand(socketId),
            trump: game.trump,
            score1: game.score.team1,
            score2: game.score.team2,
            dealer: game.dealer,
            position: playerPosition,  // Include player's position to avoid the bid UI race
            currentHand: game.currentHand,  // Hand index for hand indicator
            hsiValues,  // HSI for all players to display under avatars
            playerInfo  // Current player info for avatar updates
        });
    }

    // Send spectator-safe gameStart (no hand data) so spectators see updated trump/score/hand
    for (const spec of game.getSpectators()) {
        game.sendToPlayer(io, spec.socketId, 'gameStart', {
            gameId: game.gameId,
            trump: game.trump,
            score1: game.score.team1,
            score2: game.score.team2,
            dealer: game.dealer,
            currentHand: game.currentHand,
            hand: [],
            playerInfo
        });
    }

    gameLogger.info('Hand dealt', { gameId: game.gameId, handSize: game.currentHand, dealer: game.dealer, firstHand });
    game.currentTurn = game.bidder;
    if (!game.transition(Phase.DEALING, Phase.BIDDING)) return;

    if (firstHand) {
        if (!(await game.pause(1000))) return;
        // A bid during the pause already sent updateTurn and triggered the
        // next bot; repeating them would double-schedule it
        if (game.stage !== Phase.BIDDING || game.getBidCount() > 0) return;
    }

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });

    // Trigger bot if first bidder is a bot
    triggerBotIfNeeded(io, game, 'bid');
}

async function playerBid(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    if (!game) return;

    const position = game.getPositionBySocketId(socket.id);

    // Validate stage and turn (before the deal currentTurn holds the
    // constructor default)
    if (game.stage !== Phase.BIDDING || position !== game.currentTurn) {
        rejectAction(socket, game, 'bid', 'not_your_turn', { position, currentTurn: game.currentTurn });
        return;
    }
    if (game.playerBids[position - 1] != null) {
        rejectAction(socket, game, 'bid', 'already_bid', { position });
        return;
    }

    const bid = String(data.bid).toUpperCase();
    if (!isValidBid(bid, game.playerBids, game.currentHand)) {
        rejectAction(socket, game, 'bid', 'invalid_bid', { position, bid, handSize: game.currentHand });
        return;
    }
    game.recordBid(position, bid);

    // Add bid to game log
    const player = game.getPlayerByPosition(position);
    game.addLogEntry(`${player.username} bid ${bid}.`, position, 'bid');

    gameLogger.debug('Bid received', { position, bid, gameId: game.gameId });
    game.broadcast(io, 'bidReceived', {
        bid: data.bid,
        position,
        bidArray: game.playerBids
    });

    // Advance turn
    game.currentTurn = rotatePosition(game.currentTurn);

    // Handle post-bid logic (check if all bids done, trigger next bot, etc.)
    await handlePostBid(io, game);
}

async function playCard(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    if (!game) return;

    const position = game.getPositionBySocketId(socket.id);

    // Validate stage, turn, trick state and card ownership. Plays are only
    // accepted in PLAYING: during TRICK_RESOLVING currentTurn has already
    // rotated to the leader while the trick is still on the table.
    if (game.stage !== Phase.PLAYING || position !== game.currentTurn) {
        rejectAction(socket, game, 'play', 'not_your_turn', { position, currentTurn: game.currentTurn });
        return;
    }
    const check = game.validateCardPlay(socket.id, data.card);
    if (!check.valid) {
        rejectAction(socket, game, 'play', 'invalid_play', { position, error: check.error });
        return;
    }
    if (game.playedCards[position - 1]) {
        rejectAction(socket, game, 'play', 'already_played', { position });
        return;
    }

    const card = data.card;
    const hand = game.getHand(socket.id);

    // Remove card from hand first (for validation)
    game.removeCardFromHand(socket.id, card);
    const remainingHand = game.getHand(socket.id);

    // Validate move
    const isLeading = game.playedCardsIndex === 0;
    if (isLeading) {
        if (!isLegalMove(card, remainingHand, card, true, game.trump, game.isTrumpBroken, position, position) &&
            !isTrumpTight([card, ...remainingHand], game.trump)) {
            gameLogger.warn('Player tried to lead illegal card', { position, card, gameId: game.gameId });
            // Re-add card to hand
            hand.push(card);
            rejectAction(socket, game, 'play', 'illegal_card', { position, card });
            return;
        }
        game.leadCard = card;
        game.leadPosition = position;
    } else {
        if (!isLegalMove(card, remainingHand, game.leadCard, false, game.trump, game.isTrumpBroken, position, game.leadPosition)) {
            gameLogger.warn('Player tried to play illegal card', { position, card, gameId: game.gameId });
            // Re-add card to hand
            remainingHand.push(card);
            rejectAction(socket, game, 'play', 'illegal_card', { position, card });
            return;
        }
    }

    // Record played card
    game.playedCards[position - 1] = card;
    game.playedCardsIndex++;
    game.cardIndex++;

    // Check if trump is broken
    if (card.suit === game.trump.suit || card.suit === 'joker') {
        game.isTrumpBroken = true;
    }

    game.broadcast(io, 'cardPlayed', {
        playerId: socket.id,
        card,
        position,
        trump: game.isTrumpBroken
    });

    // Notify bots about this card play
    botController.notifyCardPlayed(game.gameId, card, position, game.trump, game.leadPosition);

    // Advance turn
    game.currentTurn = rotatePosition(game.currentTurn);

    // Handle post-play logic (check for trick complete, trigger next bot, etc.)
    await handlePostPlay(io, game);
}

async function handleHandComplete(game, io) {
    if (game.stage !== Phase.HAND_RESOLVING) return;
    gameLogger.info('Hand complete', { gameId: game.gameId, handSize: game.currentHand });

    const team1OldScore = game.score.team1;
    const team2OldScore = game.score.team2;

    // Calculate team 1 score
    if (game.tricks.team1 >= game.bids.team1) {
        game.score.team1 += game.bids.team1 * 10 * game.team1Mult +
            (game.tricks.team1 - game.bids.team1) +
            game.rainbows.team1 * 10;
    } else {
        game.score.team1 -= game.bids.team1 * 10 * game.team1Mult;
        game.score.team1 += game.rainbows.team1 * 10;
    }

    // Calculate team 2 score
    if (game.tricks.team2 >= game.bids.team2) {
        game.score.team2 += game.bids.team2 * 10 * game.team2Mult +
            (game.tricks.team2 - game.bids.team2) +
            game.rainbows.team2 * 10;
    } else {
        game.score.team2 -= game.bids.team2 * 10 * game.team2Mult;
        game.score.team2 += game.rainbows.team2 * 10;
    }

    // Track hand stats for player profiles
    game.handStats.totalHands++;
    if (game.tricks.team1 < game.bids.team1) {
        game.handStats.team1Sets++;
        // Track the actual points lost to this set (for "drag" stat)
        const team1SetPoints = game.bids.team1 * 10 * game.team1Mult - game.rainbows.team1 * 10;
        game.handStats.team1SetPoints = (game.handStats.team1SetPoints || 0) + team1SetPoints;
    }
    if (game.tricks.team2 < game.bids.team2) {
        game.handStats.team2Sets++;
        // Track the actual points lost to this set (for "drag" stat)
        const team2SetPoints = game.bids.team2 * 10 * game.team2Mult - game.rainbows.team2 * 10;
        game.handStats.team2SetPoints = (game.handStats.team2SetPoints || 0) + team2SetPoints;
    }

    // Track set responsibility per player
    // A player is responsible for a set if their team was set AND they bid more than they took
    if (game.playerStats && game.handTricks) {
        const getBidValue = (bid) => {
            const bidStr = String(bid);
            return bidStr.includes('B') ? 0 : parseInt(bidStr, 10) || 0;
        };

        // Team 1 set check (positions 1 and 3)
        if (game.tricks.team1 < game.bids.team1) {
            const p1Bid = getBidValue(game.playerBids[0]); // Position 1
            const p3Bid = getBidValue(game.playerBids[2]); // Position 3
            const p1Tricks = game.handTricks[1] || 0;
            const p3Tricks = game.handTricks[3] || 0;

            if (p1Bid > p1Tricks && game.playerStats[1]) {
                game.playerStats[1].setsCaused++;
            }
            if (p3Bid > p3Tricks && game.playerStats[3]) {
                game.playerStats[3].setsCaused++;
            }
        }

        // Team 2 set check (positions 2 and 4)
        if (game.tricks.team2 < game.bids.team2) {
            const p2Bid = getBidValue(game.playerBids[1]); // Position 2
            const p4Bid = getBidValue(game.playerBids[3]); // Position 4
            const p2Tricks = game.handTricks[2] || 0;
            const p4Tricks = game.handTricks[4] || 0;

            if (p2Bid > p2Tricks && game.playerStats[2]) {
                game.playerStats[2].setsCaused++;
            }
            if (p4Bid > p4Tricks && game.playerStats[4]) {
                game.playerStats[4].setsCaused++;
            }
        }
    }

    gameLogger.debug('Score update', {
        team1: { score: game.score.team1, bids: [game.playerBids[0], game.playerBids[2]], tricks: game.tricks.team1 },
        team2: { score: game.score.team2, bids: [game.playerBids[1], game.playerBids[3]], tricks: game.tricks.team2 },
        gameId: game.gameId
    });

    // Add hand complete messages to game log
    const team1P1 = game.getPlayerByPosition(1);
    const team1P2 = game.getPlayerByPosition(3);
    const team2P1 = game.getPlayerByPosition(2);
    const team2P2 = game.getPlayerByPosition(4);
    const team1Name = `${team1P1.username}/${team1P2.username}`;
    const team2Name = `${team2P1.username}/${team2P2.username}`;
    const team1Change = game.score.team1 - team1OldScore;
    const team2Change = game.score.team2 - team2OldScore;
    const team1ChangeStr = team1Change >= 0 ? `+${team1Change}` : `${team1Change}`;
    const team2ChangeStr = team2Change >= 0 ? `+${team2Change}` : `${team2Change}`;

    game.addLogEntry('--- HAND COMPLETE ---', null, 'score');
    game.addLogEntry(`${team1Name}: Bid ${game.playerBids[0]}/${game.playerBids[2]}, Won ${game.tricks.team1}, ${team1ChangeStr} → ${game.score.team1}`, null, 'score');
    game.addLogEntry(`${team2Name}: Bid ${game.playerBids[1]}/${game.playerBids[3]}, Won ${game.tricks.team2}, ${team2ChangeStr} → ${game.score.team2}`, null, 'score');

    game.broadcast(io, 'handComplete', {
        score: game.score,
        team1Tricks: game.tricks.team1,
        team2Tricks: game.tricks.team2,
        team1OldScore,
        team2OldScore
    });

    // Bot personality hooks: update Zach's partner tracking, trigger chat reactions
    botController.updatePartnerHistory(game);
    botController.handleHandCompleteChat(io, game);

    // Determine next hand
    let nextDealer = rotatePosition(game.dealer);
    let nextHandSize;

    // Hand progression: 12→10→8→6→4→2→1→3→5→7→9→11→13→[end]
    if (game.currentHand === 2) {
        nextHandSize = 1;
    } else if (game.currentHand === 1) {
        // After 1-card hand, start going back up through odd numbers
        nextHandSize = 3;
    } else if (game.currentHand === 13) {
        // After 13-card hand, game is over
        nextHandSize = 0; // Signal game end
    } else if (game.currentHand % 2 === 0) {
        // Even hands (12,10,8,6,4): go down by 2
        nextHandSize = game.currentHand - 2;
    } else {
        // Odd hands (3,5,7,9,11): go up by 2
        nextHandSize = game.currentHand + 2;
    }

    if (nextHandSize === 0) {
        // Game over - add final score to log
        game.addLogEntry('=== GAME OVER ===', null, 'score');
        game.addLogEntry(`${team1Name}: ${game.score.team1}`, null, 'score');
        game.addLogEntry(`${team2Name}: ${game.score.team2}`, null, 'score');

        gameLogger.info('Game ended', { gameId: game.gameId, finalScore: game.score });

        // Build player stats with usernames for final score screen
        const playerStatsWithNames = {};
        const totalHands = game.handStats.totalHands;
        for (let pos = 1; pos <= 4; pos++) {
            const player = game.getPlayerByPosition(pos);
            playerStatsWithNames[pos] = {
                username: player?.username || `P${pos}`,
                ...game.playerStats[pos],
                avgHSI: totalHands > 0 ? Math.round(game.playerStats[pos].totalHSI / totalHands) : 0
            };
        }

        // Check for tournament context
        const tournamentId = gameManager.tournamentGames.get(game.gameId) || null;

        // gameEnd goes out first, then ENDED + epoch bump + timer
        // cancellation (synchronously). False: the game was aborted
        // meanwhile, so the tournament must not be resolved a second time.
        if (!game.terminate(io, Phase.ENDED, 'gameEnd', {
            score: game.score,
            playerStats: playerStatsWithNames,
            tournamentId
        })) return;

        // Retire: bots, room, every playerGames entry (players can create
        // new lobbies / return to the tournament right away)
        gameManager.endGame(game.gameId, io);

        // Persist stats in the background: a slow DB must not hold up the
        // end of the game for the players
        recordGameStats(game).catch(logContinuationError('recordGameStats', game));

        // Clear active game for all players
        try {
            await gameManager.clearActiveGameForAll(game.gameId, game);
        } catch (err) {
            logContinuationError('clearActiveGameForAll', game)(err);
        }

        // Tournament-specific: record scores and check round completion
        if (tournamentId) {
            const tournament = gameManager.getTournamentById(tournamentId);
            if (tournament) {
                // Record each human tournament player's team score
                for (let pos = 1; pos <= 4; pos++) {
                    const player = game.getOriginalPlayer(pos);
                    if (!player || !player.username) continue;

                    // Only record scores for players in the tournament (not filler bots)
                    const tournamentPlayer = tournament.getPlayerByUsername(player.username);
                    if (!tournamentPlayer) continue;

                    const isTeam1 = (pos === 1 || pos === 3);
                    const teamScore = isTeam1 ? game.score.team1 : game.score.team2;
                    const oppScore = isTeam1 ? game.score.team2 : game.score.team1;
                    const partnerPos = pos <= 2 ? pos + 2 : pos - 2;
                    const partner = game.getOriginalPlayer(partnerPos);

                    tournament.recordPlayerRoundScore(player.username, {
                        roundNumber: tournament.currentRound,
                        gameId: game.gameId,
                        position: pos,
                        teamScore,
                        oppScore,
                        partner: partner?.username || 'Bot'
                    });
                }

                // Handle tournament game end (mark complete, check round)
                const result = gameManager.handleTournamentGameEnd(game.gameId);

                // Broadcast game complete to tournament room
                tournament.broadcast(io, 'tournamentGameComplete', {
                    gameId: game.gameId,
                    score: game.score,
                    activeGames: tournament.getActiveGames(),
                    scoreboard: tournament.getScoreboard(),
                    currentRound: tournament.currentRound,
                    totalRounds: tournament.totalRounds
                });

                if (result && result.roundComplete) {
                    // Broadcasts tournamentRoundComplete, or tournamentComplete
                    // with the tournament kept alive briefly so players can
                    // return from the game-end screen and see final standings
                    const { broadcastRoundOutcome } = require('./tournamentHandlers');
                    await broadcastRoundOutcome(io, tournament);
                }
            }
        }

        // Notify main room that an in-progress game has ended
        emitLobbiesUpdated(io);
    } else {
        gameLogger.debug('Starting next hand', { dealer: nextDealer, handSize: nextHandSize, gameId: game.gameId });
        if (!game.transition(Phase.HAND_RESOLVING, Phase.DEALING)) return;
        await dealHand(game, io, { dealer: nextDealer, handSize: nextHandSize });
    }
}

/**
 * Resign the human at `position` and seat a fresh bot there (hand, player
 * entry and playerGames mapping move to the bot). Shared by forceResign and
 * draw-phase leavers. Broadcasting is left to the caller.
 * @returns {BotPlayer} the new bot
 */
function replaceSeatWithBot(game, position) {
    // Pick a random personality not already used by a bot in this game
    const usedPersonalities = botController.getGameBots(game.gameId).map(b => b.personality);
    const availablePersonalities = PERSONALITY_LIST.filter(p => !usedPersonalities.includes(p));
    const pool = availablePersonalities.length > 0 ? availablePersonalities : PERSONALITY_LIST;
    const personality = pool[Math.floor(Math.random() * pool.length)];
    const displayName = personalities.getDisplayName(personality);
    const botUsername = `🤖 ${displayName}`;

    // Create bot instance
    const bot = botController.createBot(botUsername, personality);

    // Assign random pic for bot
    const botPic = Math.floor(Math.random() * 82) + 1;
    bot.position = position;
    bot.pic = botPic;

    // Resign the player (transfers hand, replaces player entry)
    game.resignPlayer(position, bot.socketId, bot.username, botPic);

    // Register bot with controller
    botController.registerBot(game.gameId, bot);

    // Initialize bot card memory
    bot.resetCardMemory(game.currentHand, game.trump);

    // Update playerGames mapping: remove old socket (unless it has since
    // moved on to another game), add bot
    const oldSocketId = game.resignedPlayers[position]?.originalSocketId;
    if (oldSocketId && gameManager.playerGames.get(oldSocketId) === game.gameId) {
        gameManager.playerGames.delete(oldSocketId);
    }
    gameManager.playerGames.set(bot.socketId, game.gameId);

    // Clear disconnected status
    game.clearPlayerDisconnected(position);

    return bot;
}

/**
 * Force-resign a disconnected player, replacing them with a bot
 */
async function forceResign(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    if (!game) {
        socket.emit('error', { message: 'Not in a game' });
        return;
    }

    const { position } = data;

    // Validate: requesting player is in the same game
    const requestingPosition = game.getPositionBySocketId(socket.id);
    if (!requestingPosition) {
        socket.emit('error', { message: 'Not a player in this game' });
        return;
    }

    // Validate: target position is actually disconnected
    if (!game.isPlayerDisconnected(position)) {
        socket.emit('error', { message: 'Player is not disconnected' });
        return;
    }

    // Get the disconnected player's info before replacement
    const oldPlayer = game.getPlayerByPosition(position);
    const oldUsername = oldPlayer?.username || `Player ${position}`;

    const bot = replaceSeatWithBot(game, position);
    const botPic = bot.pic;

    // Cancel abort timer if no more disconnected players
    if (game.getDisconnectedPlayers().length === 0) {
        cancelAbortTimer(game.gameId);
    }

    // Broadcast playerResigned event
    game.broadcast(io, 'playerResigned', {
        position,
        oldUsername,
        botUsername: bot.username,
        botPic
    });

    // Add game log entry
    game.addLogEntry(`${oldUsername} has been resigned. ${bot.username} is taking over.`, null, 'system');
    game.broadcast(io, 'gameLogEntry', {
        message: `${oldUsername} has been resigned. ${bot.username} is taking over.`,
        type: 'system'
    });

    gameLogger.info('Player force-resigned', {
        gameId: game.gameId,
        position,
        oldUsername,
        botUsername: bot.username,
        requestedBy: requestingPosition
    });

    // If it's the resigned player's turn, trigger bot action
    // (not while a trick/hand resolves: the next updateTurn re-triggers it)
    const actionType = game.actionTypeForTurn();
    if (game.currentTurn === position && actionType) {
        triggerBotIfNeeded(io, game, actionType);
    }
}

module.exports = {
    draw,
    autoDraw,
    playerBid,
    playCard,
    handleDrawComplete,
    forceResign,
    triggerBotIfNeeded
};

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
    BID_RANKS
} = require('../game/rules');
const { delay } = require('../utils/timing');
const { gameLogger } = require('../utils/logger');
const { botController } = require('../game/bot');

/**
 * Check if the current turn is a bot and schedule their action
 * @param {Object} io - Socket.IO server
 * @param {Object} game - GameState
 * @param {string} actionType - 'bid' or 'play'
 */
function triggerBotIfNeeded(io, game, actionType) {
    const currentPlayer = game.getPlayerByPosition(game.currentTurn);
    if (!currentPlayer || !game.isBot(currentPlayer.socketId)) {
        return;
    }

    if (actionType === 'bid') {
        botController.scheduleBotAction(io, game, 'bid', (io, game, bot) => {
            botController.processBotBid(io, game, bot);
            // After bot bids, advance turn and check for more bots or end bidding
            game.currentTurn = rotatePosition(game.currentTurn);
            handlePostBid(io, game);
        });
    } else if (actionType === 'play') {
        botController.scheduleBotAction(io, game, 'play', (io, game, bot) => {
            botController.processBotPlay(io, game, bot);
            // After bot plays, advance turn and check for trick complete
            game.currentTurn = rotatePosition(game.currentTurn);
            handlePostPlay(io, game);
        });
    }
}

/**
 * Handle logic after a bid is made (check if all bids done, trigger next bot)
 */
async function handlePostBid(io, game) {
    // Check if all bids are in
    if (game.getBidCount() === 4) {
        game.bidding = false;

        // Calculate team bids
        const bids = game.playerBids;
        game.bids = {
            team1: (BID_RANKS[bids[0]] || 0) + (BID_RANKS[bids[2]] || 0),
            team2: (BID_RANKS[bids[1]] || 0) + (BID_RANKS[bids[3]] || 0)
        };

        // Cap bids at hand size and calculate multipliers
        if (game.bids.team1 > game.currentHand) {
            game.bids.team1 = game.currentHand;
            game.team1Mult = calculateMultiplier(bids[0], bids[2]);
        }
        if (game.bids.team2 > game.currentHand) {
            game.bids.team2 = game.currentHand;
            game.team2Mult = calculateMultiplier(bids[1], bids[3]);
        }

        gameLogger.debug('Bidding complete', { team1: game.bids.team1, team2: game.bids.team2, gameId: game.gameId });

        const lead = findHighestBidder(game.bidder, bids) + 1;

        game.broadcast(io, 'doneBidding', { bids, lead });

        // Check for zero bids (redeal)
        if (game.bids.team1 === 0 && game.bids.team2 === 0) {
            gameLogger.info('Zero bids, redealing', { gameId: game.gameId });
            game.broadcast(io, 'destroyHands', {});
            await cleanupNextHand(game, io, game.dealer, game.currentHand);
            return;
        }

        game.currentTurn = lead;
        game.leadPosition = lead;
    }

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });

    // Trigger next bot if needed
    if (game.bidding) {
        triggerBotIfNeeded(io, game, 'bid');
    } else {
        // Bidding done, start play phase - trigger bot if lead is a bot
        triggerBotIfNeeded(io, game, 'play');
    }
}

/**
 * Handle logic after a card is played (check for trick complete, trigger next bot)
 */
async function handlePostPlay(io, game) {
    // Check if trick is complete
    if (game.playedCardsIndex === 4) {
        await delay(2000);

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

        game.playedCards = [];
        game.playedCardsIndex = 0;

        // Check if hand is complete
        if (game.cardIndex === game.currentHand * 4) {
            await delay(4000);
            await handleHandComplete(game, io);
            return;
        }
    }

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });

    // Trigger next bot if needed
    triggerBotIfNeeded(io, game, 'play');
}

async function draw(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    if (!game || game.phase !== 'drawing') return;

    let order = data.num;
    if (order > game.deck.remaining - 1) {
        order = game.deck.remaining - 1;
    }

    // Draw card at specified position
    const card = game.deck.cards[order];
    game.drawCards.push(card);
    game.drawIDs.push(socket.id);
    game.deck.cards.splice(order, 1);

    gameLogger.debug('Player drew card', { socketId: socket.id, card: `${card.rank} of ${card.suit}` });

    // Get username for this player
    const user = gameManager.getUserBySocketId(socket.id);
    const username = user?.username || 'Player';

    // Tell the drawing player their card
    socket.emit('youDrew', { card, drawOrder: game.drawIndex + 1 });

    // Broadcast to all players that someone drew (so they can see it)
    game.broadcast(io, 'playerDrew', {
        username,
        card,
        drawOrder: game.drawIndex + 1,
        socketId: socket.id
    });

    game.drawIndex++;

    // Check if all players have drawn
    if (game.drawIndex === 4) {
        await handleDrawComplete(io, game);
    }
}

/**
 * Handle draw phase completion - assign positions and start game
 * Called when all 4 players (human or bot) have drawn
 */
async function handleDrawComplete(io, game) {
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
            // Extract bot name from socket ID (format: bot:name:uuid)
            const parts = playerId.split(':');
            username = parts[1] ? parts[1].charAt(0).toUpperCase() + parts[1].slice(1) : 'Bot';
        } else {
            const user = gameManager.getUserBySocketId(playerId);
            username = user?.username || 'Player';
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

        // Only emit to human players
        if (!isBot) {
            io.to(playerId).emit('playerAssigned', { playerId, position });
        }
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

    await delay(1000);

    game.broadcast(io, 'positionUpdate', {
        positions: orderedPositions,
        sockets: orderedSockets,
        usernames: orderedUsernames,
        pics: orderedPics
    });

    // Set active game for all players (enables cross-browser reconnection)
    for (const player of orderedUsernames) {
        await gameManager.setActiveGame(player.username, game.gameId);
    }

    // Announce teams (positions 1&3 vs 2&4)
    const team1Player1 = game.getPlayerByPosition(1);
    const team1Player2 = game.getPlayerByPosition(3);
    const team2Player1 = game.getPlayerByPosition(2);
    const team2Player2 = game.getPlayerByPosition(4);

    await delay(1000);

    game.broadcast(io, 'teamsAnnounced', {
        team1: [team1Player1?.username || 'Player 1', team1Player2?.username || 'Player 3'],
        team2: [team2Player1?.username || 'Player 2', team2Player2?.username || 'Player 4']
    });

    // Wait for team announcement to be seen (3 seconds)
    await delay(3000);

    // Reset draw state
    game.drawCards = [];
    game.drawIndex = 0;
    game.drawIDs = [];
    game.phase = 'bidding';

    // createUI must come BEFORE gameStart (client expects this order)
    game.broadcast(io, 'createUI', {});

    // Add game start message to log
    game.addLogEntry('Game started!', null, 'system');

    await delay(1000);

    // Start the actual game (emits gameStart to each player)
    await startHand(game, io);
}

async function startHand(game, io) {
    // Initialize deck
    const deck = new Deck();
    deck.shuffle();

    // Deal cards
    const socketIds = game.getSocketIds();
    for (const socketId of socketIds) {
        const hand = deck.draw(game.currentHand);
        game.setHand(socketId, hand);
    }

    // Set trump
    game.trump = deck.drawOne();

    // Calculate HSI for each player's hand and add to their stats
    for (const socketId of socketIds) {
        const hand = game.getHand(socketId);
        const position = game.getPositionBySocketId(socketId);
        const hsi = calculateHSI(hand, game.trump);
        game.addHSI(position, hsi);
    }

    // Check for rainbows (only on 4-card hands)
    if (game.currentHand === 4) {
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

    // Send game start to all players (each gets their own hand and position)
    for (const socketId of socketIds) {
        const playerPosition = game.getPositionBySocketId(socketId);
        game.sendToPlayer(io, socketId, 'gameStart', {
            gameId: game.gameId,
            players: socketIds,
            hand: game.getHand(socketId),
            trump: game.trump,
            score1: game.score.team1,
            score2: game.score.team2,
            dealer: game.dealer,
            position: playerPosition,  // Include player's position to avoid race condition
            currentHand: game.currentHand  // Hand index for hand indicator
        });
    }

    gameLogger.info('Game started', { gameId: game.gameId, handSize: game.currentHand, dealer: game.dealer });
    game.bidding = true;
    game.currentTurn = game.bidder;

    await delay(1000);

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });

    // Trigger bot if first bidder is a bot
    triggerBotIfNeeded(io, game, 'bid');
}

async function playerBid(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    if (!game) return;

    const position = game.getPositionBySocketId(socket.id);

    // Validate turn
    if (!game.bidding || position !== game.currentTurn) {
        gameLogger.warn('Player tried to bid out of turn', { position, currentTurn: game.currentTurn, gameId: game.gameId });
        return;
    }

    const bid = String(data.bid).toUpperCase();
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

    // Validate turn
    if (position !== game.currentTurn || game.bidding) {
        gameLogger.warn('Player tried to play out of turn', { socketId: socket.id, position, currentTurn: game.currentTurn });
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
            return;
        }
        game.leadCard = card;
        game.leadPosition = position;
    } else {
        if (!isLegalMove(card, remainingHand, game.leadCard, false, game.trump, game.isTrumpBroken, position, game.leadPosition)) {
            gameLogger.warn('Player tried to play illegal card', { position, card, gameId: game.gameId });
            // Re-add card to hand
            remainingHand.push(card);
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

    // Advance turn
    game.currentTurn = rotatePosition(game.currentTurn);

    // Handle post-play logic (check for trick complete, trigger next bot, etc.)
    await handlePostPlay(io, game);
}

async function handleHandComplete(game, io) {
    gameLogger.info('Hand complete', { gameId: game.gameId, handSize: game.currentHand });

    const team1OldScore = game.score.team1;
    const team2OldScore = game.score.team2;

    // Calculate team 1 score
    if (game.tricks.team1 >= game.bids.team1) {
        game.score.team1 += game.bids.team1 * 10 * game.team1Mult +
            (game.tricks.team1 - game.bids.team1) +
            game.rainbows.team1 * 10;
    } else {
        game.score.team1 -= game.bids.team1 * 10 * game.team1Mult -
            game.rainbows.team1 * 10;
    }

    // Calculate team 2 score
    if (game.tricks.team2 >= game.bids.team2) {
        game.score.team2 += game.bids.team2 * 10 * game.team2Mult +
            (game.tricks.team2 - game.bids.team2) +
            game.rainbows.team2 * 10;
    } else {
        game.score.team2 -= game.bids.team2 * 10 * game.team2Mult -
            game.rainbows.team2 * 10;
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

        // Record game stats for all players
        await recordGameStats(game);

        // Build player stats with usernames for final score screen
        const playerStatsWithNames = {};
        for (let pos = 1; pos <= 4; pos++) {
            const player = game.getPlayerByPosition(pos);
            playerStatsWithNames[pos] = {
                username: player?.username || `P${pos}`,
                ...game.playerStats[pos]
            };
        }

        game.broadcast(io, 'gameEnd', {
            score: game.score,
            playerStats: playerStatsWithNames
        });
        // Clear active game for all players
        await gameManager.clearActiveGameForAll(game.gameId);
        // Cleanup bots
        botController.cleanupGame(game.gameId);
        game.leaveAllFromRoom(io);
        // Clear playerGames Map entries so players can create new lobbies
        gameManager.endGame(game.gameId);
        game.resetForNewGame();
    } else {
        gameLogger.debug('Starting next hand', { dealer: nextDealer, handSize: nextHandSize, gameId: game.gameId });
        await cleanupNextHand(game, io, nextDealer, nextHandSize);
    }
}

async function cleanupNextHand(game, io, dealer, handSize) {
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

    // Calculate HSI for each player's hand and add to their stats
    for (const socketId of socketIds) {
        const hand = game.getHand(socketId);
        const position = game.getPositionBySocketId(socketId);
        const hsi = calculateHSI(hand, game.trump);
        game.addHSI(position, hsi);
    }

    // Check for rainbows (only on 4-card hands)
    if (game.currentHand === 4) {
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

    // Send new hand to all players (each gets their own hand and position)
    for (const socketId of socketIds) {
        const playerPosition = game.getPositionBySocketId(socketId);
        game.sendToPlayer(io, socketId, 'gameStart', {
            gameId: game.gameId,
            players: socketIds,
            hand: game.getHand(socketId),
            trump: game.trump,
            score1: game.score.team1,
            score2: game.score.team2,
            dealer: game.dealer,
            position: playerPosition,  // Include player's position to fix bid UI bug
            currentHand: game.currentHand  // Hand index for hand indicator
        });
    }

    game.currentTurn = game.bidder;
    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });

    // Trigger bot if first bidder is a bot
    triggerBotIfNeeded(io, game, 'bid');
}

module.exports = {
    draw,
    playerBid,
    playCard,
    handleDrawComplete
};

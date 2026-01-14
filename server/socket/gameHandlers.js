/**
 * Game play socket event handlers
 */

const gameManager = require('../game/GameManager');
const Deck = require('../game/Deck');
const {
    rotatePosition,
    isRainbow,
    isLegalMove,
    isTrumpTight,
    determineWinner,
    findHighestBidder,
    calculateMultiplier,
    determineDrawPosition,
    BID_RANKS
} = require('../game/rules');
const { delay } = require('../utils/timing');
const { gameLogger } = require('../utils/logger');

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

    // All players have drawn
    if (game.drawIndex === 4) {
        // Generate random profile pics
        const pics = [];
        for (let i = 0; i < 4; i++) {
            let picInt;
            do {
                picInt = Math.floor(Math.random() * 83) + 1;
            } while (pics.includes(picInt));
            pics.push(picInt);
        }

        // Assign positions based on cards drawn
        const positions = [];
        for (let i = 0; i < game.drawIDs.length; i++) {
            const playerId = game.drawIDs[i];
            const position = determineDrawPosition(game.drawCards[i], game.drawCards);
            positions.push(position);

            const user = gameManager.getUserBySocketId(playerId);
            game.addPlayer(playerId, user?.username || 'Player', position, pics[i]);

            io.to(playerId).emit('playerAssigned', { playerId, position });
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

        await delay(1000);

        // Start the actual game (emits gameStart to each player)
        await startHand(game, io);
    }
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

    // Check for rainbows (only on 4-card hands)
    if (game.currentHand === 4) {
        for (const socketId of socketIds) {
            const hand = game.getHand(socketId);
            if (isRainbow(hand, game.trump)) {
                const position = game.getPositionBySocketId(socketId);
                gameLogger.info('Rainbow hand detected', { socketId, position, gameId: game.gameId });
                game.broadcast(io, 'rainbow', { position });

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
            position: playerPosition  // Include player's position to avoid race condition
        });
    }

    gameLogger.info('Game started', { gameId: game.gameId, handSize: game.currentHand, dealer: game.dealer });
    game.bidding = true;
    game.currentTurn = game.bidder;

    await delay(1000);

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });
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

    gameLogger.debug('Bid received', { position, bid, gameId: game.gameId });
    game.broadcast(io, 'bidReceived', {
        bid: data.bid,
        position,
        bidArray: game.playerBids
    });

    // Advance turn
    game.currentTurn = rotatePosition(game.currentTurn);

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

    // Check if trick is complete
    if (game.playedCardsIndex === 4) {
        await delay(2000);

        const winner = determineWinner(game.playedCards, game.leadPosition, game.trump);

        if (winner === 1 || winner === 3) {
            game.tricks.team1++;
        } else {
            game.tricks.team2++;
        }

        gameLogger.debug('Trick complete', { winner, team1Tricks: game.tricks.team1, team2Tricks: game.tricks.team2, gameId: game.gameId });

        game.currentTurn = winner;

        game.broadcast(io, 'trickComplete', { winner });

        game.playedCards = [];
        game.playedCardsIndex = 0;

        // Check if hand is complete
        if (game.cardIndex === game.currentHand * 4) {
            await delay(4000);
            await handleHandComplete(game, io);
        }
    }

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });
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

    gameLogger.debug('Score update', {
        team1: { score: game.score.team1, bids: [game.playerBids[0], game.playerBids[2]], tricks: game.tricks.team1 },
        team2: { score: game.score.team2, bids: [game.playerBids[1], game.playerBids[3]], tricks: game.tricks.team2 },
        gameId: game.gameId
    });

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
        // Game over
        gameLogger.info('Game ended', { gameId: game.gameId, finalScore: game.score });
        game.broadcast(io, 'gameEnd', { score: game.score });
        // Clear active game for all players
        await gameManager.clearActiveGameForAll(game.gameId);
        game.leaveAllFromRoom(io);
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

    // Check for rainbows (only on 4-card hands)
    if (game.currentHand === 4) {
        for (const socketId of socketIds) {
            const hand = game.getHand(socketId);
            if (isRainbow(hand, game.trump)) {
                const position = game.getPositionBySocketId(socketId);
                gameLogger.info('Rainbow hand detected', { socketId, position, gameId: game.gameId });
                game.broadcast(io, 'rainbow', { position });

                if (position === 1 || position === 3) {
                    game.rainbows.team1 += 1;
                } else {
                    game.rainbows.team2 += 1;
                }
            }
        }
    }

    // Send new hand to all players (each gets their own hand)
    for (const socketId of socketIds) {
        game.sendToPlayer(io, socketId, 'gameStart', {
            gameId: game.gameId,
            players: socketIds,
            hand: game.getHand(socketId),
            trump: game.trump,
            score1: game.score.team1,
            score2: game.score.team2,
            dealer: game.dealer
        });
    }

    game.currentTurn = game.bidder;
    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });
}

module.exports = {
    draw,
    playerBid,
    playCard
};

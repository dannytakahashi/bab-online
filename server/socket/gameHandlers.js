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

    console.log(`socket ${socket.id} pulled the ${card.rank} of ${card.suit}`);
    socket.emit('youDrew', { card });

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
            console.log(`[DEBUG] getUserBySocketId(${playerId}) returned:`, user);
            console.log(`[DEBUG] currentUsers:`, gameManager.currentUsers);
            game.addPlayer(playerId, user?.username || 'Player', position, pics[i]);

            io.to(playerId).emit('playerAssigned', { playerId, position });
            console.log(`assigned player with socket ${playerId} to position ${position} with username ${user?.username || 'Player'}`);
        }

        // Reorder users for display
        const orderedUsers = [];
        for (let pos = 1; pos <= 4; pos++) {
            const player = game.getPlayerByPosition(pos);
            if (player) {
                orderedUsers.push({
                    username: player.username,
                    socketId: player.socketId
                });
            }
        }

        await delay(1000);

        game.broadcast(io, 'positionUpdate', {
            positions,
            sockets: game.drawIDs,
            usernames: orderedUsers,
            pics
        });

        await delay(2000);

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
                console.log(`player ${socketId} has a rainbow!`);
                game.broadcast(io, 'rainbow', { position });

                if (position === 1 || position === 3) {
                    game.rainbows.team1 += 1;
                } else {
                    game.rainbows.team2 += 1;
                }
            }
        }
    }

    // Send game start to all players (each gets their own hand)
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

    console.log('Game started');
    game.bidding = true;
    game.currentTurn = game.bidder;

    await delay(1000);

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });
    console.log('emitted update turn on game start');
}

async function playerBid(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    if (!game) return;

    const position = game.getPositionBySocketId(socket.id);

    // Validate turn
    if (!game.bidding || position !== game.currentTurn) {
        console.log(`❌ Player ${position} tried to bid out of turn!`);
        return;
    }

    const bid = String(data.bid).toUpperCase();
    game.recordBid(position, bid);

    console.log(`position ${position} bid ${bid}`);
    game.broadcast(io, 'bidReceived', {
        bid: data.bid,
        position,
        bidArray: game.playerBids
    });

    // Advance turn
    game.currentTurn = rotatePosition(game.currentTurn);

    console.log('bid array is', game.playerBids);

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

        console.log('team 1 bid:', game.bids.team1);
        console.log('team 2 bid:', game.bids.team2);

        const lead = findHighestBidder(game.bidder, bids) + 1;

        game.broadcast(io, 'doneBidding', { bids, lead });

        // Check for zero bids (redeal)
        if (game.bids.team1 === 0 && game.bids.team2 === 0) {
            console.log('zero bids, redeal!');
            game.broadcast(io, 'destroyHands', {});
            await cleanupNextHand(game, io, game.dealer, game.currentHand);
            return;
        }

        console.log(`position ${lead} leads`);
        game.currentTurn = lead;
        game.leadPosition = lead;
    }

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });
    console.log('emitted update turn after a bid');
}

async function playCard(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    if (!game) return;

    const position = game.getPositionBySocketId(socket.id);

    // Validate turn
    if (position !== game.currentTurn || game.bidding) {
        console.log(`❌ Player ${socket.id} tried to play out of turn!`);
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
            console.log(`❌ Player ${position} tried to lead an illegal card!`);
            // Re-add card to hand
            hand.push(card);
            return;
        }
        game.leadCard = card;
        game.leadPosition = position;
    } else {
        if (!isLegalMove(card, remainingHand, game.leadCard, false, game.trump, game.isTrumpBroken, position, game.leadPosition)) {
            console.log(`❌ Player ${position} tried to play an illegal card!`);
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
            console.log(`team 1 wins this trick via player ${winner}`);
        } else {
            game.tricks.team2++;
            console.log(`team 2 wins this trick via player ${winner}`);
        }

        game.currentTurn = winner;

        game.broadcast(io, 'trickComplete', { winner });
        console.log('fired trick complete');

        game.playedCards = [];
        game.playedCardsIndex = 0;

        // Check if hand is complete
        if (game.cardIndex === game.currentHand * 4) {
            await delay(4000);
            await handleHandComplete(game, io);
        }
    }

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });
    console.log('emitted update turn on a playCard');
}

async function handleHandComplete(game, io) {
    console.log('hand complete.');

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

    console.log(`team 1 score: ${game.score.team1}, bidding ${game.playerBids[0]} and ${game.playerBids[2]}, getting ${game.tricks.team1}`);
    console.log(`team 2 score: ${game.score.team2}, bidding ${game.playerBids[1]} and ${game.playerBids[3]}, getting ${game.tricks.team2}`);

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

    if (game.currentHand === 2) {
        nextHandSize = 1;
    } else if (game.currentHand === 1) {
        // Hand progression: after 1, go back up
        nextHandSize = 13; // Signal game end
    } else if (game.currentHand % 2 === 0) {
        nextHandSize = game.currentHand - 2;
    } else {
        nextHandSize = game.currentHand + 2;
    }

    if (nextHandSize === 13) {
        // Game over
        console.log('firing gameEnd');
        game.broadcast(io, 'gameEnd', { score: game.score });
        game.leaveAllFromRoom(io);
        game.resetForNewGame();
    } else {
        console.log(`starting next hand with dealer ${nextDealer} and hand ${nextHandSize}`);
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
                console.log(`player ${socketId} has a rainbow!`);
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

    console.log('hand started');
    game.currentTurn = game.bidder;

    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });
    console.log('emitted update turn on a cleanup/handstart');
}

module.exports = {
    draw,
    playerBid,
    playCard
};

/**
 * Pure strategy functions for bot decision making.
 * No side effects - all functions take inputs and return outputs.
 */

const {
    RANK_VALUES,
    BID_RANKS,
    getPartnerPosition,
    isVoidInSuit,
    isTrumpTight,
    isLegalMove,
    determineWinner
} = require('../rules');

/**
 * Evaluate hand strength for bidding
 * @param {Array} hand - Player's cards
 * @param {Object} trump - Trump card
 * @returns {Object} - { points, trumpCount, voids, suitCounts }
 */
function evaluateHand(hand, trump) {
    let points = 0;
    let trumpCount = 0;
    const suitCounts = { spades: 0, hearts: 0, diamonds: 0, clubs: 0 };

    for (const card of hand) {
        const effectiveSuit = card.suit === 'joker' ? trump.suit : card.suit;
        const isTrump = card.suit === trump.suit || card.suit === 'joker';

        // Count suits
        if (card.suit !== 'joker') {
            suitCounts[card.suit]++;
        }

        // Count trump
        if (isTrump) {
            trumpCount++;
        }

        // Point values for high cards
        if (card.rank === 'HI') {
            points += 2; // High joker almost always wins
        } else if (card.rank === 'LO') {
            points += 1.5; // Low joker usually wins
        } else if (card.rank === 'A') {
            if (isTrump) {
                points += 1.5; // Trump ace very strong
            } else {
                points += 0.75; // Off-suit ace good but not guaranteed
            }
        } else if (card.rank === 'K') {
            if (isTrump) {
                points += 1;
            } else {
                points += 0.4;
            }
        } else if (card.rank === 'Q') {
            if (isTrump) {
                points += 0.5;
            }
        }
    }

    // Trump length bonus
    if (trumpCount >= 6) {
        points += 2;
    } else if (trumpCount >= 5) {
        points += 1;
    }

    // Count voids (suits with 0 cards) - excluding trump
    let voids = 0;
    for (const [suit, count] of Object.entries(suitCounts)) {
        if (count === 0 && suit !== trump.suit) {
            voids++;
        }
    }

    // Void bonus (can trump in)
    points += voids * 0.5;

    return { points, trumpCount, voids, suitCounts };
}

/**
 * Calculate optimal bid based on hand evaluation
 * @param {Array} hand - Player's cards
 * @param {Object} trump - Trump card
 * @param {number} position - Player's position (1-4)
 * @param {Array} existingBids - Bids already made (may be incomplete)
 * @param {number} handSize - Number of cards in hand
 * @returns {string} - Bid value
 */
function calculateOptimalBid(hand, trump, position, existingBids, handSize) {
    const evaluation = evaluateHand(hand, trump);
    let bid = Math.round(evaluation.points);

    // Cap bid at hand size
    bid = Math.min(bid, handSize);

    // Get partner's bid if available (positions: 1&3 are partners, 2&4 are partners)
    const partnerPosition = getPartnerPosition(position);
    const partnerBidIndex = partnerPosition - 1;
    const partnerBid = existingBids[partnerBidIndex];

    // If partner already bid, coordinate
    if (partnerBid !== undefined && partnerBid !== null) {
        const partnerBidValue = BID_RANKS[partnerBid] || 0;
        const combinedBid = bid + partnerBidValue;

        // Don't overbid as a team
        if (combinedBid > handSize) {
            bid = Math.max(0, handSize - partnerBidValue);
        }
    }

    // Very small hands (1-2 cards) - be conservative
    if (handSize <= 2) {
        // Only bid if we have joker or trump ace
        const hasHighJoker = hand.some(c => c.rank === 'HI');
        const hasLowJoker = hand.some(c => c.rank === 'LO');
        const hasTrumpAce = hand.some(c => c.rank === 'A' && (c.suit === trump.suit || c.suit === 'joker'));

        if (hasHighJoker) {
            bid = Math.min(1, handSize);
        } else if (hasLowJoker || hasTrumpAce) {
            bid = Math.min(1, handSize);
        } else {
            bid = 0;
        }
    }

    // Consider bore bids for very strong hands on larger hand sizes
    // Only consider if we have very strong hand (8+ points with 6+ trump)
    if (handSize >= 10 && evaluation.points >= 8 && evaluation.trumpCount >= 6) {
        // Check if we can realistically take all tricks
        const hasHighJoker = hand.some(c => c.rank === 'HI');
        const hasLowJoker = hand.some(c => c.rank === 'LO');

        if (hasHighJoker && hasLowJoker && evaluation.trumpCount >= 7) {
            // Consider bore - but this is risky so only in very clear cases
            return 'B';
        }
    }

    // Ensure non-negative
    bid = Math.max(0, bid);

    return String(bid);
}

/**
 * Get all legal cards from hand
 * @param {Array} hand - Player's cards
 * @param {Object} leadCard - First card of trick (null if leading)
 * @param {boolean} isLeading - Whether player is leading
 * @param {Object} trump - Trump card
 * @param {boolean} trumpBroken - Whether trump has been broken
 * @param {number} position - Player's position
 * @param {number} leadPosition - Position that led
 * @returns {Array} - Array of legal cards
 */
function getLegalCards(hand, leadCard, isLeading, trump, trumpBroken, position, leadPosition) {
    return hand.filter(card => {
        const remainingHand = hand.filter(c => c !== card);
        return isLegalMove(card, remainingHand, leadCard || card, isLeading, trump, trumpBroken, position, leadPosition || position);
    });
}

/**
 * Check if a card can beat the current winning card
 * @param {Object} card - Card to check
 * @param {Object} winningCard - Current winning card
 * @param {Object} leadCard - Lead card of trick
 * @param {Object} trump - Trump card
 * @returns {boolean}
 */
function canBeatCard(card, winningCard, leadCard, trump) {
    const cardSuit = card.suit === 'joker' ? trump.suit : card.suit;
    const winningSuit = winningCard.suit === 'joker' ? trump.suit : winningCard.suit;
    const leadSuit = leadCard.suit === 'joker' ? trump.suit : leadCard.suit;

    const cardIsTrump = card.suit === trump.suit || card.suit === 'joker';
    const winningIsTrump = winningCard.suit === trump.suit || winningCard.suit === 'joker';

    // Trump beats non-trump
    if (cardIsTrump && !winningIsTrump) {
        return true;
    }

    // Both trump: compare ranks
    if (cardIsTrump && winningIsTrump) {
        return RANK_VALUES[card.rank] > RANK_VALUES[winningCard.rank];
    }

    // Same suit as lead: compare ranks
    if (cardSuit === leadSuit && winningSuit === leadSuit) {
        return RANK_VALUES[card.rank] > RANK_VALUES[winningCard.rank];
    }

    // Off-suit non-trump can't beat anything
    return false;
}

/**
 * Find the current winning card and position in a partial trick
 * @param {Array} playedCards - Cards played so far (sparse array, indexed by position-1)
 * @param {number} leadPosition - Position that led
 * @param {Object} trump - Trump card
 * @returns {Object} - { card, position }
 */
function getCurrentWinner(playedCards, leadPosition, trump) {
    let winnerPosition = leadPosition;
    let winnerCard = playedCards[leadPosition - 1];

    for (let i = 0; i < 4; i++) {
        if (playedCards[i] && i !== leadPosition - 1) {
            const checkPosition = i + 1;
            if (canBeatCard(playedCards[i], winnerCard, playedCards[leadPosition - 1], trump)) {
                winnerCard = playedCards[i];
                winnerPosition = checkPosition;
            }
        }
    }

    return { card: winnerCard, position: winnerPosition };
}

/**
 * Select optimal card when leading
 * @param {Array} hand - Player's cards
 * @param {Object} trump - Trump card
 * @param {boolean} trumpBroken - Whether trump has been broken
 * @param {Object} gameState - Game state info
 * @returns {Object} - Card to play
 */
function selectLead(hand, trump, trumpBroken, gameState) {
    const legalCards = getLegalCards(hand, null, true, trump, trumpBroken, gameState.position, gameState.position);

    if (legalCards.length === 1) {
        return legalCards[0];
    }

    // Lead high joker when we have it - draws out opponent trump
    const highJoker = legalCards.find(c => c.rank === 'HI');
    if (highJoker) {
        return highJoker;
    }

    // Group cards by suit
    const bySuit = { spades: [], hearts: [], diamonds: [], clubs: [], joker: [] };
    for (const card of legalCards) {
        bySuit[card.suit].push(card);
    }

    // Prefer leading from longest off-suit with an ace
    let bestSuit = null;
    let bestLength = 0;

    for (const [suit, cards] of Object.entries(bySuit)) {
        if (suit === trump.suit || suit === 'joker') continue;
        if (cards.length > bestLength) {
            bestLength = cards.length;
            bestSuit = suit;
        }
    }

    if (bestSuit && bySuit[bestSuit].length > 0) {
        // Sort by rank descending and lead highest
        const sorted = bySuit[bestSuit].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);
        // Lead ace if we have it, otherwise lead low
        const ace = sorted.find(c => c.rank === 'A');
        if (ace) {
            return ace;
        }
        // Lead low from the suit
        return sorted[sorted.length - 1];
    }

    // If we only have trump, lead low trump
    const trumpCards = legalCards.filter(c => c.suit === trump.suit || c.suit === 'joker');
    if (trumpCards.length > 0) {
        return trumpCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
    }

    // Fallback: play lowest card
    return legalCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
}

/**
 * Select optimal card when following
 * @param {Array} hand - Player's cards
 * @param {Array} playedCards - Cards already played in trick
 * @param {Object} leadCard - First card of trick
 * @param {number} leadPosition - Position that led
 * @param {Object} trump - Trump card
 * @param {boolean} trumpBroken - Whether trump has been broken
 * @param {number} position - Bot's position
 * @returns {Object} - Card to play
 */
function selectFollow(hand, playedCards, leadCard, leadPosition, trump, trumpBroken, position) {
    const legalCards = getLegalCards(hand, leadCard, false, trump, trumpBroken, position, leadPosition);

    if (legalCards.length === 1) {
        return legalCards[0];
    }

    const partnerPosition = getPartnerPosition(position);
    const { card: winningCard, position: winnerPosition } = getCurrentWinner(playedCards, leadPosition, trump);
    const partnerIsWinning = winnerPosition === partnerPosition;
    const partnerHasPlayed = playedCards[partnerPosition - 1] !== undefined;

    // Determine lead suit
    const leadSuit = leadCard.suit === 'joker' ? trump.suit : leadCard.suit;

    // Check if we can follow suit
    const followCards = legalCards.filter(c => {
        const suit = c.suit === 'joker' ? trump.suit : c.suit;
        return suit === leadSuit;
    });

    const canFollow = followCards.length > 0;

    if (canFollow) {
        // We can follow suit
        if (partnerIsWinning && partnerHasPlayed) {
            // Partner is winning - play lowest
            return followCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
        }

        // Try to win with minimum card
        const winners = followCards.filter(c => canBeatCard(c, winningCard, leadCard, trump));
        if (winners.length > 0) {
            // Play lowest winning card
            return winners.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
        }

        // Can't win - play lowest
        return followCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
    }

    // We're void in lead suit
    const trumpCards = legalCards.filter(c => c.suit === trump.suit || c.suit === 'joker');
    const nonTrumpCards = legalCards.filter(c => c.suit !== trump.suit && c.suit !== 'joker');

    if (partnerIsWinning && partnerHasPlayed) {
        // Partner winning - don't trump, just discard
        if (nonTrumpCards.length > 0) {
            return selectDiscard(nonTrumpCards, trump);
        }
        // Only have trump - play lowest
        return trumpCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
    }

    // Opponent winning - try to trump
    if (trumpCards.length > 0) {
        const winningIsTrump = winningCard.suit === trump.suit || winningCard.suit === 'joker';

        if (winningIsTrump) {
            // Need to overtrump
            const overtrumps = trumpCards.filter(c => RANK_VALUES[c.rank] > RANK_VALUES[winningCard.rank]);
            if (overtrumps.length > 0) {
                return overtrumps.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
            }
            // Can't overtrump - discard
            if (nonTrumpCards.length > 0) {
                return selectDiscard(nonTrumpCards, trump);
            }
            return trumpCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
        }

        // Trump in with lowest trump
        return trumpCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
    }

    // No trump available - discard
    return selectDiscard(legalCards, trump);
}

/**
 * Select a card to discard (when we can't win)
 * @param {Array} cards - Available cards to discard
 * @param {Object} trump - Trump card
 * @returns {Object} - Card to discard
 */
function selectDiscard(cards, trump) {
    // Prefer discarding from short suits (not trump)
    const nonTrump = cards.filter(c => c.suit !== trump.suit && c.suit !== 'joker');

    if (nonTrump.length > 0) {
        // Group by suit and find shortest
        const bySuit = {};
        for (const card of nonTrump) {
            if (!bySuit[card.suit]) bySuit[card.suit] = [];
            bySuit[card.suit].push(card);
        }

        // Find shortest suit
        let shortestSuit = null;
        let shortestLength = Infinity;
        for (const [suit, suitCards] of Object.entries(bySuit)) {
            if (suitCards.length < shortestLength) {
                shortestLength = suitCards.length;
                shortestSuit = suit;
            }
        }

        if (shortestSuit) {
            // Discard lowest from shortest suit
            return bySuit[shortestSuit].sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
        }
    }

    // Fallback: discard lowest card
    return cards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
}

/**
 * Select optimal card to play
 * @param {Array} hand - Player's cards
 * @param {Array} playedCards - Cards already played in trick (sparse array)
 * @param {Object|null} leadCard - First card of trick
 * @param {number|null} leadPosition - Position that led
 * @param {Object} trump - Trump card
 * @param {boolean} trumpBroken - Whether trump has been broken
 * @param {number} position - Bot's position
 * @returns {Object} - Card to play
 */
function selectOptimalCard(hand, playedCards, leadCard, leadPosition, trump, trumpBroken, position) {
    const isLeading = !leadCard || playedCards.every(c => c === undefined || c === null);

    if (isLeading) {
        return selectLead(hand, trump, trumpBroken, { position });
    }

    return selectFollow(hand, playedCards, leadCard, leadPosition, trump, trumpBroken, position);
}

module.exports = {
    evaluateHand,
    calculateOptimalBid,
    getLegalCards,
    canBeatCard,
    getCurrentWinner,
    selectLead,
    selectFollow,
    selectDiscard,
    selectOptimalCard
};

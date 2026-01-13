/**
 * Pure game rule functions for BAB card game
 * These functions have no side effects and don't depend on global state
 */

const RANK_VALUES = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
    '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
    'LO': 15, 'HI': 16
};

const BID_RANKS = {
    '4B': 16, '3B': 15, '2B': 14, 'B': 13,
    '12': 12, '11': 11, '10': 10, '9': 9, '8': 8,
    '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2, '1': 1, '0': 0
};

/**
 * Rotate position (1→2→3→4→1)
 * @param {number} position - Current position (1-4)
 * @returns {number} - Next position
 */
function rotatePosition(position) {
    return (position % 4) + 1;
}

/**
 * Get teammate position
 * @param {number} position - Player position (1-4)
 * @returns {number} - Partner position
 */
function getPartnerPosition(position) {
    // Position 1's partner is 3, position 2's partner is 4, etc.
    return ((position + 1) % 4) + 1;
}

/**
 * Check if two cards are same suit (considering jokers as trump)
 * @param {Object} card1 - First card
 * @param {Object} card2 - Second card
 * @param {Object} trump - Trump card
 * @returns {boolean}
 */
function isSameSuit(card1, card2, trump) {
    const suit1 = card1.suit === 'joker' ? trump.suit : card1.suit;
    const suit2 = card2.suit === 'joker' ? trump.suit : card2.suit;
    return suit1 === suit2;
}

/**
 * Check if hand is void in a suit
 * @param {Array} hand - Player's hand
 * @param {string} suit - Suit to check
 * @param {Object} trump - Trump card
 * @returns {boolean}
 */
function isVoidInSuit(hand, suit, trump) {
    return !hand.some(card => {
        const cardSuit = card.suit === 'joker' ? trump.suit : card.suit;
        return cardSuit === suit;
    });
}

/**
 * Check if hand is a rainbow (has all 4 suits)
 * @param {Array} hand - Player's hand
 * @param {Object} trump - Trump card
 * @returns {boolean}
 */
function isRainbow(hand, trump) {
    const suits = {
        spades: false,
        hearts: false,
        diamonds: false,
        clubs: false
    };

    for (const card of hand) {
        if (card.suit === 'joker') {
            suits[trump.suit] = true;
        } else {
            suits[card.suit] = true;
        }
    }

    return suits.spades && suits.hearts && suits.diamonds && suits.clubs;
}

/**
 * Check if hand only has trump cards
 * @param {Array} hand - Player's hand
 * @param {Object} trump - Trump card
 * @returns {boolean}
 */
function isTrumpTight(hand, trump) {
    return hand.every(card =>
        card.suit === trump.suit || card.suit === 'joker'
    );
}

/**
 * Check if card is the highest trump in hand
 * @param {string} rank - Card rank to check
 * @param {Array} hand - Player's hand
 * @param {Object} trump - Trump card
 * @returns {boolean}
 */
function isHighestTrumpInHand(rank, hand, trump) {
    for (const card of hand) {
        if ((card.suit === trump.suit || card.suit === 'joker') &&
            RANK_VALUES[card.rank] > RANK_VALUES[rank]) {
            return false;
        }
    }
    return true;
}

/**
 * Check if a move is legal
 * @param {Object} card - Card being played
 * @param {Array} hand - Player's hand (after card removed)
 * @param {Object} leadCard - First card of trick
 * @param {boolean} isLeading - Whether this player is leading
 * @param {Object} trump - Trump card
 * @param {boolean} trumpBroken - Whether trump has been played
 * @param {number} playPosition - Position of player
 * @param {number} leadPosition - Position that led
 * @returns {boolean}
 */
function isLegalMove(card, hand, leadCard, isLeading, trump, trumpBroken, playPosition, leadPosition) {
    // Leading
    if (isLeading) {
        // Can't lead trump unless broken (or only have trump)
        if ((card.suit === trump.suit || card.suit === 'joker') && !trumpBroken) {
            return isTrumpTight([card, ...hand], trump);
        }
        return true;
    }

    // Following
    const leadSuit = leadCard.suit === 'joker' ? trump.suit : leadCard.suit;
    const cardSuit = card.suit === 'joker' ? trump.suit : card.suit;

    // Must follow suit if possible
    if (cardSuit !== leadSuit && !isVoidInSuit([card, ...hand], leadSuit, trump)) {
        return false;
    }

    // Special rule: HI joker lead requires highest trump (from opponents)
    if (leadCard.rank === 'HI' && (playPosition % 2 !== leadPosition % 2)) {
        if (!isHighestTrumpInHand(card.rank, [card, ...hand], trump)) {
            return false;
        }
    }

    return true;
}

/**
 * Determine winner of a trick
 * @param {Array} trick - Array of 4 cards (indexed by position-1)
 * @param {number} leadPosition - Position that led (1-4)
 * @param {Object} trump - Trump card
 * @returns {number} - Winning position (1-4)
 */
function determineWinner(trick, leadPosition, trump) {
    let winner = leadPosition;
    const leadCard = trick[leadPosition - 1];
    const leadSuit = leadCard.suit === 'joker' ? trump.suit : leadCard.suit;

    for (let i = 1; i < 4; i++) {
        let checkPos = leadPosition + i;
        if (checkPos > 4) checkPos -= 4;

        const currentCard = trick[checkPos - 1];
        const winningCard = trick[winner - 1];

        const currentSuit = currentCard.suit === 'joker' ? trump.suit : currentCard.suit;
        const winningSuit = winningCard.suit === 'joker' ? trump.suit : winningCard.suit;

        const currentIsTrump = currentCard.suit === trump.suit || currentCard.suit === 'joker';
        const winningIsTrump = winningCard.suit === trump.suit || winningCard.suit === 'joker';

        // Trump beats non-trump
        if (currentIsTrump && !winningIsTrump) {
            winner = checkPos;
        }
        // Both trump: higher wins
        else if (currentIsTrump && winningIsTrump) {
            if (RANK_VALUES[currentCard.rank] > RANK_VALUES[winningCard.rank]) {
                winner = checkPos;
            }
        }
        // Same suit as lead: higher wins
        else if (currentSuit === leadSuit && winningSuit === leadSuit) {
            if (RANK_VALUES[currentCard.rank] > RANK_VALUES[winningCard.rank]) {
                winner = checkPos;
            }
        }
    }

    return winner;
}

/**
 * Calculate score for a team
 * @param {number} bid - Team's bid
 * @param {number} tricks - Tricks won
 * @param {number} multiplier - Bid multiplier (1, 2, 4, 8, or 16)
 * @param {number} rainbows - Number of rainbow hands
 * @returns {number} - Points scored
 */
function calculateScore(bid, tricks, multiplier, rainbows) {
    const rainbowBonus = rainbows * 10;

    if (tricks >= bid) {
        // Made bid: (bid × 10 × multiplier) + overtricks + rainbow bonus
        return (bid * 10 * multiplier) + (tricks - bid) + rainbowBonus;
    } else {
        // Missed bid: -(bid × 10 × multiplier) + rainbow bonus
        return -(bid * 10 * multiplier) + rainbowBonus;
    }
}

/**
 * Find the index of the highest bidder starting from a position
 * @param {number} startPosition - Position to start checking from (1-4)
 * @param {Array} bids - Array of bid strings
 * @returns {number} - Index (0-3) of highest bidder
 */
function findHighestBidder(startPosition, bids) {
    let maxIndex = startPosition - 1;
    let maxValue = BID_RANKS[bids[maxIndex]] || 0;
    let spot = startPosition - 1;

    for (let i = 0; i < 4; i++) {
        const bidValue = BID_RANKS[bids[spot]] || 0;
        if (bidValue > maxValue) {
            maxIndex = spot;
            maxValue = bidValue;
        }
        spot = (spot + 1) % 4;
    }

    return maxIndex;
}

/**
 * Calculate bid multiplier based on board bids
 * @param {string} bid1 - First player's bid
 * @param {string} bid2 - Second player's bid (teammate)
 * @returns {number} - Multiplier (1, 2, 4, 8, or 16)
 */
function calculateMultiplier(bid1, bid2) {
    const bids = [bid1, bid2];

    if (bids.includes('4B')) return 16;
    if (bids.includes('3B')) return 8;
    if (bids.includes('2B')) return 4;
    if (bids.includes('B')) return 2;
    return 1;
}

/**
 * Determine draw order position based on card drawn
 * @param {Object} myCard - Card drawn by player
 * @param {Array} allCards - All cards drawn
 * @returns {number} - Position (1-4)
 */
function determineDrawPosition(myCard, allCards) {
    const suitOrder = { clubs: 0, diamonds: 1, hearts: 2, spades: 3, joker: 4 };
    let rank = 0;

    for (const card of allCards) {
        if (RANK_VALUES[myCard.rank] > RANK_VALUES[card.rank]) {
            rank++;
        } else if (RANK_VALUES[myCard.rank] === RANK_VALUES[card.rank] &&
                   suitOrder[myCard.suit] > suitOrder[card.suit]) {
            rank++;
        }
    }

    // Handle position 2/3 swap
    const position = 4 - rank;
    if (position === 2) return 3;
    if (position === 3) return 2;
    return position;
}

module.exports = {
    RANK_VALUES,
    BID_RANKS,
    rotatePosition,
    getPartnerPosition,
    isSameSuit,
    isVoidInSuit,
    isRainbow,
    isTrumpTight,
    isHighestTrumpInHand,
    isLegalMove,
    determineWinner,
    calculateScore,
    findHighestBidder,
    calculateMultiplier,
    determineDrawPosition
};

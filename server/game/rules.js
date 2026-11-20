/**
 * Pure game rule functions for BAB card game
 * These functions have no side effects and don't depend on global state
 */

const RANK_VALUES = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
    '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
    'LO': 15, 'HI': 16
};

// Tricks a bid counts for in the team total (bores count as 13 and are
// capped at the hand size). '13' is a plain 1x bid, legal only on the
// 13-card hand (isValidBid); it ties 'B' here, so findHighestBidder ranks
// bores above every number for the lead.
const BID_RANKS = {
    '4B': 16, '3B': 15, '2B': 14, 'B': 13,
    '13': 13, '12': 12, '11': 11, '10': 10, '9': 9, '8': 8,
    '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2, '1': 1, '0': 0
};

const BORE_BIDS = ['B', '2B', '3B', '4B'];
/** Largest hand (the last deal); numeric bids run 0..MAX_HAND_SIZE. */
const MAX_HAND_SIZE = 13;
/**
 * The deal sizes of a game in order (docs/RULES.md): down by twos to 2, then
 * 1, then up the odd sizes to 13. The one server copy (the web keeps its own
 * in client/src/constants/ranks.js, iOS in CardConstants.swift;
 * handProgression.test.js holds both to this).
 */
const HAND_PROGRESSION = Object.freeze([12, 10, 8, 6, 4, 2, 1, 3, 5, 7, 9, 11, 13]);

/** The hand size dealt after `handSize`; 0 after the last hand (game over) or for a size no deal has. */
function nextHandSize(handSize) {
    const i = HAND_PROGRESSION.indexOf(handSize);
    return i === -1 || i === HAND_PROGRESSION.length - 1 ? 0 : HAND_PROGRESSION[i + 1];
}

/** Every bid value any hand can accept ('0'..'13', then the bores). */
const BID_VALUES = [...Array.from({ length: MAX_HAND_SIZE + 1 }, (_, i) => String(i)), ...BORE_BIDS];

/** Lead order: the BID_RANKS value, with every bore above the numeric 13. */
function bidLeadRank(bid) {
    return (BID_RANKS[bid] || 0) + (BORE_BIDS.includes(bid) ? 1 : 0);
}

/**
 * Rotate to next player position (clockwise)
 * Seating: Position 1 (bottom), 2 (left), 3 (top), 4 (right)
 * Clockwise order: 1 → 2 → 3 → 4 → 1
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
 * Is playing `card` out of `hand` (the hand BEFORE the card leaves it) legal?
 * The one legality check for a play: GameState.checkPlay (human and bot
 * plays) and the sim both use it. `card` must be in `hand`.
 * @param {Object} card
 * @param {Array} hand
 * @param {{leadCard: Object|null, isLeading: boolean, trump: Object,
 *   trumpBroken: boolean, position: number, leadPosition: number|null}} trick
 * @returns {boolean}
 */
function isLegalPlay(card, hand, { leadCard, isLeading, trump, trumpBroken, position, leadPosition }) {
    const i = hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
    if (i === -1) return false;
    const remaining = hand.slice(0, i).concat(hand.slice(i + 1));
    return isLeading
        ? isLegalMove(card, remaining, card, true, trump, trumpBroken, position, position)
        : isLegalMove(card, remaining, leadCard, false, trump, trumpBroken, position, leadPosition);
}

/**
 * The first legal card of `hand` in hand order (deterministic), or null for
 * an empty hand. The fallback when a bot's chosen card is refused.
 */
function firstLegalCard(hand, trick) {
    return hand.find(c => isLegalPlay(c, hand, trick)) || null;
}

/**
 * The bid a bot falls back to when its own is refused or its strategy
 * throws: the minimum legal bid, '0' (legal on every hand), except '1' for
 * the last bidder over three zeros, whose 0 would redeal the hand (a table
 * of failing bots would otherwise redeal forever).
 * @param {Array} playerBids - the deal's bids so far, by position - 1
 */
function safeBid(playerBids) {
    const others = playerBids.filter(b => b != null);
    return others.length === 3 && others.every(b => String(b) === '0') ? '1' : '0';
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
 * A player's own bid as the tricks a set blames them for: a bore counts as
 * 0 (its team total is the hand, game.bids.teamN), else its number.
 * @param {string|number|null|undefined} bid
 * @returns {number}
 */
function personalBidValue(bid) {
    const s = String(bid ?? '');
    return s.includes('B') ? 0 : parseInt(s, 10) || 0;
}

/** Team seats in the order the hand's log lines name them (team1, then team2). */
const FAULT_TEAM_SEATS = Object.freeze([['team1', [1, 3]], ['team2', [2, 4]]]);

/**
 * The hand's faults (owner 2026-11-19; the one source of the setsCaused
 * stat and the "Fault: <name> (bid N, took M)" log lines): for each team
 * that was SET (took fewer tricks than its combined bid, teamBids.teamN:
 * a bore is the whole hand, capped at it), every player on it who took
 * fewer tricks than they personally bid (personalBidValue: a bore is 0).
 * A team that made its bid has none. Seats 1, 3, then 2, 4.
 *
 * @param {Object} hand
 * @param {{team1: number, team2: number}} hand.teamBids - game.bids at hand end
 * @param {{team1: number, team2: number}} hand.teamTricks - game.tricks
 * @param {Array} hand.playerBids - game.playerBids (index = position - 1)
 * @param {Object} hand.handTricks - game.handTricks ({1..4: tricks won this hand})
 * @returns {{position: number, bid: number, took: number}[]}
 */
function handFaults({ teamBids, teamTricks, playerBids, handTricks } = {}) {
    if (!teamBids || !teamTricks || !Array.isArray(playerBids) || !handTricks) return [];
    const out = [];
    for (const [team, seats] of FAULT_TEAM_SEATS) {
        if (!(teamTricks[team] < teamBids[team])) continue; // made (or unknown)
        for (const position of seats) {
            const bid = personalBidValue(playerBids[position - 1]);
            const took = handTricks[position] || 0;
            if (bid > took) out.push({ position, bid, took });
        }
    }
    return out;
}

/**
 * One seat's bags in a hand (superlatives, owner 2026-11-20): the tricks it
 * took over its own bid, never below 0. A bore bid counts as bidding every
 * trick of the hand (as GameState.recordBid totals it), so a bore never
 * bags; nor does its partner: the team's contract was the whole hand (its
 * team total is capped at it), so no trick of that team was over its bid,
 * the same as the team's bags in the record (team1Bags / team2Bags).
 * @param {string|number} bid - the seat's bid ('0'..'13', 'B', '2B', ...)
 * @param {number} took - tricks the seat won this hand
 * @param {string|number} [partnerBid] - the partner's bid this hand
 * @returns {number}
 */
function seatBags(bid, took, partnerBid) {
    const s = String(bid ?? '');
    if (s.includes('B') || String(partnerBid ?? '').includes('B')) return 0;
    return Math.max(0, (Number(took) || 0) - (parseInt(s, 10) || 0));
}

/**
 * The game's bag counter (game.seatBags, superlatives' Bag Boy):
 * `{hands, byPos: {1..4: n}}`, `hands` the hands it counted (each counted
 * hand adds rules.seatBags to every seat and 1 to hands, together). A copy
 * of a well-formed one (non-negative safe integers, all four seats), else
 * null: no counter (a game saved by a process without it), so its record
 * falls back to the net per seat.
 * @param {*} v
 * @returns {{hands: number, byPos: Object}|null}
 */
function normalizeSeatBags(v) {
    const count = (n) => Number.isSafeInteger(n) && n >= 0;
    if (!v || typeof v !== 'object' || !count(v.hands) || !v.byPos || typeof v.byPos !== 'object') return null;
    const byPos = {};
    for (const pos of [1, 2, 3, 4]) {
        if (!count(v.byPos[pos])) return null;
        byPos[pos] = v.byPos[pos];
    }
    return { hands: v.hands, byPos };
}

/**
 * Find the index of the highest bidder starting from a position
 * @param {number} startPosition - Position to start checking from (1-4)
 * @param {Array} bids - Array of bid strings
 * @returns {number} - Index (0-3) of highest bidder
 */
function findHighestBidder(startPosition, bids) {
    let maxIndex = startPosition - 1;
    let maxValue = bidLeadRank(bids[maxIndex]);
    let spot = startPosition - 1;

    for (let i = 0; i < 4; i++) {
        const bidValue = bidLeadRank(bids[spot]);
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
/**
 * Server-side bid legality. Numeric bids must fit the hand; a bore above 'B'
 * requires the level directly below it to already be on the table (2B needs
 * a B, 3B a 2B, 4B a 3B) — levels can't be skipped.
 * @param {string} bid - Uppercased bid string
 * @param {Array} playerBids - Bids so far, indexed by position-1
 * @param {number} handSize - Cards in this hand
 * @returns {boolean}
 */
function isValidBid(bid, playerBids, handSize) {
    if (/^\d+$/.test(bid)) return Number(bid) <= handSize;
    const prerequisite = { B: null, '2B': 'B', '3B': '2B', '4B': '3B' };
    if (!(bid in prerequisite)) return false;
    // Each bore level once per deal (owner 2026-11-11: "refuse repeats"; both
    // clients already hide or grey a level that is on the table, and bots
    // only ever bid the next level up). With the prerequisite chain this
    // also refuses B once any bore is out.
    if (playerBids.includes(bid)) return false;
    return prerequisite[bid] === null || playerBids.includes(prerequisite[bid]);
}

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

/**
 * Card value mapping for HSI calculation
 * Non-trump: 2=0, 3=1, 4=2, ..., A=12
 * Trump: 2=14, 3=15, 4=16, ..., A=26
 * Jokers: LO=27, HI=28
 */
const HSI_RANK_VALUES = {
    '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6,
    '9': 7, '10': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12
};
const HSI_TRUMP_OFFSET = 14; // Add to non-trump value to get trump value
const HSI_JOKER_VALUES = { 'LO': 27, 'HI': 28 };
const HSI_VOID_MULTIPLIER = 1.25;

/**
 * Calculate Hand Strength Index (HSI) for a hand
 * @param {Array} hand - Player's hand (array of card objects)
 * @param {Object} trump - Trump card
 * @returns {number} - HSI value normalized to 13 cards
 */
function calculateHSI(hand, trump) {
    if (!hand || hand.length === 0) return 0;

    const trumpSuit = trump.suit;
    const handSize = hand.length;
    let totalValue = 0;

    // Track which non-trump suits are present
    const nonTrumpSuits = ['spades', 'hearts', 'diamonds', 'clubs'].filter(s => s !== trumpSuit);
    const suitsPresent = new Set();

    for (const card of hand) {
        if (card.suit === 'joker') {
            // Jokers
            totalValue += HSI_JOKER_VALUES[card.rank];
        } else if (card.suit === trumpSuit) {
            // Trump suit cards
            totalValue += HSI_RANK_VALUES[card.rank] + HSI_TRUMP_OFFSET;
            suitsPresent.add(card.suit);
        } else {
            // Non-trump suit cards
            totalValue += HSI_RANK_VALUES[card.rank];
            suitsPresent.add(card.suit);
        }
    }

    // Normalize to 13 cards
    let hsi = totalValue * (13 / handSize);

    // Apply void multiplier for hands of 9+ cards
    if (handSize >= 9) {
        for (const suit of nonTrumpSuits) {
            if (!suitsPresent.has(suit)) {
                hsi *= HSI_VOID_MULTIPLIER;
            }
        }
    }

    return hsi;
}

module.exports = {
    RANK_VALUES,
    BID_RANKS,
    BORE_BIDS,
    BID_VALUES,
    MAX_HAND_SIZE,
    HAND_PROGRESSION,
    nextHandSize,
    isValidBid,
    rotatePosition,
    getPartnerPosition,
    isSameSuit,
    isVoidInSuit,
    isRainbow,
    isTrumpTight,
    isHighestTrumpInHand,
    isLegalMove,
    isLegalPlay,
    firstLegalCard,
    safeBid,
    determineWinner,
    calculateScore,
    personalBidValue,
    handFaults,
    seatBags,
    normalizeSeatBags,
    findHighestBidder,
    calculateMultiplier,
    determineDrawPosition,
    calculateHSI
};

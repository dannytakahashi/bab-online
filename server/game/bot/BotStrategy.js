/**
 * Pure strategy functions for bot decision making.
 * No side effects - all functions take inputs and return outputs.
 *
 * Strategy is informed by docs/bot-strategy-guide.md
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

// --- Hand progression for determining game phase ---
const HAND_PROGRESSION = [12, 10, 8, 6, 4, 2, 1, 3, 5, 7, 9, 11, 13];

/**
 * Check if the current hand is no-trump (joker was flipped)
 */
function isNoTrump(trump) {
    return trump.suit === 'joker';
}

/**
 * Scaling factor for non-trump high card values by hand size.
 * As hand size decreases, opponents are more likely void in your suit.
 */
function getNonTrumpScale(handSize) {
    if (handSize <= 1) return 0.0;
    if (handSize <= 2) return 0.1;
    if (handSize <= 3) return 0.2;
    if (handSize <= 4) return 0.3;
    if (handSize <= 6) return 0.5;
    if (handSize <= 8) return 0.7;
    if (handSize <= 10) return 0.85;
    return 1.0;
}

/**
 * Scaling factor for trump card values by hand size.
 * Mid-trump becomes more valuable in small hands (fewer trump in play).
 */
function getTrumpScale(handSize) {
    if (handSize <= 2) return 1.2;
    if (handSize <= 4) return 1.1;
    return 1.0;
}

/**
 * Get opponent positions for a given player position
 */
function getOpponentPositions(position) {
    const partner = getPartnerPosition(position);
    return [1, 2, 3, 4].filter(p => p !== position && p !== partner);
}

/**
 * Analyze memory to find suits opponents have shown voids in.
 * Returns a Set of strings like "2:hearts" meaning position 2 is void in hearts.
 */
function getOpponentVoidSuits(memory, position, trump) {
    const voidSuits = new Set();
    if (!memory || !memory.playedCards || memory.playedCards.length === 0) return voidSuits;

    const partnerPosition = getPartnerPosition(position);

    // Group played cards by trick
    const tricks = {};
    for (const entry of memory.playedCards) {
        if (!tricks[entry.trickIndex]) tricks[entry.trickIndex] = [];
        tricks[entry.trickIndex].push(entry);
    }

    for (const trickCards of Object.values(tricks)) {
        if (trickCards.length === 0) continue;
        const leadEntry = trickCards[0];
        const leadSuit = leadEntry.suit === 'joker' ? (isNoTrump(trump) ? 'joker' : trump.suit) : leadEntry.suit;

        for (const entry of trickCards) {
            if (entry.position === position || entry.position === partnerPosition) continue;
            const entrySuit = entry.suit === 'joker' ? (isNoTrump(trump) ? 'joker' : trump.suit) : entry.suit;
            if (entrySuit !== leadSuit) {
                voidSuits.add(`${entry.position}:${leadSuit}`);
            }
        }
    }

    return voidSuits;
}

/**
 * Analyze memory to find suits partner has shown voids in.
 * Returns a Set of suit names.
 */
function getPartnerVoidSuits(memory, position, trump) {
    const voidSuits = new Set();
    if (!memory || !memory.playedCards || memory.playedCards.length === 0) return voidSuits;

    const partnerPosition = getPartnerPosition(position);

    const tricks = {};
    for (const entry of memory.playedCards) {
        if (!tricks[entry.trickIndex]) tricks[entry.trickIndex] = [];
        tricks[entry.trickIndex].push(entry);
    }

    for (const trickCards of Object.values(tricks)) {
        if (trickCards.length === 0) continue;
        const leadEntry = trickCards[0];
        const leadSuit = leadEntry.suit === 'joker' ? (isNoTrump(trump) ? 'joker' : trump.suit) : leadEntry.suit;

        for (const entry of trickCards) {
            if (entry.position !== partnerPosition) continue;
            const entrySuit = entry.suit === 'joker' ? (isNoTrump(trump) ? 'joker' : trump.suit) : entry.suit;
            if (entrySuit !== leadSuit) {
                voidSuits.add(leadSuit);
            }
        }
    }

    return voidSuits;
}

/**
 * Determine how far along the game is (0.0 = start, 1.0 = end)
 */
function getGameProgress(currentHandSize) {
    const idx = HAND_PROGRESSION.indexOf(currentHandSize);
    if (idx === -1) return 0.5;
    return idx / (HAND_PROGRESSION.length - 1);
}

/**
 * Evaluate hand strength for bidding with hand-size-dependent scaling
 * @param {Array} hand - Player's cards
 * @param {Object} trump - Trump card
 * @param {number} handSize - Number of cards dealt this hand
 * @returns {Object} - { points, trumpCount, voids, suitCounts, hasHighJoker, hasLowJoker, hasTrumpAce }
 */
function evaluateHand(hand, trump, handSize) {
    let points = 0;
    let trumpCount = 0;
    const suitCounts = { spades: 0, hearts: 0, diamonds: 0, clubs: 0 };
    const noTrump = isNoTrump(trump);
    const ntScale = getNonTrumpScale(handSize);
    const tScale = getTrumpScale(handSize);

    for (const card of hand) {
        const isTrump = card.suit === 'joker' || (!noTrump && card.suit === trump.suit);

        // Count suits (excluding jokers)
        if (card.suit !== 'joker') {
            suitCounts[card.suit]++;
        }

        if (isTrump) {
            trumpCount++;
        }

        // --- Point evaluation ---
        if (card.rank === 'HI') {
            points += 1.9;
        } else if (card.rank === 'LO') {
            points += 1.4;
        } else if (isTrump && card.rank === 'A') {
            points += 1.4 * tScale;
        } else if (isTrump && card.rank === 'K') {
            points += 0.9 * tScale;
        } else if (isTrump && card.rank === 'Q') {
            points += 0.4 * tScale;
        } else if (isTrump && RANK_VALUES[card.rank] >= 7) {
            // Trump mid-cards (J-7): small value in small hands
            points += (handSize <= 4) ? 0.3 * tScale : 0;
        } else if (!isTrump && card.rank === 'A') {
            if (noTrump) {
                points += 1.3;
            } else {
                points += 0.8 * ntScale;
            }
        } else if (!isTrump && card.rank === 'K') {
            if (noTrump) {
                points += 0.7;
            } else {
                points += 0.4 * ntScale;
            }
        } else if (noTrump && card.rank === 'Q') {
            points += 0.3;
        }
    }

    // Single trump card devaluation in large hands
    if (trumpCount === 1 && handSize >= 8 && !noTrump) {
        const singleTrump = hand.find(c =>
            c.suit === trump.suit || c.suit === 'joker'
        );
        if (singleTrump && singleTrump.rank !== 'HI' && singleTrump.rank !== 'LO') {
            if (singleTrump.rank === 'A') points -= 0.4;
            else if (singleTrump.rank === 'K') points -= 0.3;
            else if (singleTrump.rank === 'Q') points -= 0.15;
        }
    }

    // Count voids (excluding trump suit and joker)
    let voids = 0;
    for (const [suit, count] of Object.entries(suitCounts)) {
        if (count === 0 && (noTrump || suit !== trump.suit)) {
            voids++;
        }
    }

    // Void + trump synergy: scales with trump count
    if (!noTrump) {
        const voidBonus = Math.min(0.3 + trumpCount * 0.15, 1.5);
        points += voids * voidBonus;
    } else {
        // In no-trump, voids are nearly worthless
        points += voids * 0.1;
    }

    // Trump length bonus (large hands only)
    if (handSize >= 6 && !noTrump) {
        if (trumpCount >= 6) points += 1.5;
        else if (trumpCount >= 5) points += 0.75;
        else if (trumpCount >= 4) points += 0.25;
    }

    return {
        points,
        trumpCount,
        voids,
        suitCounts,
        hasHighJoker: hand.some(c => c.rank === 'HI'),
        hasLowJoker: hand.some(c => c.rank === 'LO'),
        hasTrumpAce: hand.some(c => c.rank === 'A' && (c.suit === trump.suit || c.suit === 'joker'))
    };
}

/**
 * Calculate optimal bid based on hand evaluation
 * @param {Array} hand - Player's cards
 * @param {Object} trump - Trump card
 * @param {number} position - Player's position (1-4)
 * @param {Array} existingBids - Bids already made [pos1, pos2, pos3, pos4] (sparse)
 * @param {number} handSize - Cards per player
 * @param {Object|null} memory - Card memory snapshot
 * @param {Object|null} gameContext - { teamScore, oppScore, currentHandSize }
 * @param {string} personality - Bot personality key (default: 'mary')
 * @param {Array} partnerHistory - Zach's partner tracking data
 * @returns {string} - Bid value
 */
function calculateOptimalBid(hand, trump, position, existingBids, handSize, memory, gameContext, personality = 'mary', partnerHistory = []) {
    const evaluation = evaluateHand(hand, trump, handSize);
    const noTrump = isNoTrump(trump);

    // --- Parse all existing bids ---
    const partnerPosition = getPartnerPosition(position);
    const partnerBidIndex = partnerPosition - 1;
    const partnerBid = existingBids[partnerBidIndex];
    const partnerBidValue = (partnerBid !== undefined && partnerBid !== null)
        ? (BID_RANKS[partnerBid] || 0)
        : null;

    const opponentPositions = getOpponentPositions(position);

    let opponentTotalBid = 0;
    let opponentBidCount = 0;
    let allOthersBidZero = true;
    let partnerBored = false;
    let highestBore = null;

    for (let i = 0; i < 4; i++) {
        const bid = existingBids[i];
        if (bid === undefined || bid === null) continue;
        const bidValue = BID_RANKS[bid] || 0;
        const bidPosition = i + 1;

        if (bidPosition !== position) {
            if (bidValue > 0 || ['B', '2B', '3B', '4B'].includes(bid)) {
                allOthersBidZero = false;
            }
        }

        if (opponentPositions.includes(bidPosition)) {
            opponentTotalBid += bidValue;
            opponentBidCount++;
        }

        if (['B', '2B', '3B', '4B'].includes(bid)) {
            highestBore = bid;
            if (bidPosition === partnerPosition) {
                partnerBored = true;
            }
        }
    }

    const bidsBefore = existingBids.filter(b => b !== undefined && b !== null).length;
    const isFirstBidder = bidsBefore === 0;
    const isDealer = bidsBefore === 3;

    // --- Game-level score awareness ---
    let riskAdjustment = 0; // positive = more aggressive, negative = more conservative
    if (gameContext) {
        const progress = getGameProgress(gameContext.currentHandSize);
        const scoreDiff = gameContext.teamScore - gameContext.oppScore;

        if (progress >= 0.7) {
            // Late game
            if (scoreDiff < -30) riskAdjustment = 1;      // Behind: bid more aggressively
            else if (scoreDiff > 30) riskAdjustment = -1;  // Ahead: protect the lead
        }
    }

    // --- BORE DECISIONS (check before normal bidding) ---

    // 1-card hand bore
    if (handSize === 1 && allOthersBidZero) {
        if (evaluation.hasHighJoker) return 'B';
        if (evaluation.hasLowJoker || evaluation.hasTrumpAce) return 'B';
        const card = hand[0];
        const isTrump = card.suit === 'joker' || (!noTrump && card.suit === trump.suit);
        if (isTrump && RANK_VALUES[card.rank] >= RANK_VALUES['K']) return 'B';
        // With positive risk adjustment, lower the threshold
        if (riskAdjustment > 0 && isTrump && RANK_VALUES[card.rank] >= RANK_VALUES['Q']) return 'B';
    }

    // 2-card hand bore
    if (handSize === 2 && allOthersBidZero) {
        const c1 = hand[0];
        const c2 = hand[1];
        const c1Trump = c1.suit === 'joker' || (!noTrump && c1.suit === trump.suit);
        const c2Trump = c2.suit === 'joker' || (!noTrump && c2.suit === trump.suit);
        const bothTrump = c1Trump && c2Trump;
        const hasMidTrumpPlus = hand.some(c =>
            (c.suit === 'joker' || (!noTrump && c.suit === trump.suit)) &&
            RANK_VALUES[c.rank] >= RANK_VALUES['7']
        );
        const hasHighNonTrump = hand.some(c =>
            c.suit !== 'joker' && (noTrump || c.suit !== trump.suit) &&
            (c.rank === 'A' || c.rank === 'K')
        );
        const hasHighTrump = evaluation.hasHighJoker || evaluation.hasLowJoker || evaluation.hasTrumpAce;

        // Two trump cards, at least one mid+: BORE
        if (bothTrump && hasMidTrumpPlus) return 'B';
        // One high trump + one high non-trump: BORE
        if (hasHighTrump && hasHighNonTrump) return 'B';
    }

    // 3-5 card hand bore
    if (handSize >= 3 && handSize <= 5 && allOthersBidZero) {
        if (evaluation.hasHighJoker && evaluation.trumpCount >= handSize) return 'B';
        if (evaluation.hasHighJoker && evaluation.trumpCount >= handSize - 1 && evaluation.hasLowJoker) return 'B';
    }

    // Partner bore support (double bore)
    if (partnerBored && !['B', '2B', '3B', '4B'].includes(existingBids[position - 1])) {
        if (handSize <= 4 && evaluation.trumpCount >= Math.ceil(handSize / 2)) {
            // Determine the next bore level
            if (highestBore === 'B') return '2B';
            if (highestBore === '2B') return '3B';
            if (highestBore === '3B') return '4B';
        }
    }

    // Large hand bore (10+, keep conservative)
    if (handSize >= 10 && evaluation.points >= 8 && evaluation.trumpCount >= 6) {
        if (evaluation.hasHighJoker && evaluation.hasLowJoker && evaluation.trumpCount >= 7) {
            return 'B';
        }
    }

    // --- NORMAL BIDDING ---

    // Conservative rounding: floor instead of round
    let bid = Math.floor(evaluation.points);

    // Additional conservatism for first bidder (least information)
    if (isFirstBidder && bid > 1) {
        bid = bid - 1;
    }

    // Cap at hand size
    bid = Math.min(bid, handSize);

    // --- Small hand special logic ---
    if (handSize === 1) {
        if (evaluation.hasHighJoker || evaluation.hasLowJoker || evaluation.hasTrumpAce) {
            bid = 1;
        } else {
            bid = 0;
        }
    } else if (handSize === 2) {
        const hasTrump = hand.some(c => c.suit === 'joker' || (!noTrump && c.suit === trump.suit));
        if (evaluation.hasHighJoker) {
            bid = (evaluation.hasLowJoker || evaluation.hasTrumpAce) ? 2 : 1;
        } else if (evaluation.hasLowJoker || evaluation.hasTrumpAce) {
            bid = 1;
        } else if (hasTrump) {
            bid = 0;
        } else {
            bid = 0;
        }
    } else if (handSize <= 4) {
        // Cap at trump-based estimate for small hands
        const trumpBidCap = Math.ceil(evaluation.trumpCount * 0.75) +
            (evaluation.hasHighJoker ? 1 : 0) +
            (evaluation.hasLowJoker ? 1 : 0);
        bid = Math.min(bid, trumpBidCap, handSize);
    }

    // --- Partner bid coordination ---
    if (partnerBidValue !== null) {
        const combinedBid = bid + partnerBidValue;
        if (combinedBid > handSize) {
            bid = Math.max(0, handSize - partnerBidValue);
        }
    }

    // --- Opponent bid adjustments ---
    if (opponentBidCount === 2 && opponentTotalBid >= handSize * 0.6) {
        bid = Math.max(0, bid - 1);
    }

    if (partnerBidValue !== null && partnerBidValue >= Math.ceil(handSize * 0.5)) {
        bid = Math.min(bid, Math.max(0, handSize - partnerBidValue - 1));
    }

    // --- Game-level score adjustment ---
    if (riskAdjustment > 0 && bid < handSize) {
        // Behind late: slightly more aggressive
        // Only bump up if evaluation is close to next integer
        if (evaluation.points - bid >= 0.4) {
            bid = Math.min(bid + 1, handSize);
        }
    } else if (riskAdjustment < 0 && bid > 0) {
        // Ahead late: slightly more conservative
        if (evaluation.points - bid < 0.3) {
            bid = Math.max(0, bid - 1);
        }
    }

    bid = Math.max(0, bid);

    // Apply personality-specific bid modifier
    bid = applyBidModifier(bid, personality, evaluation, handSize, partnerHistory);

    return String(bid);
}

/**
 * Apply personality-specific bid modification after base (Mary) calculation.
 * @param {number} baseBid - Mary's calculated bid
 * @param {string} personality - Bot personality key
 * @param {Object} evaluation - Hand evaluation from evaluateHand()
 * @param {number} handSize - Cards per player
 * @param {Array} partnerHistory - Zach's partner tracking [{ bid, tricks }]
 * @returns {number} - Modified bid
 */
function applyBidModifier(baseBid, personality, evaluation, handSize, partnerHistory) {
    let bid = baseBid;

    switch (personality) {
        case 'sharon':
            // Sharon underbids strong hands
            if (handSize > 0 && evaluation.points >= handSize * 0.7) {
                bid = Math.max(0, bid - 2);
            } else if (handSize > 0 && evaluation.points >= handSize * 0.5) {
                bid = Math.max(0, bid - 1);
            }
            break;

        case 'danny':
            // Danny rounds up on close calls - calculated risk-taking
            if (evaluation.points - baseBid >= 0.25) {
                bid = Math.min(baseBid + 1, handSize);
            }
            break;

        case 'mike':
            // Mike randomly overbids ~25% of the time - he misjudges hands
            if (Math.random() < 0.25) {
                bid = Math.min(baseBid + 1, handSize);
            }
            break;

        case 'zach': {
            // Zach compensates for partner's tendencies with conservative lean
            if (partnerHistory.length >= 2) {
                const totalError = partnerHistory.reduce((sum, h) => sum + (h.tricks - h.bid), 0);
                const avgError = totalError / partnerHistory.length;

                if (avgError < -0.5) {
                    // Partner overbids (aggressive) - fully compensate down
                    bid = Math.max(0, bid - 1);
                } else if (avgError > 0.5) {
                    // Partner underbids (conservative) - cautious half-measure up
                    // Only bid up if hand evaluation supports it
                    if (evaluation.points - baseBid >= 0.3) {
                        bid = Math.min(bid + 1, handSize);
                    }
                }
            }
            break;
        }

        // 'mary' and default: no modification
    }

    return bid;
}

/**
 * Get all legal cards from hand
 */
function getLegalCards(hand, leadCard, isLeading, trump, trumpBroken, position, leadPosition) {
    return hand.filter(card => {
        const remainingHand = hand.filter(c => c !== card);
        return isLegalMove(card, remainingHand, leadCard || card, isLeading, trump, trumpBroken, position, leadPosition || position);
    });
}

/**
 * Check if a card can beat the current winning card
 */
function canBeatCard(card, winningCard, leadCard, trump) {
    const cardIsTrump = card.suit === trump.suit || card.suit === 'joker';
    const winningIsTrump = winningCard.suit === trump.suit || winningCard.suit === 'joker';
    const cardSuit = card.suit === 'joker' ? trump.suit : card.suit;
    const winningSuit = winningCard.suit === 'joker' ? trump.suit : winningCard.suit;
    const leadSuit = leadCard.suit === 'joker' ? trump.suit : leadCard.suit;

    if (cardIsTrump && !winningIsTrump) return true;
    if (cardIsTrump && winningIsTrump) return RANK_VALUES[card.rank] > RANK_VALUES[winningCard.rank];
    if (cardSuit === leadSuit && winningSuit === leadSuit) return RANK_VALUES[card.rank] > RANK_VALUES[winningCard.rank];
    return false;
}

/**
 * Find the current winning card and position in a partial trick
 */
function getCurrentWinner(playedCards, leadPosition, trump) {
    let winnerPosition = leadPosition;
    let winnerCard = playedCards[leadPosition - 1];

    for (let i = 0; i < 4; i++) {
        if (playedCards[i] && i !== leadPosition - 1) {
            if (canBeatCard(playedCards[i], winnerCard, playedCards[leadPosition - 1], trump)) {
                winnerCard = playedCards[i];
                winnerPosition = i + 1;
            }
        }
    }

    return { card: winnerCard, position: winnerPosition };
}

/**
 * Select optimal card when leading
 */
function selectLead(hand, trump, trumpBroken, gameState, memory, handSize) {
    const legalCards = getLegalCards(hand, null, true, trump, trumpBroken, gameState.position, gameState.position);

    if (legalCards.length === 1) return legalCards[0];

    const noTrump = isNoTrump(trump);
    const opponentVoids = getOpponentVoidSuits(memory, gameState.position, trump);
    const partnerVoids = getPartnerVoidSuits(memory, gameState.position, trump);

    // 1. Lead HI joker when we have it (draws out opponent trump)
    const highJoker = legalCards.find(c => c.rank === 'HI');
    if (highJoker) return highJoker;

    // 2. Group by suit
    const bySuit = { spades: [], hearts: [], diamonds: [], clubs: [] };
    const trumpSuitCards = [];
    for (const card of legalCards) {
        if (card.suit === 'joker' || (!noTrump && card.suit === trump.suit)) {
            trumpSuitCards.push(card);
        } else if (card.suit !== 'joker') {
            bySuit[card.suit].push(card);
        }
    }

    // 3. Score each off-suit for leading
    const opponents = getOpponentPositions(gameState.position);
    let bestSuit = null;
    let bestScore = -Infinity;

    for (const [suit, cards] of Object.entries(bySuit)) {
        if (cards.length === 0) continue;
        if (!noTrump && suit === trump.suit) continue;

        let score = 0;

        // Prefer suits partner is void in (they can trump in)
        if (partnerVoids.has(suit)) score += 10;

        // Avoid suits opponents are void in
        if (opponentVoids.has(`${opponents[0]}:${suit}`)) score -= 5;
        if (opponentVoids.has(`${opponents[1]}:${suit}`)) score -= 5;

        // Prefer suits where we have Ace (guaranteed trick)
        const hasAce = cards.some(c => c.rank === 'A');
        if (hasAce) score += 8;

        // Prefer shorter suits (opponents less likely void, voids us faster)
        score += (5 - cards.length);

        // Penalize suits with unprotected King on large hands
        const hasKing = cards.some(c => c.rank === 'K');
        if (hasKing && !hasAce && handSize >= 8 && memory && !memory.acesPlayed[suit]) {
            score -= 3;
        }

        if (score > bestScore) {
            bestScore = score;
            bestSuit = suit;
        }
    }

    if (bestSuit && bySuit[bestSuit].length > 0) {
        const sorted = bySuit[bestSuit].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);

        // Lead Ace if we have it
        const ace = sorted.find(c => c.rank === 'A');
        if (ace) return ace;

        // Lead King only if Ace has been played (or small hand where Ace may not be dealt)
        const king = sorted.find(c => c.rank === 'K');
        if (king) {
            const aceIsGone = (memory && memory.acesPlayed[bestSuit]) || handSize <= 4;
            if (aceIsGone) return king;
        }

        // Lead low from the suit
        return sorted[sorted.length - 1];
    }

    // Only have trump: lead low trump
    if (trumpSuitCards.length > 0) {
        return trumpSuitCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
    }

    // Fallback
    return legalCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
}

/**
 * Select optimal card when following
 */
function selectFollow(hand, playedCards, leadCard, leadPosition, trump, trumpBroken, position, memory, handSize) {
    const legalCards = getLegalCards(hand, leadCard, false, trump, trumpBroken, position, leadPosition);

    if (legalCards.length === 1) return legalCards[0];

    const partnerPosition = getPartnerPosition(position);
    const { card: winningCard, position: winnerPosition } = getCurrentWinner(playedCards, leadPosition, trump);
    const partnerIsWinning = winnerPosition === partnerPosition;
    const partnerHasPlayed = playedCards[partnerPosition - 1] !== undefined;

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
            return followCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
        }

        // Try to win with minimum card
        const winners = followCards.filter(c => canBeatCard(c, winningCard, leadCard, trump));
        if (winners.length > 0) {
            const sortedWinners = winners.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank]);
            const lowestWinner = sortedWinners[0];

            // King protection on large hands: if King is lowest winner and Ace not played
            if (lowestWinner.rank === 'K' && handSize >= 8 && memory) {
                const kingSuit = lowestWinner.suit;
                if (kingSuit !== 'joker' && !memory.acesPlayed[kingSuit]) {
                    // How many players still to act after us?
                    const playersAfterUs = 4 - playedCards.filter(c => c !== undefined && c !== null).length - 1;
                    if (playersAfterUs > 0 && sortedWinners.length > 1) {
                        return sortedWinners[1]; // Play next lowest winner instead
                    }
                }
            }

            return lowestWinner;
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
 */
function selectDiscard(cards, trump) {
    const nonTrump = cards.filter(c => c.suit !== trump.suit && c.suit !== 'joker');

    if (nonTrump.length > 0) {
        // Group by suit and find shortest
        const bySuit = {};
        for (const card of nonTrump) {
            if (!bySuit[card.suit]) bySuit[card.suit] = [];
            bySuit[card.suit].push(card);
        }

        let shortestSuit = null;
        let shortestLength = Infinity;
        for (const [suit, suitCards] of Object.entries(bySuit)) {
            if (suitCards.length < shortestLength) {
                shortestLength = suitCards.length;
                shortestSuit = suit;
            }
        }

        if (shortestSuit) {
            return bySuit[shortestSuit].sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
        }
    }

    return cards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
}

/**
 * Select optimal card to play
 */
function selectOptimalCard(hand, playedCards, leadCard, leadPosition, trump, trumpBroken, position, memory, handSize) {
    const isLeading = !leadCard || playedCards.every(c => c === undefined || c === null);

    if (isLeading) {
        return selectLead(hand, trump, trumpBroken, { position }, memory, handSize);
    }

    return selectFollow(hand, playedCards, leadCard, leadPosition, trump, trumpBroken, position, memory, handSize);
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
    selectOptimalCard,
    // Exported for testing
    isNoTrump,
    getNonTrumpScale,
    getTrumpScale,
    getOpponentPositions,
    getOpponentVoidSuits,
    getPartnerVoidSuits,
    getGameProgress,
    applyBidModifier
};

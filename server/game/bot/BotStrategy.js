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
const { getBidStyle, getPlayStyle } = require('./personalities');

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
 * Check if any opponent has not yet played in the current trick.
 * Since the bot is the current player, any unplayed position (other than itself) plays after it.
 */
function hasOpponentsAfterMe(playedCards, position) {
    const partnerPosition = getPartnerPosition(position);
    for (let i = 0; i < 4; i++) {
        const pos = i + 1;
        if (pos === position || pos === partnerPosition) continue;
        if (playedCards[i] === undefined || playedCards[i] === null) return true;
    }
    return false;
}

/**
 * Select the best card from a sorted-highest-first list, preserving HI joker for leading.
 * HI joker's forcing ability (opponents must play highest trump) is too valuable to waste
 * on a follow. Only play it when it's the sole winner or genuinely needed to hold the trick.
 */
function bestWithoutHiJoker(sortedCards, winningCard, trump) {
    if (sortedCards.length === 0) return null;
    const best = sortedCards[0];

    // If best card isn't HI joker, no issue
    if (best.rank !== 'HI' || best.suit !== 'joker') return best;

    // HI joker is our best card — should we play it?
    // Yes if it's our only option
    if (sortedCards.length === 1) return best;

    // Spend HI only when the current winner is trump strong enough that our
    // next-best winner can't reliably hold the trick (LO joker or trump Ace).
    // A non-trump winner never needs HI — every card in this list already
    // beats it. And if our next-best winner is the LO joker, it is itself
    // unbeatable (we hold the HI), so hold HI even then.
    const winningIsTrump = winningCard && (winningCard.suit === 'joker' ||
        (trump.suit !== 'joker' && winningCard.suit === trump.suit));
    if (winningIsTrump && (winningCard.rank === 'LO' || winningCard.rank === 'A')) {
        const next = sortedCards[1];
        if (!(next.rank === 'LO' && next.suit === 'joker')) return best;
    }

    // Otherwise hold HI joker for leading — use next best card
    return sortedCards[1];
}

/**
 * Determine if the current winning card is vulnerable to being beaten by an opponent still to play.
 * A win is "good" (not vulnerable) if no card that outranks it remains in unseen hands
 * AND (for non-trump winners) no remaining opponent is known void in the led suit.
 * @param {Array} [hand] - Our own hand; cards we hold can't beat the winner from elsewhere
 */
function isWinVulnerable(winningCard, leadCard, trump, memory, playedCards, position, hand = []) {
    const noTrump = isNoTrump(trump);
    const winningIsTrump = winningCard.suit === 'joker' || (!noTrump && winningCard.suit === trump.suit);

    // Check if any remaining opponent is known void in the led suit (trump-in risk)
    const opponentVoids = getOpponentVoidSuits(memory, position, trump);
    const opponents = getOpponentPositions(position);
    let opponentKnownVoid = false;
    for (const opp of opponents) {
        // Only check opponents who haven't played yet
        if (playedCards[opp - 1] !== undefined && playedCards[opp - 1] !== null) continue;
        const leadSuit = leadCard.suit === 'joker' ? (noTrump ? 'joker' : trump.suit) : leadCard.suit;
        if (opponentVoids.has(`${opp}:${leadSuit}`)) {
            opponentKnownVoid = true;
            break;
        }
    }

    // Trump winner: only a higher trump still in unseen hands threatens it.
    // Counting actual outstanding cards lets a trump Queen stand once the
    // jokers/A/K are accounted for, instead of overtaking partner "just in case".
    if (winningIsTrump) {
        if (!memory) {
            // No memory: fall back to rank heuristics
            return !(winningCard.rank === 'HI' || winningCard.rank === 'LO' || winningCard.rank === 'A');
        }
        return countHigherUnseen(winningCard, hand, memory, trump) > 0;
    }

    // Non-trump winner: vulnerable to a ruff from a known-void opponent.
    // In no-trump the one live joker is still trump — the ruff risk only
    // disappears once that joker is accounted for.
    if (opponentKnownVoid && (!noTrump || countLiveJokersOutside(hand, memory, trump) > 0)) {
        return true;
    }
    // ...or to a higher card of the suit in unseen hands
    if (!memory) return winningCard.rank !== 'A';
    return countHigherUnseen(winningCard, hand, memory, trump) > 0;
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
        const leadEntry = findLeadEntry(trickCards);
        if (!leadEntry) continue; // partially observed trick (bot joined mid-trick)
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
 * Find the entry that led a recorded trick. Entries carry an explicit isLead
 * flag (recorded by BotPlayer); when absent (older recordings), fall back to
 * assuming the first recorded card led — only safe when the bot observed the
 * trick from its start.
 */
function findLeadEntry(trickCards) {
    const hasLeadInfo = trickCards.some(e => e.isLead !== undefined);
    if (hasLeadInfo) return trickCards.find(e => e.isLead) || null;
    return trickCards[0];
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
        const leadEntry = findLeadEntry(trickCards);
        if (!leadEntry) continue; // partially observed trick (bot joined mid-trick)
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

const SUIT_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

/**
 * Count cards still in opponents'/partner's hands that would beat this card
 * in direct comparison: higher cards of its suit (for trump, higher trump
 * including jokers). Excludes cards already played, cards in our own hand,
 * and the flipped trump card (which is out of play). 0 means the card is
 * boss — nothing left in other hands outranks it (it can still lose to a
 * ruff if it isn't trump; that risk is tracked separately).
 */
function countHigherUnseen(card, hand, memory, trump) {
    const noTrump = isNoTrump(trump);
    const cardIsTrump = card.suit === 'joker' || (!noTrump && card.suit === trump.suit);
    const myVal = RANK_VALUES[card.rank];

    const gone = new Set();
    gone.add(`${trump.suit}:${trump.rank}`); // flipped card is out of play
    for (const c of hand) gone.add(`${c.suit}:${c.rank}`);
    if (memory && memory.playedCards) {
        for (const e of memory.playedCards) gone.add(`${e.suit}:${e.rank}`);
    }
    if (memory && memory.acesPlayed) {
        for (const [suit, played] of Object.entries(memory.acesPlayed)) {
            if (played) gone.add(`${suit}:A`);
        }
    }

    let count = 0;
    if (cardIsTrump) {
        if (!noTrump) {
            for (const r of SUIT_RANKS) {
                if (RANK_VALUES[r] > myVal && !gone.has(`${trump.suit}:${r}`)) count++;
            }
        }
        if (RANK_VALUES['LO'] > myVal && !gone.has('joker:LO')) count++;
        if (RANK_VALUES['HI'] > myVal && !gone.has('joker:HI')) count++;
    } else {
        for (const r of SUIT_RANKS) {
            if (RANK_VALUES[r] > myVal && !gone.has(`${card.suit}:${r}`)) count++;
        }
    }
    return count;
}

/**
 * Count jokers still in other players' hands (not flipped, not ours, not yet
 * played). In no-trump hands the one live joker is still trump and can ruff.
 */
function countLiveJokersOutside(hand, memory, trump) {
    const gone = new Set();
    gone.add(`${trump.suit}:${trump.rank}`);
    for (const c of hand) gone.add(`${c.suit}:${c.rank}`);
    if (memory && memory.playedCards) {
        for (const e of memory.playedCards) gone.add(`${e.suit}:${e.rank}`);
    }
    let count = 0;
    if (!gone.has('joker:HI')) count++;
    if (!gone.has('joker:LO')) count++;
    return count;
}

/**
 * Derive the contract picture from play context (see BotController.buildPlayContext).
 * Returns null when context is unavailable; callers fall back to contract-blind play.
 *
 * The core output is `target` — how many of the remaining tricks the team
 * should fight for — and the effort level that follows from it:
 *  - 'max':    every remaining trick matters (live bore, or bid exactly
 *              coverable, or one trick sets an opponent bore)
 *  - 'cheap':  nothing left but ±1 overtricks — never spend honors or trump
 *  - 'normal': contested middle
 */
function getContractState(playContext, position, handSize) {
    if (!playContext || !playContext.bids || !playContext.tricks) return null;

    const isTeam1 = position === 1 || position === 3;
    const myBid = (isTeam1 ? playContext.bids.team1 : playContext.bids.team2) || 0;
    const oppBid = (isTeam1 ? playContext.bids.team2 : playContext.bids.team1) || 0;
    const myTricks = (isTeam1 ? playContext.tricks.team1 : playContext.tricks.team2) || 0;
    const oppTricks = (isTeam1 ? playContext.tricks.team2 : playContext.tricks.team1) || 0;

    const partnerPosition = getPartnerPosition(position);
    const playerBids = playContext.playerBids || [];
    const isBoreBid = (b) => ['B', '2B', '3B', '4B'].includes(String(b));
    const teamBored = isBoreBid(playerBids[position - 1]) || isBoreBid(playerBids[partnerPosition - 1]);
    const oppBored = getOpponentPositions(position).some(p => isBoreBid(playerBids[p - 1]));

    const tricksRemaining = handSize - myTricks - oppTricks;
    const needed = Math.max(0, myBid - myTricks);
    const oppNeeded = Math.max(0, oppBid - oppTricks);

    // Objectives still alive: making our own bid, and setting theirs
    const makeTarget = needed <= tricksRemaining ? needed : 0; // 0 when our bid is already dead
    const toSetOpp = oppNeeded > 0 ? tricksRemaining - oppNeeded + 1 : Infinity;
    // Denial is worth chasing only when realistic: an opposing bore (huge
    // swing), or a set that doesn't demand sweeping far beyond what our own
    // bid already requires. Without this gate, opponents sitting one trick
    // from a small bid would push the bot into sweep-everything mode all hand.
    let setTarget = 0;
    if (toSetOpp > 0 && toSetOpp <= tricksRemaining) {
        if (oppBored || toSetOpp <= Math.max(makeTarget, Math.ceil(tricksRemaining / 2))) {
            setTarget = toSetOpp;
        }
    }

    const target = Math.max(makeTarget, setTarget);
    let effort = 'normal';
    if (target === 0) effort = 'cheap';
    else if (target >= tricksRemaining) effort = 'max';
    // An opposing bore is worth so much that the one trick that sets it
    // always justifies maximum effort
    else if (oppBored && myTricks === 0) effort = 'max';

    return {
        teamBored,
        oppBored,
        needed,
        oppNeeded,
        tricksRemaining,
        target,
        effort,
        urgency: tricksRemaining > 0 ? target / tricksRemaining : 0
    };
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
        // The flipped trump card is out of play: when it's the HI joker the LO
        // becomes unbeatable, and a trump King under a flipped Ace is the boss
        // trump card after the jokers.
        if (card.rank === 'HI') {
            points += 1.9;
        } else if (card.rank === 'LO') {
            points += (trump.rank === 'HI' ? 1.9 : 1.4);
        } else if (isTrump && card.rank === 'A') {
            points += 1.4 * tScale;
        } else if (isTrump && card.rank === 'K') {
            points += (trump.rank === 'A' ? 1.4 : 0.9) * tScale;
        } else if (isTrump && card.rank === 'Q') {
            points += (trump.rank === 'K' ? 0.9 : 0.4) * tScale;
        } else if (isTrump) {
            // Low/mid trump (2-J): every trump card pulls weight — it ruffs or
            // forces out a bigger trump. Worth more in small hands (fewer
            // trump in play) and when higher in rank.
            const mid = RANK_VALUES[card.rank] >= 7;
            if (handSize <= 4) points += (mid ? 0.45 : 0.35) * tScale;
            else if (handSize <= 7) points += (mid ? 0.25 : 0.1) * tScale;
            else points += (mid ? 0.15 : 0.05) * tScale;
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
    // Voids are worthless without trump - can't trump in
    if (!noTrump) {
        if (trumpCount > 0) {
            const voidBonus = Math.min(0.3 + trumpCount * 0.15, 1.5);
            points += voids * voidBonus;
        }
    } else {
        // In no-trump, voids are nearly worthless
        points += voids * 0.1;
    }

    // Trump length bonus (large hands only) — smaller than before since each
    // trump card now carries value of its own; this models the extra control
    // long trump gives beyond the sum of its cards
    if (handSize >= 6 && !noTrump) {
        if (trumpCount >= 6) points += 0.75;
        else if (trumpCount >= 5) points += 0.4;
        else if (trumpCount >= 4) points += 0.15;
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
/**
 * Count the cards in hand that are guaranteed to win a trick no matter how
 * play unfolds: an unbroken run of the highest trumps in play, counted down
 * from the HI joker. The flipped trump card is out of play, so it is skipped
 * rather than breaking the run (e.g. HI flipped → LO, trump A, ... lead it).
 *
 * Holding N such cards guarantees N tricks — a top trump wins whatever trick
 * it is played into, and if a hand is entirely top trumps it may lead trump
 * even when trump isn't broken.
 */
function countLockedWinners(hand, trump) {
    const noTrump = isNoTrump(trump);
    const order = [{ suit: 'joker', rank: 'HI' }, { suit: 'joker', rank: 'LO' }];
    if (!noTrump) {
        for (let i = SUIT_RANKS.length - 1; i >= 0; i--) {
            order.push({ suit: trump.suit, rank: SUIT_RANKS[i] });
        }
    }

    let locked = 0;
    for (const c of order) {
        if (c.suit === trump.suit && c.rank === trump.rank) continue; // flipped: out of play
        if (hand.some(h => h.suit === c.suit && h.rank === c.rank)) locked++;
        else break;
    }
    return locked;
}

const NEXT_BORE = { null: 'B', B: '2B', '2B': '3B', '3B': '4B', '4B': null };

/** Binomial coefficient C(n, k) as a float (n <= 54 here, so it stays exact). */
function choose(n, k) {
    if (k < 0 || k > n) return 0;
    if (k > n - k) k = n - k;
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return r;
}

/**
 * What a seat would bid on a small hand holding exactly these trump cards
 * (off-suit cards contribute ~nothing at hand sizes 1-5). Mirrors this
 * module's own small-hand bidding — which is also how people bid them — and
 * is used to read opponents' bids: a 0 says "no top trump", a number says
 * "probably one".
 */
function impliedTrumpBid(trumps, trump, handSize) {
    const m = trumps.length;
    const isJoker = c => c.rank === 'HI' || c.rank === 'LO';
    if (handSize === 1) {
        return (m > 0 && (isJoker(trumps[0]) || RANK_VALUES[trumps[0].rank] >= RANK_VALUES['7'])) ? 1 : 0;
    }
    if (handSize === 2) {
        let winners = trumps.filter(c => isJoker(c) || RANK_VALUES[c.rank] >= RANK_VALUES['Q']).length;
        if (winners === 0 && m === 2) winners = 1;
        return Math.min(winners, 2);
    }
    const ts = getTrumpScale(handSize);
    let points = 0;
    for (const c of trumps) {
        if (c.rank === 'HI') points += 1.9;
        else if (c.rank === 'LO') points += (trump.rank === 'HI' ? 1.9 : 1.4);
        else if (c.rank === 'A') points += 1.4 * ts;
        else if (c.rank === 'K') points += (trump.rank === 'A' ? 1.4 : 0.9) * ts;
        else if (c.rank === 'Q') points += (trump.rank === 'K' ? 0.9 : 0.4) * ts;
        else {
            const mid = RANK_VALUES[c.rank] >= 7;
            points += (handSize <= 4 ? (mid ? 0.45 : 0.35) : (mid ? 0.25 : 0.1)) * ts;
        }
    }
    let bid = Math.floor(points);
    if (handSize <= 4) {
        const hi = trumps.some(c => c.rank === 'HI') ? 1 : 0;
        const lo = trumps.some(c => c.rank === 'LO') ? 1 : 0;
        bid = Math.min(bid, Math.ceil(m * 0.75) + hi + lo);
    }
    return bid;
}

/**
 * Probability that our hand sweeps when it holds the opening lead — which a
 * bore bid wins, as the highest bid on the table.
 *
 * Models the line the bot plays at max effort: while trump is unbroken a
 * mixed hand must lead its off-suit cards first; once only trump remains it
 * leads the HI joker, then the rest of its trump top-down. Each opponent's
 * trump holding is enumerated exactly (every subset of the unseen trump,
 * weighted by its hypergeometric probability) and scored against the
 * worst-case defence. An opponent holding m trumps against our r can save
 * its best for trick min(m, r):
 *  - our HI joker led first forces its highest trump, so it beats us iff its
 *    SECOND-highest outranks our min(m, r)-th trump;
 *  - without the HI it beats us iff its highest does.
 * An off-suit lead loses iff the opponent holds a higher card of the suit,
 * or is void in it with a trump to ruff.
 *
 * oppBids are the two opponents' bids seen so far: each holding is weighted
 * by how consistent it is with the bid (BORE_TUNING.likelihood). The two
 * opponents are combined as independent, and partner's cards are treated as
 * harmless (they can only help), so the estimate is mildly pessimistic —
 * except after an opponent's non-zero bid, where the soft likelihood leaves
 * it optimistic; calculateOptimalBid demands a much higher bar there.
 *
 * @returns {number} P(sweep) in [0, 1]
 */
function analyzeLeadSweep(hand, trump, handSize, oppBids = []) {
    const noTrump = isNoTrump(trump);
    const isTrumpCard = c => c.suit === 'joker' || (!noTrump && c.suit === trump.suit);
    const key = c => `${c.suit}:${c.rank}`;
    const mine = new Set(hand.map(key));
    const flipped = key(trump);

    // Unseen trump cards, high to low
    const pool = [];
    for (const rank of ['HI', 'LO']) {
        if (!mine.has(`joker:${rank}`) && `joker:${rank}` !== flipped) pool.push({ suit: 'joker', rank });
    }
    if (!noTrump) {
        for (let i = SUIT_RANKS.length - 1; i >= 0; i--) {
            const c = { suit: trump.suit, rank: SUIT_RANKS[i] };
            if (!mine.has(key(c)) && key(c) !== flipped) pool.push(c);
        }
    }
    const T = pool.length;
    const N = 54 - 1 - hand.length; // unseen cards
    const n = handSize;
    const myTrump = hand.filter(isTrumpCard).map(c => RANK_VALUES[c.rank]).sort((a, b) => b - a);
    const r = myTrump.length;
    const hasHi = r > 0 && myTrump[0] === RANK_VALUES.HI;

    const offsuit = hand.filter(c => !isTrumpCard(c)).map(c => {
        let inSuit = 0, higher = 0;
        for (const rank of SUIT_RANKS) {
            const k = `${c.suit}:${rank}`;
            if (mine.has(k) || k === flipped) continue;
            inSuit++;
            if (RANK_VALUES[rank] > RANK_VALUES[c.rank]) higher++;
        }
        return { inSuit, higher };
    });

    // P(every off-suit lead survives this opponent | it holds m trumps)
    const offOk = [];
    for (let m = 0; m <= n; m++) {
        const k = n - m;
        const tot = choose(N - T, k);
        let ok = 1;
        for (const o of offsuit) {
            if (tot === 0) break;
            const pHigher = 1 - choose(N - T - o.higher, k) / tot;
            const pVoid = m > 0 ? choose(N - T - o.inSuit, k) / tot : 0;
            ok *= Math.max(0, 1 - pHigher - pVoid);
        }
        offOk.push(ok);
    }

    const L = BORE_TUNING.likelihood;
    const likelihood = (held, bid) => {
        if (bid === undefined || bid === null) return 1;
        const implied = impliedTrumpBid(held, trump, n);
        if (['B', '2B', '3B', '4B'].includes(bid)) return implied >= 1 ? 1 : L.boreWithout;
        if ((BID_RANKS[bid] || 0) === 0) return implied === 0 ? 1 : L.zeroWith;
        return implied >= 1 ? 1 : L.numberWithout;
    };

    const totalHands = choose(N, n);
    let pSweep = 1;
    for (let o = 0; o < 2; o++) {
        const bid = oppBids[o];
        let okMass = 0, mass = 0;
        const held = [];
        const visit = (start) => {
            const m = held.length;
            const w = choose(N - T, n - m) / totalHands;
            if (w > 0) {
                let beatsTrump = false;
                if (r > 0 && m > 0) {
                    const v = myTrump[Math.min(m, r) - 1];
                    let above = 0;
                    for (const c of held) if (RANK_VALUES[c.rank] > v) above++;
                    beatsTrump = hasHi ? above >= 2 : above >= 1;
                }
                const ok = beatsTrump ? 0 : offOk[m];
                const lw = likelihood(held, bid);
                okMass += w * lw * ok;
                mass += w * lw;
            }
            if (m >= n) return;
            for (let i = start; i < T; i++) {
                held.push(pool[i]);
                visit(i + 1);
                held.pop();
            }
        };
        visit(0);
        pSweep *= mass > 0 ? okMass / mass : 0;
    }
    return pSweep;
}

/**
 * Sim-tuned bore knobs (see sim/README.md for the measurements). Exported so
 * the tuning harness can sweep them; production code never mutates them.
 */
const BORE_TUNING = {
    // Hand sizes the sweep model decides (bigger hands fall back to the
    // conservative large-hand rule — the model ignores too much there)
    maxModelHandSize: 5,
    // Minimum modelled P(sweep) to open a bore (no bore on the table yet)
    threshold: { 1: 0.6, 2: 0.6, 3: 0.6, 4: 0.6, 5: 0.6 },
    // ...after an opponent bid a number: the model reads such bids softly and
    // is badly optimistic there (measured 2-card bores at model p 0.5-0.7
    // swept only 10-35%), so demand near-certainty
    thresholdAfterOppBid: 0.9,
    // How strongly an opponent's bid says it holds a top trump: weight of a
    // holding the bid is inconsistent with (see impliedTrumpBid)
    likelihood: { boreWithout: 0.05, zeroWith: 0.1, numberWithout: 0.25 }
};

/**
 * Decide whether to bore (or escalate a bore) and at what level. Returns the
 * bore bid, or null to bid a number.
 *
 * Legality: the only bore ever returned is NEXT_BORE[highest bore on the
 * table] — 'B' when none is out, otherwise exactly one level up. A bore
 * never repeats or skips a level.
 *
 * "Guaranteed" is only ever claimed for a true lock (countLockedWinners
 * covers the whole hand): those cards win every trick whoever leads. Any
 * other sweep estimate assumes we keep the opening lead, which a later seat
 * can take by escalating — so it is never used to counter-bore an opponent.
 */
function decideBore(hand, trump, handSize, evaluation, existingBids, position, table) {
    const { highestBore, highestBorePosition, opponentBored, oppNumericBid } = table;
    const nextBore = NEXT_BORE[highestBore];
    if (!nextBore) return null;

    // Guaranteed sweep: every card is a top trump, so our team wins every
    // trick regardless of seat, lead, or what anyone else bid. Bore — or
    // escalate one level over any existing bore (partner's raises our
    // multiplier; an opponent's is certain to be set while ours is certain
    // to make).
    if (countLockedWinners(hand, trump) >= handSize) return nextBore;

    const partnerPosition = getPartnerPosition(position);
    const loIsBoss = evaluation.hasLowJoker && trump.rank === 'HI';

    if (highestBore) {
        // An opponent holds the top bore: counter only on a true lock (above).
        // Everything else measured strongly negative (-20 to -80 per hand).
        if (highestBorePosition !== partnerPosition) return null;

        // Partner holds the top bore: escalating doubles our own multiplier
        // and hands us the lead.
        if (handSize === 1) {
            // A 1-card bore is near-certain (~99% sweep) and our card can only
            // help, so escalate whatever we hold (+19 points per decision in
            // sim counterfactuals, even holding an off-suit 2). Over an
            // opponent's counter-bore, only with the unbeatable card.
            if (!opponentBored) return nextBore;
            return (evaluation.hasHighJoker || loIsBoss) ? nextBore : null;
        }
        if (handSize <= 4) {
            // Escalating over an OPPONENT's counter-bore doubles the stakes on a
            // contested hand — only do it holding the unbeatable card ourselves
            if (opponentBored && !(evaluation.hasHighJoker || loIsBoss)) return null;
            if (evaluation.trumpCount >= Math.ceil(handSize / 2)) return nextBore;
            // 2 cards: an off-suit Ace is a safe lead once we hold the lead
            // (no off-suit King to strand); measured +12.8 per decision
            if (handSize === 2 && !opponentBored) {
                const off = hand.filter(c => c.suit !== 'joker' && (isNoTrump(trump) || c.suit !== trump.suit));
                if (off.some(c => c.rank === 'A') && !off.some(c => c.rank === 'K')) return nextBore;
            }
        }
        return null;
    }

    // No bore on the table yet: bore when the modelled sweep chance clears
    // the bar. A bore pays +/-20 per card against roughly +10 to +20 for a
    // plain small-hand bid, so it is +EV down to roughly a 60-65% sweep.
    if (handSize <= BORE_TUNING.maxModelHandSize) {
        const opps = getOpponentPositions(position);
        const p = analyzeLeadSweep(hand, trump, handSize, opps.map(o => existingBids[o - 1]));
        const th = oppNumericBid ? BORE_TUNING.thresholdAfterOppBid : BORE_TUNING.threshold[handSize];
        return p >= th ? 'B' : null;
    }

    // Large hand bore (10+, keep conservative)
    if (handSize >= 10 && evaluation.points >= 8 && evaluation.trumpCount >= 7 &&
        evaluation.hasHighJoker && evaluation.hasLowJoker) {
        return 'B';
    }
    return null;
}


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
    let opponentBored = false;
    let highestBore = null;
    let highestBorePosition = null;
    let oppNumericBid = false;     // an opponent bid a number > 0

    for (let i = 0; i < 4; i++) {
        const bid = existingBids[i];
        if (bid === undefined || bid === null) continue;
        const bidValue = BID_RANKS[bid] || 0;
        const bidPosition = i + 1;
        const isBoreBid = ['B', '2B', '3B', '4B'].includes(bid);

        if (!isBoreBid && bidValue > 0) {
            if (opponentPositions.includes(bidPosition)) oppNumericBid = true;
        }

        if (opponentPositions.includes(bidPosition)) {
            // Bores carry BID_RANKS values 13-16; keep them out of trick math
            opponentTotalBid += isBoreBid ? 0 : bidValue;
            opponentBidCount++;
        }

        if (isBoreBid) {
            if (!highestBore || BID_RANKS[bid] > BID_RANKS[highestBore]) {
                highestBore = bid;
                highestBorePosition = bidPosition;
            }
            if (opponentPositions.includes(bidPosition)) opponentBored = true;
        }
    }

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
    const boreBid = decideBore(hand, trump, handSize, evaluation, existingBids, position, {
        highestBore, highestBorePosition, opponentBored, oppNumericBid
    });
    if (boreBid) return boreBid;

    // --- NORMAL BIDDING ---

    // Conservative rounding: floor instead of round. The set penalty
    // (-10/trick) dwarfs the overtrick payoff (+1/trick); sim-tested against
    // +0.2/+0.45 offsets — same win rate, materially fewer sets.
    let bid = Math.floor(evaluation.points);

    // No extra first-bidder discount: the pessimistic evaluation plus floor()
    // already price in the uncertainty — stacking a further -1 triple-counts
    // it (sim-tested: the discount cost ~1.2% win rate).

    // Cap at hand size
    bid = Math.min(bid, handSize);

    // --- Small hand special logic ---
    if (handSize === 1) {
        if (evaluation.hasHighJoker || evaluation.hasLowJoker || evaluation.hasTrumpAce) {
            bid = 1;
        } else if (noTrump && (hand[0].rank === 'A' || hand[0].rank === 'K')) {
            // No-trump: an Ace (or King) can't be ruffed and we lead as the
            // highest bidder — near-certain winner
            bid = 1;
        } else if (!noTrump &&
            (hand[0].suit === trump.suit || hand[0].suit === 'joker') &&
            RANK_VALUES[hand[0].rank] >= RANK_VALUES['7']) {
            // High trump is a likely winner even into an unknown field
            bid = 1;
        } else {
            bid = 0;
        }
    } else if (handSize === 2) {
        if (noTrump) {
            // Nothing can be ruffed: jokers and aces are near-certain winners
            let winners = 0;
            for (const c of hand) {
                if (c.rank === 'HI' || c.rank === 'LO' || c.rank === 'A') winners++;
            }
            bid = Math.min(winners, 2);
        } else {
            let winners = 0;
            let trumps = 0;
            for (const c of hand) {
                const isTrumpCard = c.suit === 'joker' || c.suit === trump.suit;
                if (isTrumpCard) trumps++;
                if (c.rank === 'HI' || c.rank === 'LO') winners++;
                else if (isTrumpCard && RANK_VALUES[c.rank] >= RANK_VALUES['Q']) winners++;
            }
            // Two trump cards: the higher one usually scores a trick
            if (winners === 0 && trumps === 2) winners = 1;
            bid = Math.min(winners, 2);
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

    // An opponent bored: either they sweep (we're set regardless of our bid)
    // or we take a trick and set them. Keep our own bid minimal.
    if (opponentBored) {
        bid = Math.min(bid, 1);
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

    // Personality adjustments must still respect the combined-bid cap — a
    // team bid above hand size is unmakeable — and the opponent-bore cap
    if (partnerBidValue !== null) {
        bid = Math.min(bid, Math.max(0, handSize - partnerBidValue));
    }
    if (opponentBored) {
        bid = Math.min(bid, 1);
    }
    bid = Math.max(0, Math.min(bid, handSize));

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

    switch (getBidStyle(personality)) {
        case 'conservative':
            // Sharon trims big bids by one: banks the safety, forfeits ~9
            // points of upside on hands she'd usually make anyway
            if (bid >= 3) {
                bid = bid - 1;
            }
            break;

        case 'calculated-aggressive':
            // Danny rounds up bids that just missed the next trick.
            // But don't override small-hand special logic: a 0 bid on ≤4 cards
            // means the hand genuinely lacks trick-taking power
            if (evaluation.points - baseBid >= 0.85) {
                if (baseBid === 0 && handSize <= 4) break;
                bid = Math.min(baseBid + 1, handSize);
            }
            break;

        case 'overconfident':
            // Mike misjudges his hand now and then
            if (Math.random() < 0.10) {
                bid = Math.min(baseBid + 1, handSize);
            }
            break;

        case 'adaptive': {
            // Zach compensates for his partner's observed bid error. The
            // deadband is asymmetric because well-calibrated partners run
            // ~+0.5-1 tricks over their bid by design (conservative floor
            // rounding) — only a clearly larger surplus means sandbagging.
            if (partnerHistory.length >= 3) {
                const totalError = partnerHistory.reduce((sum, h) => sum + (h.tricks - h.bid), 0);
                const avgError = totalError / partnerHistory.length;

                if (avgError < -0.5) {
                    // Partner overbids (gets set) - compensate down
                    bid = Math.max(0, bid - 1);
                } else if (avgError > 1.5) {
                    // Partner sandbags heavily - pick up the slack when the
                    // hand supports it
                    if (evaluation.points - baseBid >= 0.5) {
                        bid = Math.min(bid + 1, handSize);
                    }
                }
            }
            break;
        }

        // 'neutral' (Mary) and default: no modification
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
 * Pick which of several trick-winning cards to actually play.
 * Always prefers the cheapest BOSS winner (a card nothing left in unseen
 * hands can beat — secure AND cheap). With no boss available: highest
 * winner when securing matters, lowest when it doesn't. HI joker is held
 * back whenever an alternative does the job.
 */
function pickWinner(winners, hand, memory, trump, winningCard, secure) {
    const asc = [...winners].sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank]);
    const isHi = (c) => c.rank === 'HI' && c.suit === 'joker';

    // Cheapest non-HI boss: secure AND cheap
    const nonHiBoss = asc.filter(c => !isHi(c) && countHigherUnseen(c, hand, memory, trump) === 0);
    if (nonHiBoss.length > 0) return nonHiBoss[0];

    // HI is always boss but too valuable to spend while alternatives exist —
    // bestWithoutHiJoker arbitrates the exceptions
    if (asc.length === 1) return asc[0];
    if (secure) {
        const desc = [...winners].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);
        return bestWithoutHiJoker(desc, winningCard, trump);
    }
    return asc[0];
}

/**
 * Select optimal card when leading
 * @param {Object|null} contract - From getContractState(); null = contract-blind
 */
function selectLead(hand, trump, trumpBroken, gameState, memory, handSize, contract) {
    const legalCards = getLegalCards(hand, null, true, trump, trumpBroken, gameState.position, gameState.position);

    if (legalCards.length === 1) return legalCards[0];

    const noTrump = isNoTrump(trump);
    const opponentVoids = getOpponentVoidSuits(memory, gameState.position, trump);
    const partnerVoids = getPartnerVoidSuits(memory, gameState.position, trump);
    const effort = contract ? contract.effort : 'normal';
    const opponents = getOpponentPositions(gameState.position);

    const legalTrump = legalCards.filter(c => c.suit === 'joker' || (!noTrump && c.suit === trump.suit));
    const legalOffsuit = legalCards.filter(c => c.suit !== 'joker' && (noTrump || c.suit !== trump.suit));
    // "Safe" boss: nothing outranks it AND no known-void opponent can ruff it
    // (in no-trump, ruffs stay possible until the live joker is accounted for)
    const ruffersExist = !noTrump || countLiveJokersOutside(hand, memory, trump) > 0;
    const safeBossOffsuit = legalOffsuit.filter(c =>
        countHigherUnseen(c, hand, memory, trump) === 0 &&
        (!ruffersExist || !opponents.some(o => opponentVoids.has(`${o}:${c.suit}`))));

    // --- Maximum effort (live bore / must-win-every-trick): lead raw strength ---
    if (effort === 'max') {
        const hiJoker = legalCards.find(c => c.rank === 'HI');
        if (hiJoker) return hiJoker;
        const bossTrump = legalTrump
            .filter(c => countHigherUnseen(c, hand, memory, trump) === 0)
            .sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank])[0];
        if (bossTrump) return bossTrump;
        if (safeBossOffsuit.length > 0) return safeBossOffsuit[0];
        if (legalTrump.length > 0) {
            return legalTrump.sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank])[0];
        }
        return legalCards.sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank])[0];
    }

    // --- Only ±1 overtricks left: cash sure winners while we have the lead ---
    if (effort === 'cheap' && safeBossOffsuit.length > 0) {
        return safeBossOffsuit[0];
    }

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
 * @param {Object|null} contract - From getContractState(); null = contract-blind
 * @param {string} [playStyle] - Personality play style (see personalities.js);
 *   styles never apply at 'max' effort — flavor must not bust a live bore
 */
function selectFollow(hand, playedCards, leadCard, leadPosition, trump, trumpBroken, position, memory, handSize, contract, playStyle = 'balanced') {
    const legalCards = getLegalCards(hand, leadCard, false, trump, trumpBroken, position, leadPosition);

    if (legalCards.length === 1) return legalCards[0];

    const partnerPosition = getPartnerPosition(position);
    const { card: winningCard, position: winnerPosition } = getCurrentWinner(playedCards, leadPosition, trump);
    const partnerIsWinning = winnerPosition === partnerPosition;
    const partnerHasPlayed = playedCards[partnerPosition - 1] != null;
    const effort = contract ? contract.effort : 'normal';

    const leadSuit = leadCard.suit === 'joker' ? trump.suit : leadCard.suit;

    // Check if we can follow suit
    const followCards = legalCards.filter(c => {
        const suit = c.suit === 'joker' ? trump.suit : c.suit;
        return suit === leadSuit;
    });

    const canFollow = followCards.length > 0;

    const opponentsRemain = hasOpponentsAfterMe(playedCards, position);

    const effortIsMax = effort === 'max';

    if (canFollow) {
        // We can follow suit
        if (partnerIsWinning && partnerHasPlayed) {
            const partnerVulnerable = isWinVulnerable(winningCard, leadCard, trump, memory, playedCards, position, hand);

            // Mike sometimes overtakes a partner who is winning just fine
            if (playStyle === 'erratic' && !effortIsMax && !partnerVulnerable && Math.random() < 0.12) {
                const higherCards = followCards.filter(c => canBeatCard(c, winningCard, leadCard, trump));
                if (higherCards.length > 0) {
                    return pickWinner(higherCards, hand, memory, trump, winningCard, true);
                }
            }

            // If opponents still play after us and partner's win is vulnerable, overtake it
            if (opponentsRemain && partnerVulnerable) {
                const higherCards = followCards.filter(c => canBeatCard(c, winningCard, leadCard, trump));
                if (higherCards.length > 0) {
                    return pickWinner(higherCards, hand, memory, trump, winningCard, true);
                }
            }
            // Partner's win is good, or we can't beat it — play low
            return followCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
        }

        // Try to win
        const winners = followCards.filter(c => canBeatCard(c, winningCard, leadCard, trump));
        if (winners.length > 0) {
            if (opponentsRemain) {
                // Sharon won't spend honors on a contested trick — she ducks
                // unless she holds a sure (boss) winner
                if (playStyle === 'hoarding' && !effortIsMax) {
                    const sureWinners = winners.filter(c =>
                        !(c.rank === 'HI' && c.suit === 'joker') &&
                        countHigherUnseen(c, hand, memory, trump) === 0);
                    if (sureWinners.length === 0) {
                        return followCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
                    }
                }
                // Danny reaches straight for the big card a cheaper winner
                // would have held with
                if (playStyle === 'flashy' && !effortIsMax) {
                    const desc = [...winners].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);
                    return bestWithoutHiJoker(desc, winningCard, trump);
                }
                // Cheapest boss winner when we have one, else highest to fight
                // for the trick (HI joker preserved when alternatives exist)
                return pickWinner(winners, hand, memory, trump, winningCard, true);
            }

            // No opponents remain — the lowest winner always holds the trick
            return winners.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
        }

        // Can't win - play lowest
        return followCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
    }

    // We're void in lead suit
    const trumpCards = legalCards.filter(c => c.suit === trump.suit || c.suit === 'joker');
    const nonTrumpCards = legalCards.filter(c => c.suit !== trump.suit && c.suit !== 'joker');

    if (partnerIsWinning && partnerHasPlayed) {
        // When sweeping is mandatory, secure a vulnerable partner win with trump
        if (effort === 'max' && opponentsRemain && trumpCards.length > 0 &&
            isWinVulnerable(winningCard, leadCard, trump, memory, playedCards, position, hand)) {
            const winningIsTrump = winningCard.suit === trump.suit || winningCard.suit === 'joker';
            const candidates = winningIsTrump
                ? trumpCards.filter(c => RANK_VALUES[c.rank] > RANK_VALUES[winningCard.rank])
                : trumpCards;
            if (candidates.length > 0) {
                return pickWinner(candidates, hand, memory, trump, winningCard, true);
            }
        }
        // Partner winning - don't trump, just discard
        if (nonTrumpCards.length > 0) {
            return selectDiscard(nonTrumpCards, trump, trumpCards.length > 0, memory, hand);
        }
        return trumpCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
    }

    // Opponent winning - try to trump
    if (trumpCards.length > 0) {
        const winningIsTrump = winningCard.suit === trump.suit || winningCard.suit === 'joker';
        const candidates = winningIsTrump
            ? trumpCards.filter(c => RANK_VALUES[c.rank] > RANK_VALUES[winningCard.rank])
            : trumpCards;

        if (candidates.length > 0) {
            if (opponentsRemain) {
                if (playStyle === 'flashy' && !effortIsMax) {
                    const desc = [...candidates].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);
                    return bestWithoutHiJoker(desc, winningCard, trump);
                }
                return pickWinner(candidates, hand, memory, trump, winningCard, true);
            }
            return candidates.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
        }

        // Can't overtrump - discard
        if (nonTrumpCards.length > 0) {
            return selectDiscard(nonTrumpCards, trump, true, memory, hand);
        }
        return trumpCards.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
    }

    // No trump available - discard
    return selectDiscard(legalCards, trump, false, memory, hand);
}

/**
 * Select a card to discard (when we can't win)
 * @param {Array} cards - Available cards to discard from
 * @param {Object} trump - Trump card
 * @param {boolean} hasTrumpInHand - Whether bot holds any trump cards
 * @param {Object|null} [memory] - Card memory; enables boss-card protection
 * @param {Array} [fullHand] - Complete current hand (for boss detection)
 */
function selectDiscard(cards, trump, hasTrumpInHand, memory = null, fullHand = null) {
    const nonTrump = cards.filter(c => c.suit !== trump.suit && c.suit !== 'joker');
    const pool = nonTrump.length > 0 ? nonTrump : cards;

    // A card is worth protecting if nothing left in unseen hands beats it
    // (established winner), or — without memory — if it's an Ace or King
    const isProtected = (c) => {
        if (memory && fullHand) return countHigherUnseen(c, fullHand, memory, trump) === 0;
        return c.rank === 'A' || c.rank === 'K';
    };

    if (!hasTrumpInHand) {
        // No trump = voiding is pointless. Keep suit coverage and winners,
        // dump the lowest unprotected card.
        const sorted = [...pool].sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank]);
        return sorted.find(c => !isProtected(c)) || sorted[0];
    }

    // Has trump - try to void shortest suit, but protect established winners
    const bySuit = {};
    for (const card of pool) {
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
        const candidate = bySuit[shortestSuit]
            .sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];

        // Don't slough a winner to complete a void - find a lower card elsewhere
        if (isProtected(candidate)) {
            const allSorted = [...pool]
                .sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank]);
            const lowerCard = allSorted.find(c => !isProtected(c));
            if (lowerCard) return lowerCard;
            // Everything is a winner - discard the lowest-ranked one
            return allSorted[0];
        }

        return candidate;
    }

    return pool.sort((a, b) => RANK_VALUES[a.rank] - RANK_VALUES[b.rank])[0];
}

/**
 * Select optimal card to play
 * @param {Object|null} playContext - Contract state from BotController.buildPlayContext;
 *   null falls back to contract-blind tactics (used by older callers/tests)
 * @param {string} [personality] - Personality key; its playStyle flavors following
 */
function selectOptimalCard(hand, playedCards, leadCard, leadPosition, trump, trumpBroken, position, memory, handSize, playContext = null, personality = 'mary') {
    const isLeading = !leadCard || playedCards.every(c => c === undefined || c === null);
    const contract = getContractState(playContext, position, handSize);

    if (isLeading) {
        return selectLead(hand, trump, trumpBroken, { position }, memory, handSize, contract);
    }

    return selectFollow(hand, playedCards, leadCard, leadPosition, trump, trumpBroken, position, memory, handSize, contract, getPlayStyle(personality));
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
    applyBidModifier,
    hasOpponentsAfterMe,
    isWinVulnerable,
    bestWithoutHiJoker,
    countHigherUnseen,
    countLockedWinners,
    analyzeLeadSweep,
    decideBore,
    BORE_TUNING,
    NEXT_BORE,
    getContractState,
    pickWinner
};

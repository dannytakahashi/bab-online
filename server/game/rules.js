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
 * @param {number} [seatCount=4] - seats at the table (3 in Get Your Bid)
 * @returns {number} - Next position
 */
function rotatePosition(position, seatCount = 4) {
    return (position % seatCount) + 1;
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
 * @param {boolean} [solo=false] - no partners (Get Your Bid): every other
 *   seat is an opponent of the HI joker's lead
 * @returns {boolean}
 */
function isLegalMove(card, hand, leadCard, isLeading, trump, trumpBroken, playPosition, leadPosition, solo = false) {
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
    if (leadCard.rank === 'HI' && (solo ? playPosition !== leadPosition : playPosition % 2 !== leadPosition % 2)) {
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
 *   trumpBroken: boolean, position: number, leadPosition: number|null,
 *   solo?: boolean}} trick - solo: no partners (Get Your Bid)
 * @returns {boolean}
 */
function isLegalPlay(card, hand, { leadCard, isLeading, trump, trumpBroken, position, leadPosition, solo = false }) {
    const i = hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
    if (i === -1) return false;
    const remaining = hand.slice(0, i).concat(hand.slice(i + 1));
    return isLeading
        ? isLegalMove(card, remaining, card, true, trump, trumpBroken, position, position, solo)
        : isLegalMove(card, remaining, leadCard, false, trump, trumpBroken, position, leadPosition, solo);
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
 * @param {number} [seatCount=4] - seats at the table (3 in Get Your Bid)
 * @returns {number} - Winning position (1-4)
 */
function determineWinner(trick, leadPosition, trump, seatCount = 4) {
    let winner = leadPosition;
    const leadCard = trick[leadPosition - 1];
    const leadSuit = leadCard.suit === 'joker' ? trump.suit : leadCard.suit;

    for (let i = 1; i < seatCount; i++) {
        let checkPos = leadPosition + i;
        if (checkPos > seatCount) checkPos -= seatCount;

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
 * Whether one seat's bid was spot on this hand (superlatives' My
 * Quantitative, owner 2026-11-20): a numeric bid the seat's own tricks
 * matched exactly (a 0 bid with no trick counts). A bore is the team's
 * contract for every trick of the hand, so on a team with a bore bid (either
 * seat) both seats are spot on exactly when the team took every trick, the
 * way rules.seatBags treats that team as one contract.
 * @param {string|number} bid - the seat's bid ('0'..'13', 'B', '2B', ...)
 * @param {number} took - tricks the seat won this hand
 * @param {string|number} partnerBid - the partner's bid this hand
 * @param {number} teamTook - tricks the seat's team won this hand
 * @param {number} handSize - cards per player this hand
 * @returns {0|1}
 */
function seatSpotOn(bid, took, partnerBid, teamTook, handSize) {
    const s = String(bid ?? '');
    if (s.includes('B') || String(partnerBid ?? '').includes('B')) {
        return (Number(teamTook) || 0) === (Number(handSize) || 0) && Number(handSize) > 0 ? 1 : 0;
    }
    if (!/^\d+$/.test(s)) return 0;
    return (Number(took) || 0) === parseInt(s, 10) ? 1 : 0;
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
function findHighestBidder(startPosition, bids, seatCount = 4) {
    let maxIndex = startPosition - 1;
    let maxValue = bidLeadRank(bids[maxIndex]);
    let spot = startPosition - 1;

    for (let i = 0; i < seatCount; i++) {
        const bidValue = bidLeadRank(bids[spot]);
        if (bidValue > maxValue) {
            maxIndex = spot;
            maxValue = bidValue;
        }
        spot = (spot + 1) % seatCount;
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

const DRAW_SUIT_ORDER = { clubs: 0, diamonds: 1, hearts: 2, spades: 3, joker: 4 };

/**
 * How many of `allCards` `myCard` beats in the draw (0..3 over four drawn
 * cards): rank first (RANK_VALUES: 2 low .. A, then LO 15 < HI 16), then
 * suit clubs < diamonds < hearts < spades < joker. The 54 cards are
 * distinct and every one has its own (rank, suit) place, so over four drawn
 * cards the counts are always 0, 1, 2 and 3: a draw never ties.
 * @param {Object} myCard - Card drawn by player
 * @param {Array} allCards - All cards drawn
 * @returns {number}
 */
function drawBeats(myCard, allCards) {
    let beats = 0;
    for (const card of allCards) {
        if (RANK_VALUES[myCard.rank] > RANK_VALUES[card.rank]) {
            beats++;
        } else if (RANK_VALUES[myCard.rank] === RANK_VALUES[card.rank] &&
                   DRAW_SUIT_ORDER[myCard.suit] > DRAW_SUIT_ORDER[card.suit]) {
            beats++;
        }
    }
    return beats;
}

/**
 * Determine draw order position based on card drawn (the ordinary draw:
 * the two highest cards are partners at 1 and 3, the highest at 1 deals
 * first; the third highest at 2 bids first)
 * @param {Object} myCard - Card drawn by player
 * @param {Array} allCards - All cards drawn
 * @returns {number} - Position (1-4)
 */
function determineDrawPosition(myCard, allCards) {
    // Handle position 2/3 swap
    const position = 4 - drawBeats(myCard, allCards);
    if (position === 2) return 3;
    if (position === 3) return 2;
    return position;
}


// ============================================================
// Get Your Bid (owner 2026-11-24): the 3-player, no-teams mode a lobby may
// choose. Card play is the base game's (every other seat is an opponent of
// a HI joker lead: isLegalMove's `solo`); bidding and scoring are these.
// ============================================================

/** Seats at a Get Your Bid table. */
const GYB_SEATS = 3;
/** The Forbidden Bid applies only to hands of at least this many cards. */
const GYB_FORBIDDEN_MIN_HAND = 5;

/**
 * The Forbidden Bid of the LAST bidder (Get Your Bid): on a hand of 5 or
 * more cards the bids may not add up to the hand, so the last bidder may
 * not bid `handSize - (the other bids)`. Null while it does not apply: a
 * smaller hand, a seat that is not the last to bid, or bids that already
 * exceed the hand.
 * @param {Array} playerBids - the deal's bids so far, by position - 1
 * @param {number} handSize
 * @param {number} [seatCount=3]
 * @returns {number|null}
 */
function gybForbiddenBid(playerBids, handSize, seatCount = GYB_SEATS) {
    if (!(handSize >= GYB_FORBIDDEN_MIN_HAND)) return null;
    const placed = [];
    for (let i = 0; i < seatCount; i++) if (playerBids[i] != null) placed.push(playerBids[i]);
    if (placed.length !== seatCount - 1) return null;
    const left = handSize - placed.reduce((sum, b) => sum + (parseInt(b, 10) || 0), 0);
    return left >= 0 ? left : null;
}

/** Get Your Bid bid legality: a number up to the hand (no bores), never the Forbidden Bid. */
function isValidGybBid(bid, playerBids, handSize, seatCount = GYB_SEATS) {
    if (!/^\d+$/.test(bid) || Number(bid) > handSize) return false;
    return Number(bid) !== gybForbiddenBid(playerBids, handSize, seatCount);
}

/** The fallback bid of a failing bot or a bid clock timeout: '0', or '1' when 0 is the Forbidden Bid. */
function gybSafeBid(playerBids, handSize, seatCount = GYB_SEATS) {
    return gybForbiddenBid(playerBids, handSize, seatCount) === 0 ? '1' : '0';
}

/**
 * One seat's points for a hand of Get Your Bid: exactly the bid scores 10
 * plus the bid (an exact 0 scores 5); anything else scores nothing, except
 * 1 point for the seat that took exactly its Forbidden Bid. Never negative.
 * @param {string|number} bid
 * @param {number} took - tricks the seat won this hand
 * @param {number|null} [forbidden] - this seat's Forbidden Bid, if it had one
 * @returns {number}
 */
function gybHandScore(bid, took, forbidden = null) {
    const b = parseInt(bid, 10) || 0;
    const t = Number(took) || 0;
    if (t === b) return b === 0 ? 5 : 10 + b;
    return forbidden != null && t === forbidden ? 1 : 0;
}

/**
 * Seat order from the draw at a 3-seat table: the highest card sits at 1,
 * then 2, then 3 (no teams, so no 2/3 swap).
 */
function gybDrawPosition(myCard, allCards) {
    const suitOrder = { clubs: 0, diamonds: 1, hearts: 2, spades: 3, joker: 4 };
    let rank = 0;
    for (const card of allCards) {
        if (RANK_VALUES[myCard.rank] > RANK_VALUES[card.rank]) rank++;
        else if (RANK_VALUES[myCard.rank] === RANK_VALUES[card.rank] && suitOrder[myCard.suit] > suitOrder[card.suit]) rank++;
    }
    return allCards.length - rank;
}

/**
 * Seats for a table whose teams are fixed before the draw (a tournament
 * round's plan, tournamentPartners): the team holding the highest of the
 * four cards sits 1 & 3, that card at 1 (it deals first: game.dealer
 * starts at 1), its partner at 3; the other team 2 & 4, its higher card at
 * 2 (it bids first). Equals determineDrawPosition whenever the partners
 * hold the two highest or the two lowest cards (the draws where the casual
 * rule would have paired them too).
 * @param {Array<{suit, rank}>} drawCards - the four drawn cards, in draw order
 * @param {string[]} drawIDs - who drew each (same order)
 * @param {Array<[string, string]>} teams - the two planned teams of socket ids
 * @returns {Map<string, 1|2|3|4>|null} socket id -> position; null on
 *   malformed input (the caller falls back to determineDrawPosition)
 */
function seatPlannedTeams(drawCards, drawIDs, teams) {
    if (!Array.isArray(drawCards) || !Array.isArray(drawIDs) || drawCards.length !== 4 || drawIDs.length !== 4) return null;
    if (!Array.isArray(teams) || teams.length !== 2 || teams.some((t) => !Array.isArray(t) || t.length !== 2)) return null;
    if (drawCards.some((c) => !c || RANK_VALUES[c.rank] === undefined || DRAW_SUIT_ORDER[c.suit] === undefined)) return null;
    const ids = teams.flat();
    if (new Set(drawIDs).size !== 4 || new Set(ids).size !== 4 || ids.some((id) => !drawIDs.includes(id))) return null;
    const beats = new Map(drawIDs.map((id, i) => [id, drawBeats(drawCards[i], drawCards)]));
    if (new Set(beats.values()).size !== 4) return null;
    const high = teams.find((t) => t.some((id) => beats.get(id) === 3));
    const low = teams.find((t) => t !== high);
    const order = (t) => [...t].sort((a, b) => beats.get(b) - beats.get(a));
    const [h1, h3] = order(high);
    const [l2, l4] = order(low);
    return new Map([[h1, 1], [l2, 2], [h3, 3], [l4, 4]]);
}

// Hand Strength Index: server/game/hsi.js (expected share of the tricks, on the
// 55 .. 130 (average) .. 355 scale)
const { calculateHSI } = require('./hsi');

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
    seatSpotOn,
    normalizeSeatBags,
    // the same {hands, byPos} counter shape: game.seatExact (My Quantitative)
    normalizeSeatCounter: normalizeSeatBags,
    findHighestBidder,
    calculateMultiplier,
    drawBeats,
    determineDrawPosition,
    seatPlannedTeams,
    calculateHSI,
    GYB_SEATS,
    GYB_FORBIDDEN_MIN_HAND,
    gybForbiddenBid,
    isValidGybBid,
    gybSafeBid,
    gybHandScore,
    gybDrawPosition
};

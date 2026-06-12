/**
 * Bot integrity tests:
 *  1. Legality invariant — across randomized full hands (all sizes, all trump
 *     types including no-trump, all personalities, live bores), every card a
 *     bot selects must be in its hand and legal per rules.isLegalMove.
 *  2. Contract-aware behavior — bots must execute bores (lead strength, not
 *     junk), defend against opponent bores, and read the contract state.
 */

const rules = require('../../rules');
const BotPlayer = require('../BotPlayer');
const {
    selectLead,
    selectFollow,
    getContractState,
    countHigherUnseen
} = require('../BotStrategy');

const card = (suit, rank) => ({ suit, rank });
const HI = card('joker', 'HI');
const LO = card('joker', 'LO');

// Deterministic RNG so failures are reproducible
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function freshDeck(rng) {
    const cards = [];
    for (const suit of SUITS) for (const rank of RANKS) cards.push({ suit, rank });
    cards.push({ ...HI });
    cards.push({ ...LO });
    for (let i = cards.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
}

const isBore = (b) => ['B', '2B', '3B', '4B'].includes(b);

/**
 * Play one full randomized hand with 4 bots, asserting every selection is
 * legal. Returns per-team trick counts.
 * @param {boolean} forceBore - Overwrite seat 1's bid with 'B' so multi-trick
 *   bore execution paths are exercised deterministically (bots rarely bore
 *   organically on larger random hands)
 */
function playLegalHand(rng, handSize, personalities, forceNoTrump, forceBore = false) {
    const deck = freshDeck(rng);
    let trump;
    if (forceNoTrump) {
        const jokerIdx = deck.findIndex(c => c.suit === 'joker');
        trump = deck.splice(jokerIdx, 1)[0];
    } else {
        trump = deck[4 * handSize];
    }

    const bots = {};
    const hands = {};
    for (let p = 1; p <= 4; p++) {
        bots[p] = new BotPlayer(`🤖 Test${p}`, personalities[p - 1]);
        bots[p].assignToGame('test-game', p, p);
        bots[p].resetCardMemory(handSize, trump);
        hands[p] = deck.slice((p - 1) * handSize, p * handSize);
    }

    // Bidding
    const playerBids = [undefined, undefined, undefined, undefined];
    const firstBidder = 1 + Math.floor(rng() * 4);
    for (let i = 0; i < 4; i++) {
        const pos = ((firstBidder - 1 + i) % 4) + 1;
        const bid = bots[pos].decideBid(hands[pos].slice(), trump, playerBids, handSize,
            { teamScore: 0, oppScore: 0, currentHandSize: handSize });
        expect(typeof bid).toBe('string');
        if (!isBore(bid)) {
            const n = parseInt(bid, 10);
            expect(Number.isNaN(n)).toBe(false);
            expect(n).toBeGreaterThanOrEqual(0);
            expect(n).toBeLessThanOrEqual(handSize);
        }
        playerBids[pos - 1] = bid;
    }

    if (forceBore) {
        playerBids[0] = 'B';
    }

    const teamBid = {
        team1: Math.min(handSize, (rules.BID_RANKS[playerBids[0]] || 0) + (rules.BID_RANKS[playerBids[2]] || 0)),
        team2: Math.min(handSize, (rules.BID_RANKS[playerBids[1]] || 0) + (rules.BID_RANKS[playerBids[3]] || 0))
    };

    // Play
    let lead = rules.findHighestBidder(firstBidder, playerBids) + 1;
    let trumpBroken = false;
    const teamTricks = { team1: 0, team2: 0 };

    for (let t = 0; t < handSize; t++) {
        const playedCards = [undefined, undefined, undefined, undefined];
        let leadCard = null;
        const leadPosition = lead;
        for (let i = 0; i < 4; i++) {
            const pos = ((lead - 1 + i) % 4) + 1;
            const isLeading = i === 0;
            const hand = hands[pos];
            const playContext = {
                playerBids,
                bids: teamBid,
                tricks: { ...teamTricks },
                team1Mult: rules.calculateMultiplier(playerBids[0], playerBids[2]),
                team2Mult: rules.calculateMultiplier(playerBids[1], playerBids[3])
            };

            const chosen = bots[pos].decideCard(hand.slice(), playedCards,
                isLeading ? null : leadCard, isLeading ? null : leadPosition,
                trump, trumpBroken, handSize, playContext);

            // THE invariant: the chosen card is in hand and legal
            const inHand = hand.find(c => c.suit === chosen.suit && c.rank === chosen.rank);
            expect(inHand).toBeDefined();
            const remaining = hand.filter(c => c !== inHand);
            const legal = rules.isLegalMove(inHand, remaining, leadCard || inHand, isLeading,
                trump, trumpBroken, pos, isLeading ? pos : leadPosition);
            if (!legal) {
                throw new Error(`Illegal card ${chosen.rank} of ${chosen.suit} ` +
                    `(hand: ${hand.map(c => `${c.rank}${c.suit[0]}`).join(' ')}, ` +
                    `trump: ${trump.rank} of ${trump.suit}, lead: ${leadCard ? `${leadCard.rank} of ${leadCard.suit}` : 'none'}, ` +
                    `trumpBroken: ${trumpBroken})`);
            }

            hands[pos] = remaining;
            playedCards[pos - 1] = inHand;
            if (isLeading) leadCard = inHand;
            if (inHand.suit === trump.suit || inHand.suit === 'joker') trumpBroken = true;
            for (let q = 1; q <= 4; q++) bots[q].recordCardPlayed(inHand, pos, trump, leadPosition);
        }
        const winner = rules.determineWinner(playedCards, leadPosition, trump);
        expect(winner).toBeGreaterThanOrEqual(1);
        expect(winner).toBeLessThanOrEqual(4);
        teamTricks[winner === 1 || winner === 3 ? 'team1' : 'team2']++;
        for (let q = 1; q <= 4; q++) bots[q].advanceTrick();
        lead = winner;
    }

    // Every card must have been played — a falsifiable end-state check
    for (let p = 1; p <= 4; p++) expect(hands[p]).toHaveLength(0);

    return teamTricks;
}

describe('legality invariant (fuzz)', () => {
    const realRandom = Math.random;
    let rng;

    beforeAll(() => {
        rng = mulberry32(20260611);
        Math.random = () => rng(); // Mike's modifier and erratic play use Math.random
    });

    afterAll(() => {
        Math.random = realRandom;
    });

    const HAND_SIZES = [12, 10, 8, 6, 4, 2, 1, 3, 5, 7, 9, 11, 13];
    const PERSONALITY_SETS = [
        ['mary', 'mary', 'mary', 'mary'],
        ['sharon', 'danny', 'mike', 'zach']
    ];

    test.each(HAND_SIZES)('%i-card hands: every bot selection is legal', (handSize) => {
        for (const personalities of PERSONALITY_SETS) {
            for (let iter = 0; iter < 4; iter++) {
                const tricks = playLegalHand(rng, handSize, personalities, false);
                expect(tricks.team1 + tricks.team2).toBe(handSize);
            }
        }
    });

    test('no-trump hands: every bot selection is legal', () => {
        for (const handSize of HAND_SIZES) {
            for (const personalities of PERSONALITY_SETS) {
                const tricks = playLegalHand(rng, handSize, personalities, true);
                expect(tricks.team1 + tricks.team2).toBe(handSize);
            }
        }
    });

    test('live bores (forced): every bot selection is legal at max effort', () => {
        for (const handSize of HAND_SIZES) {
            for (const personalities of PERSONALITY_SETS) {
                const tricks = playLegalHand(rng, handSize, personalities, false, true);
                expect(tricks.team1 + tricks.team2).toBe(handSize);
            }
        }
    });
});

describe('contract awareness', () => {
    const heartsTrump = card('hearts', '5');
    const freshMemory = () => ({
        playedCards: [],
        trumpPlayed: [],
        acesPlayed: { spades: false, hearts: false, diamonds: false, clubs: false },
        trickIndex: 0,
        totalCardsPlayed: 0
    });

    test('getContractState: live bore demands max effort', () => {
        const ctx = {
            playerBids: ['B', '0', '0', '0'],
            bids: { team1: 3, team2: 0 },
            tricks: { team1: 0, team2: 0 },
            team1Mult: 2, team2Mult: 1
        };
        const contract = getContractState(ctx, 1, 3);
        expect(contract.teamBored).toBe(true);
        expect(contract.effort).toBe('max');
    });

    test('getContractState: opponent bore is max effort until a trick is taken', () => {
        const ctx = {
            playerBids: ['0', 'B', '0', '0'],
            bids: { team1: 0, team2: 5 },
            tricks: { team1: 0, team2: 0 },
            team1Mult: 1, team2Mult: 2
        };
        expect(getContractState(ctx, 1, 5).effort).toBe('max');

        // After our team takes one trick, their bore is dead
        const after = {
            ...ctx,
            tricks: { team1: 1, team2: 1 }
        };
        expect(getContractState(after, 1, 5).effort).toBe('cheap');
    });

    test('getContractState: both bids made leaves only overtricks (cheap)', () => {
        const ctx = {
            playerBids: ['2', '1', '0', '0'],
            bids: { team1: 2, team2: 1 },
            tricks: { team1: 2, team2: 1 },
            team1Mult: 1, team2Mult: 1
        };
        expect(getContractState(ctx, 1, 6).effort).toBe('cheap');
    });

    test('boring bot leads its strongest trump, not its lowest', () => {
        // Regression: the borer used to lead LOW from a trump-tight hand,
        // handing the first trick away and busting its own bore
        const hand = [card('hearts', '3'), card('hearts', '9'), card('hearts', 'K')];
        const ctx = {
            playerBids: ['B', '0', '0', '0'],
            bids: { team1: 3, team2: 0 },
            tricks: { team1: 0, team2: 0 },
            team1Mult: 2, team2Mult: 1
        };
        const contract = getContractState(ctx, 1, 3);
        const result = selectLead(hand, heartsTrump, false, { position: 1 }, freshMemory(), 3, contract);
        expect(result.rank).toBe('K');
    });

    test('at max effort a void bot trumps to secure partner\'s vulnerable win', () => {
        // Partner (pos 3) winning with the spade King, the Ace is unseen and
        // an opponent still acts. Contract-blind play discards; a live bore
        // must secure the trick with trump.
        const hand = [card('hearts', '9'), card('clubs', '2')];
        const playedCards = [undefined, card('spades', '5'), card('spades', 'K'), undefined];
        const leadCard = card('spades', '5');

        const blind = selectFollow(hand, playedCards, leadCard, 2, heartsTrump, false, 1, freshMemory(), 4, null);
        expect(blind.suit).toBe('clubs'); // discards, saves trump

        const ctx = {
            playerBids: ['B', '0', '0', '0'],
            bids: { team1: 4, team2: 0 },
            tricks: { team1: 0, team2: 0 },
            team1Mult: 2, team2Mult: 1
        };
        const contract = getContractState(ctx, 1, 4);
        const secured = selectFollow(hand, playedCards, leadCard, 2, heartsTrump, false, 1, freshMemory(), 4, contract);
        expect(secured.suit).toBe('hearts'); // trumps in to guarantee the sweep
    });

    test('countHigherUnseen excludes the flipped card, own hand, and played cards', () => {
        const memory = freshMemory();
        // Trump is hearts 5 (flipped). Holding hearts K; hearts A was played.
        memory.playedCards.push({ suit: 'hearts', rank: 'A', position: 2, trickIndex: 0, isLead: true });
        const hand = [card('hearts', 'K'), card('hearts', 'Q')];
        // Higher than K among trump: A (played), LO, HI (both unseen) => 2
        expect(countHigherUnseen(card('hearts', 'K'), hand, memory, heartsTrump)).toBe(2);
        // Higher than Q: K is in our own hand, A played => still just the jokers
        expect(countHigherUnseen(card('hearts', 'Q'), hand, memory, heartsTrump)).toBe(2);
    });

    test('countHigherUnseen treats the flipped trump card itself as out of play', () => {
        // Trump Ace flipped: only the jokers outrank the King. Without the
        // flipped-card exclusion this would count the Ace too and read 3.
        const flippedAce = card('hearts', 'A');
        expect(countHigherUnseen(card('hearts', 'K'), [card('hearts', 'K')], freshMemory(), flippedAce)).toBe(2);
    });
});

describe('personality play styles', () => {
    const heartsTrump = card('hearts', '5');
    const freshMemory = () => ({
        playedCards: [],
        trumpPlayed: [],
        acesPlayed: { spades: false, hearts: false, diamonds: false, clubs: false },
        trickIndex: 0,
        totalCardsPlayed: 0
    });

    // Opponent (pos 2) led and is winning with the spade Queen; we (pos 1)
    // hold K and 3 of spades; partner (pos 3) and opponent (pos 4) still act.
    // The King beats the Queen but is not boss (Ace unseen).
    const contestedTrick = () => ({
        hand: [card('spades', 'K'), card('spades', '3')],
        playedCards: [undefined, card('spades', 'Q'), undefined, undefined],
        leadCard: card('spades', 'Q')
    });

    test('hoarding (Sharon) ducks a contested trick with no boss winner', () => {
        const { hand, playedCards, leadCard } = contestedTrick();
        const result = selectFollow(hand, playedCards, leadCard, 2, heartsTrump, false, 1, freshMemory(), 8, null, 'hoarding');
        expect(result.rank).toBe('3');
    });

    test('hoarding (Sharon) still takes the trick with a boss winner', () => {
        const { playedCards, leadCard } = contestedTrick();
        const hand = [card('spades', 'A'), card('spades', '3')]; // Ace is boss
        const result = selectFollow(hand, playedCards, leadCard, 2, heartsTrump, false, 1, freshMemory(), 8, null, 'hoarding');
        expect(result.rank).toBe('A');
    });

    test('balanced (Mary) fights the same contested trick', () => {
        const { hand, playedCards, leadCard } = contestedTrick();
        const result = selectFollow(hand, playedCards, leadCard, 2, heartsTrump, false, 1, freshMemory(), 8, null, 'balanced');
        expect(result.rank).toBe('K');
    });

    test('flashy (Danny) spends the Ace where balanced wins cheaply with the boss King', () => {
        const { playedCards, leadCard } = contestedTrick();
        // Holding A-K over the Queen: our own Ace makes the King boss, so
        // balanced wins as cheaply as possible while flashy slams the Ace
        const hand = [card('spades', 'A'), card('spades', 'K')];

        const balanced = selectFollow(hand, playedCards, leadCard, 2, heartsTrump, false, 1, freshMemory(), 8, null, 'balanced');
        expect(balanced.rank).toBe('K');

        const flashy = selectFollow(hand, playedCards, leadCard, 2, heartsTrump, false, 1, freshMemory(), 8, null, 'flashy');
        expect(flashy.rank).toBe('A');
    });

    test('erratic (Mike) overtakes a safely winning partner when the dice say so', () => {
        // Partner (pos 3) winning with the spade Queen — safe only because we
        // hold the A and K ourselves. Mary plays the 3; Mike sometimes can't help himself.
        const hand = [card('spades', 'A'), card('spades', 'K'), card('spades', '3')];
        const playedCards = [undefined, card('spades', '5'), card('spades', 'Q'), undefined];
        const leadCard = card('spades', '5');

        const realRandom = Math.random;
        try {
            Math.random = () => 0.05; // below the 0.12 erratic threshold
            const overtaken = selectFollow(hand, playedCards, leadCard, 2, heartsTrump, false, 1, freshMemory(), 8, null, 'erratic');
            expect(overtaken.rank).toBe('K');

            Math.random = () => 0.5; // above the threshold — plays low like Mary
            const normal = selectFollow(hand, playedCards, leadCard, 2, heartsTrump, false, 1, freshMemory(), 8, null, 'erratic');
            expect(normal.rank).toBe('3');
        } finally {
            Math.random = realRandom;
        }
    });
});

describe('overconfident bid modifier (deterministic)', () => {
    const { applyBidModifier } = require('../BotStrategy');
    const makeEval = (points) => ({ points, trumpCount: 0, voids: 0, suitCounts: {}, hasHighJoker: false, hasLowJoker: false, hasTrumpAce: false });

    test('mike overbids exactly when the roll is under 0.10', () => {
        const realRandom = Math.random;
        try {
            Math.random = () => 0.05;
            expect(applyBidModifier(3, 'mike', makeEval(3.0), 12, [])).toBe(4);
            Math.random = () => 0.15;
            expect(applyBidModifier(3, 'mike', makeEval(3.0), 12, [])).toBe(3);
        } finally {
            Math.random = realRandom;
        }
    });
});

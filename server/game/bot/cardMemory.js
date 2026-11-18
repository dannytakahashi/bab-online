/**
 * A bot's card memory: every card it has seen played this hand, by whom and
 * in which trick. Pure functions over a plain object, so the same memory can
 * be built without a BotPlayer (which would mint a uuid): BotPlayer keeps
 * one in `this.cardMemory` and delegates here, and `fromHistory` rebuilds
 * the snapshot a seat would have from the public record of the hand
 * (GameState.trickHistory plus the open trick, server/game/tableView.js).
 *
 * Nothing here reads a clock or Math.random.
 */

'use strict';

/** A fresh memory for the start of a hand. */
function resetCardMemory() {
    return {
        playedCards: [],
        trumpPlayed: [],
        acesPlayed: {
            spades: false,
            hearts: false,
            diamonds: false,
            clubs: false
        },
        trickIndex: 0
    };
}

/**
 * Record a card played in the current trick.
 * @param {Object|null} memory - from resetCardMemory (null: ignored)
 * @param {Object} card - { suit, rank }
 * @param {number} position - who played it (1-4)
 * @param {Object} trump - the trump card, for what counts as trump
 * @param {number} [leadPosition] - who led the current trick. Recording this
 *   explicitly (rather than assuming the first recorded card led) keeps void
 *   inference correct for bots that join mid-trick.
 */
function recordCardPlayed(memory, card, position, trump, leadPosition) {
    if (!memory) return;

    memory.playedCards.push({
        suit: card.suit,
        rank: card.rank,
        position,
        trickIndex: memory.trickIndex,
        isLead: leadPosition !== undefined ? position === leadPosition : undefined
    });

    // Track aces
    if (card.rank === 'A' && card.suit !== 'joker') {
        memory.acesPlayed[card.suit] = true;
    }

    // Track trump cards played
    const isTrump = card.suit === 'joker' ||
        (trump.suit !== 'joker' && card.suit === trump.suit);
    if (isTrump) {
        memory.trumpPlayed.push({ rank: card.rank, position });
    }
}

/** Move on to the next trick. */
function advanceTrick(memory) {
    if (!memory) return;
    memory.trickIndex++;
}

/**
 * Fill a memory from the hand's public record: exactly what a seat that
 * watched from the deal would have recorded.
 * @param {Object|null} memory
 * @param {Object} trump
 * @param {Array<{lead: number, cards: Object[]}>} tricks - won tricks, cards
 *   in play order from `lead` (GameState.trickHistory)
 * @param {{lead: number, cards: Object[]}|null} [open] - the trick on the
 *   table, in play order (not yet counted: no advanceTrick)
 */
function replayCardMemory(memory, trump, tricks, open = null) {
    if (!memory || !trump) return;
    const play = ({ lead, cards }) => {
        cards.forEach((card, k) => {
            if (card) recordCardPlayed(memory, card, ((lead - 1 + k) % 4) + 1, trump, lead);
        });
    };
    for (const trick of tricks || []) {
        play(trick);
        advanceTrick(memory);
    }
    if (open && open.cards.length > 0) play(open);
}

/**
 * A copy of the memory for the strategy functions (keeps them pure).
 * @returns {Object|null} null when there is no memory
 */
function getMemorySnapshot(memory) {
    if (!memory) return null;
    return {
        playedCards: [...memory.playedCards],
        trumpPlayed: [...memory.trumpPlayed],
        acesPlayed: { ...memory.acesPlayed },
        trickIndex: memory.trickIndex,
        totalCardsPlayed: memory.playedCards.length
    };
}

/**
 * The snapshot a seat would hold now, from the public record alone.
 * @param {Object} trump
 * @param {Array} trickHistory - GameState.trickHistory
 * @param {{lead: number, cards: Object[]}|null} [openTrick] - tableView.openTrick(game)
 * @returns {Object} the getMemorySnapshot shape
 */
function fromHistory(trump, trickHistory, openTrick = null) {
    const memory = resetCardMemory();
    replayCardMemory(memory, trump, trickHistory, openTrick);
    return getMemorySnapshot(memory);
}

module.exports = {
    resetCardMemory,
    recordCardPlayed,
    advanceTrick,
    replayCardMemory,
    getMemorySnapshot,
    fromHistory
};

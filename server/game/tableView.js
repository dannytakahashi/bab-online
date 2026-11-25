/**
 * Read-only views of a game's table that more than one module needs. Pure:
 * nothing here changes the game.
 */

'use strict';

/**
 * The cards on the table in play order from the lead, as the bots were told
 * them (cardPlayed), or null. Through TRICK_RESOLVING the 4th card is still
 * here: resumeTrick moves the trick to trickHistory and advances the bots.
 * Used for a seat bot's card memory (seatLifecycle.createSeatBot, restore)
 * and for cardMemory.fromHistory.
 * @param {Object} game
 * @param {number} [N=4] - seats at the table (the caller's game.seatCount;
 *   not read here: assist/seatView may only read its own list of fields)
 * @returns {{lead: number, cards: Object[]}|null}
 */
function openTrick(game, N = 4) {
    if (!game.playedCardsIndex || !game.leadPosition) return null;
    const cards = [];
    for (let k = 0; k < N; k++) {
        const c = game.playedCards[((game.leadPosition - 1 + k) % N)];
        if (!c) break;
        cards.push(c);
    }
    return { lead: game.leadPosition, cards };
}

module.exports = { openTrick };

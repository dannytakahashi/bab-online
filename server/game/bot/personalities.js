/**
 * Bot personality definitions.
 * Each personality modifies Mary's base strategy with behavioral variations.
 *
 * This registry is the single source of truth: BotStrategy switches on
 * `bidStyle` (applyBidModifier) and `playStyle` (selectFollow), so adding a
 * personality here is what wires it into the strategy.
 *
 * bidStyle:
 *  - neutral:               no adjustment (Mary's calibrated bid)
 *  - conservative:          trims big bids by one — banks safety, forfeits upside
 *  - calculated-aggressive: rounds up bids that just miss the next trick
 *  - overconfident:         occasionally bids one more than the hand supports
 *  - adaptive:              compensates for the partner's observed bid error
 *
 * playStyle:
 *  - balanced: Mary's card play
 *  - hoarding: ducks contested tricks instead of spending honors to fight
 *  - flashy:   spends the big card when a cheaper winner would hold the trick
 *  - erratic:  sometimes overtakes a partner who is already safely winning
 */

const PERSONALITIES = {
    mary:   { displayName: 'Mary',   bidStyle: 'neutral',               playStyle: 'balanced' },
    sharon: { displayName: 'Sharon', bidStyle: 'conservative',          playStyle: 'hoarding' },
    danny:  { displayName: 'Danny',  bidStyle: 'calculated-aggressive', playStyle: 'flashy' },
    mike:   { displayName: 'Mike',   bidStyle: 'overconfident',         playStyle: 'erratic' },
    zach:   { displayName: 'Zach',   bidStyle: 'adaptive',              playStyle: 'balanced' }
};

const PERSONALITY_LIST = Object.keys(PERSONALITIES);

/**
 * Get display name for a personality key
 * @param {string} personality - Personality key (e.g., 'sharon')
 * @returns {string} Display name (e.g., 'Sharon')
 */
function getDisplayName(personality) {
    return PERSONALITIES[personality]?.displayName || 'Mary';
}

/**
 * Get bid style for a personality key (default: neutral)
 */
function getBidStyle(personality) {
    return PERSONALITIES[personality]?.bidStyle || 'neutral';
}

/**
 * Get play style for a personality key (default: balanced)
 */
function getPlayStyle(personality) {
    return PERSONALITIES[personality]?.playStyle || 'balanced';
}

module.exports = {
    PERSONALITIES,
    PERSONALITY_LIST,
    getDisplayName,
    getBidStyle,
    getPlayStyle
};

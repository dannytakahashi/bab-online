/**
 * Bot personality definitions.
 * Each personality modifies Mary's base strategy with behavioral variations.
 */

const PERSONALITIES = {
    mary:   { displayName: 'Mary',   bidStyle: 'neutral' },
    sharon: { displayName: 'Sharon', bidStyle: 'conservative' },
    danny:  { displayName: 'Danny',  bidStyle: 'calculated-aggressive' },
    mike:   { displayName: 'Mike',   bidStyle: 'overconfident' },
    zach:   { displayName: 'Zach',   bidStyle: 'adaptive' }
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

module.exports = {
    PERSONALITIES,
    PERSONALITY_LIST,
    getDisplayName
};

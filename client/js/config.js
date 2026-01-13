/**
 * Game configuration constants
 * Centralizes all magic numbers and layout values
 */
const GameConfig = {
    // Display dimensions
    DESIGN_WIDTH: 1920,
    DESIGN_HEIGHT: 953,

    // Card dimensions
    CARD_WIDTH: 100,
    CARD_HEIGHT: 140,
    CARD_SCALE: 1.5,

    // Player positions relative to screen
    POSITIONS: {
        PLAYER: { x: 0, y: 300 },      // Bottom (self)
        PARTNER: { x: 0, y: -300 },    // Top
        LEFT: { x: -400, y: 0 },       // Left opponent
        RIGHT: { x: 400, y: 0 }        // Right opponent
    },

    // Animation durations (ms)
    ANIMATION: {
        CARD_PLAY_DURATION: 300,
        CARD_DEAL_STAGGER: 100,
        TRICK_COLLECT_DELAY: 2000,
        CARD_HOVER_DURATION: 150,
        HAND_REPOSITION_DURATION: 200
    },

    // Timing constants (ms)
    TIMING: {
        BID_BUBBLE_DURATION: 3000,
        TURN_INDICATOR_PULSE: 1000,
        ERROR_DISPLAY_DURATION: 2000
    },

    // Card rank values for comparison
    RANK_VALUES: {
        '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
        '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
        'LO': 15, 'HI': 16
    },

    // Suit order for sorting
    SUIT_ORDER: ['spades', 'hearts', 'diamonds', 'clubs', 'joker']
};

// Freeze to prevent accidental modification
Object.freeze(GameConfig);
Object.freeze(GameConfig.POSITIONS);
Object.freeze(GameConfig.ANIMATION);
Object.freeze(GameConfig.TIMING);
Object.freeze(GameConfig.RANK_VALUES);
Object.freeze(GameConfig.SUIT_ORDER);

export default GameConfig;

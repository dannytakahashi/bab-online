/**
 * Phaser game configuration.
 *
 * Exports a function to create the config so it can be customized
 * and so we can access window dimensions at creation time.
 */

/**
 * Create Phaser game configuration.
 *
 * @param {Object} options - Config options
 * @param {string} options.parent - Parent element ID
 * @param {Object} options.scene - Scene configuration or class
 * @returns {Object} Phaser game config
 */
export function createGameConfig({
  parent = 'game-container',
  scene = null,
} = {}) {
  return {
    type: Phaser.AUTO,
    width: window.innerWidth,
    height: window.innerHeight,
    transparent: true, // Let CSS background show through
    parent,
    scale: {
      mode: Phaser.Scale.RESIZE, // Dynamic resizing for window changes
      autoCenter: Phaser.Scale.NO_CENTER, // Align left for game log space
    },
    scene: scene || [],
    physics: {
      default: 'arcade',
      arcade: {
        debug: false,
      },
    },
  };
}

/**
 * Default card dimensions and scaling.
 */
export const CARD_CONFIG = {
  // Base dimensions (from asset)
  BASE_WIDTH: 100,
  BASE_HEIGHT: 145,

  // Scale factor for display (matches legacy displayCards setScale(1.5))
  SCALE: 1.5,

  // Spacing between cards in hand (matches legacy 50px base spacing)
  HAND_SPACING: 50,

  // Z-ordering
  Z_INDEX: {
    BACKGROUND: 0,
    TABLE: 100,
    PLAYED_CARDS: 200,
    HAND: 300,
    ACTIVE_CARD: 400,
    UI: 500,
  },
};

/**
 * Animation durations in milliseconds.
 */
export const ANIMATION_CONFIG = {
  CARD_DEAL: 500,
  CARD_PLAY: 300,
  CARD_COLLECT: 500,
  CARD_HOVER: 100,
  FADE: 200,
};

/**
 * Table positions for 4 players (relative to center).
 */
export const TABLE_POSITIONS = {
  // Positions relative to screen center
  1: { x: 0, y: 0.3 }, // Bottom (me)
  2: { x: -0.3, y: 0 }, // Left
  3: { x: 0, y: -0.3 }, // Top (partner)
  4: { x: 0.3, y: 0 }, // Right
};

/**
 * Phaser game configuration.
 *
 * The canvas renders at the device pixel ratio (item 18a, ui-15 /
 * webclient-12): Phaser 3.55 has no working `resolution` setting, so the
 * game's size is the CSS size times the ratio (the backing store) with the
 * scale manager's zoom at 1 / ratio (the canvas is drawn at its CSS size),
 * and the main camera zooms by the ratio, so every game object, the table
 * layout and the DOM HUD stay in CSS pixels. phaser/backingStore.js is the
 * one conversion point (the canvas follows #game-container through it).
 */
import { deviceScale } from './backingStore.js';

/**
 * Create Phaser game configuration.
 *
 * @param {Object} options - Config options
 * @param {string} options.parent - Parent element ID
 * @param {Object} options.scene - Scene configuration or class
 * @param {number} [options.dpr] - device pixel ratio (default: the window's, capped)
 * @returns {Object} Phaser game config
 */
export function createGameConfig({
  parent = 'game-container',
  scene = null,
  dpr = deviceScale(),
  cssWidth = window.innerWidth,
  cssHeight = window.innerHeight,
} = {}) {
  return {
    type: Phaser.AUTO,
    // the backing store: CSS size x DPR (backingStore.applyBackingStore keeps it)
    width: Math.round(cssWidth * dpr),
    height: Math.round(cssHeight * dpr),
    transparent: true, // Let CSS background show through
    parent,
    scale: {
      // the canvas follows its grid column through applyBackingStore, not
      // Phaser's RESIZE mode (that one sizes the backing store at 1x)
      mode: Phaser.Scale.NONE,
      autoCenter: Phaser.Scale.NO_CENTER,
      zoom: 1 / dpr,
    },
    // (Phaser reads every render setting, transparent included, from a
    // `render` block when there is one: none here, so the defaults hold:
    // antialias on, pixelArt off, i.e. linear filtering for the card atlas)
    antialias: true,
    pixelArt: false,
    scene: scene || [],
    // no physics: nothing on the table uses arcade bodies (webclient-10)
  };
}

/**
 * Card dimensions and scaling.
 */
export const CARD_CONFIG = {
  // A card at design scale 1, in CSS px: the old art's 62 px visible height
  // (so the item 17 table keeps its geometry) at the iOS face's 300 x 435
  // proportions (42.76 wide; the old card was 44). The layout's sprite scales
  // map it onto the atlas bitmap (computeTableLayout: card[kind].scale =
  // on-screen height / atlas frame height)
  UNIT: { w: 62 * 300 / 435, h: 62 },

  // Hand cards at layout scale 1 (s = 1) are drawn at this design scale
  SCALE: 1.5,

  // The atlas frame's widest bitmap (px): iOS's 3x hand card
  TEX_MAX_W: 300,

  // Spacing between hand cards at layout scale 1 (today's 50 px of a 1920
  // design width on the 1600 px canvas of a 1920 window); times layout.s
  HAND_SPACING: 42,

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
 * Animation durations in milliseconds. CARD_PLAY and CARD_COLLECT are game
 * pacing (phaser/pacing.js sizes them to the server's resumeInMs); hover
 * and fades are cosmetic and come from the motion tokens (ui/motion.js).
 */
export const ANIMATION_CONFIG = {
  CARD_DEAL: 500,
  CARD_PLAY: 300,
  CARD_COLLECT: 500,
};

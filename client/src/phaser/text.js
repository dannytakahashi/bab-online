/**
 * Canvas text (item 18a, ui-15): every Phaser Text uses the UI font (the
 * system stack, as the DOM; never Phaser's default Courier) and is
 * rasterised at the backing store's pixel ratio, so it is as crisp as the
 * DOM beside it. A ratio change (another display) re-rasterises it.
 */
import { FONT_UI, WEIGHT } from '../ui/tokens.js';

/** The ratio the scene's canvas renders at (backingStore.js). */
export function sceneDpr(scene) {
  return scene?.scale?.babDpr || scene?.game?.scale?.babDpr || 1;
}

/**
 * A Text style in the UI font at the scene's ratio.
 * @param {Phaser.Scene} scene
 * @param {Object} style - Phaser text style (fontSize, color, ...); `weight` maps to fontStyle
 */
export function uiTextStyle(scene, { weight = null, ...style } = {}) {
  const out = { fontFamily: FONT_UI, resolution: sceneDpr(scene), ...style };
  if (weight !== null && weight !== undefined) {
    // Phaser's fontStyle is the CSS font shorthand's style part: a weight goes there
    out.fontStyle = String(WEIGHT[weight] ?? weight);
  }
  return out;
}

/** Re-rasterise every Text of the scene at its current ratio (a DPR change). */
export function refreshTextResolution(scene) {
  const dpr = sceneDpr(scene);
  for (const obj of scene?.children?.list || []) {
    if (obj?.type !== 'Text' || typeof obj.setResolution !== 'function') continue;
    if (obj.style?.resolution !== dpr) obj.setResolution(dpr);
  }
}

/**
 * LayoutManager - the DOM table backgrounds (the rail around the trick, my
 * hand's panel), placed from the table layout (layout/computeTableLayout.js):
 * the play zone around the trick, the hand box under my cards. The bid sheet
 * and every other DOM piece live in the HUD (ui/tableHud.js).
 *
 * Their look is table.css (.table-rail, .hand-panel, .hand-border; item 18a
 * reskin); this sets only their geometry, as CSS variables (--x, --y, --w,
 * --h) from the layout.
 */

import { layoutOf } from '../layout/computeTableLayout.js';

/** Make a backdrop element with its classes (positioned by placeBackdrop). */
function backdrop(id, className) {
  const el = document.createElement('div');
  el.id = id;
  el.className = `table-backdrop ${className}`;
  return el;
}

/** The layout's rect on a backdrop (dynamic geometry: CSS variables), or hidden without one. */
export function placeBackdrop(el, r, extra = {}) {
  if (!el) return;
  el.hidden = !r;
  if (!r) return;
  const px = (v) => `${Math.round(v * 100) / 100}px`;
  el.style.setProperty('--x', px(r.x));
  el.style.setProperty('--y', px(r.y));
  el.style.setProperty('--w', px(r.w));
  el.style.setProperty('--h', px(r.h));
  for (const [k, v] of Object.entries(extra)) el.style.setProperty(k, v);
}

export class LayoutManager {
  constructor(scene) {
    this.scene = scene;
    this.layout = null;
  }

  /**
   * Read the current layout (call on resize or initially).
   */
  update() {
    this.layout = layoutOf(this.scene);
    return this.layout;
  }

  /**
   * Create DOM background elements (the rail, the hand panel and its border).
   * Only creates if they don't exist.
   */
  createDomBackgrounds({ skipHandArea = false } = {}) {
    const container = document.getElementById('game-container');
    if (!container) return;

    if (!document.getElementById('playZoneDom')) {
      container.appendChild(backdrop('playZoneDom', 'table-rail'));
    }

    // My hand's panel (not for spectators)
    if (!skipHandArea && !document.getElementById('handBackgroundDom')) {
      container.appendChild(backdrop('handBackgroundDom', 'hand-panel'));
      container.appendChild(backdrop('handBorderDom', 'hand-border'));
    }

    this.positionDomBackgrounds();
  }

  /**
   * Position DOM background elements from the layout.
   */
  positionDomBackgrounds() {
    const L = this.layout || this.update();
    const rail = `${Math.round(Math.max(2, L.felt?.border ?? 4) * 100) / 100}px`;
    placeBackdrop(document.getElementById('playZoneDom'), L.trick.zone, { '--rail-w': rail, '--s': String(L.s) });
    // The hand box (a spectator's layout has none)
    for (const id of ['handBackgroundDom', 'handBorderDom']) {
      placeBackdrop(document.getElementById(id), L.hand ? L.hand.rect : null);
    }
  }

  /**
   * Cleanup DOM background elements.
   */
  cleanupDomBackgrounds() {
    for (const id of ['playZoneDom', 'handBackgroundDom', 'handBorderDom']) {
      document.getElementById(id)?.remove();
    }
  }
}

/**
 * LayoutManager - the DOM table backgrounds (the play zone felt, the hand
 * area), placed from the table layout (layout/computeTableLayout.js): the
 * play zone around the trick, the hand box under my cards. The bid sheet
 * and every other DOM piece live in the HUD (ui/tableHud.js).
 */

import { layoutOf } from '../layout/computeTableLayout.js';

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
   * Create DOM background elements (play zone, hand background, border).
   * Only creates if they don't exist.
   */
  createDomBackgrounds({ skipHandArea = false } = {}) {
    const container = document.getElementById('game-container');
    if (!container) return;

    // Create play zone DOM element
    if (!document.getElementById('playZoneDom')) {
      const playZoneDom = document.createElement('div');
      playZoneDom.id = 'playZoneDom';
      playZoneDom.style.position = 'absolute';
      playZoneDom.style.backgroundColor = 'rgba(50, 205, 50, 0.6)';
      playZoneDom.style.border = '4px solid white';
      playZoneDom.style.boxSizing = 'border-box';
      playZoneDom.style.borderRadius = '8px';
      playZoneDom.style.pointerEvents = 'none';
      playZoneDom.style.zIndex = '-1';
      container.appendChild(playZoneDom);
    }

    // Create hand background DOM element (skip for spectators)
    if (!skipHandArea && !document.getElementById('handBackgroundDom')) {
      const handBgDom = document.createElement('div');
      handBgDom.id = 'handBackgroundDom';
      handBgDom.style.position = 'absolute';
      handBgDom.style.backgroundColor = 'rgba(26, 51, 40, 0.85)';
      handBgDom.style.pointerEvents = 'none';
      handBgDom.style.zIndex = '-2';
      container.appendChild(handBgDom);

      const borderDom = document.createElement('div');
      borderDom.id = 'handBorderDom';
      borderDom.style.position = 'absolute';
      borderDom.style.border = '2px solid #2d5a40';
      borderDom.style.boxSizing = 'border-box';
      borderDom.style.pointerEvents = 'none';
      borderDom.style.zIndex = '-1';
      container.appendChild(borderDom);
    }

    // Position the elements
    this.positionDomBackgrounds();
  }

  /**
   * Position DOM background elements from the layout.
   */
  positionDomBackgrounds() {
    const L = this.layout || this.update();
    const place = (el, r) => {
      el.style.left = `${r.x}px`;
      el.style.top = `${r.y}px`;
      el.style.width = `${r.w}px`;
      el.style.height = `${r.h}px`;
    };

    const playZoneDom = document.getElementById('playZoneDom');
    if (playZoneDom) place(playZoneDom, L.trick.zone);

    // The hand box (a spectator's layout has none)
    const handBgDom = document.getElementById('handBackgroundDom');
    const borderDom = document.getElementById('handBorderDom');
    for (const el of [handBgDom, borderDom]) {
      if (!el) continue;
      if (L.hand) {
        place(el, L.hand.rect);
        el.style.display = '';
      } else {
        el.style.display = 'none';
      }
    }
  }

  /**
   * Cleanup DOM background elements.
   */
  cleanupDomBackgrounds() {
    const playZoneDom = document.getElementById('playZoneDom');
    const handBgDom = document.getElementById('handBackgroundDom');
    const borderDom = document.getElementById('handBorderDom');
    if (playZoneDom) playZoneDom.remove();
    if (handBgDom) handBgDom.remove();
    if (borderDom) borderDom.remove();
  }
}

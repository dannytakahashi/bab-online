/**
 * LayoutManager - DOM table backgrounds (play zone, hand area) and the bid
 * grid position, sized from the canvas on every resize.
 */

// Base design dimensions for scaling
const BASE_WIDTH = 1920;
const BASE_HEIGHT = 953;

export class LayoutManager {
  constructor(scene) {
    this.scene = scene;

    // Cache current dimensions
    this.screenWidth = 0;
    this.screenHeight = 0;
    this.scaleX = 1;
    this.scaleY = 1;
  }

  /**
   * Update the cached canvas size and scale factors.
   * Call this on resize or initially.
   */
  update() {
    this.screenWidth = this.scene.scale.width;
    this.screenHeight = this.scene.scale.height;
    this.scaleX = this.screenWidth / BASE_WIDTH;
    this.scaleY = this.screenHeight / BASE_HEIGHT;
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
      playZoneDom.style.borderRadius = '8px';
      playZoneDom.style.pointerEvents = 'none';
      playZoneDom.style.zIndex = '-1';
      container.appendChild(playZoneDom);
      console.log('📍 LayoutManager: Play zone DOM created');
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
      borderDom.style.pointerEvents = 'none';
      borderDom.style.zIndex = '-1';
      container.appendChild(borderDom);
      console.log('📍 LayoutManager: Hand background DOM created');
    }

    // Position the elements
    this.positionDomBackgrounds();
  }

  /**
   * Position DOM background elements based on current screen size.
   */
  positionDomBackgrounds() {
    // Position play zone (center)
    const playZoneDom = document.getElementById('playZoneDom');
    if (playZoneDom) {
      const playZoneWidth = 600 * this.scaleX;
      const playZoneHeight = 400 * this.scaleY;
      playZoneDom.style.width = `${playZoneWidth}px`;
      playZoneDom.style.height = `${playZoneHeight}px`;
      playZoneDom.style.left = `${(this.screenWidth - playZoneWidth) / 2}px`;
      playZoneDom.style.top = `${(this.screenHeight - playZoneHeight) / 2}px`;
    }

    // Position hand background (bottom center)
    const handBgDom = document.getElementById('handBackgroundDom');
    const borderDom = document.getElementById('handBorderDom');
    if (handBgDom) {
      const bottomClearance = 20 * this.scaleY;
      const cardHeight = 140 * 1.5 * this.scaleY;
      const cardPadding = 10 * this.scaleY;
      const handAreaHeight = cardHeight + cardPadding * 2;
      const handAreaWidth = this.screenWidth * 0.4;
      const handY = this.screenHeight - handAreaHeight - bottomClearance;
      const handX = (this.screenWidth - handAreaWidth) / 2;

      handBgDom.style.width = `${handAreaWidth}px`;
      handBgDom.style.height = `${handAreaHeight}px`;
      handBgDom.style.left = `${handX}px`;
      handBgDom.style.top = `${handY}px`;

      if (borderDom) {
        borderDom.style.width = `${handAreaWidth}px`;
        borderDom.style.height = `${handAreaHeight}px`;
        borderDom.style.left = `${handX}px`;
        borderDom.style.top = `${handY}px`;
      }
    }
  }

  /**
   * Position bid container in center of play zone.
   */
  positionBidContainer() {
    const bidContainer = document.getElementById('bidContainer');
    if (bidContainer) {
      bidContainer.style.left = `${this.screenWidth / 2}px`;
      bidContainer.style.top = `${this.screenHeight / 2}px`;
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
    console.log('🗑️ LayoutManager: DOM backgrounds cleaned up');
  }
}

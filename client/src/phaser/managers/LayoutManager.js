/**
 * LayoutManager - Centralizes all positioning and resize logic.
 *
 * Handles calculations for:
 * - Hand card positions
 * - Opponent positions
 * - Trick play positions
 * - Trump card position
 * - Play zone rectangle
 */

// Base design dimensions for scaling
const BASE_WIDTH = 1920;
const BASE_HEIGHT = 953;

// Layout constants
const GAME_LOG_WIDTH = 320; // Reserve space for game log

export class LayoutManager {
  constructor(scene) {
    this.scene = scene;

    // Cache current dimensions
    this.screenWidth = 0;
    this.screenHeight = 0;
    this.scaleX = 1;
    this.scaleY = 1;

    // Calculated positions
    this.positions = {
      hand: [],
      opponents: {
        partner: { card: { x: 0, y: 0 }, avatar: { x: 0, y: 0 }, rotation: 0 },
        opp1: { card: { x: 0, y: 0 }, avatar: { x: 0, y: 0 }, rotation: 0 },
        opp2: { card: { x: 0, y: 0 }, avatar: { x: 0, y: 0 }, rotation: 0 },
      },
      play: {
        self: { x: 0, y: 0 },
        partner: { x: 0, y: 0 },
        opponent1: { x: 0, y: 0 },
        opponent2: { x: 0, y: 0 },
      },
      trump: { x: 0, y: 0 },
      handArea: { top: 0, height: 0 },
    };
  }

  /**
   * Update layout for current screen size.
   * Call this on resize or initially.
   */
  update() {
    this.screenWidth = this.scene.scale.width;
    this.screenHeight = this.scene.scale.height;
    this.scaleX = this.screenWidth / BASE_WIDTH;
    this.scaleY = this.screenHeight / BASE_HEIGHT;

    this.updateOpponentPositions();
    this.updatePlayPositions();
    this.updateTrumpPosition();
    this.updateHandAreaPosition();
  }

  /**
   * Get current scale factors.
   */
  getScaleFactors() {
    return {
      x: this.scaleX,
      y: this.scaleY,
      screenWidth: this.screenWidth,
      screenHeight: this.screenHeight,
    };
  }

  /**
   * Update opponent positions (cards and avatars).
   */
  updateOpponentPositions() {
    const centerX = this.screenWidth / 2;
    const centerY = this.screenHeight / 2;

    // Clamp positions to stay within canvas
    const minX = 80;
    const maxX = this.screenWidth - 120;

    this.positions.opponents = {
      partner: {
        card: { x: centerX, y: centerY - 275 * this.scaleY },
        avatar: { x: centerX, y: centerY - 400 * this.scaleY },
        rotation: 0,
        horizontal: true,
      },
      opp1: {
        card: { x: Math.max(minX + 50, centerX - 425 * this.scaleX), y: centerY },
        avatar: { x: Math.max(minX, centerX - 550 * this.scaleX), y: centerY },
        rotation: Math.PI / 2,
        horizontal: false,
      },
      opp2: {
        card: { x: Math.min(maxX - 50, centerX + 425 * this.scaleX), y: centerY },
        avatar: { x: Math.min(maxX, centerX + 550 * this.scaleX), y: centerY },
        rotation: -Math.PI / 2,
        horizontal: false,
      },
    };
  }

  /**
   * Update trick play positions.
   */
  updatePlayPositions() {
    const centerX = this.screenWidth / 2;
    const centerY = this.screenHeight / 2;
    const playOffsetX = 80 * this.scaleX;
    const playOffsetY = 80 * this.scaleY;

    this.positions.play = {
      opponent1: { x: centerX - playOffsetX, y: centerY },
      opponent2: { x: centerX + playOffsetX, y: centerY },
      partner: { x: centerX, y: centerY - playOffsetY },
      self: { x: centerX, y: centerY + playOffsetY },
    };
  }

  /**
   * Update trump card position.
   */
  updateTrumpPosition() {
    this.positions.trump = {
      x: this.screenWidth / 2 + 500 * this.scaleX,
      y: this.screenHeight / 2 - 300 * this.scaleY,
    };
  }

  /**
   * Update hand area position.
   */
  updateHandAreaPosition() {
    const bottomClearance = 20 * this.scaleY;
    const cardHeight = 140 * 1.5 * this.scaleY;
    const cardPadding = 10 * this.scaleY;
    const handAreaHeight = cardHeight + cardPadding * 2;
    const handAreaTop = this.screenHeight - handAreaHeight - bottomClearance;

    this.positions.handArea = {
      top: handAreaTop,
      height: handAreaHeight,
      centerY: handAreaTop + handAreaHeight / 2,
    };
  }

  /**
   * Get card positions for a hand of given size.
   * @param {number} handSize - Number of cards
   * @returns {Array} Array of {x, y} positions
   */
  getHandCardPositions(handSize) {
    if (handSize === 0) return [];

    const cardSpacing = 50 * this.scaleX;
    const totalWidth = (handSize - 1) * cardSpacing;
    const startX = (this.screenWidth - totalWidth) / 2;
    const startY = this.positions.handArea.centerY;

    const positions = [];
    for (let i = 0; i < handSize; i++) {
      positions.push({
        x: startX + i * cardSpacing,
        y: startY,
      });
    }
    return positions;
  }

  /**
   * Get opponent positions.
   * @returns {Object} Opponent positions
   */
  getOpponentPositions() {
    return this.positions.opponents;
  }

  /**
   * Get play positions (for trick cards).
   * @returns {Object} Play positions
   */
  getPlayPositions() {
    return this.positions.play;
  }

  /**
   * Get trump card position.
   * @returns {Object} {x, y}
   */
  getTrumpPosition() {
    return this.positions.trump;
  }

  /**
   * Get play zone rectangle (for visual bounds).
   * @returns {Object} {x, y, width, height}
   */
  getPlayZoneRect() {
    const margin = 100 * this.scaleX;
    return {
      x: margin,
      y: margin,
      width: this.screenWidth - margin * 2 - GAME_LOG_WIDTH,
      height: this.screenHeight - margin * 2 - this.positions.handArea.height,
    };
  }

  /**
   * Get card spacing for hands.
   */
  getCardSpacing() {
    return 50 * this.scaleX;
  }

  /**
   * Get opponent card spacing.
   */
  getOpponentCardSpacing() {
    return 10 * this.scaleX;
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

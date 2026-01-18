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
}

/**
 * Card sprite management for Phaser.
 *
 * Handles card display, positioning, and animations.
 */

import { getCardImageKey } from '../../utils/cards.js';
import { CARD_CONFIG, ANIMATION_CONFIG } from '../config.js';

/**
 * CardManager handles all card-related sprite operations.
 */
export class CardManager {
  /**
   * @param {Phaser.Scene} scene - The Phaser scene
   */
  constructor(scene) {
    this._scene = scene;
    this._handSprites = [];
    this._playedSprites = {};
    this._onCardClick = null;
  }

  /**
   * Set callback for card clicks.
   * @param {Function} callback - Called with (card, sprite)
   */
  setCardClickHandler(callback) {
    this._onCardClick = callback;
  }

  /**
   * Get card texture key for atlas.
   * @param {Object} card - Card object
   * @returns {string} Atlas frame key
   */
  getTextureKey(card) {
    return getCardImageKey(card);
  }

  /**
   * Calculate hand card positions.
   *
   * @param {number} cardCount - Number of cards
   * @param {number} centerX - Center X position
   * @param {number} centerY - Center Y position
   * @returns {Array} Array of { x, y } positions
   */
  calculateHandPositions(cardCount, centerX, centerY) {
    const positions = [];
    const { HAND_SPACING, BASE_WIDTH, SCALE } = CARD_CONFIG;
    const cardWidth = BASE_WIDTH * SCALE;

    // Total width of all cards with overlap
    const totalWidth = cardWidth + (cardCount - 1) * HAND_SPACING;
    const startX = centerX - totalWidth / 2 + cardWidth / 2;

    for (let i = 0; i < cardCount; i++) {
      positions.push({
        x: startX + i * HAND_SPACING,
        y: centerY,
      });
    }

    return positions;
  }

  /**
   * Display cards in hand.
   *
   * @param {Array} cards - Array of card objects
   * @param {Object} options - Display options
   * @param {boolean} options.animate - Whether to animate dealing
   */
  displayHand(cards, { animate = true } = {}) {
    // Clear existing hand
    this.clearHand();

    if (!cards || cards.length === 0) return;

    const scene = this._scene;
    const { scale } = scene;
    const centerX = scale.width / 2;
    const bottomY = scale.height - 100;

    const positions = this.calculateHandPositions(cards.length, centerX, bottomY);

    cards.forEach((card, index) => {
      const pos = positions[index];
      const sprite = this._createCardSprite(card, pos.x, pos.y, animate);
      sprite.setData('card', card);
      sprite.setData('index', index);

      // Make interactive
      sprite.setInteractive({ useHandCursor: true });
      this._setupCardInteraction(sprite);

      this._handSprites.push(sprite);
    });
  }

  /**
   * Create a card sprite.
   */
  _createCardSprite(card, x, y, animate = false) {
    const scene = this._scene;
    const textureKey = this.getTextureKey(card);
    const { SCALE, Z_INDEX } = CARD_CONFIG;

    let sprite;
    if (animate) {
      // Start from off-screen
      sprite = scene.add.sprite(scene.scale.width / 2, -100, 'cards', textureKey);
      sprite.setScale(SCALE);
      sprite.setDepth(Z_INDEX.HAND);

      // Animate to position
      scene.tweens.add({
        targets: sprite,
        x,
        y,
        duration: ANIMATION_CONFIG.CARD_DEAL,
        ease: 'Power2',
      });
    } else {
      sprite = scene.add.sprite(x, y, 'cards', textureKey);
      sprite.setScale(SCALE);
      sprite.setDepth(Z_INDEX.HAND);
    }

    return sprite;
  }

  /**
   * Set up hover and click interactions for a card.
   */
  _setupCardInteraction(sprite) {
    const scene = this._scene;
    const originalY = sprite.y;

    sprite.on('pointerover', () => {
      scene.tweens.add({
        targets: sprite,
        y: originalY - 20,
        duration: ANIMATION_CONFIG.CARD_HOVER,
        ease: 'Power2',
      });
      sprite.setDepth(CARD_CONFIG.Z_INDEX.ACTIVE_CARD);
    });

    sprite.on('pointerout', () => {
      scene.tweens.add({
        targets: sprite,
        y: originalY,
        duration: ANIMATION_CONFIG.CARD_HOVER,
        ease: 'Power2',
      });
      sprite.setDepth(CARD_CONFIG.Z_INDEX.HAND);
    });

    sprite.on('pointerdown', () => {
      if (this._onCardClick) {
        this._onCardClick(sprite.getData('card'), sprite);
      }
    });
  }

  /**
   * Animate playing a card to the table.
   *
   * @param {Object} card - Card being played
   * @param {number} position - Player position (1-4)
   * @param {number} targetX - Target X position
   * @param {number} targetY - Target Y position
   */
  playCard(card, position, targetX, targetY) {
    // Find and remove card from hand
    const spriteIndex = this._handSprites.findIndex((s) => {
      const c = s.getData('card');
      return c.suit === card.suit && c.rank === card.rank;
    });

    if (spriteIndex === -1) {
      // Card not in hand - create new sprite for opponent play
      const sprite = this._scene.add.sprite(
        targetX,
        targetY,
        'cards',
        this.getTextureKey(card)
      );
      sprite.setScale(CARD_CONFIG.SCALE);
      sprite.setDepth(CARD_CONFIG.Z_INDEX.PLAYED_CARDS);
      this._playedSprites[position] = sprite;
      return;
    }

    // Remove from hand array
    const sprite = this._handSprites.splice(spriteIndex, 1)[0];

    // Animate to table position
    this._scene.tweens.add({
      targets: sprite,
      x: targetX,
      y: targetY,
      duration: ANIMATION_CONFIG.CARD_PLAY,
      ease: 'Power2',
      onComplete: () => {
        sprite.setDepth(CARD_CONFIG.Z_INDEX.PLAYED_CARDS);
      },
    });

    this._playedSprites[position] = sprite;
  }

  /**
   * Collect cards from table (after trick complete).
   *
   * @param {number} winnerPosition - Winning player position
   */
  collectTrick(winnerPosition) {
    const scene = this._scene;
    const { scale } = scene;

    // Get winner's edge position
    const targets = {
      1: { x: scale.width / 2, y: scale.height + 100 },
      2: { x: -100, y: scale.height / 2 },
      3: { x: scale.width / 2, y: -100 },
      4: { x: scale.width + 100, y: scale.height / 2 },
    };

    const target = targets[winnerPosition];

    // Animate all played cards to winner
    Object.values(this._playedSprites).forEach((sprite) => {
      scene.tweens.add({
        targets: sprite,
        x: target.x,
        y: target.y,
        alpha: 0,
        duration: ANIMATION_CONFIG.CARD_COLLECT,
        ease: 'Power2',
        onComplete: () => {
          sprite.destroy();
        },
      });
    });

    this._playedSprites = {};
  }

  /**
   * Clear all hand sprites.
   */
  clearHand() {
    this._handSprites.forEach((sprite) => {
      if (sprite && sprite.destroy) {
        sprite.destroy();
      }
    });
    this._handSprites = [];
  }

  /**
   * Clear all played card sprites.
   */
  clearPlayed() {
    Object.values(this._playedSprites).forEach((sprite) => {
      if (sprite && sprite.destroy) {
        sprite.destroy();
      }
    });
    this._playedSprites = {};
  }

  /**
   * Clear all card sprites.
   */
  clearAll() {
    this.clearHand();
    this.clearPlayed();
  }

  /**
   * Get hand sprite count.
   */
  getHandCount() {
    return this._handSprites.length;
  }

  /**
   * Get played card count.
   */
  getPlayedCount() {
    return Object.keys(this._playedSprites).length;
  }

  /**
   * Get hand sprites array (for external updates).
   */
  getHandSprites() {
    return this._handSprites;
  }

  /**
   * Update card tinting based on legality.
   *
   * @param {Function} legalityChecker - Function that takes a card and returns boolean
   * @param {boolean} canPlay - Whether the player can currently play a card
   */
  updateCardLegality(legalityChecker, canPlay = true) {
    this._handSprites.forEach((sprite) => {
      if (!sprite || !sprite.active) return;

      const card = sprite.getData('card');
      if (!card) return;

      // If player can't play, dim all cards
      if (!canPlay) {
        sprite.setTint(0xaaaaaa);
        sprite.setData('isLegal', false);
        return;
      }

      // Check legality
      const isLegal = legalityChecker ? legalityChecker(card) : true;

      if (isLegal) {
        sprite.clearTint();
        sprite.setData('isLegal', true);
      } else {
        sprite.setTint(0xaaaaaa);
        sprite.setData('isLegal', false);
      }
    });
  }

  /**
   * Set all cards to a specific tint.
   */
  setAllTint(tintColor = 0xaaaaaa) {
    this._handSprites.forEach((sprite) => {
      if (sprite && sprite.active) {
        sprite.setTint(tintColor);
        sprite.setData('isLegal', false);
      }
    });
  }

  /**
   * Clear tint from all cards.
   */
  clearAllTint() {
    this._handSprites.forEach((sprite) => {
      if (sprite && sprite.active) {
        sprite.clearTint();
        sprite.setData('isLegal', true);
      }
    });
  }

  /**
   * Reposition hand cards (for resize handling).
   */
  repositionHand() {
    if (!this._handSprites.length) return;

    const scene = this._scene;
    const { scale } = scene;
    const centerX = scale.width / 2;
    const bottomY = scale.height - 100;

    const positions = this.calculateHandPositions(
      this._handSprites.length,
      centerX,
      bottomY
    );

    this._handSprites.forEach((sprite, index) => {
      if (sprite && sprite.active) {
        sprite.x = positions[index].x;
        sprite.y = positions[index].y;
        // Update original Y for hover effect
        sprite.setData('originalY', positions[index].y);
      }
    });
  }

  /**
   * Remove a specific card from hand by card data.
   */
  removeCard(card) {
    const index = this._handSprites.findIndex((s) => {
      const c = s.getData('card');
      return c && c.suit === card.suit && c.rank === card.rank;
    });

    if (index !== -1) {
      const sprite = this._handSprites.splice(index, 1)[0];
      if (sprite && sprite.destroy) {
        sprite.destroy();
      }
      return true;
    }
    return false;
  }
}

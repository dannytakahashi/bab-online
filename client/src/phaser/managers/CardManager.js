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
    this._isDealing = false; // Flag to prevent repositionHand during deal animation
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
   * Uses same positioning logic as legacy displayCards for compatibility.
   *
   * @param {number} cardCount - Number of cards
   * @param {number} screenWidth - Screen width for scaling
   * @returns {Array} Array of { x, y } positions
   */
  calculateHandPositions(cardCount, screenWidth) {
    const positions = [];
    const scaleFactorX = screenWidth / 1920;

    // Match legacy: cardSpacing = 50 * scaleFactorX
    const cardSpacing = 50 * scaleFactorX;

    // Match legacy: totalWidth = (cardCount - 1) * cardSpacing
    const totalWidth = (cardCount - 1) * cardSpacing;

    // Match legacy: startX = (screenWidth - totalWidth) / 2
    const startX = (screenWidth - totalWidth) / 2;

    // Get Y position from scene
    const scene = this._scene;
    const scaleY = scene.scale.height / 953;
    const bottomY = scene.scale.height - (135 * scaleY);

    for (let i = 0; i < cardCount; i++) {
      positions.push({
        x: startX + i * cardSpacing,
        y: bottomY,
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

    // Set dealing flag to prevent repositionHand from interrupting animation
    if (animate) {
      this._isDealing = true;
    }

    const positions = this.calculateHandPositions(cards.length, scale.width);

    cards.forEach((card, index) => {
      const pos = positions[index];
      const sprite = this._createCardSprite(card, pos.x, pos.y, animate, index);
      sprite.setData('card', card);
      sprite.setData('index', index);
      sprite.setData('baseY', pos.y); // Store target Y for hover effects
      sprite.setData('isLegal', true); // Default to legal, updateCardLegality will correct this

      // Set index-based depth so rightmost cards are on top
      // Higher depth = checked first for input, so overlapping cards work correctly
      sprite.setDepth(CARD_CONFIG.Z_INDEX.HAND + index);

      // Use explicit hit area matching visible card bounds within the 64x64 frame
      // (cards have transparent padding in the atlas that shouldn't be clickable)
      const { CARD_BOUNDS } = CARD_CONFIG;
      const hitArea = new Phaser.Geom.Rectangle(
        CARD_BOUNDS.x,
        CARD_BOUNDS.y,
        CARD_BOUNDS.width,
        CARD_BOUNDS.height
      );
      sprite.setInteractive(hitArea, Phaser.Geom.Rectangle.Contains);
      this._setupCardInteraction(sprite);

      this._handSprites.push(sprite);
    });

    // Schedule a reposition after deal animation completes to handle container resize timing
    // This ensures cards are positioned correctly even if container width changes
    // Delay must be longer than base delay (200ms) + deal animation (750ms) + stagger (cards * 50ms)
    const animationDelay = animate ? 200 + 750 + (cards.length * 50) + 100 : 50;
    scene.time.delayedCall(animationDelay, () => {
      this._isDealing = false; // Clear dealing flag so resize can work again
      this.repositionHand();
    });
  }

  /**
   * Create a card sprite.
   */
  _createCardSprite(card, x, y, animate = false, index = 0) {
    const scene = this._scene;
    const textureKey = this.getTextureKey(card);
    const { SCALE, Z_INDEX } = CARD_CONFIG;

    let sprite;
    if (animate) {
      // Start from trump card's actual position (if it exists)
      // This ensures we use the same position regardless of container resize timing
      let startX, startY;
      if (scene.tableCardSprite) {
        startX = scene.tableCardSprite.x;
        startY = scene.tableCardSprite.y;
      } else {
        // Fallback to calculated position
        const DESIGN_WIDTH = 1920;
        const DESIGN_HEIGHT = 953;
        const scaleX = scene.scale.width / DESIGN_WIDTH;
        const scaleY = scene.scale.height / DESIGN_HEIGHT;
        startX = scene.scale.width / 2 + 500 * scaleX;
        startY = scene.scale.height / 2 - 300 * scaleY;
      }

      sprite = scene.add.sprite(startX, startY, 'cards', textureKey);
      sprite.setScale(SCALE);
      sprite.setDepth(Z_INDEX.HAND + index);
      sprite.setAlpha(0); // Start invisible to avoid position glitch during delay

      // Animate to position with staggered delay (750ms to match opponents)
      // Add base delay so cards are visible at trump position first
      // Use explicit from/to values to ensure starting position is correct
      scene.tweens.add({
        targets: sprite,
        x: { from: startX, to: x },
        y: { from: startY, to: y },
        alpha: { from: 1, to: 1 }, // Reveal card when tween starts
        duration: 750,
        ease: 'Power2',
        delay: 200 + (index * 50),
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

    sprite.on('pointerover', () => {
      // Set hand cursor on hover
      scene.input.setDefaultCursor('pointer');

      // Only apply hover effect to legal cards
      if (!sprite.getData('isLegal')) return;

      // Use stored baseY which is set after positioning is complete
      const baseY = sprite.getData('baseY') || sprite.y;
      scene.tweens.add({
        targets: sprite,
        y: baseY - 20,
        duration: ANIMATION_CONFIG.CARD_HOVER,
        ease: 'Power2',
      });
      // Keep index-based depth - card stays partially behind cards to its right
    });

    sprite.on('pointerout', () => {
      // Reset cursor
      scene.input.setDefaultCursor('default');

      // Only apply hover effect to legal cards
      if (!sprite.getData('isLegal')) return;

      // Use stored baseY which is set after positioning is complete
      const baseY = sprite.getData('baseY') || sprite.y;
      scene.tweens.add({
        targets: sprite,
        y: baseY,
        duration: ANIMATION_CONFIG.CARD_HOVER,
        ease: 'Power2',
      });
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

      const wasLegal = sprite.getData('isLegal');

      // If player can't play, dim all cards
      if (!canPlay) {
        sprite.setTint(0xaaaaaa);
        sprite.setData('isLegal', false);
        // Reset position if card was hovered when becoming illegal
        if (wasLegal) {
          const baseY = sprite.getData('baseY');
          if (baseY !== undefined) {
            sprite.y = baseY;
          }
        }
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
        // Reset position if card was hovered when becoming illegal
        if (wasLegal) {
          const baseY = sprite.getData('baseY');
          if (baseY !== undefined) {
            sprite.y = baseY;
          }
        }
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
    // Skip repositioning during deal animation to prevent snapping cards to final position
    if (this._isDealing) return;
    if (!this._handSprites.length) return;

    const scene = this._scene;
    const { scale } = scene;

    const positions = this.calculateHandPositions(
      this._handSprites.length,
      scale.width
    );

    this._handSprites.forEach((sprite, index) => {
      if (sprite && sprite.active) {
        sprite.x = positions[index].x;
        sprite.y = positions[index].y;
        // Update baseY for hover effect
        sprite.setData('baseY', positions[index].y);
        // Maintain index-based depth
        sprite.setDepth(CARD_CONFIG.Z_INDEX.HAND + index);
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

  /**
   * Extract a card sprite from hand without destroying it.
   * Used for animating the card to the play area.
   * @param {Object} card - Card data to find
   * @returns {Phaser.GameObjects.Sprite|null} The sprite, or null if not found
   */
  extractCard(card) {
    const index = this._handSprites.findIndex((s) => {
      const c = s.getData('card');
      return c && c.suit === card.suit && c.rank === card.rank;
    });

    if (index !== -1) {
      const sprite = this._handSprites.splice(index, 1)[0];
      return sprite;
    }
    return null;
  }

  /**
   * Add turn glow to the player's hand border.
   * Uses CSS class on the handBorderDom element for resize-safe glow.
   */
  addTurnGlow() {
    const borderDom = document.getElementById('handBorderDom');
    if (borderDom) {
      borderDom.classList.add('turn-glow');
      console.log('🟫 Added CSS turn glow to hand border.');
    }
  }

  /**
   * Remove turn glow from the player's hand border.
   */
  removeTurnGlow() {
    const borderDom = document.getElementById('handBorderDom');
    if (borderDom) {
      borderDom.classList.remove('turn-glow');
      console.log('🚫 Removed CSS turn glow from hand border.');
    }
  }

  /**
   * Update player turn glow based on current turn.
   *
   * @param {number} currentTurn - The position (1-4) of the current turn
   * @param {number} playerPosition - The player's position (1-4)
   */
  updatePlayerTurnGlow(currentTurn, playerPosition) {
    if (currentTurn === playerPosition) {
      this.addTurnGlow();
    } else {
      this.removeTurnGlow();
    }
  }
}

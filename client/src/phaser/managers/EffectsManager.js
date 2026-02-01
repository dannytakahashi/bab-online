/**
 * Effects Manager for Phaser
 *
 * Handles visual effects like bore impacts, rainbow displays, and turn indicators.
 */

import { team, rotate } from '../../utils/positions.js';

/**
 * Base design dimensions for scaling.
 */
const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 953;

/**
 * EffectsManager handles all visual effect operations.
 */
export class EffectsManager {
  /**
   * @param {Phaser.Scene} scene - The Phaser scene
   */
  constructor(scene) {
    this._scene = scene;

    // Track active rainbow sprites for cleanup
    this._rainbowSprites = [];

    // Track active impact sprites for cleanup
    this._impactSprites = [];

    // Player's position (needed for rainbow placement)
    this._playerPosition = null;
  }

  /**
   * Set the player's position (1-4).
   */
  setPlayerPosition(position) {
    this._playerPosition = position;
  }

  /**
   * Get scale factors based on current screen size.
   */
  getScaleFactors() {
    const screenWidth = this._scene.scale.width;
    const screenHeight = this._scene.scale.height;
    return {
      x: screenWidth / DESIGN_WIDTH,
      y: screenHeight / DESIGN_HEIGHT,
      screenWidth,
      screenHeight,
    };
  }

  /**
   * Show an impact event (bore, OT, etc).
   *
   * @param {string} event - Event type ('b', '2b', '3b', '4b', 'ot')
   */
  showImpactEvent(event) {
    const scene = this._scene;
    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();

    // OT uses different position (top-left corner of play area) and smaller size
    const isOT = event === 'ot';
    const otOffsetX = 180; // Offset from center toward top-left
    const otOffsetY = 150;
    const x = isOT ? screenWidth / 2 - otOffsetX * scaleX : screenWidth / 2;
    const y = isOT ? screenHeight / 2 - otOffsetY * scaleY : screenHeight / 2;
    const targetScale = isOT ? 0.9 : 1.2;

    const impactImage = scene.add
      .image(x, y, event)
      .setScale(0)
      .setAlpha(1)
      .setDepth(999);

    this._impactSprites.push(impactImage);

    // Tween for impact effect (scale up + bounce)
    scene.tweens.add({
      targets: impactImage,
      scale: { from: 0, to: targetScale },
      ease: 'Back.Out',
      duration: 500,
    });

    // Remove the image after 1.5 seconds with fade
    scene.time.delayedCall(1500, () => {
      scene.tweens.add({
        targets: impactImage,
        alpha: { from: 1, to: 0 },
        duration: 1000,
        ease: 'Power1',
        onComplete: () => {
          impactImage.destroy();
          const index = this._impactSprites.indexOf(impactImage);
          if (index > -1) {
            this._impactSprites.splice(index, 1);
          }
        },
      });
    });
  }

  /**
   * Show rainbow effect for a player position.
   *
   * @param {number} rainbowPosition - Position of player with rainbow (1-4)
   * @param {Function} onComplete - Optional callback when animation completes
   */
  showRainbow(rainbowPosition, onComplete = null) {
    if (!this._playerPosition) {
      console.warn('EffectsManager: Player position not set');
      return;
    }

    const scene = this._scene;
    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();

    let x, y;

    // Calculate position based on relative player position
    if (rainbowPosition === this._playerPosition) {
      // Self
      x = screenWidth / 2 + 580 * scaleX;
      y = screenHeight / 2 + 125 * scaleY;
    } else if (rainbowPosition === rotate(this._playerPosition)) {
      // Opp1 (to the left)
      x = screenWidth / 2 - 645 * scaleX;
      y = screenHeight / 2;
    } else if (rainbowPosition === team(this._playerPosition)) {
      // Partner (top)
      x = screenWidth / 2 + 135 * scaleX;
      y = screenHeight / 2 - 400 * scaleY;
    } else if (rainbowPosition === rotate(rotate(rotate(this._playerPosition)))) {
      // Opp2 (to the right)
      x = screenWidth / 2 + 630 * scaleX;
      y = screenHeight / 2;
    } else {
      console.warn('EffectsManager: Invalid rainbow position');
      return;
    }

    const rainbowSprite = scene.add.image(x, y, 'rainbow').setScale(0).setDepth(1000).setAlpha(1);

    this._rainbowSprites.push(rainbowSprite);

    // Scale up animation
    scene.tweens.add({
      targets: rainbowSprite,
      scale: { from: 0, to: 1 },
      ease: 'Power2',
      duration: 500,
      onComplete: () => {
        // Fade out after delay
        scene.time.delayedCall(2000, () => {
          scene.tweens.add({
            targets: rainbowSprite,
            alpha: { from: 1, to: 0 },
            duration: 1000,
            ease: 'Power1',
            onComplete: () => {
              rainbowSprite.destroy();
              const index = this._rainbowSprites.indexOf(rainbowSprite);
              if (index > -1) {
                this._rainbowSprites.splice(index, 1);
              }
              if (onComplete) {
                onComplete();
              }
            },
          });
        });
      },
    });
  }

  /**
   * Show rainbows for multiple positions.
   *
   * @param {Array<number>} positions - Array of positions with rainbows
   * @param {Function} onGameFeed - Callback to add to game feed
   * @param {Function} getPlayerName - Function to get player name from position
   */
  showRainbows(positions, onGameFeed = null, getPlayerName = null) {
    positions.forEach((position) => {
      if (onGameFeed && getPlayerName) {
        onGameFeed(`${getPlayerName(position)} has a rainbow!`);
      }
      this.showRainbow(position);
    });
  }

  /**
   * Add turn glow to a DOM element.
   *
   * @param {HTMLElement|string} element - Element or element ID
   */
  addTurnGlow(element) {
    const el = typeof element === 'string' ? document.getElementById(element) : element;
    if (el) {
      el.classList.add('turn-glow');
    }
  }

  /**
   * Remove turn glow from a DOM element.
   *
   * @param {HTMLElement|string} element - Element or element ID
   */
  removeTurnGlow(element) {
    const el = typeof element === 'string' ? document.getElementById(element) : element;
    if (el) {
      el.classList.remove('turn-glow');
    }
  }

  /**
   * Remove turn glow from all elements.
   */
  clearAllTurnGlows() {
    document.querySelectorAll('.turn-glow').forEach((el) => {
      el.classList.remove('turn-glow');
    });
  }

  /**
   * Clear all active effects.
   */
  clearAll() {
    // Clear rainbow sprites
    this._rainbowSprites.forEach((sprite) => {
      if (sprite && sprite.active) {
        sprite.destroy();
      }
    });
    this._rainbowSprites = [];

    // Clear impact sprites
    this._impactSprites.forEach((sprite) => {
      if (sprite && sprite.active) {
        sprite.destroy();
      }
    });
    this._impactSprites = [];

    // Clear turn glows
    this.clearAllTurnGlows();
  }

  /**
   * Reset for new hand.
   */
  resetForNewHand() {
    this.clearAll();
  }

  /**
   * Check if the document is visible.
   *
   * @returns {boolean} True if visible
   */
  isVisible() {
    return document.visibilityState === 'visible';
  }
}

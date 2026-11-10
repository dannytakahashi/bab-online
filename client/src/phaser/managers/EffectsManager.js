/**
 * Effects Manager for Phaser
 *
 * Handles visual effects like bore impacts, rainbow displays, and turn indicators.
 */

import { team, rotate } from '../../utils/positions.js';
import { sceneDelay, sceneTween } from '../TableDirector.js';
import { layoutOf } from '../layout/computeTableLayout.js';

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

  /** The table layout (its `effects` anchors: the trick centre, the seats). */
  layout() {
    return layoutOf(this._scene);
  }

  /**
   * Show an impact event (bore, OT, etc).
   *
   * @param {string} event - Event type ('b', '2b', '3b', '4b', 'ot')
   */
  showImpactEvent(event) {
    const scene = this._scene;
    const { effects } = this.layout();

    // OT uses different position (top-left corner of play area) and smaller size
    const isOT = event === 'ot';
    const spot = isOT ? effects.overTrump : effects.impact;
    const { x, y } = spot;
    const targetScale = spot.scale;

    const impactImage = scene.add
      .image(x, y, event)
      .setScale(0)
      .setAlpha(1)
      .setDepth(999);

    this._impactSprites.push(impactImage);

    // Tween for impact effect (scale up + bounce)
    sceneTween(scene, {
      targets: impactImage,
      scale: { from: 0, to: targetScale },
      ease: 'Back.Out',
      duration: 500,
    });

    // Remove the image after 1.5 seconds with fade
    sceneDelay(scene, 1500, () => {
      sceneTween(scene, {
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
    const { effects } = this.layout();

    // Beside the seat's avatar (the layout's rainbow anchor per seat)
    let seat;
    if (rainbowPosition === this._playerPosition) seat = 'self';
    else if (rainbowPosition === rotate(this._playerPosition)) seat = 'opp1';
    else if (rainbowPosition === team(this._playerPosition)) seat = 'partner';
    else if (rainbowPosition === rotate(rotate(rotate(this._playerPosition)))) seat = 'opp2';
    else {
      console.warn('EffectsManager: Invalid rainbow position');
      return;
    }
    const { x, y } = effects.rainbow[seat];

    const rainbowSprite = scene.add.image(x, y, 'rainbow').setScale(0).setDepth(1000).setAlpha(1);

    this._rainbowSprites.push(rainbowSprite);

    // Scale up animation
    sceneTween(scene, {
      targets: rainbowSprite,
      scale: { from: 0, to: effects.rainbowScale },
      ease: 'Power2',
      duration: 500,
      onComplete: () => {
        // Fade out after delay
        sceneDelay(scene, 2000, () => {
          sceneTween(scene, {
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

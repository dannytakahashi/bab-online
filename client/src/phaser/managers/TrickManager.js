/**
 * Trick sprite management for Phaser.
 *
 * Handles trick display, card animations to center, and trick collection.
 */

import { getCardImageKey } from '../../utils/cards.js';
import { CARD_CONFIG, ANIMATION_CONFIG } from '../config.js';

/**
 * Base design dimensions for scaling.
 */
const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 953;

/**
 * TrickManager handles all trick-related sprite operations.
 */
export class TrickManager {
  /**
   * @param {Phaser.Scene} scene - The Phaser scene
   */
  constructor(scene) {
    this._scene = scene;

    // Current trick sprites (in play area)
    this._currentTrick = [];

    // Trick history (stacked off to sides)
    this._teamTrickHistory = [];
    this._oppTrickHistory = [];

    // Play positions for card animations
    this._playPositions = {
      opponent1: { x: 0, y: 0 },
      opponent2: { x: 0, y: 0 },
      partner: { x: 0, y: 0 },
      self: { x: 0, y: 0 },
    };

    // Player's position for calculating relative positions
    this._playerPosition = null;

    // Track trick counts
    this._teamTrickCount = 0;
    this._oppTrickCount = 0;
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
   * Update play positions for card animations.
   */
  updatePlayPositions() {
    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();
    const playOffsetX = 80 * scaleX;
    const playOffsetY = 80 * scaleY;

    this._playPositions = {
      opponent1: { x: screenWidth / 2 - playOffsetX, y: screenHeight / 2 },
      opponent2: { x: screenWidth / 2 + playOffsetX, y: screenHeight / 2 },
      partner: { x: screenWidth / 2, y: screenHeight / 2 - playOffsetY },
      self: { x: screenWidth / 2, y: screenHeight / 2 + playOffsetY },
    };
  }

  /**
   * Get play position for a relative position key.
   */
  getPlayPosition(positionKey) {
    return this._playPositions[positionKey];
  }

  /**
   * Get relative position key (self, partner, opponent1, opponent2) from absolute position.
   */
  getRelativePositionKey(absolutePosition) {
    if (!this._playerPosition) return null;

    if (absolutePosition === this._playerPosition) {
      return 'self';
    }
    if (absolutePosition === this._playerPosition + 1 ||
        absolutePosition === this._playerPosition - 3) {
      return 'opponent1';
    }
    if (absolutePosition === this._playerPosition + 2 ||
        absolutePosition === this._playerPosition - 2) {
      return 'partner';
    }
    if (absolutePosition === this._playerPosition + 3 ||
        absolutePosition === this._playerPosition - 1) {
      return 'opponent2';
    }
    return null;
  }

  /**
   * Add a played card to the current trick.
   *
   * @param {Object} card - Card data
   * @param {number} position - Player position who played
   * @param {Phaser.GameObjects.Image} sprite - Sprite to animate (for opponent cards)
   * @param {boolean} animate - Whether to animate
   */
  addPlayedCard(card, position, sprite = null, animate = true) {
    const scene = this._scene;
    const positionKey = this.getRelativePositionKey(position);
    const playPos = this._playPositions[positionKey];

    if (!playPos) {
      console.warn('Unknown position:', position);
      return null;
    }

    // If no sprite provided, create one (for self-plays)
    if (!sprite) {
      const cardKey = getCardImageKey(card);
      sprite = scene.add.image(playPos.x, playPos.y, 'cards', cardKey);
      sprite.setScale(1.5);
      sprite.setDepth(200);
    }

    // Store position key for resize handling
    sprite.setData('playPosition', positionKey);

    // Animate to position
    if (animate && sprite.x !== playPos.x || sprite.y !== playPos.y) {
      scene.tweens.add({
        targets: sprite,
        x: playPos.x,
        y: playPos.y,
        duration: 500,
        ease: 'Power2',
        rotation: 0,
        scale: 1.5,
        onComplete: () => {
          sprite.setDepth(200);
        },
      });
    } else {
      sprite.x = playPos.x;
      sprite.y = playPos.y;
      sprite.setDepth(200);
      sprite.setScale(1.5);
      sprite.setRotation(0);
    }

    this._currentTrick.push(sprite);
    return sprite;
  }

  /**
   * Handle trick completion - animate cards to winner's stack.
   *
   * @param {number} winnerPosition - Position of trick winner (1-4)
   * @param {boolean} isMyTeam - Whether winner is on player's team
   */
  completeTrick(winnerPosition, isMyTeam) {
    const scene = this._scene;
    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();
    const trickSpacing = 40 * scaleX;

    // Determine stack position based on winner
    let winningPosition;
    if (isMyTeam) {
      this._teamTrickCount++;
      winningPosition = {
        x: 20 + this._teamTrickCount * trickSpacing,
        y: screenHeight - 100,
      };
    } else {
      this._oppTrickCount++;
      winningPosition = {
        x: 20 + this._oppTrickCount * trickSpacing,
        y: 100,
      };
    }

    // Copy trick cards for history
    const trickCards = [...this._currentTrick];

    // Animate cards to stack position
    trickCards.forEach((card, index) => {
      // If not our team's trick, show card backs
      if (!isMyTeam) {
        card.setTexture('cardBack');
      }

      if (this.isVisible()) {
        scene.tweens.add({
          targets: card,
          x: winningPosition.x,
          y: winningPosition.y,
          scale: 0.75,
          duration: 500,
          ease: 'Power2',
          onComplete: () => {
            card.setDepth(200 + index);
          },
        });
      } else {
        card.x = winningPosition.x;
        card.y = winningPosition.y;
        card.setDepth(200 + index);
        card.setScale(0.75);
      }

      // Make interactive for hover
      card.setInteractive();
      card.originalDepth = 200 + index;
    });

    // Store in history
    if (isMyTeam) {
      this._teamTrickHistory.push({
        cards: trickCards,
        position: { ...winningPosition },
      });

      // Add hover effects for team tricks
      this._setupTrickHover(trickCards, winningPosition);
    } else {
      this._oppTrickHistory.push({
        cards: trickCards,
        position: { ...winningPosition },
      });
    }

    // Clear current trick
    this._currentTrick = [];
  }

  /**
   * Set up hover effects for a completed trick.
   */
  _setupTrickHover(trickCards, position) {
    const scene = this._scene;
    const { x: scaleX, y: scaleY } = this.getScaleFactors();

    const fanOut = () => {
      trickCards.forEach((card, index) => {
        card.setDepth(250 + index);
        if (this.isVisible()) {
          scene.tweens.add({
            targets: card,
            x: position.x + index * 20 * scaleX,
            y: position.y - index * 5 * scaleY,
            duration: 200,
            ease: 'Power1',
          });
        } else {
          card.x = position.x + index * 20 * scaleX;
          card.y = position.y - index * 5 * scaleY;
        }
      });
    };

    const resetStack = () => {
      trickCards.forEach((card) => {
        card.setDepth(card.originalDepth);
        if (this.isVisible()) {
          scene.tweens.add({
            targets: card,
            x: position.x,
            y: position.y,
            duration: 200,
            ease: 'Power1',
          });
        } else {
          card.x = position.x;
          card.y = position.y;
        }
      });
    };

    trickCards.forEach((card) => {
      card.on('pointerover', fanOut);
      card.on('pointerout', resetStack);
    });
  }

  /**
   * Check if document is visible.
   */
  isVisible() {
    return document.visibilityState === 'visible';
  }

  /**
   * Reposition current trick cards (for resize handling).
   */
  repositionCurrentTrick() {
    this.updatePlayPositions();

    this._currentTrick.forEach((card) => {
      if (!card || !card.active) return;

      const positionKey = card.getData('playPosition');
      if (!positionKey || !this._playPositions[positionKey]) return;

      card.x = this._playPositions[positionKey].x;
      card.y = this._playPositions[positionKey].y;
    });
  }

  /**
   * Clear current trick sprites.
   */
  clearCurrentTrick() {
    this._currentTrick.forEach((sprite) => {
      if (sprite && sprite.destroy) {
        sprite.destroy();
      }
    });
    this._currentTrick = [];
  }

  /**
   * Clear all trick history sprites.
   */
  clearTrickHistory() {
    // Clear team tricks
    this._teamTrickHistory.forEach((trick) => {
      trick.cards.forEach((card) => {
        if (card && card.destroy) {
          card.destroy();
        }
      });
    });
    this._teamTrickHistory = [];
    this._teamTrickCount = 0;

    // Clear opponent tricks
    this._oppTrickHistory.forEach((trick) => {
      trick.cards.forEach((card) => {
        if (card && card.destroy) {
          card.destroy();
        }
      });
    });
    this._oppTrickHistory = [];
    this._oppTrickCount = 0;
  }

  /**
   * Clear all trick sprites.
   */
  clearAll() {
    this.clearCurrentTrick();
    this.clearTrickHistory();
  }

  /**
   * Reset for new hand.
   */
  resetForNewHand() {
    this.clearAll();
    this._teamTrickCount = 0;
    this._oppTrickCount = 0;
  }

  /**
   * Get current trick sprite count.
   */
  getCurrentTrickCount() {
    return this._currentTrick.length;
  }

  /**
   * Get current trick sprites (for external use).
   */
  getCurrentTrickSprites() {
    return this._currentTrick;
  }

  /**
   * Restore played cards from rejoin data.
   *
   * @param {Array} playedCards - Array of cards (indexed by position-1)
   */
  restorePlayedCards(playedCards) {
    if (!playedCards || playedCards.length === 0) return;

    this.updatePlayPositions();

    playedCards.forEach((card, index) => {
      if (!card) return;

      const cardPosition = index + 1; // Convert to 1-4 position
      this.addPlayedCard(card, cardPosition, null, false);
    });
  }
}

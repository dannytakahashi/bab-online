/**
 * Opponent sprite management for Phaser.
 *
 * Handles opponent card backs, avatars, dealer button, and turn glow.
 */

import { team, rotate } from '../../utils/positions.js';
import { CARD_CONFIG, ANIMATION_CONFIG } from '../config.js';

/**
 * Base design dimensions for scaling.
 */
const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 953;

/**
 * OpponentManager handles all opponent-related sprite operations.
 */
export class OpponentManager {
  /**
   * @param {Phaser.Scene} scene - The Phaser scene
   */
  constructor(scene) {
    this._scene = scene;

    // Card back sprites for each opponent
    this._cardSprites = {
      partner: [],
      opp1: [],
      opp2: [],
    };

    // DOM-based avatars (for CSS glow support)
    this._avatarDoms = {
      partner: null,
      opp1: null,
      opp2: null,
    };

    // Dealer button sprite
    this._dealerButton = null;

    // Player's position (needed to calculate relative positions)
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
   * Calculate opponent positions relative to screen.
   */
  getOpponentPositions() {
    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();
    const centerX = screenWidth / 2;
    const centerY = screenHeight / 2;

    // Clamp positions to stay within canvas bounds
    const minX = 80;
    const maxX = screenWidth - 120;

    return {
      partner: {
        cardX: centerX,
        cardY: centerY - 275 * scaleY,
        avatarX: centerX,
        avatarY: centerY - 400 * scaleY,
      },
      opp1: {
        cardX: Math.max(minX + 50, centerX - 425 * scaleX),
        cardY: centerY,
        avatarX: Math.max(minX, centerX - 550 * scaleX),
        avatarY: centerY,
      },
      opp2: {
        cardX: Math.min(maxX - 50, centerX + 425 * scaleX),
        cardY: centerY,
        avatarX: Math.min(maxX, centerX + 550 * scaleX),
        avatarY: centerY,
      },
    };
  }

  /**
   * Display opponent hands (card backs).
   *
   * @param {number} cardCount - Number of cards each opponent has
   * @param {number} dealerPosition - Position of the dealer (1-4)
   * @param {Object} playerData - Player data with usernames and pics
   * @param {boolean} skipAnimation - Skip deal animation
   */
  displayOpponentHands(cardCount, dealerPosition, playerData = null, skipAnimation = false) {
    this.clearCards();

    if (cardCount === 0) return;

    const scene = this._scene;
    const positions = this.getOpponentPositions();
    const { x: scaleX, y: scaleY } = this.getScaleFactors();
    const cardSpacing = 10 * scaleX;

    // Display card backs for each opponent position
    ['partner', 'opp1', 'opp2'].forEach((opponentId) => {
      const pos = positions[opponentId];
      const isHorizontal = opponentId === 'partner';

      for (let i = 0; i < cardCount; i++) {
        let x, y, rotation;

        if (isHorizontal) {
          // Partner - horizontal spread
          const totalWidth = (cardCount - 1) * cardSpacing;
          x = pos.cardX - totalWidth / 2 + i * cardSpacing;
          y = pos.cardY;
          rotation = 0;
        } else {
          // Side opponents - vertical spread with rotation
          const totalHeight = (cardCount - 1) * cardSpacing;
          x = pos.cardX;
          y = pos.cardY - totalHeight / 2 + i * cardSpacing;
          rotation = opponentId === 'opp1' ? -Math.PI / 2 : Math.PI / 2;
        }

        // Create card back sprite
        const sprite = scene.add.image(x, y, 'cardBack');
        sprite.setScale(0.5);
        sprite.setRotation(rotation);
        sprite.setDepth(100 + i);

        if (!skipAnimation) {
          // Animate from center
          sprite.setPosition(scene.scale.width / 2, scene.scale.height / 2);
          sprite.setScale(0);
          sprite.setAlpha(0);

          scene.tweens.add({
            targets: sprite,
            x,
            y,
            scale: 0.5,
            alpha: 1,
            duration: 200,
            ease: 'Power2',
            delay: i * 30,
          });
        }

        this._cardSprites[opponentId].push(sprite);
      }
    });

    // Display dealer button
    this.displayDealerButton(dealerPosition);

    // Display opponent avatars if we have player data
    if (playerData) {
      this.displayAvatars(playerData);
    }
  }

  /**
   * Display the dealer button at the correct position.
   */
  displayDealerButton(dealerPosition) {
    if (this._dealerButton) {
      this._dealerButton.destroy();
      this._dealerButton = null;
    }

    if (!dealerPosition || !this._playerPosition) return;

    const scene = this._scene;
    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();
    const positions = this.getOpponentPositions();

    let buttonX, buttonY;

    if (dealerPosition === this._playerPosition) {
      // Player is dealer - position near player info box
      buttonX = screenWidth - 380 * scaleX + 100 * scaleX;
      buttonY = screenHeight - 150 * scaleY - 60 * scaleY;
    } else if (team(this._playerPosition) === dealerPosition) {
      // Partner is dealer
      buttonX = positions.partner.avatarX + 70;
      buttonY = positions.partner.avatarY;
    } else if (rotate(this._playerPosition) === dealerPosition) {
      // Opp1 is dealer
      buttonX = positions.opp1.avatarX - 70;
      buttonY = positions.opp1.avatarY;
    } else {
      // Opp2 is dealer
      buttonX = positions.opp2.avatarX + 70;
      buttonY = positions.opp2.avatarY;
    }

    this._dealerButton = scene.add.image(buttonX, buttonY, 'dealer');
    this._dealerButton.setScale(0.15 * scaleX);
    this._dealerButton.setDepth(150);
  }

  /**
   * Display opponent avatars using DOM elements (for CSS glow support).
   */
  displayAvatars(playerData) {
    this.clearAvatars();

    if (!this._playerPosition || !playerData) return;

    const positions = this.getOpponentPositions();

    // Get opponent positions relative to player
    const partnerPos = team(this._playerPosition);
    const opp1Pos = rotate(this._playerPosition);
    const opp2Pos = rotate(rotate(rotate(this._playerPosition)));

    const opponentMap = {
      partner: partnerPos,
      opp1: opp1Pos,
      opp2: opp2Pos,
    };

    ['partner', 'opp1', 'opp2'].forEach((opponentId) => {
      const pos = opponentMap[opponentId];
      const screenPos = positions[opponentId];

      // Find player data for this position
      const posIndex = playerData.position?.indexOf(pos);
      if (posIndex === -1 || posIndex === undefined) return;

      const username = playerData.username?.[posIndex]?.username ||
        playerData.username?.[posIndex] ||
        `P${pos}`;
      const pic = playerData.pics?.[posIndex];

      this._createAvatarDom(opponentId, pic, username, screenPos.avatarX, screenPos.avatarY);
    });
  }

  /**
   * Create a DOM-based avatar element.
   */
  _createAvatarDom(opponentId, pic, username, x, y) {
    // Remove existing
    if (this._avatarDoms[opponentId]) {
      this._avatarDoms[opponentId].remove();
    }

    const container = document.createElement('div');
    container.id = `opponent-avatar-${opponentId}`;
    container.className = `opponent-avatar-container ${opponentId}`;
    container.style.cssText = `
      position: absolute;
      left: ${x}px;
      top: ${y}px;
      transform: translate(-50%, -50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      pointer-events: none;
      z-index: 100;
    `;

    // Avatar image
    const img = document.createElement('img');
    img.src = pic ? `assets/profile${pic}.png` : 'assets/profile1.png';
    img.alt = username;
    img.style.cssText = `
      width: 60px;
      height: 60px;
      border-radius: 50%;
      border: 3px solid #333;
      background: #1a1a1a;
    `;
    container.appendChild(img);

    // Username label
    const label = document.createElement('div');
    label.textContent = username;
    label.style.cssText = `
      margin-top: 5px;
      font-size: 14px;
      color: white;
      text-shadow: 1px 1px 2px black;
      white-space: nowrap;
    `;
    container.appendChild(label);

    document.body.appendChild(container);
    this._avatarDoms[opponentId] = container;
  }

  /**
   * Add turn glow to an opponent avatar.
   */
  addTurnGlow(opponentId) {
    const dom = this._avatarDoms[opponentId];
    if (dom) {
      dom.classList.add('turn-glow');
    }
  }

  /**
   * Remove turn glow from all opponent avatars.
   */
  removeTurnGlow() {
    Object.values(this._avatarDoms).forEach((dom) => {
      if (dom) {
        dom.classList.remove('turn-glow');
      }
    });
  }

  /**
   * Remove a card from an opponent's hand (when they play).
   *
   * @param {string} opponentId - 'partner', 'opp1', or 'opp2'
   * @returns {Phaser.GameObjects.Image|null} The removed sprite
   */
  removeCard(opponentId) {
    const sprites = this._cardSprites[opponentId];
    if (sprites && sprites.length > 0) {
      return sprites.pop();
    }
    return null;
  }

  /**
   * Reposition all opponent elements (for resize handling).
   */
  reposition() {
    const positions = this.getOpponentPositions();
    const { x: scaleX } = this.getScaleFactors();
    const cardSpacing = 10 * scaleX;

    // Reposition card sprites
    ['partner', 'opp1', 'opp2'].forEach((opponentId) => {
      const sprites = this._cardSprites[opponentId];
      if (!sprites || sprites.length === 0) return;

      const pos = positions[opponentId];
      const isHorizontal = opponentId === 'partner';
      const numCards = sprites.length;

      sprites.forEach((sprite, index) => {
        if (!sprite || !sprite.active) return;

        if (isHorizontal) {
          const totalWidth = (numCards - 1) * cardSpacing;
          sprite.x = pos.cardX - totalWidth / 2 + index * cardSpacing;
          sprite.y = pos.cardY;
        } else {
          const totalHeight = (numCards - 1) * cardSpacing;
          sprite.x = pos.cardX;
          sprite.y = pos.cardY - totalHeight / 2 + index * cardSpacing;
        }
      });
    });

    // Reposition DOM avatars
    Object.keys(positions).forEach((opponentId) => {
      const dom = this._avatarDoms[opponentId];
      if (dom) {
        dom.style.left = `${positions[opponentId].avatarX}px`;
        dom.style.top = `${positions[opponentId].avatarY}px`;
      }
    });

    // Reposition dealer button
    if (this._dealerButton && this._dealerButton.active && this._playerPosition) {
      // Re-display to recalculate position
      // We need to know the dealer position to do this properly
      // For now, just update based on current button data
    }
  }

  /**
   * Clear all card sprites.
   */
  clearCards() {
    ['partner', 'opp1', 'opp2'].forEach((opponentId) => {
      this._cardSprites[opponentId].forEach((sprite) => {
        if (sprite && sprite.destroy) {
          sprite.destroy();
        }
      });
      this._cardSprites[opponentId] = [];
    });
  }

  /**
   * Clear all avatar DOM elements.
   */
  clearAvatars() {
    Object.keys(this._avatarDoms).forEach((key) => {
      if (this._avatarDoms[key]) {
        this._avatarDoms[key].remove();
        this._avatarDoms[key] = null;
      }
    });
  }

  /**
   * Clear dealer button.
   */
  clearDealerButton() {
    if (this._dealerButton) {
      this._dealerButton.destroy();
      this._dealerButton = null;
    }
  }

  /**
   * Clear all opponent elements.
   */
  clearAll() {
    this.clearCards();
    this.clearAvatars();
    this.clearDealerButton();
  }

  /**
   * Get card count for an opponent.
   */
  getCardCount(opponentId) {
    return this._cardSprites[opponentId]?.length || 0;
  }
}

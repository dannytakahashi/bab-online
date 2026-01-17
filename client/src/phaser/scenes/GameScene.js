/**
 * Main game scene for the Phaser game.
 *
 * Handles card display, opponent visuals, trick animations,
 * and all game-related visual updates.
 */

import { getGameState } from '../../state/GameState.js';
import { getCardImageKey } from '../../utils/cards.js';
import { team, rotate } from '../../utils/positions.js';

/**
 * Base design dimensions for scaling calculations.
 */
const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 953;

/**
 * Main game scene class.
 */
export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });

    // State reference
    this.state = null;

    // Scene ready flag
    this.isReady = false;

    // Card sprites
    this.myCards = [];
    this.opponentCardSprites = {
      partner: [],
      opp1: [],
      opp2: [],
    };
    this.currentTrickSprites = [];

    // UI elements
    this.tableCardSprite = null;
    this.tableCardBackground = null;
    this.tableCardLabel = null;
    this.buttonHandle = null; // Dealer button
    this.playerInfo = null;

    // DOM-based opponent avatars (for CSS glow support)
    this.opponentAvatarDoms = {
      partner: null,
      opp1: null,
      opp2: null,
    };

    // Play positions for card animations
    this.playPositions = {
      opponent1: { x: 0, y: 0 },
      opponent2: { x: 0, y: 0 },
      partner: { x: 0, y: 0 },
      self: { x: 0, y: 0 },
    };

    // Trick history (sprite arrays for hover effects)
    this.teamTrickHistory = [];
    this.oppTrickHistory = [];

    // Active chat bubbles by position key
    this.activeChatBubbles = {};

    // Callbacks for external UI updates
    this.callbacks = {};
  }

  /**
   * Set callbacks for external updates.
   */
  setCallbacks(callbacks) {
    this.callbacks = callbacks || {};
  }

  /**
   * Get current scale factors based on screen size.
   */
  getScaleFactors() {
    const screenWidth = this.scale.width;
    const screenHeight = this.scale.height;
    return {
      x: screenWidth / DESIGN_WIDTH,
      y: screenHeight / DESIGN_HEIGHT,
      screenWidth,
      screenHeight,
    };
  }

  // ============================================
  // Phaser Lifecycle Methods
  // ============================================

  preload() {
    console.log('🎮 GameScene.preload() running...');

    // Load card atlas (reduces 54 requests to 2)
    this.load.atlas('cards', 'assets/sprites/cards.png', 'assets/sprites/cards.json');

    // Load other essential assets
    this.load.image('cardBack', 'assets/card_back.png');
    this.load.image('dealer', 'assets/frog.png');
    this.load.image('background', 'assets/background.png');
    this.load.image('rainbow', 'assets/rainbow1.png');
    this.load.image('ot', 'assets/ot.png');
    this.load.image('b', 'assets/b.png');
    this.load.image('2b', 'assets/2b.png');
    this.load.image('3b', 'assets/3b.png');
    this.load.image('4b', 'assets/4b.png');

    // Load profile images
    for (let i = 1; i <= 82; i++) {
      // Skip missing profile numbers
      if (i === 10 || i === 11) continue;
      this.load.image(`profile${i}`, `assets/profile${i}.png`);
    }
  }

  create() {
    console.log('🎮 GameScene.create() running...');

    // Get state reference
    this.state = getGameState();

    // Set up resize handler
    this.scale.on('resize', (gameSize) => {
      console.log(`📐 Phaser resize: ${gameSize.width}x${gameSize.height}`);
      this.handleResize(gameSize.width, gameSize.height);
    });

    // Initial position calculation
    this.updatePlayPositions();

    // Mark scene as ready
    this.isReady = true;

    // Process any pending data
    this.processPendingData();

    console.log('🎮 GameScene.create() complete!');
  }

  update() {
    // Empty - we don't need per-frame updates
  }

  // ============================================
  // Pending Data Processing
  // ============================================

  /**
   * Process any pending data that arrived before scene was ready.
   */
  processPendingData() {
    const state = this.state;

    // Check for pending rejoin
    const rejoinData = state.consumePendingRejoinData();
    if (rejoinData) {
      console.log('🔄 Processing pending rejoin data...');
      this.processRejoin(rejoinData);
      return;
    }

    // Check for pending position update
    const positionData = state.consumePendingPositionData();
    if (positionData) {
      console.log('📍 Processing pending position data...');
      this.callbacks.onPositionUpdate?.(positionData);
    }

    // Check for pending game start
    const gameStartData = state.consumePendingGameStartData();
    if (gameStartData) {
      console.log('🎮 Processing pending game start data...');
      this.callbacks.onGameStart?.(gameStartData);
    }
  }

  /**
   * Process rejoin data and restore game visuals.
   */
  processRejoin(data) {
    console.log('🔄 Processing rejoin:', data);
    // This will be called by legacy code for now
    this.callbacks.onRejoinProcess?.(data);
  }

  // ============================================
  // Resize Handling
  // ============================================

  /**
   * Handle window/container resize.
   */
  handleResize(newWidth, newHeight) {
    try {
      this.updatePlayPositions();
      this.repositionHandCards();
      this.repositionOpponentElements();
      this.repositionTrumpDisplay();
      this.repositionCurrentTrick();
      this.repositionDOMBackgrounds();

      this.callbacks.onResize?.(newWidth, newHeight);
    } catch (e) {
      console.error('❌ Error in handleResize:', e);
    }
  }

  /**
   * Update play area positions for card animations.
   */
  updatePlayPositions() {
    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();
    const playOffsetX = 80 * scaleX;
    const playOffsetY = 80 * scaleY;

    this.playPositions.opponent1 = { x: screenWidth / 2 - playOffsetX, y: screenHeight / 2 };
    this.playPositions.opponent2 = { x: screenWidth / 2 + playOffsetX, y: screenHeight / 2 };
    this.playPositions.partner = { x: screenWidth / 2, y: screenHeight / 2 - playOffsetY };
    this.playPositions.self = { x: screenWidth / 2, y: screenHeight / 2 + playOffsetY };
  }

  /**
   * Reposition cards in player's hand during resize.
   */
  repositionHandCards() {
    if (!this.myCards || this.myCards.length === 0) return;

    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();

    const cardSpacing = 50 * scaleX;
    const totalWidth = (this.myCards.length - 1) * cardSpacing;
    const startX = (screenWidth - totalWidth) / 2;

    // Calculate hand area position
    const bottomClearance = 20 * scaleY;
    const cardHeight = 140 * 1.5 * scaleY;
    const cardPadding = 10 * scaleY;
    const handAreaHeight = cardHeight + cardPadding * 2;
    const handAreaTop = screenHeight - handAreaHeight - bottomClearance;
    const startY = handAreaTop + handAreaHeight / 2;

    this.myCards.forEach((card, index) => {
      if (card && card.active) {
        card.x = startX + index * cardSpacing;
        card.y = startY;
        card.setData('baseY', startY);
      }
    });
  }

  /**
   * Reposition opponent elements (avatars, card backs) during resize.
   */
  repositionOpponentElements() {
    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();
    const centerX = screenWidth / 2;
    const centerY = screenHeight / 2;

    // Clamp positions to stay within canvas bounds
    const minX = 80;
    const maxX = screenWidth - 120;

    const positions = {
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

    // Reposition opponent card sprites
    const cardSpacing = 10 * scaleX;
    Object.keys(positions).forEach((opponentId) => {
      const sprites = this.opponentCardSprites[opponentId];
      if (!sprites) return;

      const pos = positions[opponentId];
      const isHorizontal = opponentId === 'partner';
      const numCards = sprites.length;

      sprites.forEach((card, index) => {
        if (card && card.active) {
          if (isHorizontal) {
            const totalWidth = (numCards - 1) * cardSpacing;
            card.x = pos.cardX - totalWidth / 2 + index * cardSpacing;
            card.y = pos.cardY;
          } else {
            const totalHeight = (numCards - 1) * cardSpacing;
            card.x = pos.cardX;
            card.y = pos.cardY - totalHeight / 2 + index * cardSpacing;
          }
        }
      });
    });

    // Reposition DOM avatars
    Object.keys(positions).forEach((opponentId) => {
      const dom = this.opponentAvatarDoms[opponentId];
      if (dom) {
        dom.style.left = `${positions[opponentId].avatarX}px`;
        dom.style.top = `${positions[opponentId].avatarY}px`;
      }
    });
  }

  /**
   * Reposition trump card display.
   */
  repositionTrumpDisplay() {
    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();
    const trumpX = screenWidth / 2 + 500 * scaleX;
    const trumpY = screenHeight / 2 - 300 * scaleY;

    if (this.tableCardSprite && this.tableCardSprite.active) {
      this.tableCardSprite.setPosition(trumpX, trumpY);
    }
    if (this.tableCardBackground && this.tableCardBackground.active) {
      this.tableCardBackground.setPosition(trumpX, trumpY);
    }
    if (this.tableCardLabel && this.tableCardLabel.active) {
      this.tableCardLabel.setPosition(trumpX, trumpY - 100);
    }
  }

  /**
   * Reposition cards in current trick during resize.
   */
  repositionCurrentTrick() {
    if (!this.currentTrickSprites || this.currentTrickSprites.length === 0) return;

    this.currentTrickSprites.forEach((card) => {
      if (!card || !card.active) return;

      const playPosition = card.getData('playPosition');
      if (!playPosition || !this.playPositions[playPosition]) return;

      card.x = this.playPositions[playPosition].x;
      card.y = this.playPositions[playPosition].y;
    });
  }

  /**
   * Reposition DOM background elements.
   */
  repositionDOMBackgrounds() {
    // This is handled externally by game.js for now
    this.callbacks.onRepositionDOMBackgrounds?.();
  }

  // ============================================
  // Card Display Methods
  // ============================================

  /**
   * Display the player's hand of cards.
   */
  displayHand(cards, skipAnimation = false) {
    // Clear existing card sprites
    this.clearHand();

    if (!cards || cards.length === 0) return;

    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();

    const cardSpacing = 50 * scaleX;
    const totalWidth = (cards.length - 1) * cardSpacing;
    const startX = (screenWidth - totalWidth) / 2;

    // Calculate hand area position
    const bottomClearance = 20 * scaleY;
    const cardHeight = 140 * 1.5 * scaleY;
    const cardPadding = 10 * scaleY;
    const handAreaHeight = cardHeight + cardPadding * 2;
    const handAreaTop = screenHeight - handAreaHeight - bottomClearance;
    const startY = handAreaTop + handAreaHeight / 2;

    // Create card sprites
    cards.forEach((cardData, index) => {
      const cardKey = getCardImageKey(cardData);
      const targetX = startX + index * cardSpacing;
      const targetY = startY;

      // Create sprite (from bottom of screen if animating)
      const fromY = skipAnimation ? targetY : screenHeight + 100;
      const sprite = this.add.image(targetX, fromY, 'cards', cardKey);

      sprite.setScale(1.5);
      sprite.setDepth(300 + index);
      sprite.setData('card', cardData);
      sprite.setData('baseY', targetY);
      sprite.setData('index', index);

      // Animate into position
      if (!skipAnimation) {
        this.tweens.add({
          targets: sprite,
          y: targetY,
          duration: 200,
          ease: 'Power2',
          delay: index * 50,
        });
      }

      this.myCards.push(sprite);
    });

    // Set up card interactions
    this.setupCardInteractions();
  }

  /**
   * Clear player's hand sprites.
   */
  clearHand() {
    this.myCards.forEach((sprite) => {
      if (sprite && sprite.active) {
        sprite.destroy();
      }
    });
    this.myCards = [];
  }

  /**
   * Set up card hover and click interactions.
   */
  setupCardInteractions() {
    this.myCards.forEach((sprite) => {
      if (!sprite || !sprite.active) return;

      sprite.setInteractive();

      // Hover effects
      sprite.on('pointerover', () => {
        const baseY = sprite.getData('baseY');
        sprite.y = baseY - 20;
        sprite.setDepth(500);
      });

      sprite.on('pointerout', () => {
        const baseY = sprite.getData('baseY');
        const index = sprite.getData('index');
        sprite.y = baseY;
        sprite.setDepth(300 + index);
      });

      // Click to play
      sprite.on('pointerdown', () => {
        const card = sprite.getData('card');
        const isLegal = sprite.getData('isLegal');

        if (isLegal) {
          this.callbacks.onCardClicked?.(card, sprite);
        }
      });
    });
  }

  /**
   * Update card tinting based on legality.
   */
  updateCardLegality(legalityChecker) {
    const state = this.state;

    this.myCards.forEach((sprite) => {
      if (!sprite || !sprite.active) return;

      const card = sprite.getData('card');
      if (!card) return;

      // During bidding or not our turn, dim all cards
      if (state.isBidding || state.currentTurn !== state.position || state.hasPlayedCard) {
        sprite.setTint(0xaaaaaa);
        sprite.setData('isLegal', false);
        return;
      }

      // Check legality with provided checker function
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
   * Display trump card on table.
   */
  displayTrumpCard(trumpCard) {
    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();
    const trumpX = screenWidth / 2 + 500 * scaleX;
    const trumpY = screenHeight / 2 - 300 * scaleY;

    // Clear existing
    if (this.tableCardSprite) {
      this.tableCardSprite.destroy();
    }
    if (this.tableCardBackground) {
      this.tableCardBackground.destroy();
    }
    if (this.tableCardLabel) {
      this.tableCardLabel.destroy();
    }

    // Background
    this.tableCardBackground = this.add.rectangle(trumpX, trumpY, 120, 180, 0x000000, 0.5);
    this.tableCardBackground.setDepth(99);

    // Card
    const cardKey = getCardImageKey(trumpCard);
    this.tableCardSprite = this.add.image(trumpX, trumpY, 'cards', cardKey);
    this.tableCardSprite.setScale(1.2);
    this.tableCardSprite.setDepth(100);

    // Label
    this.tableCardLabel = this.add.text(trumpX, trumpY - 100, 'TRUMP', {
      fontSize: `${24 * scaleX}px`,
      fontStyle: 'bold',
      color: '#FFD700',
    });
    this.tableCardLabel.setOrigin(0.5);
    this.tableCardLabel.setDepth(100);
  }

  // ============================================
  // Chat Bubble Methods
  // ============================================

  /**
   * Show a chat/bid bubble at a position.
   */
  showChatBubble(positionKey, message, color = null, duration = 6000) {
    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();
    const centerX = screenWidth / 2;
    const centerY = screenHeight / 2;

    // Calculate position based on key
    const positions = {
      opp1: { x: centerX - 480 * scaleX, y: centerY },
      opp2: { x: centerX + 620 * scaleX, y: centerY },
      partner: { x: centerX + 20 * scaleX, y: centerY - 380 * scaleY },
      me: { x: screenWidth - 310 * scaleX, y: screenHeight - 270 * scaleY },
    };

    const pos = positions[positionKey];
    if (!pos) return;

    // Destroy existing bubble for this position
    if (this.activeChatBubbles[positionKey]) {
      const existing = this.activeChatBubbles[positionKey];
      if (existing.timer) {
        existing.timer.remove();
      }
      if (existing.bubble) {
        existing.bubble.destroy();
      }
    }

    // Create new bubble
    const bubble = this.createSpeechBubble(pos.x, pos.y, 150, 50, message, color);

    const timer = this.time.delayedCall(duration, () => {
      bubble.destroy();
      delete this.activeChatBubbles[positionKey];
    });

    this.activeChatBubbles[positionKey] = { bubble, timer };
  }

  /**
   * Create a speech bubble container.
   */
  createSpeechBubble(x, y, width, height, text, color = null) {
    const bubbleWidth = width;
    const bubbleHeight = height;
    const bubblePadding = 10;

    // Container
    const container = this.add.container(x, y);
    container.setDepth(1000);

    // Background
    const graphics = this.add.graphics();
    graphics.fillStyle(0x222222, 0.9);
    graphics.fillRoundedRect(-bubbleWidth / 2, -bubbleHeight / 2, bubbleWidth, bubbleHeight, 10);
    container.add(graphics);

    // Text
    const content = this.add.text(0, 0, text, {
      fontSize: '16px',
      color: color || '#ffffff',
      wordWrap: { width: bubbleWidth - bubblePadding * 2 },
    });
    content.setOrigin(0.5);
    container.add(content);

    return container;
  }

  // ============================================
  // Utility Methods
  // ============================================

  /**
   * Check if document is visible.
   */
  isVisible() {
    return document.visibilityState === 'visible';
  }

  /**
   * Force a visual update (for fixing WebGL rendering issues).
   */
  forceRenderUpdate() {
    requestAnimationFrame(() => {
      this.myCards.forEach((sprite) => {
        if (sprite && sprite.active) {
          const currentBlend = sprite.blendMode;
          sprite.setBlendMode(Phaser.BlendModes.ADD);
          sprite.setBlendMode(currentBlend);
          sprite.setVisible(false);
          sprite.setVisible(true);
          sprite.setInteractive();
        }
      });

      if (this.game && this.game.scale) {
        this.game.scale.refresh();
      }
    });
  }

  /**
   * Clean up all visual elements.
   */
  cleanup() {
    // Clear cards
    this.clearHand();

    // Clear opponent cards
    Object.values(this.opponentCardSprites).forEach((sprites) => {
      sprites.forEach((sprite) => {
        if (sprite && sprite.active) {
          sprite.destroy();
        }
      });
    });
    this.opponentCardSprites = { partner: [], opp1: [], opp2: [] };

    // Clear trick sprites
    this.currentTrickSprites.forEach((sprite) => {
      if (sprite && sprite.active) {
        sprite.destroy();
      }
    });
    this.currentTrickSprites = [];

    // Clear trump
    if (this.tableCardSprite) {
      this.tableCardSprite.destroy();
      this.tableCardSprite = null;
    }
    if (this.tableCardBackground) {
      this.tableCardBackground.destroy();
      this.tableCardBackground = null;
    }
    if (this.tableCardLabel) {
      this.tableCardLabel.destroy();
      this.tableCardLabel = null;
    }

    // Clear chat bubbles
    Object.values(this.activeChatBubbles).forEach((bubble) => {
      if (bubble.timer) bubble.timer.remove();
      if (bubble.bubble) bubble.bubble.destroy();
    });
    this.activeChatBubbles = {};

    // Clear DOM avatars
    Object.values(this.opponentAvatarDoms).forEach((dom) => {
      if (dom) dom.remove();
    });
    this.opponentAvatarDoms = { partner: null, opp1: null, opp2: null };
  }
}

// Export for use in Phaser config
export default GameScene;

/**
 * Main game scene for the Phaser game.
 *
 * Handles card display, opponent visuals, trick animations,
 * and all game-related visual updates.
 */

import { getGameState } from '../../state/GameState.js';
import { getCardImageKey } from '../../utils/cards.js';
import { team, rotate } from '../../utils/positions.js';
import { CardManager } from '../managers/CardManager.js';
import { OpponentManager } from '../managers/OpponentManager.js';
import { TrickManager } from '../managers/TrickManager.js';
import { EffectsManager } from '../managers/EffectsManager.js';
import { DrawManager } from '../managers/DrawManager.js';
import { BidManager } from '../managers/BidManager.js';
import { LayoutManager } from '../managers/LayoutManager.js';
import {
  showChatBubble as showChatBubbleUI,
  clearChatBubbles,
} from '../../ui/components/ChatBubble.js';

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

    // Managers (instantiated in create())
    this.cardManager = null;
    this.opponentManager = null;
    this.trickManager = null;
    this.effectsManager = null;
    this.drawManager = null;
    this.bidManager = null;
    this.layoutManager = null;

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

    // Instantiate managers
    this.layoutManager = new LayoutManager(this);
    this.cardManager = new CardManager(this);
    this.opponentManager = new OpponentManager(this);
    this.trickManager = new TrickManager(this);
    this.effectsManager = new EffectsManager(this);
    this.drawManager = new DrawManager(this);
    this.bidManager = new BidManager(this);

    // Initialize layout
    this.layoutManager.update();

    console.log('🎮 Managers instantiated');

    // Set up resize handler
    this.scale.on('resize', (gameSize) => {
      console.log(`📐 Phaser resize: ${gameSize.width}x${gameSize.height}`);
      this.handleResize(gameSize.width, gameSize.height);
    });

    // Initial position calculation
    this.updatePlayPositions();

    // Mark scene as ready
    this.isReady = true;

    // Register this scene with main.js for external access
    if (window.ModernUtils && window.ModernUtils.setGameScene) {
      window.ModernUtils.setGameScene(this);
      console.log('🎮 GameScene registered with ModernUtils');
    }

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
      // Update layout calculations
      if (this.layoutManager) {
        this.layoutManager.update();
        // Position DOM backgrounds (play zone, hand area)
        this.layoutManager.positionDomBackgrounds();
        // Position bid container
        this.layoutManager.positionBidContainer();
      }

      // Reposition manager-controlled elements
      if (this.cardManager) {
        this.cardManager.repositionHand();
      }
      if (this.opponentManager) {
        this.opponentManager.reposition();
      }
      if (this.trickManager) {
        this.trickManager.repositionCurrentTrick();
      }

      // Reposition trump display and player info
      this.repositionTrumpDisplay();
      if (this.repositionPlayerInfo) {
        this.repositionPlayerInfo();
      }

      // Update play positions for card animations
      this.updatePlayPositions();

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
      const cardHeight = this.tableCardSprite ? this.tableCardSprite.displayHeight + 10 : 100;
      this.tableCardLabel.setPosition(trumpX, trumpY - (cardHeight / 2) - 12);
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

    // Card
    const cardKey = getCardImageKey(trumpCard);
    this.tableCardSprite = this.add.image(trumpX, trumpY, 'cards', cardKey);
    this.tableCardSprite.setScale(1.0);
    this.tableCardSprite.setDepth(100);

    // Background - subtle box around card
    const cardWidth = this.tableCardSprite.displayWidth + 10;
    const cardHeight = this.tableCardSprite.displayHeight + 10;
    this.tableCardBackground = this.add.rectangle(trumpX, trumpY, cardWidth, cardHeight, 0x000000, 0.3);
    this.tableCardBackground.setStrokeStyle(1, 0x666666, 0.5);
    this.tableCardBackground.setDepth(99);

    // Label - smaller and closer to card
    this.tableCardLabel = this.add.text(trumpX, trumpY - (cardHeight / 2) - 12, 'TRUMP', {
      fontSize: `${12 * scaleX}px`,
      fontFamily: 'Arial, sans-serif',
      color: '#aaaaaa',
    });
    this.tableCardLabel.setOrigin(0.5);
    this.tableCardLabel.setDepth(100);
  }

  // ============================================
  // Game Feed Methods
  // ============================================

  /**
   * Add a message to the game feed/log.
   * @param {string} message - The message to add
   * @param {number|null} playerPosition - Player position for color coding (optional)
   */
  handleAddToGameFeed(message, playerPosition = null) {
    if (window.addToGameFeedFromLegacy) {
      window.addToGameFeedFromLegacy(message, playerPosition);
    }
  }

  // ============================================
  // Chat Bubble Methods
  // ============================================

  /**
   * Handle showing a chat bubble from a chat message event.
   * @param {number} myPosition - The local player's position
   * @param {number} senderPosition - The position of the message sender
   * @param {string} message - The chat message text
   */
  handleShowChatBubble(myPosition, senderPosition, message) {
    // Determine which position key the sender maps to relative to the player
    const positionKey = this.getPositionKey(senderPosition);
    if (positionKey) {
      this.showChatBubble(positionKey, message, null, 6000);
    }
  }

  /**
   * Show a chat/bid bubble at a position.
   * Uses ChatBubble.js for consistent styling (white bg, black/red text).
   * Positions are avatar centers - ChatBubble handles the offset.
   */
  showChatBubble(positionKey, message, color = null, duration = 6000) {
    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();
    const centerX = screenWidth / 2;
    const centerY = screenHeight / 2;

    // Avatar center positions
    // 'me' uses window coordinates since player info box is outside game container
    const positions = {
      opp1: { x: Math.max(130, centerX - 550 * scaleX), y: centerY - 40 },
      opp2: { x: Math.min(screenWidth - 130, centerX + 550 * scaleX), y: centerY - 40 },
      partner: { x: centerX, y: centerY - 400 * scaleY },
      me: { x: window.innerWidth - 405, y: window.innerHeight - 230 },
    };

    const pos = positions[positionKey];
    if (!pos) return;

    // Use the imported ChatBubble.js function (DOM-based)
    showChatBubbleUI(positionKey, pos.x, pos.y, message, color, duration);
  }

  // ============================================
  // Draw Phase Handlers
  // ============================================

  /**
   * Handle startDraw event - show the draw UI.
   * @param {Object} data - Event data from server
   */
  handleStartDraw(data) {
    console.log('🎮 GameScene.handleStartDraw()');
    this.drawManager.showDrawUI();
  }

  /**
   * Handle youDrew event - player drew a card.
   * @param {Object} data - { card }
   */
  handleYouDrew(data) {
    console.log('🎮 GameScene.handleYouDrew()');
    this.drawManager.handleYouDrew(data);
  }

  /**
   * Handle playerDrew event - any player drew a card.
   * @param {Object} data - { username, card, drawOrder, position }
   */
  handlePlayerDrew(data) {
    console.log('🎮 GameScene.handlePlayerDrew()');
    this.drawManager.handlePlayerDrew(data);
  }

  /**
   * Handle teamsAnnounced event - show teams overlay.
   * @param {Object} data - { team1: [], team2: [] }
   */
  handleTeamsAnnounced(data) {
    console.log('🎮 GameScene.handleTeamsAnnounced()');
    this.drawManager.handleTeamsAnnounced(data);
  }

  /**
   * Handle createUI event - transition from draw to game.
   * @param {Object} data - Event data from server
   */
  handleCreateUI(data) {
    console.log('🎮 GameScene.handleCreateUI()');
    // Clean up draw phase
    this.drawManager.cleanup();
    // Delegate to callback for legacy code
    this.callbacks.onCreateUI?.(data);
  }

  // ============================================
  // Bidding Phase Handlers
  // ============================================

  /**
   * Handle bidReceived event - show bid bubble, impact events, update game log.
   * @param {Object} data - { position, bid, bidArray }
   */
  handleBidReceived(data) {
    console.log('🎮 GameScene.handleBidReceived()');

    const bidStr = String(data.bid).toUpperCase();

    // Show impact event for bore bids
    if (this.effectsManager) {
      if (bidStr === 'B') this.effectsManager.showImpactEvent('b');
      if (bidStr === '2B') this.effectsManager.showImpactEvent('2b');
      if (bidStr === '3B') this.effectsManager.showImpactEvent('3b');
      if (bidStr === '4B') this.effectsManager.showImpactEvent('4b');
    }

    // Add bid to state history for bore button updates
    this.state.addTempBid(data.bid);

    // Update bore button states
    if (this.bidManager) {
      this.bidManager.updateBoreButtonStates();
    }

    // Show bid bubble at the appropriate position
    const positionKey = this.getPositionKey(data.position);
    if (positionKey && this.bidManager) {
      this.bidManager.showBidBubble(positionKey, data.bid);
    }

    // Add to game feed
    const playerName = this.getPlayerNameForPosition(data.position);
    const feedMessage = `${playerName} bid ${data.bid}.`;
    if (window.addToGameFeedFromLegacy) {
      window.addToGameFeedFromLegacy(feedMessage);
    }

    // Update game log score with bid info
    this.updateGameLogWithBids(data.bidArray);

    // Delegate to callback for additional handling
    this.callbacks.onBidReceived?.(data);
  }

  /**
   * Get player name for a position.
   */
  getPlayerNameForPosition(pos) {
    if (window.ModernUtils && window.ModernUtils.getPlayerName) {
      return window.ModernUtils.getPlayerName(pos, this.state.playerData);
    }
    return `Player ${pos}`;
  }

  /**
   * Update game log with current bid info.
   */
  updateGameLogWithBids(bidArray) {
    if (!bidArray || !this.state.position) return;

    const pos = this.state.position;
    const myBids = ['-', '-', '-', '-'];

    for (let i = 0; i < bidArray.length; i++) {
      if (bidArray[i] !== undefined && bidArray[i] !== null) {
        myBids[i] = bidArray[i];
      }
    }

    const teamBids = `${myBids[pos - 1]}/${myBids[team(pos) - 1]}`;
    const oppBids = `${myBids[rotate(pos) - 1]}/${myBids[rotate(rotate(rotate(pos))) - 1]}`;

    // Store for later use
    this.state.currentTeamBids = teamBids;
    this.state.currentOppBids = oppBids;

    // Update game log score
    if (window.ModernUtils && this.state.playerData) {
      const { teamName, oppName } = window.ModernUtils.getTeamNames(pos, this.state.playerData);
      const teamScore = pos % 2 !== 0 ? this.state.teamScore : this.state.oppScore;
      const oppScore = pos % 2 !== 0 ? this.state.oppScore : this.state.teamScore;

      if (window.updateGameLogScoreFromLegacy) {
        window.updateGameLogScoreFromLegacy(teamName, oppName, teamScore, oppScore, teamBids, oppBids);
      }
    }
  }

  /**
   * Handle doneBidding event - transition to playing phase.
   * @param {Object} data - { bids, lead }
   */
  handleDoneBidding(data) {
    console.log('🎮 GameScene.handleDoneBidding()', data);

    // Hide bid UI
    if (this.bidManager) {
      this.bidManager.hideBidUI();
    }

    // Clear temp bids and update state
    this.state.clearTempBids();
    this.state.isBidding = false;
    this.state.hasPlayedCard = false;

    // Reset play state for new hand - critical for isLegalMove checks
    this.state.playedCardIndex = 0;
    this.state.leadCard = null;
    this.state.leadPosition = null;
    this.state.trumpBroken = false;
    this.state.currentTrick = [];

    // Set currentTurn from lead player data
    if (data.lead !== undefined) {
      this.state.currentTurn = data.lead;
    }

    // Store bids data in state for game log
    if (data.bids) {
      this.state.bids = data.bids;
    }

    // Update card legality now that bidding is over
    // The lead player can play any card, others are dimmed
    if (this.cardManager) {
      const canPlay = this.state.currentTurn === this.state.position;
      // No lead card yet, so all cards are legal for the lead player
      this.cardManager.updateCardLegality(() => true, canPlay);
    }

    // Update turn glow
    if (this.cardManager) {
      this.cardManager.updatePlayerTurnGlow(this.state.currentTurn, this.state.position);
    }
    if (this.opponentManager) {
      this.opponentManager.removeTurnGlow();
      if (this.state.currentTurn !== this.state.position) {
        const opponentKey = this.getPositionKey(this.state.currentTurn);
        if (opponentKey && opponentKey !== 'me') {
          this.opponentManager.addTurnGlow(opponentKey);
        }
      }
    }

    // Delegate to callback for additional handling
    this.callbacks.onDoneBidding?.(data);
  }

  /**
   * Handle updateTurn event - update turn glow, card legality, and bid UI visibility.
   * @param {Object} data - { currentTurn }
   */
  handleUpdateTurn(data) {
    console.log('🎮 GameScene.handleUpdateTurn()');

    const currentTurn = data.currentTurn;
    const myPosition = this.state.position;

    // Update turn glow for player's hand
    if (this.cardManager) {
      this.cardManager.updatePlayerTurnGlow(currentTurn, myPosition);
    }

    // Update turn glow for opponents
    if (this.opponentManager) {
      this.opponentManager.removeTurnGlow();
      if (currentTurn !== myPosition) {
        const opponentKey = this.getPositionKey(currentTurn);
        if (opponentKey && opponentKey !== 'me') {
          this.opponentManager.addTurnGlow(opponentKey);
        }
      }
    }

    // Update card legality
    if (this.cardManager && !this.state.isBidding) {
      const canPlay = currentTurn === myPosition && !this.state.hasPlayedCard;
      const gameState = this.state;

      const legalityChecker = (card) => {
        if (window.ModernUtils && window.ModernUtils.isLegalMove) {
          const result = window.ModernUtils.isLegalMove(
            card,
            gameState.myCards,
            gameState.leadCard,
            gameState.playedCardIndex === 0,
            gameState.trump,
            gameState.trumpBroken,
            myPosition,
            gameState.leadPosition
          );
          return result.legal;
        }
        return true;
      };

      this.cardManager.updateCardLegality(legalityChecker, canPlay);
    }

    // Update bid UI visibility (only during bidding)
    if (this.bidManager && this.state.isBidding) {
      this.bidManager.updateVisibility();
    }

    // Delegate to callback for additional handling
    this.callbacks.onUpdateTurn?.(data);
  }

  /**
   * Get position key ('opp1', 'opp2', 'partner', 'me') from game position.
   * @param {number} gamePosition - Position 1-4
   * @returns {string|null} Position key or null
   */
  getPositionKey(gamePosition) {
    const myPosition = this.state.position;
    if (!myPosition) return null;

    if (gamePosition === myPosition) return 'me';
    if (gamePosition === team(myPosition)) return 'partner';
    if (gamePosition === rotate(myPosition)) return 'opp1';
    if (gamePosition === rotate(rotate(rotate(myPosition)))) return 'opp2';

    return null;
  }

  // ============================================
  // Card Play & Trick Handlers
  // ============================================

  /**
   * Handle cardPlayed event - animate card to play area, update state.
   * @param {Object} data - { card, position, trump/trumpBroken }
   */
  handleCardPlayed(data) {
    console.log('🎮 GameScene.handleCardPlayed()');

    const myPosition = this.state.position;
    const playedPosition = data.position;
    const card = data.card;

    // Track if this is lead card
    if (this.state.playedCardIndex === 0) {
      this.state.leadCard = card;
      this.state.leadPosition = playedPosition;

      // Update card legality when lead is set
      this.updateCardLegalityAfterPlay();
    }

    // Update trump broken
    if (data.trump !== undefined) {
      this.state.trumpBroken = data.trump;
    }
    if (data.trumpBroken !== undefined) {
      this.state.trumpBroken = data.trumpBroken;
    }

    // Note: currentTrick is already updated by gameHandlers.js via addPlayedCard()
    // Do NOT push here to avoid double-counting

    // Detect over-trump and show effect
    this.detectOverTrump();

    // Note: playedCardIndex is already incremented by gameHandlers.js via addPlayedCard()
    // Do NOT increment here to avoid double-counting

    // Initialize TrickManager if needed
    if (this.trickManager && myPosition) {
      this.trickManager.setPlayerPosition(myPosition);
      this.trickManager.updatePlayPositions();
    }

    // Get position key for the player who played
    const positionKey = this.getPositionKey(playedPosition);

    // Handle opponent card animation
    if (playedPosition !== myPosition && this.opponentManager && this.trickManager) {
      const sprite = this.opponentManager.removeCard(positionKey);
      if (sprite) {
        // Update texture to show the actual card
        const cardKey = getCardImageKey(card);
        // Animate to play position, then flip
        this.tweens.add({
          targets: sprite,
          x: this.trickManager._playPositions[this.trickManager.getRelativePositionKey(playedPosition)]?.x || sprite.x,
          y: this.trickManager._playPositions[this.trickManager.getRelativePositionKey(playedPosition)]?.y || sprite.y,
          duration: 500,
          ease: 'Power2',
          rotation: 0,
          scale: 1.5,
          onComplete: () => {
            // Guard against destroyed sprite
            if (!sprite || !sprite.scene) return;
            sprite.setTexture('cards', cardKey);
            sprite.setDepth(200);
          },
        });
        this.trickManager._currentTrick.push(sprite);
      }
    } else if (playedPosition === myPosition && this.trickManager) {
      // Self play - create card at play position
      this.trickManager.addPlayedCard(card, playedPosition);
    }

    // Delegate to callback for additional handling
    this.callbacks.onCardPlayed?.(data);
  }

  /**
   * Detect over-trump and show effect.
   */
  detectOverTrump() {
    const trick = this.state.currentTrick;
    const trump = this.state.trump;
    const leadCard = this.state.leadCard;

    // Need at least 3 cards for over-trump: lead, first trump, over-trump
    // (currentTrick entries are { card, position } from addPlayedCard)
    if (!trick || trick.length < 3 || !trump || !leadCard) return;

    const RANK_VALUES = window.ModernUtils?.RANK_VALUES || {};
    // currentTrick stores { card, position } objects from addPlayedCard()
    const currentCard = trick[trick.length - 1].card;
    const previousCard = trick[trick.length - 2].card;

    const isTrumpOrJoker = (c) => c.suit === trump.suit || c.suit === 'joker';
    const leadIsTrump = leadCard.suit === trump.suit || leadCard.suit === 'joker';

    // Over-trump: current card is trump, previous was trump, current outranks previous, lead wasn't trump
    if (
      isTrumpOrJoker(currentCard) &&
      isTrumpOrJoker(previousCard) &&
      RANK_VALUES[currentCard.rank] > RANK_VALUES[previousCard.rank] &&
      !leadIsTrump
    ) {
      if (this.effectsManager) {
        this.effectsManager.showImpactEvent('ot');
      }
    }
  }

  /**
   * Update card legality after a play (when lead card changes).
   */
  updateCardLegalityAfterPlay() {
    if (!this.cardManager || this.state.isBidding) return;

    const myPosition = this.state.position;
    const currentTurn = this.state.currentTurn;
    const canPlay = currentTurn === myPosition && !this.state.hasPlayedCard;
    const gameState = this.state;

    const legalityChecker = (card) => {
      if (window.ModernUtils && window.ModernUtils.isLegalMove) {
        const result = window.ModernUtils.isLegalMove(
          card,
          gameState.myCards,
          gameState.leadCard,
          gameState.playedCardIndex === 0,
          gameState.trump,
          gameState.trumpBroken,
          myPosition,
          gameState.leadPosition
        );
        return result.legal;
      }
      return true;
    };

    this.cardManager.updateCardLegality(legalityChecker, canPlay);
  }

  /**
   * Handle trickComplete event.
   * @param {Object} data - { winner }
   */
  handleTrickComplete(data) {
    console.log('🎮 GameScene.handleTrickComplete()', data);

    const myPosition = this.state.position;
    const winner = data.winner;

    // Add to game feed
    const winnerName = this.getPlayerNameForPosition(winner);
    if (window.addToGameFeedFromLegacy) {
      window.addToGameFeedFromLegacy(`Trick won by ${winnerName}.`);
    }

    // Determine if winner is on my team (same parity = same team)
    const isMyTeam = winner % 2 === myPosition % 2;

    // Update trick counts in state
    if (isMyTeam) {
      this.state.teamTricks++;
    } else {
      this.state.oppTricks++;
    }

    // Animate cards to winner's stack via TrickManager
    if (this.trickManager) {
      this.trickManager.completeTrick(winner, isMyTeam);
    }

    // Update game log with current trick counts
    this.updateGameLogAfterTrick();

    // Reset trick state for next trick
    this.state.leadCard = null;
    this.state.leadPosition = null;
    this.state.playedCardIndex = 0;
    this.state.currentTrick = [];
    this.state.hasPlayedCard = false;

    // Delegate to callback for any remaining legacy handling
    this.callbacks.onTrickComplete?.(data);
  }

  /**
   * Update game log score display after a trick.
   */
  updateGameLogAfterTrick() {
    const state = this.state;
    if (!window.updateGameLogScoreFromLegacy) return;

    // Get team/opponent names
    const myTeamNames = `${state.username}/${state.partnerName}`;
    const oppNames = `${state.opp1Name}/${state.opp2Name}`;

    // Get scores - order depends on player position
    let teamScore, oppScore;
    if (state.position % 2 !== 0) {
      // Odd position (1 or 3) - team1
      teamScore = state.teamScore;
      oppScore = state.oppScore;
    } else {
      // Even position (2 or 4) - team2
      teamScore = state.oppScore;
      oppScore = state.teamScore;
    }

    // Get bids - use stored values or empty string
    const teamBids = state.teamBids || '';
    const oppBids = state.oppBids || '';

    window.updateGameLogScoreFromLegacy(
      myTeamNames,
      oppNames,
      teamScore,
      oppScore,
      teamBids,
      oppBids,
      state.teamTricks,
      state.oppTricks
    );
  }

  // ============================================
  // Hand & Game End Handlers
  // ============================================

  /**
   * Handle handComplete event.
   * @param {Object} data - Scoring and hand completion data
   */
  handleHandComplete(data) {
    console.log('🎮 GameScene.handleHandComplete()', data);

    const state = this.state;
    const myPosition = state.position;

    // Only process scoring if it's a full hand (13 tricks)
    if (data.team1Tricks + data.team2Tricks !== 13) {
      // Calculate team/opp scores based on position parity
      let teamScore, oppScore, teamTricksWon, oppTricksWon, teamOldScore, oppOldScore;
      if (myPosition % 2 !== 0) {
        // Player is on Team 1
        teamScore = data.score.team1;
        oppScore = data.score.team2;
        teamTricksWon = data.team1Tricks;
        oppTricksWon = data.team2Tricks;
        teamOldScore = data.team1OldScore;
        oppOldScore = data.team2OldScore;
      } else {
        // Player is on Team 2 - swap all team1/team2 values
        teamScore = data.score.team2;
        oppScore = data.score.team1;
        teamTricksWon = data.team2Tricks;
        oppTricksWon = data.team1Tricks;
        teamOldScore = data.team2OldScore;
        oppOldScore = data.team1OldScore;
      }

      // Update scores in state
      state.teamScore = teamScore;
      state.oppScore = oppScore;

      // Add hand complete messages to game log
      if (window.ModernUtils && window.ModernUtils.formatHandCompleteMessages) {
        const messages = window.ModernUtils.formatHandCompleteMessages({
          myPosition: myPosition,
          playerData: state.playerData,
          bids: state.bids,
          teamScore: teamScore,
          oppScore: oppScore,
          teamOldScore: teamOldScore,
          oppOldScore: oppOldScore,
          teamTricks: teamTricksWon,
          oppTricks: oppTricksWon,
        });
        messages.forEach((msg) => {
          if (window.addToGameFeedFromLegacy) {
            window.addToGameFeedFromLegacy(msg);
          }
        });
      }

      // Update game log score display
      if (window.ModernUtils && window.ModernUtils.getTeamNames) {
        const { teamName, oppName } = window.ModernUtils.getTeamNames(myPosition, state.playerData);
        if (window.updateGameLogScoreFromLegacy) {
          window.updateGameLogScoreFromLegacy(teamName, oppName, teamScore, oppScore);
        }
      }
    }

    // Add hand complete message to game feed
    if (window.addToGameFeedFromLegacy) {
      window.addToGameFeedFromLegacy('Hand complete. Clearing all tricks...');
    }

    // Reset state for new hand
    state.teamTricks = 0;
    state.oppTricks = 0;
    state.trumpBroken = false;

    // Clear trick history for new hand
    if (this.trickManager) {
      this.trickManager.resetForNewHand();
    }

    // Clear hand cards
    if (this.cardManager) {
      this.cardManager.clearHand();
    }

    // Delegate to callback for any remaining legacy handling
    this.callbacks.onHandComplete?.(data);
  }

  /**
   * Handle gameEnd event.
   * @param {Object} data - Final game scores
   */
  handleGameEnd(data) {
    console.log('🎮 GameScene.handleGameEnd()');

    // Delegate to callback
    this.callbacks.onGameEnd?.(data);
  }

  /**
   * Handle rainbow event.
   * @param {Object} data - { position }
   */
  handleRainbow(data) {
    console.log('🎮 GameScene.handleRainbow()');

    // Show rainbow effect
    if (this.effectsManager && this.effectsManager.showRainbow) {
      this.effectsManager.showRainbow(data.position);
    }

    // Delegate to callback
    this.callbacks.onRainbow?.(data);
  }

  /**
   * Handle destroyHands event.
   * @param {Object} data - Event data
   */
  handleDestroyHands(data) {
    console.log('🎮 GameScene.handleDestroyHands()');

    // Clear hand and trick displays
    this.clearHand();
    if (this.trickManager) {
      this.trickManager.clearAll();
    }

    // Delegate to callback
    this.callbacks.onDestroyHands?.(data);
  }

  // ============================================
  // Reconnection & Error Handlers
  // ============================================

  /**
   * Handle playerDisconnected event.
   * @param {Object} data - { username, position }
   */
  handlePlayerDisconnected(data) {
    console.log('🎮 GameScene.handlePlayerDisconnected()');
    this.callbacks.onPlayerDisconnected?.(data);
  }

  /**
   * Handle playerReconnected event.
   * @param {Object} data - { username, position }
   */
  handlePlayerReconnected(data) {
    console.log('🎮 GameScene.handlePlayerReconnected()');
    this.callbacks.onPlayerReconnected?.(data);
  }

  /**
   * Handle rejoinSuccess event.
   * @param {Object} data - Full game state for rejoin
   */
  handleRejoinSuccess(data) {
    console.log('🎮 GameScene.handleRejoinSuccess()');
    this.callbacks.onRejoinSuccess?.(data);
  }

  /**
   * Handle rejoinFailed event.
   * @param {Object} data - { reason }
   */
  handleRejoinFailed(data) {
    console.log('🎮 GameScene.handleRejoinFailed()');
    this.callbacks.onRejoinFailed?.(data);
  }

  /**
   * Handle abortGame event.
   * @param {Object} data - Abort reason
   */
  handleAbortGame(data) {
    console.log('🎮 GameScene.handleAbortGame()');

    // Full cleanup
    this.cleanup();

    // Delegate to callback
    this.callbacks.onAbortGame?.(data);
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
      // Note: Removed scale.refresh() - it triggers resize event loops
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

/**
 * Main game scene for the Phaser game.
 *
 * Handles card display, opponent visuals, trick animations,
 * and all game-related visual updates.
 */

import { avatarSrc, applyAvatarImg, isAvatarPic } from '../../utils/avatar.js';
import { getGameState } from '../../state/GameState.js';
import { getCardImageKey, sortHand } from '../../utils/cards.js';
import { team, rotate } from '../../utils/positions.js';
import { isLegalMove } from '../../rules/legality.js';
import { ANIMATION_CONFIG } from '../config.js';
import { reattachMuteButton } from '../../ui/components/VoiceChatUI.js';
import { CardManager } from '../managers/CardManager.js';
import { OpponentManager } from '../managers/OpponentManager.js';
import { TrickManager } from '../managers/TrickManager.js';
import { EffectsManager } from '../managers/EffectsManager.js';
import { DrawManager } from '../managers/DrawManager.js';
import { flyInMs, FLIP } from '../pacing.js';
import { transitionGeneration } from '../../ui/transitionOverlay.js';
import { BidManager } from '../managers/BidManager.js';
import { LayoutManager } from '../managers/LayoutManager.js';
import { showChatBubble as showChatBubbleUI } from '../../ui/components/ChatBubble.js';

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

    // Managers (instantiated in create())
    this.cardManager = null;
    this.opponentManager = null;
    this.trickManager = null;
    this.effectsManager = null;
    this.drawManager = null;
    this.bidManager = null;
    this.layoutManager = null;

    // Trump display (CardManager/OpponentManager read tableCardSprite)
    this.tableCardSprite = null;
    this.tableCardBackground = null;
    this.tableCardLabel = null;

    // Own avatar box (DOM, outside the canvas): createPlayerInfoBox. Not
    // reset by a scene restart (the constructor runs once); clearPlayerInfo
    // removes it
    this._playerInfo = null;
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
    this.load.image('rainbow', 'assets/rainbow1.png');
    this.load.image('ot', 'assets/ot.png');
    this.load.image('b', 'assets/b.png');
    this.load.image('2b', 'assets/2b.png');
    this.load.image('3b', 'assets/3b.png');
    this.load.image('4b', 'assets/4b.png');

    // Profile avatars are DOM <img> elements loaded on demand; they are not
    // preloaded as Phaser textures (~18 MB download, ~120 MB of GPU memory)
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

    // Set up resize handler. this.scale is the game-wide ScaleManager, which
    // outlives scene restarts, so remove the listener on shutdown
    const onScaleResize = (gameSize) => {
      console.log(`📐 Phaser resize: ${gameSize.width}x${gameSize.height}`);
      this.handleResize(gameSize.width, gameSize.height);
    };
    this.scale.on('resize', onScaleResize);
    this.events.once('shutdown', () => {
      this.scale.off('resize', onScaleResize);
    });

    // Register this scene with main.js for external access
    if (window.ModernUtils && window.ModernUtils.setGameScene) {
      window.ModernUtils.setGameScene(this);
      console.log('🎮 GameScene registered with ModernUtils');
    }

    console.log('🎮 GameScene.create() complete!');
  }

  update() {
    // Empty - we don't need per-frame updates
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
      this.repositionPlayerInfo();
    } catch (e) {
      console.error('❌ Error in handleResize:', e);
    }
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

    // Card - start face down, same scale as player hand cards (1.5)
    const cardKey = getCardImageKey(trumpCard);
    this.tableCardSprite = this.add.image(trumpX, trumpY, 'cardBack');
    this.tableCardSprite.setScale(1.5);
    this.tableCardSprite.setDepth(100);

    // Background - box around card with padding
    const cardWidth = this.tableCardSprite.displayWidth + 20;
    const cardHeight = this.tableCardSprite.displayHeight + 20;
    this.tableCardBackground = this.add.rectangle(trumpX, trumpY, cardWidth, cardHeight, 0x000000, 0.3);
    this.tableCardBackground.setStrokeStyle(1, 0x666666, 0.5);
    this.tableCardBackground.setDepth(99);

    // Label - above the card
    this.tableCardLabel = this.add.text(trumpX, trumpY - (cardHeight / 2) - 15, 'TRUMP', {
      fontSize: `${14 * scaleX}px`,
      fontFamily: 'Arial, sans-serif',
      color: '#aaaaaa',
    });
    this.tableCardLabel.setOrigin(0.5);
    this.tableCardLabel.setDepth(100);

    // Flip the trump card face up after all players receive their cards
    // Card deal: 200ms delay + 750ms duration + stagger (~550ms for 12 cards) = ~1500ms
    // First hand has fade transition, so add extra delay to compensate
    // This keeps the flip timing consistent relative to when cards finish dealing
    const hasTransition = window._transitionOverlay || document.getElementById('transition-overlay');
    const flipDelay = hasTransition ? 3500 : 2000;
    const flipDuration = 300;
    const sprite = this.tableCardSprite;

    this.time.delayedCall(flipDelay, () => {
      // Phase 1: Scale X to 0 (flip start)
      this.tweens.add({
        targets: sprite,
        scaleX: 0,
        duration: flipDuration / 2,
        ease: 'Power2',
        onComplete: () => {
          if (!sprite || !sprite.scene) return;
          // Change to face up texture
          sprite.setTexture('cards', cardKey);
          // Phase 2: Scale X back (flip complete)
          this.tweens.add({
            targets: sprite,
            scaleX: 1.5,
            duration: flipDuration / 2,
            ease: 'Power2',
            onComplete: () => {
              // Signal that trump flip is complete for bid UI timing
              window.dispatchEvent(new Event('trumpFlipComplete'));
            },
          });
        },
      });
    });
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
      bottom: { x: centerX, y: centerY + 400 * scaleY },
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
   * @param {Function} onUIReady - Callback to create UI elements (called after fade to black)
   */
  handleCreateUI(data, onUIReady) {
    console.log('🎮 GameScene.handleCreateUI()');

    const fadeDuration = 1200;
    const scene = this;

    // Reset the ready flag for this new game
    window._readyForGameUI = false;

    // Check if overlay already exists (created by teamsAnnounced fade)
    let overlay = window._transitionOverlay || document.getElementById('transition-overlay');

    if (!overlay) {
      // Create overlay if it doesn't exist (fallback)
      overlay = document.createElement('div');
      overlay.id = 'transition-overlay';
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: black;
        opacity: 1;
        z-index: 99999;
        pointer-events: all;
      `;
      document.body.appendChild(overlay);
      window._transitionOverlay = overlay;

      // Overlay is already opaque, proceed immediately
      proceedWithTransition();
    } else {
      // Overlay exists - wait for it to become fully opaque
      // Force it to full opacity immediately to ensure nothing shows through
      overlay.style.transition = 'none';
      overlay.style.opacity = '1';
      overlay.style.pointerEvents = 'all';

      // Proceed after a frame to ensure opacity is applied
      requestAnimationFrame(() => {
        proceedWithTransition();
      });
    }

    function proceedWithTransition() {
      // Clean up draw phase (hidden behind black overlay)
      scene.drawManager.cleanup();

      // Create the play UI (hidden behind the overlay)
      onUIReady?.();

      // Wait for next frame to ensure UI is rendered, then fade out
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Add transition and fade out
          overlay.style.transition = `opacity ${fadeDuration}ms ease-out`;
          overlay.style.pointerEvents = 'none';

          // Force reflow
          overlay.offsetHeight;

          // Listen for fade to complete. transitionend is not guaranteed
          // (no event when the transition is skipped, e.g. a style flush
          // the browser coalesces), so a timer finishes the fade as well
          let finished = false;
          const gen = transitionGeneration();
          const onFadeComplete = () => {
            if (finished) return;
            finished = true;
            overlay.removeEventListener('transitionend', onFadeComplete);
            clearTimeout(fallback);
            // A rejoin or exit removed the overlay meanwhile and owns the UI
            if (transitionGeneration() !== gen) return;
            overlay.remove();
            if (window._transitionOverlay === overlay) window._transitionOverlay = null;

            // Signal that UI can now be shown (after a short delay)
            setTimeout(() => {
              if (transitionGeneration() !== gen) return;
              window._readyForGameUI = true;
              window.dispatchEvent(new Event('gameUIReady'));
            }, 500);
          };
          overlay.addEventListener('transitionend', onFadeComplete);
          const fallback = setTimeout(onFadeComplete, fadeDuration + 250);

          // Fade out to reveal play screen
          overlay.style.opacity = '0';
        });
      });
    }
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
    // state.teamScore and state.oppScore are already adjusted for player's perspective
    if (window.ModernUtils && this.state.playerData) {
      const { teamName, oppName } = window.ModernUtils.getTeamNames(pos, this.state.playerData);

      if (window.updateGameLogScoreFromLegacy) {
        window.updateGameLogScoreFromLegacy(teamName, oppName, this.state.teamScore, this.state.oppScore, teamBids, oppBids);
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
    // Server sends bids as 0-indexed array, convert to position-keyed object (1-4)
    if (data.bids && Array.isArray(data.bids)) {
      for (let i = 0; i < data.bids.length; i++) {
        this.state.bids[i + 1] = data.bids[i];
      }
    } else if (data.bids) {
      this.state.bids = data.bids;
    }

    // Update card legality now that bidding is over
    // The lead player can play any card, others are dimmed
    if (this.cardManager) {
      const canPlay = this.state.currentTurn === this.state.position && !this.state.isLazy;
      // No lead card yet, so all cards are legal for the lead player
      this.cardManager.updateCardLegality(() => true, canPlay);
    }

    // Update turn glow
    const isPureSpectator = this.state.isSpectator && !this.state.isLazy;
    if (this.cardManager && !isPureSpectator) {
      this.cardManager.updatePlayerTurnGlow(this.state.currentTurn, this.state.position);
    }
    if (this.opponentManager) {
      this.opponentManager.updateTurnGlow(this.state.currentTurn);
    }
  }

  /**
   * Handle updateTurn event - update turn glow, card legality, and bid UI visibility.
   * @param {Object} data - { currentTurn }
   */
  handleUpdateTurn(data) {
    console.log('🎮 GameScene.handleUpdateTurn()');

    const currentTurn = data.currentTurn;
    const myPosition = this.state.position;
    const isPureSpectator = this.state.isSpectator && !this.state.isLazy;

    // Update turn glow for player's hand (skip for pure spectators — no hand area)
    if (this.cardManager && !isPureSpectator) {
      this.cardManager.updatePlayerTurnGlow(currentTurn, myPosition);
    }

    // Update turn glow for opponents (OpponentManager handles 'bottom' for spectators)
    if (this.opponentManager) {
      this.opponentManager.updateTurnGlow(currentTurn);
    }

    // Update card legality
    // Each updateTurn supersedes any deferred one (see below)
    this._turnToken = (this._turnToken || 0) + 1;
    if (this.cardManager && !this.state.isBidding) {
      const canPlay = currentTurn === myPosition && !this.state.hasPlayedCard && !this.state.isLazy;
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

      if (canPlay && this.trickManager?.isCollecting?.()) {
        // The previous trick is still flying to its stack: keep the hand
        // dimmed until it lands, then apply THIS turn, unless another
        // updateTurn came meanwhile or the turn moved on. Never derives a
        // turn itself (the hand's last trick sends none: nothing enables)
        const token = this._turnToken;
        this.cardManager.updateCardLegality(legalityChecker, false);
        this.trickManager.onCollected(() => {
          if (this._turnToken !== token || !this.cardManager) return;
          if (gameState.currentTurn !== currentTurn || gameState.hasPlayedCard || gameState.isBidding || gameState.isLazy) return;
          this.cardManager.updateCardLegality(legalityChecker, true);
        });
      } else {
        this.cardManager.updateCardLegality(legalityChecker, canPlay);
      }
    }

    // Update bid UI visibility (only during bidding)
    if (this.bidManager && this.state.isBidding) {
      this.bidManager.updateVisibility();
    }
  }

  /**
   * Get position key ('opp1', 'opp2', 'partner', 'me') from game position.
   * @param {number} gamePosition - Position 1-4
   * @returns {string|null} Position key or null
   */
  getPositionKey(gamePosition) {
    const myPosition = this.state.position;
    if (!myPosition) return null;

    if (gamePosition === myPosition) {
      // Pure spectators see position 1 as 'bottom' opponent slot
      if (this.state.isSpectator && !this.state.isLazy) return 'bottom';
      return 'me';
    }
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

    // Note: leadCard is already set by gameHandlers.js via addPlayedCard()
    // Update card legality when lead card is first played
    if (this.state.currentTrick.length === 1) {
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

    // Handle opponent card animation (includes spectator's view of position 1)
    const isPureSpectator = this.state.isSpectator && !this.state.isLazy;
    const isOpponentPlay = playedPosition !== myPosition || isPureSpectator;
    if (isOpponentPlay && this.opponentManager && this.trickManager) {
      const sprite = this.opponentManager.removeCard(positionKey);
      if (sprite) {
        // Update texture to show the actual card
        const cardKey = getCardImageKey(card);
        const relativeKey = this.trickManager.getRelativePositionKey(playedPosition);
        const targetPos = this.trickManager._playPositions[relativeKey];
        const targetX = targetPos?.x || sprite.x;
        const targetY = targetPos?.y || sprite.y;

        // Stop any deal/hand-layout tween still on the sprite, and record its
        // face and slot so TrickManager can finish an interrupted flip and
        // reposition it on resize
        this.trickManager._stopCardAnimations(sprite);
        sprite.setData('faceKey', cardKey);
        sprite.setData('playPosition', relativeKey);

        // Animate move and flip simultaneously
        // Move to play position. Keep the handle: a tween added while the tab
        // is hidden is still queued, and killTweensOf cannot see it.
        // The trick-completing card lands within a quarter of the server's
        // hold (resumeInMs), so the full trick is visible before the collect
        const flyMs = flyInMs(data.resumeInMs);
        const flipHalf = Math.min(FLIP.HALF, flyMs / 2);
        const moveTween = this.tweens.add({
          targets: sprite,
          x: targetX,
          y: targetY,
          duration: flyMs,
          ease: 'Power2',
          rotation: 0,
          scale: 1.5,
          onComplete: () => {
            if (!sprite || !sprite.scene) return;
            sprite.setData('moveTween', null);
            sprite.setDepth(200);
          },
        });
        sprite.setData('moveTween', moveTween);

        // Flip animation runs in parallel, starting after a short delay.
        // Keep the handle so completeTrick can cancel a flip that never ran.
        const flipTimer = this.time.delayedCall(FLIP.DELAY, () => {
          if (!sprite || !sprite.scene) return;
          sprite.setData('flipTimer', null);

          // Scale X to 0
          this.tweens.add({
            targets: sprite,
            scaleX: 0,
            duration: flipHalf,
            ease: 'Power2',
            onComplete: () => {
              if (!sprite || !sprite.scene) return;
              sprite.setTexture('cards', cardKey);

              // Scale X back to 1.5
              this.tweens.add({
                targets: sprite,
                scaleX: 1.5,
                duration: flipHalf,
                ease: 'Power2',
              });
            },
          });
        });
        sprite.setData('flipTimer', flipTimer);

        this.trickManager._currentTrick.push(sprite);
      }
    }
    // Handle lazy mode: bot played a card at our position, animate it
    else if (playedPosition === myPosition && this.state.isLazy && this.trickManager) {
      // Remove card from state
      this.state.optimisticPlayCard(card);
      this.state.confirmCardPlay();

      // Extract sprite from hand
      let sprite = this.cardManager?.extractCard(card);
      if (sprite) {
        sprite.removeAllListeners();
        sprite.disableInteractive();
        // A hand-layout or hover tween still on the sprite would fight the
        // move (and replay after a hidden tab)
        this.trickManager._stopCardAnimations(sprite);

        // Animate to self play position
        this.trickManager.setPlayerPosition(myPosition);
        this.trickManager.updatePlayPositions();
        const targetPos = this.trickManager._playPositions.self;
        const moveTween = this.tweens.add({
          targets: sprite,
          x: targetPos.x,
          y: targetPos.y,
          duration: flyInMs(data.resumeInMs),
          ease: 'Power2',
          rotation: 0,
          scale: 1.5,
          onComplete: () => {
            if (!sprite?.scene) return;
            sprite.setData('moveTween', null);
            sprite.setDepth(200);
          },
        });
        sprite.setData('moveTween', moveTween);
        sprite.setData('playPosition', 'self');
        this.trickManager._currentTrick.push(sprite);
      }

      // Reposition remaining cards
      this.cardManager?.repositionHand();
      this.state.hasPlayedCard = true;
    }
    // Note: Normal self play animation is handled by the card click handler in main.js
    // which extracts the sprite and animates it to the play position with a flip effect
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
   * The local player took the seat back (/active): lazy mode had dimmed
   * every card (isLegal false) and hidden the bid UI. updateTurn may have
   * arrived while the seat was still lazy, so recompute here.
   * @param {Function} onBidSelect - sends the chosen bid
   */
  refreshControlAfterActive(onBidSelect) {
    const state = this.state;
    if (state.isBidding) {
      this.cardManager?.updateCardLegality(() => true, false);
      const handSize = state.myCards?.length || 0;
      if (this.bidManager && state.bids?.[state.position] === undefined && handSize > 0) {
        this.bidManager.showBidUI(handSize, onBidSelect);
      }
      return;
    }
    // Same gate as handleUpdateTurn: the hand stays dimmed until a trick
    // still flying to its stack lands
    if (this.trickManager?.isCollecting?.()) {
      this.cardManager?.updateCardLegality(() => true, false);
      this.trickManager.onCollected(() => {
        if (!state.isLazy) this.updateCardLegalityAfterPlay();
      });
      return;
    }
    this.updateCardLegalityAfterPlay();
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
      this.trickManager.completeTrick(winner, isMyTeam, data.resumeInMs);
    }

    // Update game log with current trick counts
    this.updateGameLogAfterTrick();

    // Reset trick state for next trick
    this.state.leadCard = null;
    this.state.leadPosition = null;
    this.state.playedCardIndex = 0;
    this.state.currentTrick = [];
    this.state.hasPlayedCard = false;
  }

  /**
   * Update game log score display after a trick.
   */
  updateGameLogAfterTrick() {
    const state = this.state;
    if (!window.updateGameLogScoreFromLegacy) return;

    // Team/opponent names from the seats (a spectator's view position is
    // someone else's seat, and it has no partner/opponent names)
    const names = window.ModernUtils?.getTeamNames?.(state.position, state.playerData);
    const myTeamNames = names?.teamName ?? `${state.username}/${state.partnerName}`;
    const oppNames = names?.oppName ?? `${state.opp1Name}/${state.opp2Name}`;

    // state.teamScore and state.oppScore are already adjusted for player's perspective
    const teamScore = state.teamScore;
    const oppScore = state.oppScore;

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

    // Start trick animation immediately (before score processing)
    this._animateTricksAndTrumpAway();

    const state = this.state;
    const myPosition = state.position;

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

    // Reset state for new hand
    state.teamTricks = 0;
    state.oppTricks = 0;
    state.trumpBroken = false;

    // Clear hand cards
    if (this.cardManager) {
      this.cardManager.clearHand();
    }
  }

  /**
   * Animate tricks back to trump card and flip trump face down.
   * Extracted to run immediately at start of handleHandComplete.
   */
  _animateTricksAndTrumpAway() {
    if (this.trickManager && this.tableCardSprite) {
      const trumpX = this.tableCardSprite.x;
      const trumpY = this.tableCardSprite.y;

      // Set flag to delay next hand's card dealing
      window._tricksAnimating = true;

      // Flip trump card face down while tricks are whisked
      const trumpSprite = this.tableCardSprite;
      const flipDuration = 150;
      this.tweens.add({
        targets: trumpSprite,
        scaleX: 0,
        duration: flipDuration,
        ease: 'Power2',
        onComplete: () => {
          if (trumpSprite && trumpSprite.scene) {
            trumpSprite.setTexture('cardBack');
            this.tweens.add({
              targets: trumpSprite,
              scaleX: 1.5,
              duration: flipDuration,
              ease: 'Power2',
            });
          }
        },
      });

      this.trickManager.animateTricksAway(trumpX, trumpY, () => {
        // Reset bid totals after animation
        this.trickManager._teamBidTotal = 0;
        this.trickManager._oppBidTotal = 0;

        // Signal that tricks are done animating
        window._tricksAnimating = false;
        window.dispatchEvent(new Event('tricksCleared'));
      });
    } else if (this.trickManager) {
      // Fallback if no trump card - just reset immediately
      this.trickManager.resetForNewHand();
    }
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
  }

  /**
   * Handle destroyHands event.
   * @param {Object} data - Event data
   */
  handleDestroyHands(data) {
    console.log('🎮 GameScene.handleDestroyHands()');

    // Clear hand and trick displays (the redeal's gameStart, sent in the
    // same server tick, deals the new hand)
    this.cardManager?.clearHand();
    if (this.trickManager) {
      this.trickManager.clearAll();
    }

    // destroyHands means an all-zero redeal, which the server sends instead
    // of doneBidding: drop the old bid grid here, or the next updateTurn
    // re-shows it before the new hand and trump flip arrive
    if (this.bidManager) {
      this.bidManager.hideBidUI(false);
    }
    this.state.clearTempBids();
  }

  // ============================================
  // Reconnection & Error Handlers
  // ============================================

  /**
   * Handle playerResigned event.
   * Updates opponent avatar when a bot takes over.
   * @param {Object} data - { position, oldUsername, botUsername, botPic }
   */
  handlePlayerResigned(data) {
    console.log('🎮 GameScene.handlePlayerResigned()');
    if (this.opponentManager) {
      this.opponentManager.updatePlayerInfo(data.position, {
        username: data.botUsername,
        pic: data.botPic
      });
    }
  }

  /**
   * Handle playerLazyMode event.
   * Updates opponent avatar when a bot takes over in lazy mode.
   * @param {Object} data - { position, botUsername, botPic }
   */
  handlePlayerLazyMode(data) {
    console.log('🎮 GameScene.handlePlayerLazyMode()');
    if (data.position === this.state.position && !this.state.isSpectator) {
      // Update local player's avatar to show bot info
      if (this._playerInfo) {
        const pic = data.botPic;
        if (isAvatarPic(pic)) applyAvatarImg(this._playerInfo.avatarImg, avatarSrc(pic));
        this._playerInfo.nameLabel.textContent = data.botUsername;
      }
    } else if (this.opponentManager) {
      this.opponentManager.updatePlayerInfo(data.position, {
        username: data.botUsername,
        pic: data.botPic
      });
    }
  }

  /**
   * Handle playerActiveMode event.
   * Restores player avatar when they take back control.
   * @param {Object} data - { position, username, pic }
   */
  handlePlayerActiveMode(data) {
    console.log('🎮 GameScene.handlePlayerActiveMode()');
    if (data.position === this.state.position && !this.state.isSpectator) {
      // Restore local player's avatar
      if (this._playerInfo) {
        const pic = data.pic;
        if (isAvatarPic(pic)) applyAvatarImg(this._playerInfo.avatarImg, avatarSrc(pic));
        this._playerInfo.nameLabel.textContent = data.username;
      }
    } else if (this.opponentManager) {
      this.opponentManager.updatePlayerInfo(data.position, {
        username: data.username,
        pic: data.pic
      });
    }
  }

  /**
   * Handle abortGame event.
   * @param {Object} data - Abort reason
   */
  handleAbortGame(data) {
    console.log('🎮 GameScene.handleAbortGame()');

    // Full cleanup
    this.cleanup();
  }

  // ============================================
  // Hand, opponent hands and own avatar box
  // ============================================

  /**
   * Display the local player's hand via CardManager and wire card clicks
   * to playCard (sorted by trump; legality from the game state).
   * @param {Array} cards - Hand from the server
   * @param {boolean} skipAnimation - true on rejoin (no deal animation)
   */
  handleDisplayHand(cards, skipAnimation = false) {
    console.log('🎮 handleDisplayHand', cards?.length, 'cards, skipAnimation:', skipAnimation);
    if (!this.cardManager || !cards || cards.length === 0) return;

    const gameState = getGameState();
    const socket = window.socket;

    // Sort cards by trump before displaying
    const sortedCards = sortHand([...cards], gameState.trump);

    // Set up click handler for playing cards
    const scene = this;
    this.cardManager.setCardClickHandler((card, clickedSprite) => {
      console.log(`🃏 Card clicked: ${card.rank} of ${card.suit}`);

      // Only allow playing if the card is marked as legal
      if (!clickedSprite.getData('isLegal')) {
        console.log('Illegal move - card is disabled!');
        return;
      }

      // Set lead card if first play of trick
      if (gameState.playedCardIndex === 0) {
        gameState.leadCard = card;
        gameState.leadPosition = gameState.position;
      }

      // Play the card via socket
      if (socket) {
        socket.emit('playCard', { card, position: gameState.position });
      }

      // Mark that we've played a card (for legality checks)
      gameState.hasPlayedCard = true;

      // Update trump broken status
      if (card.suit === gameState.trump?.suit || card.suit === 'joker') {
        gameState.trumpBroken = true;
      }

      // Capture the current (hovered) position before any operations that might reset it
      const startX = clickedSprite.x;
      const startY = clickedSprite.y;

      // Extract card sprite for animation (don't destroy it)
      const sprite = this.cardManager.extractCard(card);
      if (sprite && this.trickManager) {
        // Remove event listeners to prevent pointerout from resetting position
        sprite.removeAllListeners();

        // Restore the hovered position (in case it was reset)
        sprite.x = startX;
        sprite.y = startY;

        // Get target position
        this.trickManager.setPlayerPosition(gameState.position);
        this.trickManager.updatePlayPositions();
        const targetPos = this.trickManager._playPositions.self;

        // Disable interactions during animation
        sprite.disableInteractive();
        // Its pointerout will never fire now: drop the hand cursor
        scene.input?.setDefaultCursor?.('default');
        // Stop the hover tween (it would pull the card back toward the
        // hand) and keep the move handle so a trick can cancel it
        this.trickManager._stopCardAnimations(sprite);

        // Animate from hovered position to play position
        // No flip needed since player's cards are already face-up
        const moveTween = scene.tweens.add({
          targets: sprite,
          x: targetPos.x,
          y: targetPos.y,
          duration: ANIMATION_CONFIG.CARD_PLAY,
          ease: 'Power2',
          rotation: 0,
          scale: 1.5,
          onComplete: () => {
            if (!sprite || !sprite.scene) return;
            sprite.setData('moveTween', null);
            sprite.setDepth(200);
          },
        });
        sprite.setData('moveTween', moveTween);

        // Add to trick manager's current trick
        sprite.setData('playPosition', 'self');
        this.trickManager._currentTrick.push(sprite);
      }

      // Also remove from gameState using optimistic update
      gameState.optimisticPlayCard(card);

      // Immediately dim all remaining cards since player can't play again this trick
      this.cardManager.updateCardLegality(() => true, false);
    });

    // Display the sorted hand
    this.cardManager.displayHand(sortedCards, { animate: !skipAnimation });

    // Update card legality based on current game state
    const canPlay = !gameState.isBidding &&
                    gameState.currentTurn === gameState.position &&
                    !gameState.hasPlayedCard;

    const legalityChecker = (card) => {
      const result = isLegalMove(
        card,
        gameState.myCards,
        gameState.leadCard,
        gameState.playedCardIndex === 0,
        gameState.trump,
        gameState.trumpBroken,
        gameState.position,
        gameState.leadPosition
      );
      return result.legal;
    };

    this.cardManager.updateCardLegality(legalityChecker, canPlay);
  }

  /**
   * Display the other seats' card backs and avatars via OpponentManager,
   * and the own avatar box at the same time (not for pure spectators: they
   * see all 4 players as opponent avatars).
   */
  handleDisplayOpponentHands(cardCount, dealerPosition, playerData, skipAnimation) {
    const gameState = getGameState();
    if (this.opponentManager) {
      if (gameState.position) {
        this.opponentManager.setPlayerPosition(gameState.position);
      }
      this.opponentManager.displayOpponentHands(cardCount, dealerPosition, playerData, skipAnimation);
    }
    const isPureSpectator = gameState.isSpectator && !gameState.isLazy;
    if (!this._playerInfo && !isPureSpectator) {
      if (gameState.position && gameState.playerData) {
        this.createPlayerInfoBox(gameState.playerData, gameState.position);
      }
    }
  }

  /**
   * Create the own avatar box (DOM: avatar, name, HSI) at the bottom right.
   * @returns {Object|null} { avatarContainer, avatarImg, nameLabel, hsiBox }
   */
  createPlayerInfoBox(playerData, myPosition) {
    // Safety check
    if (!playerData?.username || !playerData?.position || !playerData?.pics) {
      console.warn('⚠️ createPlayerInfoBox: playerData not ready');
      return null;
    }

    const positionIndex = playerData.position.indexOf(myPosition);
    if (positionIndex === -1 || !playerData.username[positionIndex]) {
      console.warn('⚠️ createPlayerInfoBox: position not found in playerData');
      return null;
    }

    const screenWidth = this.scale.width;
    const screenHeight = this.scale.height;
    const scaleX = screenWidth / 1920;
    const scaleY = screenHeight / 953;

    const boxX = screenWidth - 420 * scaleX;
    const boxY = screenHeight - 150 * scaleY;

    // Player Avatar - use DOM for consistent sizing with opponent avatars
    const pic = playerData.pics[positionIndex];
    const username = playerData.username[positionIndex].username || playerData.username[positionIndex];

    // Create DOM-based avatar (same approach as opponent avatars)
    const avatarContainer = document.createElement('div');
    avatarContainer.id = 'player-avatar-container';
    avatarContainer.style.cssText = `
      position: absolute;
      left: ${boxX}px;
      top: ${boxY - 60 * scaleY}px;
      transform: translate(-50%, -50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      pointer-events: auto;
      cursor: pointer;
      z-index: 100;
    `;

    avatarContainer.addEventListener('click', () => {
      const socket = window.socket;
      if (socket) {
        socket.emit('getPlayerProfile', { username });
      }
    });

    const avatarImg = document.createElement('img');
    avatarImg.className = 'player-avatar-img';
    // Stock number, inline data URL or /avatar URL (utils/avatar.js)
    applyAvatarImg(avatarImg, avatarSrc(pic));
    avatarImg.alt = username;
    avatarImg.style.cssText = `
      width: 80px;
      height: 80px;
      min-width: 80px;
      min-height: 80px;
      max-width: 80px;
      max-height: 80px;
      object-fit: cover;
      border-radius: 50%;
      border: 3px solid #333;
      background: #1a1a1a;
    `;
    avatarContainer.appendChild(avatarImg);

    // Add username label
    const nameLabel = document.createElement('div');
    nameLabel.textContent = username;
    nameLabel.style.cssText = `
      margin-top: 5px;
      padding: 2px 8px;
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid #666;
      border-radius: 4px;
      font-size: 14px;
      font-family: Arial, sans-serif;
      color: #aaa;
      text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
    `;
    avatarContainer.appendChild(nameLabel);

    // Add HSI display box
    const hsiBox = document.createElement('div');
    hsiBox.id = 'player-hsi-box';
    hsiBox.style.cssText = `
      margin-top: 4px;
      padding: 2px 8px;
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid #666;
      border-radius: 4px;
      font-size: 12px;
      color: #aaa;
      white-space: nowrap;
    `;
    hsiBox.textContent = 'HSI: --';
    avatarContainer.appendChild(hsiBox);

    // Add avatar to DOM
    document.body.appendChild(avatarContainer);

    // Move voice mute button into avatar container if voice is active
    reattachMuteButton();

    this._playerInfo = { avatarContainer, avatarImg, nameLabel, hsiBox };
    return this._playerInfo;
  }

  /**
   * Follow a resize with the own avatar box (and the mute button on it).
   */
  repositionPlayerInfo() {
    if (!this._playerInfo?.avatarContainer) return;

    const screenWidth = this.scale.width;
    const screenHeight = this.scale.height;
    const scaleX = screenWidth / 1920;
    const scaleY = screenHeight / 953;

    const boxX = screenWidth - 420 * scaleX;
    const boxY = screenHeight - 150 * scaleY;

    // Reposition DOM avatar container (position text is inside container)
    this._playerInfo.avatarContainer.style.left = `${boxX}px`;
    this._playerInfo.avatarContainer.style.top = `${boxY - 60 * scaleY}px`;

    // Reposition mute button to follow HSI box
    reattachMuteButton();
  }

  /**
   * Remove the own avatar box.
   */
  clearPlayerInfo() {
    if (this._playerInfo?.avatarContainer) {
      this._playerInfo.avatarContainer.remove();
    }
    this._playerInfo = null;
  }

  /**
   * Show the hand's HSI in the own avatar box.
   */
  updatePlayerHsi(hsi) {
    if (this._playerInfo?.hsiBox && hsi !== undefined) {
      this._playerInfo.hsiBox.textContent = `HSI: ${hsi.toFixed(1)}`;
    }
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Clean up all visual elements (game end Return to Lobby, abortGame).
   * The card hand goes before the trick manager: clearing a collect in
   * flight runs its onCollected callbacks, which must find no hand.
   */
  cleanup() {
    this.cardManager?.clearAll();
    this.opponentManager?.clearAll();
    this.trickManager?.clearAll();
    this.effectsManager?.clearAll();
    this.drawManager?.cleanup();

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
  }
}

// Export for use in Phaser config
export default GameScene;

/**
 * DrawManager - Handles the draw phase UI and animations.
 *
 * Manages the deck display, card selection, and draw animations
 * during the position determination phase of the game.
 */

import { getGameState } from '../../state/GameState.js';
import { getCardImageKey } from '../../utils/cards.js';
import { getSocketManager } from '../../socket/SocketManager.js';

// Base design dimensions for scaling
const BASE_WIDTH = 1920;
const BASE_HEIGHT = 953;

export class DrawManager {
  constructor(scene) {
    this.scene = scene;
    this.state = getGameState();

    // Track all created elements for cleanup
    this.allCards = [];
    this.drawnCardDisplays = [];
    this.hitZone = null;
    this.titleText = null;

    // Track clicked card for local player draw
    this.clickedCardSprite = null;
    this.clickedCardIndex = null;
  }

  /**
   * Get scale factors based on current screen size.
   */
  getScaleFactors() {
    const screenWidth = this.scene.scale.width;
    const screenHeight = this.scene.scale.height;
    return {
      x: screenWidth / BASE_WIDTH,
      y: screenHeight / BASE_HEIGHT,
      screenWidth,
      screenHeight,
    };
  }

  /**
   * Check if document is visible (for animation decisions).
   */
  isVisible() {
    return document.visibilityState === 'visible';
  }

  /**
   * Show the draw UI with the deck of 54 cards.
   * Called when 'startDraw' event is received.
   */
  showDrawUI() {
    this.cleanup();
    this.state.setHasDrawn(false);

    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();

    console.log('🃏 DrawManager: Showing draw UI...');

    // Card layout settings
    const startX = 400 * scaleX;
    const startY = screenHeight / 2;
    const overlap = 20 * scaleX;

    // Draw display positions (4 slots above the deck)
    const drawDisplayY = screenHeight / 2 - 200 * scaleY;
    const drawDisplayStartX = screenWidth / 2 - 300 * scaleX;
    const drawDisplaySpacing = 200 * scaleX;

    // Store positions for later use
    this.drawDisplayConfig = {
      y: drawDisplayY,
      startX: drawDisplayStartX,
      spacing: drawDisplaySpacing,
    };
    this.deckConfig = {
      startX,
      startY,
      overlap,
    };

    // Add title
    this.titleText = this.scene.add.text(screenWidth / 2, 80 * scaleY, 'Draw for Deal!', {
      fontSize: `${48 * scaleX}px`,
      fontStyle: 'bold',
      color: '#FFFFFF',
      stroke: '#000000',
      strokeThickness: 4,
    }).setOrigin(0.5).setDepth(200);
    this.allCards.push(this.titleText);

    // Create deck cards (visual only)
    for (let i = 0; i < 54; i++) {
      const cardSprite = this.scene.add.image(
        screenWidth / 2 + 500 * scaleX,
        startY,
        'cardBack'
      ).setScale(1.2).setDepth(100);

      if (this.isVisible()) {
        this.scene.tweens.add({
          targets: cardSprite,
          x: startX + i * overlap,
          y: startY,
          duration: 750,
          ease: 'Power2',
          delay: 0,
        });
      } else {
        cardSprite.x = startX + i * overlap;
        cardSprite.y = startY;
      }
      this.allCards.push(cardSprite);
    }

    // Create invisible hit zone for click detection
    const cardHeight = 190 * scaleY;
    const hitZoneWidth = 53 * overlap + 140 * scaleX;
    const hitZoneX = startX + hitZoneWidth / 2;

    this.hitZone = this.scene.add.rectangle(
      hitZoneX,
      startY,
      hitZoneWidth,
      cardHeight,
      0x000000,
      0
    ).setInteractive().setDepth(150);

    this.hitZone.on('pointerdown', (pointer) => {
      if (this.state.hasDrawn) return;
      this.state.setHasDrawn(true);

      // Calculate which card was clicked
      const clickX = pointer.x;
      const clickedIndex = Math.min(53, Math.max(0, Math.floor((clickX - startX) / overlap)));

      // Get the clicked card sprite (cards start at index 1, after titleText)
      const clickedCard = this.allCards[clickedIndex + 1];

      // Store clicked card sprite and index for the draw animation
      this.clickedCardSprite = clickedCard;
      this.clickedCardIndex = clickedIndex + 1;

      console.log(`📦 DrawManager: Clicked card ${clickedIndex + 1}`);

      // Emit draw event to server
      getSocketManager().emit('draw', { num: Math.floor(Math.random() * 54) });

      // Disable hit zone
      this.hitZone.disableInteractive();
    });

    this.allCards.push(this.hitZone);

    console.log('✅ DrawManager: Draw UI displayed');
  }

  /**
   * Handle the local player's draw result.
   * Called when 'youDrew' event is received.
   * @param {Object} data - { card }
   */
  handleYouDrew(data) {
    console.log(`🎴 DrawManager: You drew: ${data.card.rank} of ${data.card.suit}`);
    // The playerDrew event will handle the display
  }

  /**
   * Animate a drawn card for any player.
   * Called when 'playerDrew' event is received.
   * @param {Object} data - { username, card, drawOrder, position }
   */
  handlePlayerDrew(data) {
    console.log(`🎴 DrawManager: ${data.username} drew: ${data.card.rank} of ${data.card.suit} (order: ${data.drawOrder})`);

    const { x: scaleX, y: scaleY } = this.getScaleFactors();

    // Calculate position for this drawn card
    const slotX = this.drawDisplayConfig.startX + (data.drawOrder - 1) * this.drawDisplayConfig.spacing;
    const textureKey = getCardImageKey(data.card);

    // Determine if this is the local player's draw
    const isLocalPlayer = this.clickedCardSprite !== null;

    let drawnCard;
    let cardIndexToRemove;

    if (isLocalPlayer) {
      // Use the actual clicked card sprite
      drawnCard = this.clickedCardSprite;
      cardIndexToRemove = this.clickedCardIndex;
      drawnCard.setDepth(300);

      // Clear the stored references
      this.clickedCardSprite = null;
      this.clickedCardIndex = null;
    } else {
      // For remote players, pick a random card from the remaining deck
      // Cards start at index 1 (index 0 is title text)
      const availableIndices = [];
      for (let i = 1; i < this.allCards.length; i++) {
        if (this.allCards[i] && this.allCards[i].type === 'Image') {
          availableIndices.push(i);
        }
      }

      if (availableIndices.length > 0) {
        // Pick a random card from the deck
        const randomIdx = Math.floor(Math.random() * availableIndices.length);
        cardIndexToRemove = availableIndices[randomIdx];
        drawnCard = this.allCards[cardIndexToRemove];
        drawnCard.setDepth(300);
      } else {
        // Fallback: create a new card if somehow no cards left
        drawnCard = this.scene.add.image(this.deckConfig.startX, this.deckConfig.startY, 'cardBack')
          .setScale(0.8)
          .setDepth(300);
      }
    }

    // Remove the card from allCards array (don't reposition others)
    if (cardIndexToRemove !== undefined) {
      this.allCards[cardIndexToRemove] = null;
    }

    // Create username label
    const nameLabel = this.scene.add.text(
      slotX,
      this.drawDisplayConfig.y - 80 * scaleY,
      data.username,
      {
        fontSize: `${24 * scaleX}px`,
        fontStyle: 'bold',
        color: '#FFFFFF',
        stroke: '#000000',
        strokeThickness: 3,
      }
    ).setOrigin(0.5).setDepth(300);

    // Flip animation (slowed down)
    const startPos = { x: drawnCard.x, y: drawnCard.y };
    const midX = (startPos.x + slotX) / 2;
    const midY = (startPos.y + this.drawDisplayConfig.y) / 2;
    const flipDuration = 250;

    // Phase 1: Move toward midpoint and scale X to 0 (flip start)
    this.scene.tweens.add({
      targets: drawnCard,
      x: midX,
      y: midY,
      scaleX: 0,
      scaleY: 1.1,
      duration: flipDuration,
      ease: 'Power2',
      onComplete: () => {
        // Guard against destroyed sprite (cleanup called during animation)
        if (!drawnCard || !drawnCard.scene) return;

        // Change texture to revealed card
        drawnCard.setTexture('cards', textureKey);

        // Phase 2: Scale X back and complete movement
        this.scene.tweens.add({
          targets: drawnCard,
          x: slotX,
          y: this.drawDisplayConfig.y,
          scaleX: 1.5,
          scaleY: 1.5,
          duration: flipDuration,
          ease: 'Power2',
        });
      },
    });

    this.drawnCardDisplays.push(drawnCard, nameLabel);
  }

  /**
   * Handle teams announced overlay.
   * Called when 'teamsAnnounced' event is received.
   * @param {Object} data - { team1: [username1, username2], team2: [username1, username2] }
   */
  handleTeamsAnnounced(data) {
    console.log('🏆 DrawManager: Teams announced:', data);

    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();

    // Target position: off-screen top right
    const targetX = screenWidth + 150;
    const targetY = -150;
    const animationDuration = 800;
    const flipDuration = 250;
    const flipDelay = flipDuration * 2; // Wait for drawn cards to flip before whisking

    // Animate all deck cards off-screen (skip title text at index 0 and null entries)
    // Delay until drawn cards have flipped face down
    this.allCards.forEach((card, index) => {
      if (index === 0 || !card || card.type !== 'Image') return; // Skip title, null, and non-sprite elements

      this.scene.tweens.add({
        targets: card,
        x: targetX,
        y: targetY,
        scaleX: 0.6,
        scaleY: 0.6,
        duration: animationDuration,
        ease: 'Power2',
        delay: flipDelay + index * 5, // Wait for flip, then stagger
      });
    });

    // Animate drawn cards: flip face down while moving back to deck row, then whisk away
    // Name labels fade out
    const deckY = this.deckConfig.startY;
    this.drawnCardDisplays.forEach((item) => {
      if (!item || !item.scene) return;

      // Check if it's a card sprite (Image type) vs a text label
      if (item.type === 'Image') {
        // Phase 1: Move toward deck row and scale X to 0 (flip start)
        this.scene.tweens.add({
          targets: item,
          y: deckY,
          scaleX: 0,
          scaleY: 1.2,
          duration: flipDuration,
          ease: 'Power2',
          onComplete: () => {
            if (!item || !item.scene) return;

            // Change texture to card back
            item.setTexture('cardBack');

            // Phase 2: Complete flip (scale X back)
            this.scene.tweens.add({
              targets: item,
              scaleX: 1.2,
              duration: flipDuration,
              ease: 'Power2',
              onComplete: () => {
                if (!item || !item.scene) return;

                // Phase 3: Whisk off-screen with the rest
                this.scene.tweens.add({
                  targets: item,
                  x: targetX,
                  y: targetY,
                  scaleX: 0.6,
                  scaleY: 0.6,
                  duration: animationDuration,
                  ease: 'Power2',
                });
              },
            });
          },
        });
      } else if (item.type === 'Text') {
        // This is a text label - fade it out
        this.scene.tweens.add({
          targets: item,
          alpha: 0,
          duration: flipDuration * 2,
          ease: 'Power2',
        });
      }
    });

    // Hide the title text
    if (this.titleText) {
      this.scene.tweens.add({
        targets: this.titleText,
        alpha: 0,
        duration: animationDuration / 2,
        ease: 'Power2',
      });
    }

    // Show team announcement immediately while cards animate away
    this._showTeamAnnouncement(data);
  }

  /**
   * Display the team announcement overlay.
   * @param {Object} data - { team1: [username1, username2], team2: [username1, username2] }
   */
  _showTeamAnnouncement(data) {
    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = this.getScaleFactors();

    // Create semi-transparent overlay
    const overlay = this.scene.add.rectangle(
      screenWidth / 2,
      screenHeight / 2,
      screenWidth,
      screenHeight,
      0x000000,
      0.7
    ).setDepth(400);

    // Team 1 display (centered vertically on screen)
    const team1Label = this.scene.add.text(
      screenWidth / 2,
      screenHeight / 2 - 100 * scaleY,
      'Team 1',
      {
        fontSize: `${32 * scaleX}px`,
        fontStyle: 'bold',
        color: '#4ade80',
      }
    ).setOrigin(0.5).setDepth(401);

    const team1Players = this.scene.add.text(
      screenWidth / 2,
      screenHeight / 2 - 50 * scaleY,
      `${data.team1[0]} & ${data.team1[1]}`,
      {
        fontSize: `${28 * scaleX}px`,
        color: '#FFFFFF',
      }
    ).setOrigin(0.5).setDepth(401);

    // VS text
    const vsText = this.scene.add.text(
      screenWidth / 2,
      screenHeight / 2,
      'vs',
      {
        fontSize: `${24 * scaleX}px`,
        fontStyle: 'italic',
        color: '#9ca3af',
      }
    ).setOrigin(0.5).setDepth(401);

    // Team 2 display
    const team2Label = this.scene.add.text(
      screenWidth / 2,
      screenHeight / 2 + 50 * scaleY,
      'Team 2',
      {
        fontSize: `${32 * scaleX}px`,
        fontStyle: 'bold',
        color: '#f87171',
      }
    ).setOrigin(0.5).setDepth(401);

    const team2Players = this.scene.add.text(
      screenWidth / 2,
      screenHeight / 2 + 100 * scaleY,
      `${data.team2[0]} & ${data.team2[1]}`,
      {
        fontSize: `${28 * scaleX}px`,
        color: '#FFFFFF',
      }
    ).setOrigin(0.5).setDepth(401);

    // Store for cleanup
    const teamElements = [overlay, team1Label, team1Players, vsText, team2Label, team2Players];
    this.drawnCardDisplays.push(...teamElements);

    // After showing teams for a moment, start fading to black
    const fadeDelay = 2000; // Show teams for 2 seconds
    const fadeDuration = 1200;

    this.scene.time.delayedCall(fadeDelay, () => {
      // Create DOM overlay for fade to black (covers everything including DOM elements)
      const domOverlay = document.createElement('div');
      domOverlay.id = 'transition-overlay';
      domOverlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: black;
        opacity: 0;
        z-index: 99999;
        pointer-events: none;
        transition: opacity ${fadeDuration}ms ease-out;
      `;
      document.body.appendChild(domOverlay);

      // Store globally for handleCreateUI to find
      window._transitionOverlay = domOverlay;

      // Force reflow and start fade
      domOverlay.offsetHeight;
      domOverlay.style.opacity = '1';
    });
  }

  /**
   * Fade out the team overlay and then clean up.
   * @param {Function} onComplete - Callback when fade and cleanup are done
   */
  fadeOutAndCleanup(onComplete) {
    console.log('🔥 DrawManager: Fading out and cleaning up...');

    const fadeDuration = 1200;
    let fadeComplete = false;

    // Fade out all remaining elements
    const allElements = [...this.drawnCardDisplays, ...this.allCards];
    const visibleElements = allElements.filter(item => item && item.scene && item.alpha > 0);

    if (visibleElements.length === 0) {
      // Nothing to fade, just cleanup
      this.cleanup();
      onComplete?.();
      return;
    }

    // Fade all visible elements
    visibleElements.forEach((item, index) => {
      this.scene.tweens.add({
        targets: item,
        alpha: 0,
        duration: fadeDuration,
        ease: 'Power2',
        onComplete: () => {
          // Only call cleanup once, after the last fade
          if (!fadeComplete && index === visibleElements.length - 1) {
            fadeComplete = true;
            this.cleanup();
            onComplete?.();
          }
        },
      });
    });
  }

  /**
   * Clean up and remove the draw UI.
   * Called when transitioning to the game phase.
   */
  cleanup() {
    console.log('🔥 DrawManager: Cleaning up draw phase...');

    // Destroy all deck cards and title
    this.allCards.forEach(card => {
      if (card && card.destroy) {
        card.destroy();
      }
    });
    this.allCards = [];

    // Destroy drawn card displays
    this.drawnCardDisplays.forEach(item => {
      if (item && item.destroy) {
        item.destroy();
      }
    });
    this.drawnCardDisplays = [];

    this.hitZone = null;
    this.titleText = null;
    this.clickedCardSprite = null;
    this.clickedCardIndex = null;

    console.log('✅ DrawManager: Cleanup complete');
  }
}

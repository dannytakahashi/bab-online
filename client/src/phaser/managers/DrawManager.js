/**
 * DrawManager - Handles the draw phase UI and animations.
 *
 * Manages the deck display, card selection, and draw animations
 * during the position determination phase of the game.
 */

import { getGameState } from '../../state/GameState.js';
import { getCardImageKey } from '../../utils/cards.js';
import { getSocketManager } from '../../socket/SocketManager.js';
import { teamsFade } from '../pacing.js';
import { sceneDelay, sceneTween } from '../TableDirector.js';
import { createTransitionOverlay } from '../../ui/transitionOverlay.js';
import { CARD_CONFIG } from '../config.js';
import { layoutOf, deckPosition } from '../layout/computeTableLayout.js';

export class DrawManager {
  constructor(scene) {
    this.scene = scene;
    this.state = getGameState();

    // Track all created elements for cleanup
    this.allCards = [];
    this.drawnCardDisplays = [];
    this.titleText = null;

    // Track clicked card for local player draw
    this.clickedCardSprite = null;
    this.clickedCardIndex = null;

    // Teams overlay pieces (relayout keeps them centred)
    this._teamElements = null;
    this._teamsShown = false;

    // Pending fade-to-black timer (cancelled in cleanup so a stale one can't
    // add an overlay after the game UI has been built)
    this._fadeTimer = null;
  }

  /** The table layout this manager draws with (its `draw` and `teams` parts). */
  layout() {
    return layoutOf(this.scene);
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

    const L = this.layout();
    const { deck, title } = L.draw;

    console.log('🃏 DrawManager: Showing draw UI...');

    // Add title
    this.titleText = this.scene.add.text(title.x, title.y, 'Draw for Deal!', {
      fontSize: `${title.font}px`,
      fontStyle: 'bold',
      color: '#FFFFFF',
      stroke: '#000000',
      strokeThickness: 4,
    }).setOrigin(0.5).setDepth(200);
    this.allCards.push(this.titleText);

    // The deck: each card is its own button over its visible bounds, so the
    // one under the pointer is the one picked (Phaser's input checks the
    // top object first; a later card lies over the one before it). ui-19:
    // one hit zone used to map a click two or three cards to the left.
    const { CARD_BOUNDS } = CARD_CONFIG;
    for (let i = 0; i < 54; i++) {
      const spot = deckPosition(L, i);
      const cardSprite = this.scene.add.image(deck.enterX, spot.y, 'cardBack')
        .setScale(deck.card.scale).setDepth(100);
      cardSprite.setData?.('deckIndex', i);

      if (this.isVisible()) {
        cardSprite.setData?.('moveTween', sceneTween(this.scene, {
          targets: cardSprite,
          x: spot.x,
          y: spot.y,
          duration: 750,
          ease: 'Power2',
          delay: 0,
        }));
      } else {
        cardSprite.x = spot.x;
        cardSprite.y = spot.y;
      }
      cardSprite.setInteractive(
        new Phaser.Geom.Rectangle(CARD_BOUNDS.x, CARD_BOUNDS.y, CARD_BOUNDS.width, CARD_BOUNDS.height),
        Phaser.Geom.Rectangle.Contains
      );
      cardSprite.on('pointerdown', () => this._onDeckCardDown(cardSprite));
      this.allCards.push(cardSprite);
    }

    console.log('✅ DrawManager: Draw UI displayed');
  }

  /** My click on a deck card: that card is mine to flip (the server picks the value). */
  _onDeckCardDown(cardSprite) {
    if (this.state.hasDrawn) return;
    const index = this.allCards.indexOf(cardSprite);
    if (index < 1) return;
    this.state.setHasDrawn(true);

    // Store clicked card sprite and index for the draw animation
    this.clickedCardSprite = cardSprite;
    this.clickedCardIndex = index;

    console.log(`📦 DrawManager: Clicked card ${index}`);

    // Emit draw event to server
    getSocketManager().emit('draw', { num: Math.floor(Math.random() * 54) });

    // No more picks
    for (const c of this.allCards) {
      if (c && c !== this.titleText) c.disableInteractive?.();
    }
  }

  /** Deck cards still in the deck (not drawn), with their deck index. */
  deckCards() {
    return this.allCards
      .map((card, index) => ({ card, index }))
      .filter(({ card, index }) => index > 0 && card && card.active !== false && card.getData?.('deckIndex') !== undefined);
  }

  /**
   * Follow a relayout: the deck, the drawn cards and their names, the
   * title, and the teams overlay go to their places in the new layout
   * (ui-19: the draw used to ignore a resize). Tweens still heading for
   * the old places are cut short at their end state.
   */
  relayout() {
    const L = this.layout();
    const { draw, teams } = L;
    const stop = (obj) => {
      const t = obj.getData?.('moveTween');
      if (t) {
        t.stop?.();
        obj.setData('moveTween', null);
      }
      this.scene.tweens?.killTweensOf?.(obj);
    };
    if (this.titleText?.active !== false && this.titleText) {
      this.titleText.setPosition?.(draw.title.x, draw.title.y);
      this.titleText.setFontSize?.(draw.title.font);
    }
    if (!this._teamsShown) {
      // the deck in its row (the teams whisk sends it off the top: leave it)
      for (const { card } of this.deckCards()) {
        stop(card);
        const p = deckPosition(L, card.getData('deckIndex'));
        card.setPosition(p.x, p.y);
        card.setScale(draw.deck.card.scale);
      }
      // the drawn cards face up in their slots, names above
      for (const item of this.drawnCardDisplays) {
        const order = item?.getData?.('drawOrder');
        if (!order) continue;
        const slot = draw.slots[order - 1];
        if (!slot) continue;
        stop(item);
        if (item.getData('isName')) {
          item.setPosition(slot.x, slot.y + draw.name.dy);
          item.setFontSize?.(draw.name.font);
        } else {
          const face = item.getData('faceKey');
          if (face) item.setTexture('cards', face);
          item.setPosition(slot.x, slot.y);
          item.setScale(draw.slotCard.scale);
        }
      }
    }
    if (this._teamElements) {
      const [overlay, team1Label, team1Players, vsText, team2Label, team2Players] = this._teamElements;
      overlay.setPosition?.(teams.x, teams.y);
      overlay.setSize?.(L.w, L.h);
      const rows = [[team1Label, -2, teams.fonts.label], [team1Players, -1, teams.fonts.names], [vsText, 0, teams.fonts.vs],
        [team2Label, 1, teams.fonts.label], [team2Players, 2, teams.fonts.names]];
      for (const [el, row, font] of rows) {
        el.setPosition?.(teams.x, teams.y + row * teams.dy);
        el.setFontSize?.(font);
      }
    }
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

    const { draw } = this.layout();

    // This draw's slot (1-4, in draw order)
    const slot = draw.slots[Math.max(0, Math.min(3, (data.drawOrder || 1) - 1))];
    const slotX = slot.x;
    const slotY = slot.y;
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
      const availableIndices = this.deckCards().map(({ index }) => index);

      if (availableIndices.length > 0) {
        // Pick a random card from the deck
        const randomIdx = Math.floor(Math.random() * availableIndices.length);
        cardIndexToRemove = availableIndices[randomIdx];
        drawnCard = this.allCards[cardIndexToRemove];
        drawnCard.setDepth(300);
      } else {
        // Fallback: create a new card if somehow no cards left
        const p = deckPosition(this.layout(), 0);
        drawnCard = this.scene.add.image(p.x, p.y, 'cardBack')
          .setScale(draw.deck.card.scale)
          .setDepth(300);
      }
    }

    // Remove the card from allCards array (don't reposition others)
    if (cardIndexToRemove !== undefined) {
      this.allCards[cardIndexToRemove] = null;
    }
    // A drawn card leaves the deck: no longer a button, its slot and face kept for a relayout
    drawnCard.disableInteractive?.();
    drawnCard.removeAllListeners?.('pointerdown');
    drawnCard.setData?.('deckIndex', undefined);
    drawnCard.setData?.('drawOrder', data.drawOrder || 1);
    drawnCard.setData?.('faceKey', textureKey);

    // Create username label
    const nameLabel = this.scene.add.text(
      slotX,
      slotY + draw.name.dy,
      data.username,
      {
        fontSize: `${draw.name.font}px`,
        fontStyle: 'bold',
        color: '#FFFFFF',
        stroke: '#000000',
        strokeThickness: 3,
      }
    ).setOrigin(0.5).setDepth(300);
    nameLabel.setData?.('drawOrder', data.drawOrder || 1);
    nameLabel.setData?.('isName', true);

    // Stop the deal-in tween if it is still running (it would pull the card back)
    const inTween = drawnCard.getData?.('moveTween');
    if (inTween) {
      inTween.stop?.();
      drawnCard.setData('moveTween', null);
    }

    // Flip animation (slowed down)
    const startPos = { x: drawnCard.x, y: drawnCard.y };
    const midX = (startPos.x + slotX) / 2;
    const midY = (startPos.y + slotY) / 2;
    const flipDuration = 250;
    const drawnScale = draw.slotCard.scale;

    // Phase 1: Move toward midpoint and scale X to 0 (flip start)
    sceneTween(this.scene, {
      targets: drawnCard,
      x: midX,
      y: midY,
      scaleX: 0,
      scaleY: drawnScale * 0.73,
      duration: flipDuration,
      ease: 'Power2',
      onComplete: () => {
        // Guard against destroyed sprite (cleanup called during animation)
        if (!drawnCard || !drawnCard.scene) return;

        // Change texture to revealed card
        drawnCard.setTexture('cards', textureKey);

        // Phase 2: Scale X back and complete movement
        sceneTween(this.scene, {
          targets: drawnCard,
          x: slotX,
          y: slotY,
          scaleX: drawnScale,
          scaleY: drawnScale,
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

    const L = this.layout();
    this._teamsShown = true;
    const deckScale = L.draw.deck.card.scale;

    // Target position: off-screen top right
    const targetX = L.w + 150;
    const targetY = -150;
    const animationDuration = 800;
    const flipDuration = 250;
    const flipDelay = flipDuration * 2; // Wait for drawn cards to flip before whisking

    // Animate all deck cards off-screen (skip title text at index 0 and null entries)
    // Delay until drawn cards have flipped face down
    this.allCards.forEach((card, index) => {
      if (index === 0 || !card || card.getData?.('deckIndex') === undefined) return; // Skip title, null, and non-deck elements

      sceneTween(this.scene, {
        targets: card,
        x: targetX,
        y: targetY,
        scaleX: deckScale / 2,
        scaleY: deckScale / 2,
        duration: animationDuration,
        ease: 'Power2',
        delay: flipDelay + index * 5, // Wait for flip, then stagger
      });
    });

    // Animate drawn cards: flip face down while moving back to deck row, then whisk away
    // Name labels fade out
    const deckY = L.draw.deck.y;
    this.drawnCardDisplays.forEach((item) => {
      if (!item || !item.scene) return;

      // A drawn card vs its name label
      if (item.getData?.('drawOrder') && !item.getData('isName')) {
        // Phase 1: Move toward deck row and scale X to 0 (flip start)
        sceneTween(this.scene, {
          targets: item,
          y: deckY,
          scaleX: 0,
          scaleY: deckScale,
          duration: flipDuration,
          ease: 'Power2',
          onComplete: () => {
            if (!item || !item.scene) return;

            // Change texture to card back
            item.setTexture('cardBack');

            // Phase 2: Complete flip (scale X back)
            sceneTween(this.scene, {
              targets: item,
              scaleX: deckScale,
              duration: flipDuration,
              ease: 'Power2',
              onComplete: () => {
                if (!item || !item.scene) return;

                // Phase 3: Whisk off-screen with the rest
                sceneTween(this.scene, {
                  targets: item,
                  x: targetX,
                  y: targetY,
                  scaleX: deckScale / 2,
                  scaleY: deckScale / 2,
                  duration: animationDuration,
                  ease: 'Power2',
                });
              },
            });
          },
        });
      } else if (item.getData?.('isName')) {
        // This is a text label - fade it out
        sceneTween(this.scene, {
          targets: item,
          alpha: 0,
          duration: flipDuration * 2,
          ease: 'Power2',
        });
      }
    });

    // Hide the title text
    if (this.titleText) {
      sceneTween(this.scene, {
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
    const L = this.layout();
    const { teams } = L;
    const cx = teams.x;
    const cy = teams.y;
    const dy = teams.dy;

    // Create semi-transparent overlay
    const overlay = this.scene.add.rectangle(
      cx,
      cy,
      L.w,
      L.h,
      0x000000,
      0.7
    ).setDepth(400);

    // Team 1 display (centered vertically on screen)
    const team1Label = this.scene.add.text(
      cx,
      cy - 2 * dy,
      'Team 1',
      {
        fontSize: `${teams.fonts.label}px`,
        fontStyle: 'bold',
        color: '#4ade80',
      }
    ).setOrigin(0.5).setDepth(401);

    const team1Players = this.scene.add.text(
      cx,
      cy - dy,
      `${data.team1[0]} & ${data.team1[1]}`,
      {
        fontSize: `${teams.fonts.names}px`,
        color: '#FFFFFF',
      }
    ).setOrigin(0.5).setDepth(401);

    // VS text
    const vsText = this.scene.add.text(
      cx,
      cy,
      'vs',
      {
        fontSize: `${teams.fonts.vs}px`,
        fontStyle: 'italic',
        color: '#9ca3af',
      }
    ).setOrigin(0.5).setDepth(401);

    // Team 2 display
    const team2Label = this.scene.add.text(
      cx,
      cy + dy,
      'Team 2',
      {
        fontSize: `${teams.fonts.label}px`,
        fontStyle: 'bold',
        color: '#f87171',
      }
    ).setOrigin(0.5).setDepth(401);

    const team2Players = this.scene.add.text(
      cx,
      cy + 2 * dy,
      `${data.team2[0]} & ${data.team2[1]}`,
      {
        fontSize: `${teams.fonts.names}px`,
        color: '#FFFFFF',
      }
    ).setOrigin(0.5).setDepth(401);

    // Store for cleanup
    const teamElements = [overlay, team1Label, team1Players, vsText, team2Label, team2Players];
    this.drawnCardDisplays.push(...teamElements);
    this._teamElements = teamElements;

    // After showing teams for a moment, fade to black, ending exactly when
    // the server's hold does (teamsAnnounced.resumeInMs; createUI then
    // forces the overlay opaque)
    const { fadeDelay, fadeDuration } = teamsFade(data.resumeInMs);

    // The first deal waits for this fade (TableDirector.uiReady)
    this.scene.director?.beginFade();
    this._fadeTimer = sceneDelay(this.scene, fadeDelay, () => {
      this._fadeTimer = null;
      // DOM overlay for the fade to black (covers the DOM UI too);
      // handleCreateUI finds it through transitionOverlay.js
      const domOverlay = createTransitionOverlay({ opacity: 0, transitionMs: fadeDuration });

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
      sceneTween(this.scene, {
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

    if (this._fadeTimer) {
      this._fadeTimer.remove(false);
      this._fadeTimer = null;
    }

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

    this.titleText = null;
    this.clickedCardSprite = null;
    this.clickedCardIndex = null;
    this._teamElements = null;
    this._teamsShown = false;

    console.log('✅ DrawManager: Cleanup complete');
  }
}

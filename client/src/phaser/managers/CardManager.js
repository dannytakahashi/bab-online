/**
 * Card sprite management for Phaser.
 *
 * Handles card display, positioning, and animations.
 */

import { getCardImageKey } from '../../utils/cards.js';
import { CARD_CONFIG, ANIMATION_CONFIG } from '../config.js';
import { sceneDelay, sceneTween } from '../TableDirector.js';
import { layoutOf, handPositions } from '../layout/computeTableLayout.js';
import { CARD_TEXTURE_KEY, SHADOW_MARGIN } from '../cards/CardAtlas.js';
import { SHADOW_FRAME } from '../cards/cardFaces.js';
import { motionMs, dealStaggerMs, EASE_EMPHASIZED } from '../../ui/motion.js';
import { MOTION, COLOR, hex } from '../../ui/tokens.js';

/**
 * An unplayable card's opaque dimming (the iOS app's: a 0.4 black blend,
 * 60 % brightness; a translucent card would show the pips beneath it).
 */
const DIM_TINT = hex(COLOR.card.dimTint);

/** The deal's wait at the trump, then each card's flight (cosmetic: motion tokens; instant under reduced motion). */
const DEAL_DELAY_MS = 200;
export const dealMs = () => motionMs(MOTION.slow * 2);

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
    this._dealToken = 0;
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

  /** The table layout this manager draws with. */
  layout() {
    return layoutOf(this._scene);
  }

  /**
   * Hand card positions: the layout's hand box, centred, at its spacing
   * (closer when the box is too narrow for the hand).
   *
   * @param {number} cardCount - Number of cards
   * @returns {Array} Array of { x, y } positions
   */
  calculateHandPositions(cardCount) {
    return handPositions(this.layout(), cardCount);
  }

  /** The hand's sprite scale (CARD_CONFIG.SCALE times the layout's s). */
  handScale() {
    return this.layout().hand?.card.scale ?? CARD_CONFIG.SCALE;
  }

  /** How far a hovered card lifts. */
  _lift() {
    return this.layout().hand?.lift ?? 20;
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

    // Set dealing flag to prevent repositionHand from interrupting animation
    // (a later displayHand owns it: the token keeps an older deal's timer
    // from clearing it early, webclient-17)
    this._isDealing = !!animate;
    const dealToken = ++this._dealToken;

    const positions = this.calculateHandPositions(cards.length);

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

      // The hit area is the visible card: the atlas frame has no padding,
      // so it is the whole frame (cards/CardAtlas.js)
      const hitArea = new Phaser.Geom.Rectangle(0, 0, sprite.width, sprite.height);
      sprite.setInteractive(hitArea, Phaser.Geom.Rectangle.Contains);
      this._setupCardInteraction(sprite);

      this._handSprites.push(sprite);
    });

    // Schedule a reposition after deal animation completes to handle container resize timing
    // This ensures cards are positioned correctly even if container width changes
    // Delay must be longer than base delay (200ms) + the deal tween + the stagger (motion tokens)
    const animationDelay = animate ? DEAL_DELAY_MS + dealMs() + (cards.length * dealStaggerMs()) + 100 : 50;
    // Without the deal animation it only re-reads the layout (snapSafe: a
    // relayout need not fast-forward for it)
    sceneDelay(scene, animationDelay, () => {
      if (dealToken !== this._dealToken) return;
      this._isDealing = false; // Clear dealing flag so resize can work again
      this.repositionHand();
    }, { snapSafe: !animate });
  }

  /**
   * Create a card sprite.
   */
  _createCardSprite(card, x, y, animate = false, index = 0) {
    const scene = this._scene;
    const textureKey = this.getTextureKey(card);
    const { Z_INDEX } = CARD_CONFIG;
    const SCALE = this.handScale();

    let sprite;
    if (animate) {
      // Start from trump card's actual position (if it exists)
      // This ensures we use the same position regardless of container resize timing
      let startX, startY;
      if (scene.tableCardSprite) {
        startX = scene.tableCardSprite.x;
        startY = scene.tableCardSprite.y;
      } else {
        // Else the trump's place in the layout
        ({ x: startX, y: startY } = this.layout().trump);
      }

      sprite = scene.add.sprite(startX, startY, CARD_TEXTURE_KEY, textureKey);
      sprite.setScale(SCALE);
      sprite.setDepth(Z_INDEX.HAND + index);
      sprite.setAlpha(0); // Start invisible to avoid position glitch during delay

      // Animate to position with staggered delay (750ms to match opponents)
      // Add base delay so cards are visible at trump position first
      // Use explicit from/to values to ensure starting position is correct
      sceneTween(scene, {
        targets: sprite,
        x: { from: startX, to: x },
        y: { from: startY, to: y },
        alpha: { from: 1, to: 1 }, // Reveal card when tween starts
        duration: dealMs(),
        ease: EASE_EMPHASIZED,
        delay: DEAL_DELAY_MS + (index * dealStaggerMs()),
      });
    } else {
      sprite = scene.add.sprite(x, y, CARD_TEXTURE_KEY, textureKey);
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
      // The deal tween owns the card until it lands; an illegal card neither
      // lifts nor shows the hand cursor (it can't be played)
      if (this._isDealing || !sprite.getData('isLegal')) return;
      scene.input.setDefaultCursor('pointer');

      // Use stored baseY which is set after positioning is complete
      const baseY = sprite.getData('baseY') ?? sprite.y;
      // Quick in/out hovers queued competing tweens (the card could end up
      // stuck raised): only the newest hover tween runs
      scene.tweens.killTweensOf(sprite);
      sceneTween(scene, {
        targets: sprite,
        y: baseY - this._lift(),
        duration: motionMs('fast'),
        ease: EASE_EMPHASIZED,
      });
      // the raised state: the lift plus a soft shadow under the card
      this._showRaise(sprite, baseY);
      // Keep index-based depth - card stays partially behind cards to its right
    });

    sprite.on('pointerout', () => {
      // Reset cursor
      scene.input.setDefaultCursor('default');
      this._hideRaise(sprite);
      if (this._isDealing) return;

      // Always settle back to baseY: a card that turned illegal while lifted
      // must not stay up
      const baseY = sprite.getData('baseY') ?? sprite.y;
      scene.tweens.killTweensOf(sprite);
      if (sprite.y === baseY) return;
      sceneTween(scene, {
        targets: sprite,
        y: baseY,
        duration: motionMs('fast'),
        ease: EASE_EMPHASIZED,
      });
    });

    sprite.on('pointerdown', () => {
      if (this._onCardClick) {
        this._onCardClick(sprite.getData('card'), sprite);
      }
    });
  }

  /**
   * The raised card's soft shadow (the atlas's shadow frame): under the
   * hovered card, a little below its lifted position, fading in.
   */
  _showRaise(sprite, baseY) {
    const scene = this._scene;
    if (typeof scene.add?.image !== 'function') return;
    const L = this.layout();
    if (!L.hand) return;
    let shadow = this._raiseShadow;
    if (!shadow || shadow.active === false) {
      shadow = scene.add.image(sprite.x, baseY, CARD_TEXTURE_KEY, SHADOW_FRAME);
      this._raiseShadow = shadow;
    }
    // the frame's blurred card is inset by its margin: scale it up to the card
    const k = 1 / (1 - 2 * SHADOW_MARGIN);
    shadow.setScale(L.card.hand.scale * k * 1.04);
    shadow.setPosition(sprite.x, baseY - L.hand.lift * 0.55);
    shadow.setDepth((sprite.depth ?? 0) - 0.5);
    shadow.setAlpha(0);
    this._raiseOwner = sprite;
    sceneTween(scene, { targets: shadow, alpha: 1, duration: motionMs('fast'), ease: EASE_EMPHASIZED });
  }

  /** Drop the raised card's shadow (of `sprite`, or whichever card has it). */
  _hideRaise(sprite = null) {
    if (sprite && this._raiseOwner !== sprite) return;
    const shadow = this._raiseShadow;
    this._raiseShadow = null;
    this._raiseOwner = null;
    if (shadow && shadow.active !== false) {
      this._scene.tweens?.killTweensOf?.(shadow);
      shadow.destroy?.();
    }
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
        CARD_TEXTURE_KEY,
        this.getTextureKey(card)
      );
      sprite.setScale(this.layout().card.trick.scale);
      sprite.setDepth(CARD_CONFIG.Z_INDEX.PLAYED_CARDS);
      this._playedSprites[position] = sprite;
      return;
    }

    // Remove from hand array
    const sprite = this._handSprites.splice(spriteIndex, 1)[0];

    // Animate to table position
    sceneTween(this._scene, {
      targets: sprite,
      x: targetX,
      y: targetY,
      duration: ANIMATION_CONFIG.CARD_PLAY,
      ease: EASE_EMPHASIZED,
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
    // the canvas in CSS px (the layout's; the backing store is x DPR)
    const { w, h } = this.layout();

    // Get winner's edge position
    const targets = {
      1: { x: w / 2, y: h + 100 },
      2: { x: -100, y: h / 2 },
      3: { x: w / 2, y: -100 },
      4: { x: w + 100, y: h / 2 },
    };

    const target = targets[winnerPosition];

    // Animate all played cards to winner
    Object.values(this._playedSprites).forEach((sprite) => {
      sceneTween(scene, {
        targets: sprite,
        x: target.x,
        y: target.y,
        alpha: 0,
        duration: ANIMATION_CONFIG.CARD_COLLECT,
        ease: EASE_EMPHASIZED,
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
    this._hideRaise();
    this._dealToken++;
    this._isDealing = false;
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
        sprite.setTint(DIM_TINT);
        sprite.setData('isLegal', false);
        // Reset position if card was hovered when becoming illegal
        if (wasLegal) this._settleIllegal(sprite);
        return;
      }

      // Check legality
      const isLegal = legalityChecker ? legalityChecker(card) : true;

      if (isLegal) {
        sprite.clearTint();
        sprite.setData('isLegal', true);
      } else {
        sprite.setTint(DIM_TINT);
        sprite.setData('isLegal', false);
        // Reset position if card was hovered when becoming illegal
        if (wasLegal) this._settleIllegal(sprite);
      }
    });
  }

  /**
   * A card that just turned illegal drops back to the hand line (stopping a
   * hover lift still in flight) and loses the hand cursor if it was hovered.
   */
  _settleIllegal(sprite) {
    const baseY = sprite.getData('baseY');
    this._hideRaise(sprite);
    if (baseY === undefined || this._isDealing) return;
    if (sprite.y !== baseY) {
      this._scene.tweens?.killTweensOf?.(sprite);
      sprite.y = baseY;
      this._scene.input?.setDefaultCursor?.('default');
    }
  }

  /**
   * Set all cards to a specific tint.
   */
  setAllTint(tintColor = DIM_TINT) {
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
   * Enable or disable all card interaction (for spectator/lazy mode).
   * @param {boolean} enabled - Whether cards should be interactive
   */
  setInteractive(enabled) {
    this._interactionDisabled = !enabled;
    this._handSprites.forEach((sprite) => {
      if (!sprite || !sprite.active) return;
      if (enabled) {
        sprite.setInteractive();
      } else {
        sprite.disableInteractive();
        sprite.setTint(DIM_TINT);
        sprite.setData('isLegal', false);
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
    this._hideRaise();

    const positions = this.calculateHandPositions(this._handSprites.length);
    const scale = this.handScale();

    this._handSprites.forEach((sprite, index) => {
      if (sprite && sprite.active) {
        // a hover lift in flight would land at the old line
        this._scene.tweens?.killTweensOf?.(sprite);
        sprite.x = positions[index].x;
        sprite.y = positions[index].y;
        sprite.setScale?.(scale);
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
      this._hideRaise(sprite);
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

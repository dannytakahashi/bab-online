/**
 * Trick sprite management for Phaser.
 *
 * Handles trick display, card animations to center, and trick collection.
 */

import { getCardImageKey } from '../../utils/cards.js';
import { CARD_CONFIG, ANIMATION_CONFIG } from '../config.js';
import { collectMs } from '../pacing.js';
import { sceneTween } from '../TableDirector.js';
import { layoutOf, historySlot } from '../layout/computeTableLayout.js';

/**
 * Trick display: every position and size comes from the table layout
 * (layout/computeTableLayout.js): the four play slots, the two history
 * blocks (7 + 6 slots, my team bottom-left, the opponents top-left) and
 * their slot size, spacing and card scale, all at one scale (ui-6: slots
 * and spacing no longer scale apart).
 */
const TRICKS_ROW_1 = 7; // Top row capacity
const CONTAINER_COLOR = 0x1a1a1a; // Dark grey container
const SLOT_COLOR = 0x333333; // Lighter dark grey slots
const BORDER_COLOR_DANGER = 0xff4444; // Red when tricks < bid
const BORDER_COLOR_SAFE = 0x44ff44; // Green when tricks >= bid
const BORDER_WIDTH = 2; // Border stroke width

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

    // Bid totals (used for initial box size)
    this._teamBidTotal = 0;
    this._oppBidTotal = 0;

    // Background graphics
    this._backgroundGraphics = null;

    // Spectator mode — allows inspecting opponent tricks
    this._isSpectatorMode = false;

    // True while animateTricksAway is whisking the history off the table;
    // the whisked cards belong to the finished hand (no longer history)
    this._animatingAway = false;
    this._whisking = [];

    // Trick collect in flight (completeTrick's tweens): the next card is
    // not made playable until it lands (GameScene.handleUpdateTurn)
    this._collecting = false;
    this._collectToken = 0;
    this._collectFallback = null;
    this._onCollected = [];
  }

  /** True while a trick is being collected to its stack. */
  isCollecting() {
    return this._collecting;
  }

  /** Run `cb` once the collect in flight lands (at once if none is). */
  onCollected(cb) {
    if (!this._collecting) {
      cb();
      return;
    }
    this._onCollected.push(cb);
  }

  _beginCollect(ms) {
    this._collectToken++;
    const token = this._collectToken;
    this._collecting = true;
    this._collectFallback?.remove?.(false);
    // Fallback: a tween that is killed never completes
    const end = () => this._endCollect(token);
    this._collectFallback = (this._scene.director
      ? this._scene.director.delay(ms + 150, end)
      : this._scene.time?.delayedCall?.(ms + 150, end)) || null;
    return token;
  }

  /** End the collect (token: only that collect; none: whatever is in flight). */
  _endCollect(token) {
    if (token !== undefined && token !== this._collectToken) return;
    if (!this._collecting) return;
    this._collecting = false;
    this._collectFallback?.remove?.(false);
    this._collectFallback = null;
    const callbacks = this._onCollected;
    this._onCollected = [];
    for (const cb of callbacks) {
      try {
        cb();
      } catch (err) {
        console.error('onCollected callback failed', err);
      }
    }
  }

  /**
   * Set spectator mode (enables hover on opponent tricks).
   */
  setSpectatorMode(enabled) {
    this._isSpectatorMode = enabled;
  }

  /**
   * Set the team bid totals (called after bidding completes).
   * @param {number} teamBid - Total bid for player's team
   * @param {number} oppBid - Total bid for opponent team
   */
  setBidTotals(teamBid, oppBid) {
    this._teamBidTotal = teamBid;
    this._oppBidTotal = oppBid;
  }

  /**
   * Set the player's position (1-4).
   */
  setPlayerPosition(position) {
    this._playerPosition = position;
  }

  /** The table layout this manager draws with. */
  layout() {
    return layoutOf(this._scene);
  }

  /** A card in a trick slot: its sprite scale. */
  trickScale() {
    return this.layout().card.trick.scale;
  }

  /** A card in a history stack: its sprite scale. */
  historyScale() {
    return this.layout().card.history.scale;
  }

  /**
   * Centre of trick n in its history block (tricks 1-7 in the first row,
   * 8-13 centred under it).
   *
   * @param {number} trickNumber - Trick number (1-13)
   * @param {boolean} isTeamTrick - Whether this is for the player's team
   * @returns {Object} {x, y}
   */
  _getTrickPosition(trickNumber, isTeamTrick) {
    const p = historySlot(this.layout(), isTeamTrick ? 'team' : 'opp', trickNumber);
    return { x: p.x, y: p.y };
  }

  /**
   * Update play positions for card animations (the layout's trick slots).
   */
  updatePlayPositions() {
    const { slots } = this.layout().trick;
    this._playPositions = {
      opponent1: { x: slots.opponent1.x, y: slots.opponent1.y },
      opponent2: { x: slots.opponent2.x, y: slots.opponent2.y },
      partner: { x: slots.partner.x, y: slots.partner.y },
      self: { x: slots.self.x, y: slots.self.y },
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

    const scale = this.trickScale();
    // If no sprite provided, create one (for self-plays)
    if (!sprite) {
      const cardKey = getCardImageKey(card);
      sprite = scene.add.image(playPos.x, playPos.y, 'cards', cardKey);
      sprite.setScale(scale);
      sprite.setDepth(200);
    }

    // Store position key for resize handling
    sprite.setData('playPosition', positionKey);

    // Animate to position (only when asked: `animate && x || y` used to
    // tween a restored card whose y differed)
    if (animate && (sprite.x !== playPos.x || sprite.y !== playPos.y)) {
      sceneTween(scene, {
        targets: sprite,
        x: playPos.x,
        y: playPos.y,
        duration: ANIMATION_CONFIG.CARD_PLAY,
        ease: 'Power2',
        rotation: 0,
        scale,
        onComplete: () => {
          sprite.setDepth(200);
        },
      });
    } else {
      sprite.x = playPos.x;
      sprite.y = playPos.y;
      sprite.setDepth(200);
      sprite.setScale(scale);
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
   * @param {number} [resumeInMs] - trickComplete.resumeInMs (a hand's last
   *   trick only): the collect fits in half of the server's hold
   */
  completeTrick(winnerPosition, isMyTeam, resumeInMs) {
    const scene = this._scene;
    const duration = collectMs(resumeInMs);

    // Increment count and get position using new two-row layout
    let trickNumber;
    if (isMyTeam) {
      this._teamTrickCount++;
      trickNumber = this._teamTrickCount;
    } else {
      this._oppTrickCount++;
      trickNumber = this._oppTrickCount;
    }

    const winningPosition = this._getTrickPosition(trickNumber, isMyTeam);
    const stackScale = this.historyScale();

    // Copy trick cards for history
    const trickCards = [...this._currentTrick];

    // A visible collect gates the next play until its last tween lands
    const animated = this.isVisible() && trickCards.length > 0;
    let pending = animated ? trickCards.length : 0;
    const token = animated ? this._beginCollect(duration) : null;
    if (!animated) this._endCollect();

    // Animate cards to stack position
    trickCards.forEach((card, index) => {
      // Cancel play/flip animations still pending on the card (they would
      // replay after the tab becomes visible and pull it back mid-table)
      this._stopCardAnimations(card);

      // If not our team's trick, show card backs (unless spectating)
      if (!isMyTeam && !this._isSpectatorMode) {
        card.setTexture('cardBack');
      } else {
        this._applyFaceTexture(card);
      }

      if (this.isVisible()) {
        sceneTween(scene, {
          targets: card,
          x: winningPosition.x,
          y: winningPosition.y,
          scale: stackScale,
          rotation: 0,
          duration,
          ease: 'Power2',
          onComplete: () => {
            card.setDepth(200 + index);
            pending--;
            if (pending <= 0) this._endCollect(token);
          },
        });
      } else {
        card.x = winningPosition.x;
        card.y = winningPosition.y;
        card.setDepth(200 + index);
        card.setScale(stackScale);
        card.setRotation(0);
      }

      // Make interactive for hover
      card.setInteractive();
      card.originalDepth = 200 + index;
    });

    // Store in history with trick number for resize handling. The hover
    // reads the entry's position, which repositionTrickHistory updates in
    // place (a copy left the fan at the pre-resize spot)
    const entry = {
      cards: trickCards,
      position: { ...winningPosition },
      trickNumber,
    };
    (isMyTeam ? this._teamTrickHistory : this._oppTrickHistory).push(entry);
    this._setupTrickHover(trickCards, entry.position, token);

    // Clear current trick
    this._currentTrick = [];

    // Redraw backgrounds to expand container if needed
    if (this._backgroundGraphics) {
      this._drawBackgrounds();
    }
  }

  /**
   * Set up hover effects for a completed trick.
   */
  _setupTrickHover(trickCards, position, collectToken = null) {
    const scene = this._scene;

    // Move one card for the hover. Only the previous hover tween is stopped:
    // killTweensOf would also kill a collect or the hand-end whisk, whose
    // onComplete ends the collect / destroys the card and clears the table
    const moveTo = (card, x, y) => {
      card.getData?.('hoverTween')?.stop();
      card.setData?.('hoverTween', null);
      if (this.isVisible()) {
        const tween = sceneTween(scene, {
          targets: card,
          x,
          y,
          duration: 200,
          ease: 'Power1',
        });
        card.setData?.('hoverTween', tween);
      } else {
        card.x = x;
        card.y = y;
      }
    };

    // This stack's cards still flying to it (its own collect), or every
    // stack being whisked away: a hover tween would fight that flight.
    // Another trick's collect does not touch this stack, so it does not
    // block a fan or (more importantly) the reset when the pointer leaves
    const busy = () => this._animatingAway ||
      (collectToken !== null && this._collecting && this._collectToken === collectToken);

    const fanOut = () => {
      if (busy()) return;
      // Read at hover time: a relayout moves the stack (same object,
      // updated in place) and the fan's step with it (ui-6)
      const { fanDx, fanDy } = this.layout().history.team;
      trickCards.forEach((card, index) => {
        card.setDepth(250 + index);
        moveTo(card, position.x + index * fanDx, position.y - index * fanDy);
      });
    };

    const resetStack = () => {
      if (busy()) return;
      trickCards.forEach((card) => {
        card.setDepth(card.originalDepth);
        moveTo(card, position.x, position.y);
      });
    };

    trickCards.forEach((card) => {
      card.on('pointerover', fanOut);
      card.on('pointerout', resetStack);
    });
  }

  /**
   * Stop tweens and the pending flip timer on a trick sprite before it is
   * snapped or re-animated. Phaser pauses while the tab is hidden, so stale
   * tweens otherwise resume later from wherever the card was snapped to.
   */
  _stopCardAnimations(card) {
    if (!card) return;
    // killTweensOf only finds tweens the manager has activated; one added while
    // the loop is paused (hidden tab) is still queued, so stop the held handle
    const moveTween = card.getData?.('moveTween');
    if (moveTween) {
      moveTween.stop();
      card.setData('moveTween', null);
    }
    this._scene.tweens.killTweensOf(card);
    const flipTimer = card.getData?.('flipTimer');
    if (flipTimer) {
      flipTimer.remove(false);
      card.setData('flipTimer', null);
    }
  }

  /**
   * Show the card's face if a flip animation was cut short.
   */
  _applyFaceTexture(card) {
    const faceKey = card.getData?.('faceKey');
    if (faceKey) {
      card.setTexture('cards', faceKey);
    }
  }

  /**
   * Check if document is visible.
   */
  isVisible() {
    return document.visibilityState === 'visible';
  }

  /**
   * Create background graphics for trick display areas.
   * Shows dark containers with lighter slot boxes for all 13 trick positions.
   * @param {boolean} animate - Whether to animate the appearance (default true)
   */
  createTrickBackgrounds(animate = true) {
    // Destroy existing graphics if any
    if (this._backgroundGraphics) {
      this._backgroundGraphics.destroy();
    }

    this._backgroundGraphics = this._scene.add.graphics();
    this._backgroundGraphics.setDepth(50); // Below cards (200+)

    this._drawBackgrounds();

    // Animate in with fade and scale
    if (animate) {
      this._backgroundGraphics.setAlpha(0);
      this._backgroundGraphics.setScale(0.9);

      sceneTween(this._scene, {
        targets: this._backgroundGraphics,
        alpha: 1,
        scale: 1,
        duration: 200,
        ease: 'Power2',
      });
    }
  }

  /**
   * Draw background containers and slot boxes.
   * Container starts at team bid size and grows as more tricks are won.
   */
  _drawBackgrounds() {
    if (!this._backgroundGraphics) return;

    const graphics = this._backgroundGraphics;

    graphics.clear();

    // Slot size, spacing and padding all at the layout's one scale (ui-6)
    const { slotW, slotH, spacing, rowSpacing, pad: padding } = this.layout().history.team;

    // Draw both team and opponent areas
    [true, false].forEach((isTeamTrick) => {
      // Determine how many slots to show (start at team bid, expand as tricks are won)
      const tricksWon = isTeamTrick ? this._teamTrickCount : this._oppTrickCount;
      const bidTotal = isTeamTrick ? this._teamBidTotal : this._oppBidTotal;
      // Minimum 1 slot if bid is 0, otherwise use bid total
      const minSlots = Math.max(1, bidTotal);
      const slotsToShow = Math.max(minSlots, tricksWon);

      // Calculate row counts
      // Row 0 holds up to 7, row 1 holds the rest (up to 6)
      const row0Count = Math.min(slotsToShow, TRICKS_ROW_1);
      const row1Count = Math.max(0, slotsToShow - TRICKS_ROW_1);
      const needsSecondRow = row1Count > 0;

      // Get position of first card (trick 1) to anchor container
      const firstCardPos = this._getTrickPosition(1, isTeamTrick);

      // Container dimensions - tight fit around visible slots
      const containerWidth = (row0Count - 1) * spacing + slotW + padding * 2;
      const containerHeight = needsSecondRow
        ? slotH * 2 + rowSpacing - slotH + padding * 2
        : slotH + padding * 2;

      // Container X: left edge of first slot minus padding
      const containerX = firstCardPos.x - slotW / 2 - padding;

      // Container Y: top of row 0 minus padding
      const containerY = firstCardPos.y - slotH / 2 - padding;

      // Draw container background (rounded rectangle, same radius as slots)
      graphics.fillStyle(CONTAINER_COLOR, 1);
      graphics.fillRoundedRect(containerX, containerY, containerWidth, containerHeight, 4);

      // Draw border - red if tricks < bid, green if tricks >= bid
      const borderColor = tricksWon >= bidTotal ? BORDER_COLOR_SAFE : BORDER_COLOR_DANGER;
      graphics.lineStyle(BORDER_WIDTH, borderColor, 1);
      graphics.strokeRoundedRect(containerX, containerY, containerWidth, containerHeight, 4);

      // Draw slot boxes with tight vertical spacing
      graphics.fillStyle(SLOT_COLOR, 1);

      // Row 0: up to 7 slots (tricks 1-7)
      for (let col = 0; col < row0Count; col++) {
        const slotX = firstCardPos.x + col * spacing - slotW / 2;
        const slotY = firstCardPos.y - slotH / 2;
        graphics.fillRoundedRect(slotX, slotY, slotW, slotH, 4);
      }

      // Row 1: remaining slots (tricks 8-13, centered under row 0)
      if (needsSecondRow) {
        const row1Y = firstCardPos.y + rowSpacing - slotH / 2;
        const row1Offset = spacing / 2; // Center under row above
        for (let col = 0; col < row1Count; col++) {
          const slotX = firstCardPos.x + col * spacing + row1Offset - slotW / 2;
          const slotY = row1Y;
          graphics.fillRoundedRect(slotX, slotY, slotW, slotH, 4);
        }
      }
    });
  }

  /**
   * Reposition/redraw background graphics on resize.
   */
  repositionTrickBackgrounds() {
    this._drawBackgrounds();
  }

  /**
   * Reposition trick history cards during resize.
   */
  repositionTrickHistory() {
    // Cards being whisked away are not in the history (animateTricksAway
    // moved them out): snapping them would kill the tweens whose onComplete
    // destroys them and fires the hand-end callback

    // Reposition team trick history
    this._teamTrickHistory.forEach((trick, index) => {
      const trickNumber = trick.trickNumber || index + 1;
      const newPos = this._getTrickPosition(trickNumber, true);

      // Update stored position
      trick.position.x = newPos.x;
      trick.position.y = newPos.y;

      // Move all cards in this trick
      trick.cards.forEach((card) => {
        if (card && card.active) {
          this._snapToStack(card, newPos);
        }
      });
    });

    // Reposition opponent trick history
    this._oppTrickHistory.forEach((trick, index) => {
      const trickNumber = trick.trickNumber || index + 1;
      const newPos = this._getTrickPosition(trickNumber, false);

      // Update stored position
      trick.position.x = newPos.x;
      trick.position.y = newPos.y;

      // Move all cards in this trick
      trick.cards.forEach((card) => {
        if (card && card.active) {
          this._snapToStack(card, newPos);
        }
      });
    });
  }

  /**
   * Snap a trick-history card to its stack, cancelling any in-flight tween.
   */
  _snapToStack(card, pos) {
    // A snapped collect has landed
    this._endCollect();
    this._stopCardAnimations(card);
    card.x = pos.x;
    card.y = pos.y;
    card.setScale(this.historyScale());
    card.setRotation(0);
    if (card.originalDepth !== undefined) {
      card.setDepth(card.originalDepth);
    }
  }

  /**
   * Reposition current trick cards (for resize handling).
   */
  repositionCurrentTrick() {
    this.updatePlayPositions();
    const scale = this.trickScale();

    this._currentTrick.forEach((card) => {
      if (!card || !card.active) return;

      const positionKey = card.getData('playPosition');
      if (!positionKey || !this._playPositions[positionKey]) return;

      this._stopCardAnimations(card);
      this._applyFaceTexture(card);
      card.x = this._playPositions[positionKey].x;
      card.y = this._playPositions[positionKey].y;
      card.setScale(scale);
      card.setRotation(0);
      card.setDepth(200);
    });

    // Also reposition trick history and backgrounds
    this.repositionTrickHistory();
    this.repositionTrickBackgrounds();
  }

  /**
   * Clear current trick sprites.
   */
  clearCurrentTrick() {
    this._endCollect();
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
    this._endCollect();
    // The finished hand's cards still flying to the trump
    this._whisking.forEach((card) => card?.destroy?.());
    this._whisking = [];
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
    this._animatingAway = false;
  }

  /**
   * Clear background graphics.
   */
  clearBackgrounds() {
    if (this._backgroundGraphics) {
      this._backgroundGraphics.destroy();
      this._backgroundGraphics = null;
    }
  }

  /**
   * Clear all trick sprites and backgrounds.
   */
  clearAll() {
    this.clearCurrentTrick();
    this.clearTrickHistory();
    this.clearBackgrounds();
  }

  /**
   * Reset for new hand.
   */
  resetForNewHand() {
    this.clearAll();
    this._teamTrickCount = 0;
    this._oppTrickCount = 0;
    this._teamBidTotal = 0;
    this._oppBidTotal = 0;
  }

  /**
   * Animate all trick history cards to a target position, then destroy them.
   * Used at end of hand to whisk tricks back to trump card location.
   *
   * @param {number} targetX - Target X position
   * @param {number} targetY - Target Y position
   * @param {Function} onComplete - Callback when animation finishes
   */
  animateTricksAway(targetX, targetY, onComplete) {
    const scene = this._scene;

    // Group cards by trick number so both teams' same-numbered tricks animate together
    const cardsByTrickNumber = {};
    const collect = (trick) => {
      const num = trick.trickNumber;
      if (!cardsByTrickNumber[num]) cardsByTrickNumber[num] = [];
      trick.cards.forEach((card) => {
        if (card && card.active) cardsByTrickNumber[num].push(card);
      });
    };
    this._teamTrickHistory.forEach(collect);
    this._oppTrickHistory.forEach(collect);

    // The stacks leave the history now: they belong to the finished hand,
    // and the next hand's tricks start a fresh history even while these fly
    this._teamTrickHistory = [];
    this._oppTrickHistory = [];
    this._teamTrickCount = 0;
    this._oppTrickCount = 0;

    // Count total cards
    let totalCards = 0;
    Object.values(cardsByTrickNumber).forEach((cards) => {
      totalCards += cards.length;
    });

    if (totalCards === 0) {
      // No cards to animate, just clear and callback
      this.clearBackgrounds();
      if (onComplete) onComplete();
      return;
    }

    // Clear backgrounds immediately
    this.clearBackgrounds();
    this._animatingAway = true;

    // Animate cards staggered by trick number (both teams' trick N go together)
    let completedCount = 0;
    const trickNumbers = Object.keys(cardsByTrickNumber).map(Number).sort((a, b) => a - b);

    trickNumbers.forEach((trickNum, trickIndex) => {
      const cards = cardsByTrickNumber[trickNum];
      cards.forEach((card) => {
        // No more hover on a card that is leaving
        card.removeAllListeners?.('pointerover');
        card.removeAllListeners?.('pointerout');
        this._whisking.push(card);
        sceneTween(scene, {
          targets: card,
          x: targetX,
          y: targetY,
          alpha: 0,
          scale: this.historyScale() * 0.5,
          duration: 400,
          ease: 'Power2',
          delay: trickIndex * 30, // Stagger by trick number
          onComplete: () => {
            card.destroy();
            this._whisking = this._whisking.filter((c) => c !== card);
            completedCount++;

            // When all cards are done, callback
            if (completedCount === totalCards) {
              this._animatingAway = false;
              if (onComplete) onComplete();
            }
          },
        });
      });
    });
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
   * Restore trick history as card-back placeholders.
   * Used when a spectator (or reconnecting player) joins mid-hand and
   * the server only provides trick counts, not the actual cards.
   *
   * @param {number} teamTricks - Number of tricks won by team
   * @param {number} oppTricks - Number of tricks won by opponents
   */
  restoreTrickPlaceholders(teamTricks, oppTricks) {
    const scene = this._scene;

    for (let i = 1; i <= teamTricks; i++) {
      this._teamTrickCount++;
      const pos = this._getTrickPosition(i, true);
      const cards = this._createPlaceholderStack(scene, pos);
      const entry = { cards, position: { ...pos }, trickNumber: i };
      this._teamTrickHistory.push(entry);
      this._setupTrickHover(cards, entry.position);
    }

    for (let i = 1; i <= oppTricks; i++) {
      this._oppTrickCount++;
      const pos = this._getTrickPosition(i, false);
      const cards = this._createPlaceholderStack(scene, pos);
      const entry = { cards, position: { ...pos }, trickNumber: i };
      this._oppTrickHistory.push(entry);
      this._setupTrickHover(cards, entry.position);
    }

    if (this._backgroundGraphics) {
      this._drawBackgrounds();
    }
  }

  /**
   * Restore this hand's completed tricks with their real cards (a render
   * from the client's own model): my team's face up, the opponents' face
   * down unless spectating, exactly as completeTrick leaves them. A trick
   * whose cards are unknown (only a snapshot's count: cards null) is a
   * placeholder stack, as restoreTrickPlaceholders draws it.
   * @param {Array} history - [{winner, team, cards: [{position, card}] | null}]
   * @param {Function} isMyTeam - (trick) => boolean
   */
  restoreTrickHistory(history, isMyTeam) {
    const scene = this._scene;
    for (const trick of history || []) {
      const mine = isMyTeam(trick);
      const trickNumber = mine ? ++this._teamTrickCount : ++this._oppTrickCount;
      const pos = this._getTrickPosition(trickNumber, mine);
      const cards = !trick.cards ? this._createPlaceholderStack(scene, pos) : trick.cards.map((c, index) => {
        const faceUp = mine || this._isSpectatorMode;
        const sprite = faceUp
          ? scene.add.image(pos.x, pos.y, 'cards', getCardImageKey(c.card))
          : scene.add.image(pos.x, pos.y, 'cardBack');
        sprite.setData?.('faceKey', getCardImageKey(c.card));
        sprite.setScale(this.historyScale());
        sprite.setDepth(200 + index);
        sprite.setInteractive();
        sprite.originalDepth = 200 + index;
        return sprite;
      });
      const entry = { cards, position: { ...pos }, trickNumber };
      (mine ? this._teamTrickHistory : this._oppTrickHistory).push(entry);
      this._setupTrickHover(cards, entry.position);
    }
    if (this._backgroundGraphics) this._drawBackgrounds();
  }

  /** Sprite counts (render checks): current trick, team and opponent stacks. */
  spriteCounts() {
    const stacked = (h) => h.reduce((n, t) => n + t.cards.filter((c) => c && c.active !== false).length, 0);
    return {
      trick: this._currentTrick.length,
      teamStacks: this._teamTrickHistory.length,
      oppStacks: this._oppTrickHistory.length,
      stackCards: stacked(this._teamTrickHistory) + stacked(this._oppTrickHistory),
      whisking: this._whisking.filter((c) => c && c.active !== false).length,
    };
  }

  /**
   * Create a small stack of card-back sprites as a placeholder for a won trick.
   */
  _createPlaceholderStack(scene, pos) {
    const cards = [];
    for (let j = 0; j < 4; j++) {
      const sprite = scene.add.image(pos.x, pos.y, 'cardBack');
      sprite.setScale(this.historyScale());
      sprite.setDepth(200 + j);
      sprite.setInteractive();
      sprite.originalDepth = 200 + j;
      cards.push(sprite);
    }
    return cards;
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

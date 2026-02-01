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
 * Trick display layout constants.
 */
const TRICK_SCALE = 1.0; // 33% bigger than previous 0.75
const TRICKS_ROW_1 = 7; // Top row capacity
const TRICK_HORIZONTAL_SPACING = 120; // Base px between stacks (slot width + 10px gap)
const TRICK_ROW_SPACING = 86; // Base px between card rows (slotH + slotRowGap)
const TRICK_START_X = 70; // Left margin
const TEAM_BASE_Y = 95; // Offset from bottom for team row 1 center
const OPP_BASE_Y = 95; // Offset from top for opponent row 0 center
const SLOT_WIDTH = 54; // Slot width (tight fit around card)
const SLOT_HEIGHT = 76; // Slot height (tight fit around card)
const SLOT_PADDING = 4; // Tight padding inside container
const SLOT_ROW_GAP = 10; // Vertical gap between slot rows
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
   * Calculate position for a trick in the two-row layout.
   *
   * @param {number} trickNumber - Trick number (1-13)
   * @param {boolean} isTeamTrick - Whether this is for the player's team
   * @returns {Object} {x, y}
   */
  _getTrickPosition(trickNumber, isTeamTrick) {
    const { x: scaleX, y: scaleY, screenHeight } = this.getScaleFactors();

    // Calculate row and column
    // Tricks 1-7 go in row 0 (top row), tricks 8-13 go in row 1 (bottom row)
    const row = trickNumber <= TRICKS_ROW_1 ? 0 : 1;
    const col = trickNumber <= TRICKS_ROW_1 ? trickNumber - 1 : trickNumber - TRICKS_ROW_1 - 1;

    // Scale spacing with screen size
    const spacing = (SLOT_WIDTH + 10) * scaleX;

    // Starting x position with margin
    // Row 1 (6 tricks) is centered under row 0 (7 tricks) - offset by half spacing
    const rowOffset = row === 1 ? spacing / 2 : 0;
    const x = TRICK_START_X * scaleX + col * spacing + rowOffset;

    let y;
    if (isTeamTrick) {
      // Team tricks at bottom left
      const baseY = screenHeight - TEAM_BASE_Y * scaleY;
      // Row 0 (tricks 1-7) is ABOVE row 1 (smaller y value)
      y = baseY - (1 - row) * TRICK_ROW_SPACING * scaleY;
    } else {
      // Opponent tricks at top left
      const baseY = OPP_BASE_Y * scaleY;
      // Row 0 at top, row 1 below it
      y = baseY + row * TRICK_ROW_SPACING * scaleY;
    }

    return { x, y };
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
          scale: TRICK_SCALE,
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
        card.setScale(TRICK_SCALE);
      }

      // Make interactive for hover
      card.setInteractive();
      card.originalDepth = 200 + index;
    });

    // Store in history with trick number for resize handling
    if (isMyTeam) {
      this._teamTrickHistory.push({
        cards: trickCards,
        position: { ...winningPosition },
        trickNumber,
      });

      // Add hover effects for team tricks
      this._setupTrickHover(trickCards, winningPosition);
    } else {
      this._oppTrickHistory.push({
        cards: trickCards,
        position: { ...winningPosition },
        trickNumber,
      });
    }

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
  _setupTrickHover(trickCards, position) {
    const scene = this._scene;
    const { x: scaleX, y: scaleY } = this.getScaleFactors();

    const fanOut = () => {
      trickCards.forEach((card, index) => {
        card.setDepth(250 + index);
        if (this.isVisible()) {
          scene.tweens.add({
            targets: card,
            x: position.x + index * 30 * scaleX,
            y: position.y - index * 8 * scaleY,
            duration: 200,
            ease: 'Power1',
          });
        } else {
          card.x = position.x + index * 30 * scaleX;
          card.y = position.y - index * 8 * scaleY;
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

      this._scene.tweens.add({
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

    const { x: scaleX, y: scaleY } = this.getScaleFactors();
    const graphics = this._backgroundGraphics;

    graphics.clear();

    // Fixed slot dimensions (match the fixed card scale)
    const slotW = SLOT_WIDTH;
    const slotH = SLOT_HEIGHT;
    // Scaled spacing to match _getTrickPosition calculations
    const spacing = (SLOT_WIDTH + 10) * scaleX;
    const rowSpacing = TRICK_ROW_SPACING * scaleY;
    const padding = SLOT_PADDING;

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
          card.x = newPos.x;
          card.y = newPos.y;
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
          card.x = newPos.x;
          card.y = newPos.y;
        }
      });
    });
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

    // Also reposition trick history and backgrounds
    this.repositionTrickHistory();
    this.repositionTrickBackgrounds();
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

    this._teamTrickHistory.forEach((trick) => {
      const num = trick.trickNumber;
      if (!cardsByTrickNumber[num]) cardsByTrickNumber[num] = [];
      trick.cards.forEach((card) => {
        if (card && card.active) {
          cardsByTrickNumber[num].push(card);
        }
      });
    });

    this._oppTrickHistory.forEach((trick) => {
      const num = trick.trickNumber;
      if (!cardsByTrickNumber[num]) cardsByTrickNumber[num] = [];
      trick.cards.forEach((card) => {
        if (card && card.active) {
          cardsByTrickNumber[num].push(card);
        }
      });
    });

    // Count total cards
    let totalCards = 0;
    Object.values(cardsByTrickNumber).forEach((cards) => {
      totalCards += cards.length;
    });

    if (totalCards === 0) {
      // No cards to animate, just clear and callback
      this.clearTrickHistory();
      this.clearBackgrounds();
      if (onComplete) onComplete();
      return;
    }

    // Clear backgrounds immediately
    this.clearBackgrounds();

    // Animate cards staggered by trick number (both teams' trick N go together)
    let completedCount = 0;
    const trickNumbers = Object.keys(cardsByTrickNumber).map(Number).sort((a, b) => a - b);

    trickNumbers.forEach((trickNum, trickIndex) => {
      const cards = cardsByTrickNumber[trickNum];
      cards.forEach((card) => {
        scene.tweens.add({
          targets: card,
          x: targetX,
          y: targetY,
          alpha: 0,
          scale: 0.5,
          duration: 400,
          ease: 'Power2',
          delay: trickIndex * 30, // Stagger by trick number
          onComplete: () => {
            card.destroy();
            completedCount++;

            // When all cards are done, clear history and callback
            if (completedCount === totalCards) {
              this._teamTrickHistory = [];
              this._oppTrickHistory = [];
              this._teamTrickCount = 0;
              this._oppTrickCount = 0;
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

/**
 * BidManager - Handles the bidding phase UI and animations.
 *
 * Manages bid buttons, bore button states, and bid bubbles
 * displayed next to players.
 */

import { getGameState } from '../../state/GameState.js';
import { getSocketManager } from '../../socket/SocketManager.js';

// Base design dimensions for scaling
const BASE_WIDTH = 1920;
const BASE_HEIGHT = 953;

export class BidManager {
  constructor(scene) {
    this.scene = scene;
    this.state = getGameState();

    // DOM elements
    this.bidContainer = null;

    // Bore button references (for updating states)
    this.boreButtons = {};

    // All bid buttons for selection highlighting
    this.allBidButtons = [];

    // Currently selected bid
    this.selectedBid = null;
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
   * Show the bid UI.
   * @param {number} handSize - Number of cards in hand (max bid)
   * @param {Function} onBidSelect - Callback when a bid is selected
   */
  showBidUI(handSize, onBidSelect) {
    // Remove existing if any (no animation since we're replacing it)
    this.hideBidUI(false);

    const { screenWidth, screenHeight } = this.getScaleFactors();
    const position = this.state.position;
    const currentTurn = this.state.currentTurn;

    // Create container
    this.bidContainer = document.createElement('div');
    this.bidContainer.id = 'bidContainer';
    this.bidContainer.classList.add('ui-element', 'bid-grid');
    this.bidContainer.style.position = 'fixed';
    this.bidContainer.style.zIndex = '1000';
    this.bidContainer.style.flexDirection = 'column';
    this.bidContainer.style.alignItems = 'center';
    this.bidContainer.style.gap = '8px';
    this.bidContainer.style.padding = '12px';
    this.bidContainer.style.background = 'rgba(0, 0, 0, 0.85)';
    this.bidContainer.style.border = '2px solid #444';
    this.bidContainer.style.borderRadius = '8px';
    this.bidContainer.style.left = `${screenWidth / 2}px`;
    this.bidContainer.style.top = `${screenHeight / 2}px`;
    this.bidContainer.style.transform = 'translate(-50%, -50%) scale(0.9)';
    this.bidContainer.style.opacity = '0';
    this.bidContainer.style.transition = 'opacity 150ms ease-out, transform 150ms ease-out';
    this.bidContainer.style.display = 'flex';
    this.bidContainer.style.visibility = 'hidden';

    document.body.appendChild(this.bidContainer);

    // Animate in if it's our turn
    if (this.state.isBidding && currentTurn === position) {
      // Use requestAnimationFrame to ensure the initial styles are applied first
      requestAnimationFrame(() => {
        this.bidContainer.style.visibility = 'visible';
        this.bidContainer.style.opacity = '1';
        this.bidContainer.style.transform = 'translate(-50%, -50%) scale(1)';
      });
    }

    // Header
    const header = document.createElement('div');
    header.style.color = '#ffd700';
    header.style.fontSize = '18px';
    header.style.fontWeight = 'bold';
    header.style.textAlign = 'center';
    header.style.marginBottom = '4px';
    header.innerText = 'Your Bid:';
    this.bidContainer.appendChild(header);

    // Reset selection tracking
    this.allBidButtons = [];
    this.selectedBid = null;
    this.boreButtons = {};

    // Numeric row (0 to handSize)
    const numericRow = document.createElement('div');
    numericRow.style.display = 'grid';
    numericRow.style.gridTemplateColumns = 'repeat(4, 1fr)';
    numericRow.style.gap = '4px';

    for (let i = 0; i <= handSize; i++) {
      const btn = this.createBidButton(i.toString(), () => {
        if (this.state.currentTurn !== this.state.position || !this.state.isBidding) {
          console.warn('Not your turn to bid.');
          return;
        }
        this.selectButton(btn, i.toString());
        onBidSelect(i.toString());
      });
      this.allBidButtons.push(btn);
      numericRow.appendChild(btn);
    }
    this.bidContainer.appendChild(numericRow);

    // Bore row (B, 2B, 3B, 4B)
    const boreRow = document.createElement('div');
    boreRow.style.display = 'flex';
    boreRow.style.gap = '4px';
    boreRow.style.justifyContent = 'center';

    const boreBids = ['B', '2B', '3B', '4B'];
    boreBids.forEach((bid) => {
      const btn = this.createBidButton(bid, () => {
        if (btn.disabled) return;
        if (this.state.currentTurn !== this.state.position || !this.state.isBidding) {
          console.warn('Not your turn to bid.');
          return;
        }
        this.selectButton(btn, bid);
        onBidSelect(bid);
      }, true);
      btn.dataset.bid = bid;
      this.boreButtons[bid] = btn;
      this.allBidButtons.push(btn);
      boreRow.appendChild(btn);
    });
    this.bidContainer.appendChild(boreRow);

    // Update bore button states
    this.updateBoreButtonStates();

    console.log('✅ BidManager: Bid UI created');
  }

  /**
   * Create a bid button element.
   */
  createBidButton(label, onClick, isBore = false) {
    const btn = document.createElement('button');
    btn.classList.add('bid-button');
    if (isBore) btn.classList.add('bore-button');
    btn.innerText = label;
    btn.style.minWidth = isBore ? '50px' : '40px';
    btn.style.minHeight = '40px';
    btn.style.padding = isBore ? '8px 12px' : '8px';
    btn.style.fontSize = '16px';
    btn.style.fontWeight = 'bold';
    btn.style.border = 'none';
    btn.style.borderRadius = '4px';
    btn.style.background = isBore ? '#c53030' : '#4a5568';
    btn.style.color = 'white';
    btn.style.cursor = 'pointer';

    btn.addEventListener('mouseenter', () => {
      if (this.selectedBid !== label && !btn.disabled) {
        btn.style.background = isBore ? '#9b2c2c' : '#2d3748';
      }
    });
    btn.addEventListener('mouseleave', () => {
      if (this.selectedBid !== label && !btn.disabled) {
        btn.style.background = isBore ? '#c53030' : '#4a5568';
      }
    });
    btn.addEventListener('click', onClick);

    return btn;
  }

  /**
   * Highlight the selected button.
   */
  selectButton(btn, bidValue) {
    // Remove highlight from all buttons
    this.allBidButtons.forEach(b => {
      if (b.classList.contains('bore-button')) {
        b.style.background = b.disabled ? '#666' : '#c53030';
        b.style.border = 'none';
      } else {
        b.style.background = '#4a5568';
        b.style.border = 'none';
      }
    });

    // Highlight selected button
    btn.style.background = '#38a169';
    btn.style.border = '2px solid #68d391';
    this.selectedBid = bidValue;
  }

  /**
   * Update bore button enabled/disabled states based on bid history.
   */
  updateBoreButtonStates() {
    const tempBids = this.state.tempBids;

    const hasBore = tempBids.includes('B');
    const has2B = tempBids.includes('2B');
    const has3B = tempBids.includes('3B');
    const has4B = tempBids.includes('4B');

    // Disable bore buttons based on progression
    if (this.boreButtons['B']) {
      this.boreButtons['B'].disabled = hasBore;
    }
    if (this.boreButtons['2B']) {
      this.boreButtons['2B'].disabled = !hasBore || has2B;
    }
    if (this.boreButtons['3B']) {
      this.boreButtons['3B'].disabled = !has2B || has3B;
    }
    if (this.boreButtons['4B']) {
      this.boreButtons['4B'].disabled = !has3B || has4B;
    }

    // Update visual styles for disabled buttons
    Object.values(this.boreButtons).forEach(btn => {
      if (btn.disabled) {
        btn.style.opacity = '0.4';
        btn.style.cursor = 'not-allowed';
        btn.style.background = '#666';
      } else {
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        btn.style.background = '#c53030';
      }
    });
  }

  /**
   * Update bid UI visibility based on whose turn it is.
   */
  updateVisibility() {
    if (!this.bidContainer) return;

    const position = this.state.position;
    const currentTurn = this.state.currentTurn;

    if (this.state.isBidding && currentTurn === position && !this.state.isLazy) {
      // Animate in
      this.bidContainer.style.visibility = 'visible';
      this.bidContainer.style.opacity = '1';
      this.bidContainer.style.transform = 'translate(-50%, -50%) scale(1)';
    } else {
      // Animate out
      this.bidContainer.style.opacity = '0';
      this.bidContainer.style.transform = 'translate(-50%, -50%) scale(0.9)';
      // Hide after transition completes
      setTimeout(() => {
        if (this.bidContainer && this.bidContainer.style.opacity === '0') {
          this.bidContainer.style.visibility = 'hidden';
        }
      }, 150);
    }
  }

  /**
   * Hide and remove the bid UI.
   * @param {boolean} animate - Whether to animate out (default true)
   */
  hideBidUI(animate = true) {
    if (this.bidContainer) {
      if (animate) {
        // Animate out, then remove
        this.bidContainer.style.opacity = '0';
        this.bidContainer.style.transform = 'translate(-50%, -50%) scale(0.9)';
        const container = this.bidContainer;
        setTimeout(() => {
          if (container && container.parentNode) {
            container.remove();
          }
        }, 150);
      } else {
        this.bidContainer.remove();
      }
      this.bidContainer = null;
    }
    this.boreButtons = {};
    this.allBidButtons = [];
    this.selectedBid = null;
  }

  /**
   * Show a bid bubble near a player position.
   * @param {string} positionKey - 'opp1', 'opp2', 'partner', 'me'
   * @param {string} bid - The bid value
   */
  showBidBubble(positionKey, bid) {
    // Use the scene's chat bubble method
    if (this.scene.showChatBubble) {
      this.scene.showChatBubble(positionKey, bid, '#FF0000', 5000);
    }
  }

  /**
   * Clean up bid manager resources.
   */
  cleanup() {
    this.hideBidUI();
  }
}

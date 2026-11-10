/**
 * BidManager - Handles the bidding phase UI and animations.
 *
 * Manages bid buttons, bore button states, and bid bubbles
 * displayed next to players.
 */

import { getGameState } from '../../state/GameState.js';
import { getSocketManager } from '../../socket/SocketManager.js';
import { getHud } from '../../ui/tableHud.js';
import { BID_SHEET, BID_CHIP } from '../layout/computeTableLayout.js';

/**
 * The sheet's transform: centred on its layout slot, at the layout's bid
 * scale (--bid-scale on the HUD), times `k` for the pop-in.
 */
const sheetTransform = (k) => `translate(-50%, -50%) scale(calc(var(--bid-scale, 1) * ${k}))`;

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

    // Trick indicator
    this.trickIndicators = [];
    this.indicatorRow = null;
    this.handSize = 0;
  }

  /**
   * Show the bid UI.
   * @param {number} handSize - Number of cards in hand (max bid)
   * @param {Function} onBidSelect - Callback when a bid is selected
   */
  showBidUI(handSize, onBidSelect) {
    // Remove existing if any (no animation since we're replacing it)
    this.hideBidUI(false);

    const position = this.state.position;
    const currentTurn = this.state.currentTurn;

    // Create container
    this.bidContainer = document.createElement('div');
    this.bidContainer.id = 'bidContainer';
    this.bidContainer.classList.add('ui-element', 'bid-grid');
    // The HUD's bid slot places it (absolute, from the layout); without a
    // table container it stays centred on the page
    const hud = getHud();
    if (!hud) {
      this.bidContainer.style.position = 'fixed';
      this.bidContainer.style.left = '50%';
      this.bidContainer.style.top = '50%';
    }
    this.bidContainer.style.zIndex = '1000';
    this.bidContainer.style.flexDirection = 'column';
    this.bidContainer.style.alignItems = 'center';
    this.bidContainer.style.gap = '8px';
    this.bidContainer.style.padding = '12px';
    // the layout's sheet width (BID_SHEET: the bid slot and the overlap
    // check model this box), border included
    this.bidContainer.style.width = `${BID_SHEET.w}px`;
    this.bidContainer.style.boxSizing = 'border-box';
    this.bidContainer.style.background = 'rgba(0, 0, 0, 0.85)';
    this.bidContainer.style.border = '2px solid #444';
    this.bidContainer.style.borderRadius = '8px';
    this.bidContainer.style.transform = sheetTransform(0.9);
    this.bidContainer.style.opacity = '0';
    this.bidContainer.style.transition = 'opacity 150ms ease-out, transform 150ms ease-out';
    this.bidContainer.style.display = 'flex';
    this.bidContainer.style.visibility = 'hidden';

    (hud || document.body).appendChild(this.bidContainer);

    // Animate in if it's our turn
    if (this.state.isBidding && currentTurn === position) {
      // Use requestAnimationFrame to ensure the initial styles are applied first
      // (the panel may be gone or replaced by then: a doneBidding, a render).
      // A timer too: a hidden tab runs no animation frames, and the panel
      // must be there for my turn when the tab comes back
      const container = this.bidContainer;
      const reveal = () => {
        if (this.bidContainer !== container) return;
        if (!this.state.isBidding || this.state.currentTurn !== this.state.position || this.state.isLazy) return;
        container.style.visibility = 'visible';
        container.style.opacity = '1';
        container.style.transform = sheetTransform(1);
      };
      requestAnimationFrame(reveal);
      setTimeout(reveal, 50);
    }

    // Header
    const header = document.createElement('div');
    header.style.color = '#ffd700';
    header.style.fontSize = '18px';
    header.style.fontWeight = 'bold';
    header.style.textAlign = 'center';
    header.style.marginBottom = '4px';
    header.innerText = 'Bid!';
    this.bidContainer.appendChild(header);

    // Trick indicator
    this.handSize = handSize;
    this.indicatorRow = document.createElement('div');
    this.indicatorRow.style.display = 'flex';
    this.indicatorRow.style.gap = `${BID_CHIP.gap}px`;
    // the sheet's width, not its chips': an overbid's chips shrink to fit
    // instead of sticking out past the sheet
    this.indicatorRow.style.alignSelf = 'stretch';
    this.indicatorRow.style.minWidth = '0';
    this.indicatorRow.style.justifyContent = 'center';
    this.indicatorRow.style.marginBottom = '4px';
    this.trickIndicators = [];
    for (let i = 0; i < handSize; i++) {
      const rect = this.createIndicatorRect();
      this.trickIndicators.push(rect);
      this.indicatorRow.appendChild(rect);
    }
    this.bidContainer.appendChild(this.indicatorRow);
    this.updateTrickIndicator();

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

    this.updateTrickIndicator();
  }

  /**
   * Create a single indicator rectangle element.
   */
  createIndicatorRect() {
    const rect = document.createElement('div');
    rect.style.width = `${BID_CHIP.w}px`;
    rect.style.flex = `0 1 ${BID_CHIP.w}px`;
    rect.style.minWidth = '0';
    rect.style.height = '26px';
    rect.style.borderRadius = '3px';
    rect.style.background = '#555';
    rect.style.transition = 'background 150ms ease';
    rect.style.boxSizing = 'border-box';
    return rect;
  }

  /**
   * Update trick indicator colors based on current bids.
   * Adds extra pulsing rectangles for overbids (capped at 16 total).
   */
  updateTrickIndicator() {
    if (!this.indicatorRow) return;

    const bids = this.state.bids;
    const myTeam = this.state.position % 2;

    let teamBidCount = 0;
    let oppBidCount = 0;

    for (const [pos, bid] of Object.entries(bids)) {
      const bidStr = String(bid).toUpperCase();
      if (['B', '2B', '3B', '4B'].includes(bidStr)) continue;
      const numBid = parseInt(bidStr, 10);
      if (isNaN(numBid)) continue;

      if (Number(pos) % 2 === myTeam) {
        teamBidCount += numBid;
      } else {
        oppBidCount += numBid;
      }
    }

    const totalBid = teamBidCount + oppBidCount;
    const totalNeeded = Math.min(Math.max(totalBid, this.handSize), 16);

    // Add or remove extra rectangles to match totalNeeded
    while (this.trickIndicators.length < totalNeeded) {
      const rect = this.createIndicatorRect();
      this.trickIndicators.push(rect);
      this.indicatorRow.appendChild(rect);
    }
    while (this.trickIndicators.length > totalNeeded) {
      const rect = this.trickIndicators.pop();
      rect.remove();
    }

    // Color the rectangles
    for (let i = 0; i < this.trickIndicators.length; i++) {
      const rect = this.trickIndicators[i];
      const isOverbid = i >= this.handSize;

      if (i < teamBidCount) {
        rect.style.background = '#68d391';
      } else if (i < totalBid) {
        rect.style.background = '#fc8181';
      } else {
        rect.style.background = '#555';
      }

      if (isOverbid) {
        rect.style.animation = 'trickOverbidPulse 1s ease-in-out infinite';
      } else {
        rect.style.animation = '';
        rect.style.outline = '';
      }
    }
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
      this.bidContainer.style.transform = sheetTransform(1);
    } else {
      // Animate out
      this.bidContainer.style.opacity = '0';
      this.bidContainer.style.transform = sheetTransform(0.9);
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
        this.bidContainer.style.transform = sheetTransform(0.9);
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
    this.trickIndicators = [];
    this.indicatorRow = null;
    this.handSize = 0;
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

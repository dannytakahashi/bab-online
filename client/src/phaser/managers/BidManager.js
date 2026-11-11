/**
 * BidManager - Handles the bidding phase UI and animations.
 *
 * Manages bid buttons, bore button states, and bid bubbles
 * displayed next to players.
 *
 * The sheet is a kit panel (table.css .bid-sheet, item 18a): chip-style
 * numbers, the bores as a segmented control, the trick chips above them.
 * Its look, hover and pop-in are CSS (classes and motion tokens); the only
 * values set here are the layout's box model (BID_SHEET, BID_CHIP) as CSS
 * variables, so the sheet the overlap check models is the one drawn.
 */

import { getGameState } from '../../state/GameState.js';
import { getHud } from '../../ui/tableHud.js';
import { motionMs } from '../../ui/motion.js';
import { BID_SHEET, BID_CHIP, BID_SHEET_PAD, BID_SHEET_BORDER } from '../layout/computeTableLayout.js';

const BORES = ['B', '2B', '3B', '4B'];

/** The layout's sheet box model on the sheet (CSS variables). */
function applySheetModel(sheet) {
  sheet.style.setProperty('--bid-sheet-w', `${BID_SHEET.w}px`);
  sheet.style.setProperty('--bid-sheet-pad', `${BID_SHEET_PAD}px`);
  sheet.style.setProperty('--bid-sheet-border', `${BID_SHEET_BORDER}px`);
  sheet.style.setProperty('--bid-chip-w', `${BID_CHIP.w}px`);
  sheet.style.setProperty('--bid-chip-gap', `${BID_CHIP.gap}px`);
}

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

  /** Is it my turn to bid (the sheet shows)? */
  _myTurn() {
    return this.state.isBidding && this.state.currentTurn === this.state.position && !this.state.isLazy;
  }

  /**
   * Show the bid UI.
   * @param {number} handSize - Number of cards in hand (max bid)
   * @param {Function} onBidSelect - Callback when a bid is selected
   */
  showBidUI(handSize, onBidSelect) {
    // Remove existing if any (no animation since we're replacing it)
    this.hideBidUI(false);

    // Create container: the HUD's bid slot places it (absolute, from the
    // layout); without a table container it stays centred on the page
    this.bidContainer = document.createElement('div');
    this.bidContainer.id = 'bidContainer';
    this.bidContainer.className = 'ui-element bid-grid bid-sheet';
    this.bidContainer.setAttribute('role', 'group');
    this.bidContainer.setAttribute('aria-label', 'Your bid');
    applySheetModel(this.bidContainer);
    (getHud() || document.body).appendChild(this.bidContainer);

    // Pop in if it's our turn (the class's CSS transition). A frame first,
    // so the closed state is applied; a timer too: a hidden tab runs no
    // animation frames, and the panel must be there for my turn when the
    // tab comes back. The panel may be gone or replaced by then.
    if (this._myTurn()) {
      const container = this.bidContainer;
      const reveal = () => {
        if (this.bidContainer !== container || !this._myTurn()) return;
        container.classList.add('is-open');
      };
      requestAnimationFrame(reveal);
      setTimeout(reveal, 50);
    }

    // Header
    const header = document.createElement('div');
    header.className = 'bid-sheet__title';
    header.textContent = 'Bid!';
    this.bidContainer.appendChild(header);

    // Trick indicator: one chip per trick (the sheet's width: an overbid's
    // chips shrink to fit instead of sticking out past the sheet)
    this.handSize = handSize;
    this.indicatorRow = document.createElement('div');
    this.indicatorRow.className = 'bid-chips';
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
    numericRow.className = 'bid-numbers';
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

    // Bore row (B, 2B, 3B, 4B): a segmented control
    const boreRow = document.createElement('div');
    boreRow.className = 'bid-bores';
    boreRow.setAttribute('role', 'group');
    boreRow.setAttribute('aria-label', 'Bores');
    BORES.forEach((bid) => {
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
   * Create a bid button element (hover, focus and disabled are CSS).
   */
  createBidButton(label, onClick, isBore = false) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = isBore ? 'bid-button bore-button' : 'bid-button';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * Highlight the selected button.
   */
  selectButton(btn, bidValue) {
    this.allBidButtons.forEach((b) => {
      b.classList.remove('is-selected');
      b.removeAttribute('aria-pressed');
    });
    btn.classList.add('is-selected');
    btn.setAttribute('aria-pressed', 'true');
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

    // Disable bore buttons based on progression (the look is :disabled)
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

    this.updateTrickIndicator();
  }

  /**
   * Create a single indicator chip (sized by --bid-chip-w; it may shrink).
   */
  createIndicatorRect() {
    const rect = document.createElement('div');
    rect.className = 'bid-chip';
    return rect;
  }

  /**
   * Update trick indicator colors based on current bids.
   * Adds extra outlined chips for overbids (capped at 16 total).
   */
  updateTrickIndicator() {
    if (!this.indicatorRow) return;

    const bids = this.state.bids;
    const myTeam = this.state.position % 2;

    let teamBidCount = 0;
    let oppBidCount = 0;

    for (const [pos, bid] of Object.entries(bids)) {
      const bidStr = String(bid).toUpperCase();
      if (BORES.includes(bidStr)) continue;
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

    // Color the chips by absolute team (team A: positions 1 and 3), as the
    // seat rings and the log's score are; past the hand size an overbid
    const mine = myTeam === 1 ? 'a' : 'b';
    const theirs = mine === 'a' ? 'b' : 'a';
    for (let i = 0; i < this.trickIndicators.length; i++) {
      const rect = this.trickIndicators[i];
      const isTeam = i < teamBidCount;
      const isOpp = i >= teamBidCount && i < totalBid;
      rect.classList.toggle('is-team', isTeam);
      rect.classList.toggle('is-opp', isOpp);
      rect.classList.toggle('is-team-a', (isTeam && mine === 'a') || (isOpp && theirs === 'a'));
      rect.classList.toggle('is-team-b', (isTeam && mine === 'b') || (isOpp && theirs === 'b'));
      rect.classList.toggle('is-overbid', i >= this.handSize);
    }
  }

  /**
   * Update bid UI visibility based on whose turn it is.
   */
  updateVisibility() {
    if (!this.bidContainer) return;
    // the class's transition pops it in or out (visibility follows the fade)
    this.bidContainer.classList.toggle('is-open', this._myTurn());
  }

  /**
   * Hide and remove the bid UI.
   * @param {boolean} animate - Whether to animate out (default true)
   */
  hideBidUI(animate = true) {
    if (this.bidContainer) {
      const container = this.bidContainer;
      container.classList.remove('is-open');
      const ms = animate ? motionMs('fast') : 0;
      if (ms > 0) {
        setTimeout(() => container.remove(), ms);
      } else {
        container.remove();
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
      this.scene.showChatBubble(positionKey, bid, 'bid', 5000);
    }
  }

  /**
   * Clean up bid manager resources.
   */
  cleanup() {
    this.hideBidUI();
  }
}

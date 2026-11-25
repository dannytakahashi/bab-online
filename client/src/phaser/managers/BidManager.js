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
 *
 * The bid clock's countdown (owner 2026-11-18; state/bidClock.js): once the
 * server's clock runs for MY bid turn, the title row shows the whole
 * seconds left, on the right of "Bid!" (absolutely placed: the sheet's box
 * does not change), in the warning colour for the last BID_CLOCK_LOW_S. It
 * counts to deadline - BID_CLOCK_UI_MARGIN_MS; at 0 it goes and the bid is
 * no longer offered (the sheet is marked expired: the server bids 0 for me
 * next; BID_CLOCK_EXPIRED_GRACE_MS later with no word it is offered again).
 * Shown only for the bidder (a seat that acts: not a spectator, not lazy),
 * on my bid turn with no bid of mine made or pending. Screen readers hear
 * it once when it appears and once at 10 s (the number itself is not live).
 *
 * Read-only (owner 2026-11-21, the over-the-shoulder view): a watcher sees
 * the watched seat's sheet on that seat's bid turn, where a player's goes
 * (`showBidUI(n, null, {readOnly: true, owner})`): titled "Alice is
 * bidding" (its group label too), the same legal choices from public state
 * (hand size, the bores so far) as static text (spans: nothing focusable,
 * nothing clickable, no listener, never a selection; `.bid-sheet--readonly`
 * lets no pointer through), the trick chips, the mirrored hint's ring and
 * that seat's countdown (aria-label "Alice: N seconds to bid", never
 * announced). Nothing is ever sent from it; the player's own in-progress
 * selection is not on the wire and is not shown.
 *
 * Get Your Bid (owner 2026-11-24; GameState.isSolo): no bores row, and the
 * last bidder's Forbidden Bid (rules/bids.js gybForbidden: the number that
 * would make the three bids add up to a hand of 5 or more cards) is on the
 * sheet but cannot be bid: its button is disabled, struck through and
 * marked with the no-entry sign (`.bid-button.is-forbidden`, named
 * "N, the Forbidden Bid" for a screen reader), and a line under the title
 * says "Forbidden Bid: N" (`.bid-sheet__forbidden`; it keeps its height
 * while empty, so the sheet never jumps). The trick chips are coloured by
 * seat (three colours), mine first.
 */

import { getGameState } from '../../state/GameState.js';
import { getHud } from '../../ui/tableHud.js';
import { motionMs } from '../../ui/motion.js';
import { BID_SHEET, BID_CHIP, BID_SHEET_PAD, BID_SHEET_BORDER } from '../layout/computeTableLayout.js';
import { BORES, bidTotalsFor, bidTricks } from '../../rules/bids.js';
import { seatsAround, seatLetter } from '../../utils/positions.js';
import { getMyAction } from '../../state/MyAction.js';
import { NOTICE } from '../../state/noticeText.js';
import { showNotice } from '../../ui/components/Toast.js';
import { announce } from '../../ui/handA11y.js';
import { isShoulder } from '../../state/shoulder.js';
import {
  bidClockNow, countdownMs, secondsToBid, sameClock, BID_CLOCK_LOW_S, BID_CLOCK_EXPIRED_GRACE_MS,
} from '../../state/bidClock.js';

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
    // A watcher's read-only sheet of the watched seat (showBidUI readOnly)
    this.readOnly = false;
    this.owner = null;
    // The /help suggestion (setSuggestedBid)
    this.suggestedBid = null;

    // Trick indicator
    this.trickIndicators = [];
    this.indicatorRow = null;
    this.handSize = 0;

    // The bid clock's countdown (syncClock)
    this.titleRow = null;
    this.clockEl = null;
    this._clockTimer = null;
    this._clockSeen = null; // {position, deadline} of the clock last shown (sameClock)
    this._clockSaid = new Set();
    this.expired = false;
  }

  /** Is it my turn to bid (the sheet shows)? */
  _myTurn() {
    return this.state.isBidding && this.state.currentTurn === this.state.position && !this.state.isLazy;
  }

  /**
   * Show the bid UI.
   * @param {number} handSize - Number of cards in hand (max bid)
   * @param {Function} onBidSelect - Callback when a bid is selected (unused read-only)
   * @param {Object} [opts]
   * @param {boolean} [opts.readOnly] - the watched seat's sheet (the over-the-shoulder view)
   * @param {string} [opts.owner] - the watched player's name
   */
  showBidUI(handSize, onBidSelect, { readOnly = false, owner = null } = {}) {
    // Remove existing if any (no animation since we're replacing it)
    this.hideBidUI(false);
    this.readOnly = !!readOnly;
    this.owner = readOnly ? owner || '' : null;

    // Create container: the HUD's bid slot places it (absolute, from the
    // layout); without a table container it stays centred on the page
    this.bidContainer = document.createElement('div');
    this.bidContainer.id = 'bidContainer';
    this.bidContainer.className = 'ui-element bid-grid bid-sheet';
    this.bidContainer.setAttribute('role', 'group');
    this.bidContainer.setAttribute('aria-label', this.readOnly ? `${this.owner} is bidding` : 'Your bid');
    if (this.readOnly) this.bidContainer.classList.add('bid-sheet--readonly');
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

    // Header (the bid clock's countdown joins it on the right: syncClock)
    const header = document.createElement('div');
    header.className = 'bid-sheet__title';
    header.textContent = this.readOnly ? `${this.owner} is bidding` : 'Bid!';
    this.bidContainer.appendChild(header);
    this.titleRow = header;

    // Get Your Bid: the Forbidden Bid's line (empty until it applies)
    this.forbiddenLine = null;
    if (this.state.isSolo) {
      this.bidContainer.classList.add('bid-sheet--solo');
      this.forbiddenLine = document.createElement('div');
      this.forbiddenLine.className = 'bid-sheet__forbidden';
      this.forbiddenLine.setAttribute('role', 'status');
      this.bidContainer.appendChild(this.forbiddenLine);
    }

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
      if (this.readOnly) {
        const choice = this.createBidChoice(i.toString());
        this.allBidButtons.push(choice);
        numericRow.appendChild(choice);
        continue;
      }
      const btn = this.createBidButton(i.toString(), () => {
        if (this._refuseOffTurn()) return;
        // the Forbidden Bid is never sent (its button is disabled too)
        if (btn.classList.contains('is-forbidden')) return;
        this.chooseBid(btn, i.toString(), onBidSelect);
      });
      this.allBidButtons.push(btn);
      numericRow.appendChild(btn);
    }
    this.bidContainer.appendChild(numericRow);

    // Bore row (B, 2B, 3B, 4B): a segmented control (no bores in Get Your Bid)
    const boreRow = document.createElement('div');
    boreRow.className = 'bid-bores';
    boreRow.setAttribute('role', 'group');
    boreRow.setAttribute('aria-label', 'Bores');
    (this.state.isSolo ? [] : BORES).forEach((bid) => {
      if (this.readOnly) {
        const choice = this.createBidChoice(bid, true);
        choice.dataset.bid = bid;
        this.boreButtons[bid] = choice;
        this.allBidButtons.push(choice);
        boreRow.appendChild(choice);
        return;
      }
      const btn = this.createBidButton(bid, () => {
        if (btn.disabled) return;
        if (this._refuseOffTurn()) return;
        this.chooseBid(btn, bid, onBidSelect);
      }, true);
      btn.dataset.bid = bid;
      this.boreButtons[bid] = btn;
      this.allBidButtons.push(btn);
      boreRow.appendChild(btn);
    });
    if (!this.state.isSolo) this.bidContainer.appendChild(boreRow);

    // Update bore button states
    this.updateBoreButtonStates();

    // the /help suggestion survives a rebuild of the sheet (a render)
    this._markSuggested();

    // A clock already running for my turn (a rejoin, a rebuild, /active)
    this.syncClock();

    console.log('✅ BidManager: Bid UI created');
  }

  /**
   * A bid tap off my turn: true (nothing is sent). The "Not your turn."
   * notice only for a sheet still open (out of sync with the turn); a tap
   * on a closing sheet (the fade after my own bid's echo, or after the
   * clock's bid 0) is the second click of a double-click: silent.
   */
  _refuseOffTurn() {
    if (this.state.currentTurn === this.state.position && this.state.isBidding) return false;
    if (this.bidContainer?.classList.contains('is-open')) showNotice(NOTICE.NOT_YOUR_TURN);
    return true;
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
   * A read-only choice (the watched seat's sheet): static text in the
   * button's look, never focusable, no listener.
   */
  createBidChoice(label, isBore = false) {
    const el = document.createElement('span');
    el.className = isBore ? 'bid-button bore-button' : 'bid-button';
    el.textContent = label;
    return el;
  }

  /** A choice not open now: a button's disabled, a read-only choice's class. */
  _setUnavailable(el, on) {
    if (!el) return;
    if (el.tagName === 'BUTTON') el.disabled = on;
    else el.classList.toggle('is-disabled', !!on);
  }

  /**
   * Mark a bid chosen and send it. A bid the sender refuses on the spot
   * (MyAction returns false: reconnecting, not my turn any more) is unmarked
   * again, so the sheet never shows a bid that was not sent.
   */
  chooseBid(btn, bidValue, onBidSelect) {
    // the clock ran out here: the server's bid 0 for me is on its way; a
    // read-only sheet never sends (it has no buttons; belt and braces)
    if (this.expired || this.readOnly) return;
    this.selectButton(btn, bidValue);
    if (onBidSelect(bidValue) === false) this.clearSelection();
    // a bid on its way: no countdown (a rollback's render shows it again)
    this.syncClock();
  }

  /**
   * The /help suggested bid ('4', 'B'; null for none): a gold ring on its
   * button and "(suggested)" in its name. Kept across a rebuild.
   */
  setSuggestedBid(bid) {
    this.suggestedBid = bid ? String(bid).toUpperCase() : null;
    this._markSuggested();
  }

  _markSuggested() {
    for (const b of this.allBidButtons || []) {
      const on = !!this.suggestedBid && b.textContent === this.suggestedBid;
      b.classList.toggle('is-suggested', on);
      if (on) b.setAttribute('aria-label', `${b.textContent} (suggested)`);
      // (the Forbidden Bid keeps its own name: updateForbidden)
      else if (!b.classList.contains('is-forbidden')) b.removeAttribute('aria-label');
    }
  }

  /** No bid marked. */
  clearSelection() {
    (this.allBidButtons || []).forEach((b) => {
      b.classList.remove('is-selected');
      b.removeAttribute('aria-pressed');
    });
    this.selectedBid = null;
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
    this._setUnavailable(this.boreButtons['B'], hasBore);
    this._setUnavailable(this.boreButtons['2B'], !hasBore || has2B);
    this._setUnavailable(this.boreButtons['3B'], !has2B || has3B);
    this._setUnavailable(this.boreButtons['4B'], !has3B || has4B);

    this.updateForbidden();
    this.updateTrickIndicator();
    // a bid came in (mine ends my clock)
    this.syncClock();
  }

  /**
   * Get Your Bid: mark the Forbidden Bid (GameState.gybForbidden) on the
   * sheet of the seat it binds, the last bidder: mine, or the watched
   * seat's on a read-only sheet. Every other number stays open.
   */
  updateForbidden() {
    if (!this.state.isSolo || !this.bidContainer) return;
    const f = this.state.gybForbidden();
    const mine = !!f && f.position === this.state.position;
    const label = mine ? String(f.bid) : null;
    for (const b of this.allBidButtons || []) {
      const on = label !== null && b.textContent === label;
      const was = b.classList.contains('is-forbidden');
      if (on === was) continue;
      b.classList.toggle('is-forbidden', on);
      this._setUnavailable(b, on);
      if (on) {
        b.setAttribute('aria-label', `${label}, the Forbidden Bid`);
        b.title = 'The Forbidden Bid: the bids may not add up to the hand';
      } else {
        b.removeAttribute('aria-label');
        b.removeAttribute('title');
      }
    }
    if (this.forbiddenLine) {
      const text = mine ? `Forbidden Bid: ${label}` : '';
      if (this.forbiddenLine.textContent !== text) this.forbiddenLine.textContent = text;
      this.forbiddenLine.classList.toggle('is-on', mine);
    }
  }

  /**
   * Get Your Bid's trick chips: each seat's bid in its own colour, mine
   * first, then the next seats in turn; past the hand size an overbid.
   */
  _updateSoloIndicator() {
    const me = this.state.position || 1;
    const { opp1, opp2 } = seatsAround(me, 3);
    const runs = [me, opp1, opp2].map((p) => ({ letter: seatLetter(p, 3), n: bidTricks(this.state.bids?.[p], this.handSize) ?? 0, mine: p === me }));
    const totalBid = runs.reduce((n, r) => n + r.n, 0);
    const totalNeeded = Math.min(Math.max(totalBid, this.handSize), 16);
    while (this.trickIndicators.length < totalNeeded) {
      const rect = this.createIndicatorRect();
      this.trickIndicators.push(rect);
      this.indicatorRow.appendChild(rect);
    }
    while (this.trickIndicators.length > totalNeeded) this.trickIndicators.pop().remove();
    const owner = [];
    for (const r of runs) for (let k = 0; k < r.n; k++) owner.push(r);
    for (let i = 0; i < this.trickIndicators.length; i++) {
      const rect = this.trickIndicators[i];
      const r = owner[i] || null;
      rect.classList.toggle('is-team', !!r && r.mine);
      rect.classList.toggle('is-opp', !!r && !r.mine);
      for (const letter of ['a', 'b', 'c']) rect.classList.toggle(`is-team-${letter}`, !!r && r.letter === letter);
      rect.classList.toggle('is-overbid', i >= this.handSize);
    }
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
    if (this.state.isSolo) {
      this._updateSoloIndicator();
      return;
    }

    const myTeam = this.state.position % 2;
    // a bore counts as the whole hand, each team capped at the hand size
    const totals = bidTotalsFor(this.state.bids, this.state.position, this.handSize);
    const teamBidCount = totals.team;
    const oppBidCount = totals.opp;

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
    this.syncClock();
  }

  // ---------- the bid clock's countdown ----------

  /**
   * The running clock, when it is mine to see: my bid turn, my bid neither
   * made nor pending; on a read-only sheet the watched seat's.
   */
  _myClock() {
    const s = this.state;
    const clock = s.bidClock;
    if (!clock || !this.bidContainer || !s.position || s.isLazy) return null;
    if (s.isSpectator && !(this.readOnly && isShoulder(s))) return null;
    if (clock.position !== s.position || !this._myTurn()) return null;
    if (s.bids?.[s.position] !== undefined) return null;
    if (!this.readOnly && getMyAction().isPending('bid')) return null;
    return clock;
  }

  /**
   * Show, update or remove the countdown from the state's clock (the
   * bidClock event, a snapshot's render, my bid, the turn moving on).
   */
  syncClock() {
    // the clock went (stopped, my socket dropped) or is another seat's: the
    // next one for me is new, even at the same deadline (/lazy then /active)
    const live = this.state.bidClock;
    if (!live || live.position !== this._clockSeen?.position) this._clockSeen = null;
    const clock = this._myClock();
    if (!clock) {
      this._removeClock();
      return;
    }
    if (!sameClock(this._clockSeen, clock)) {
      // a new clock (or a resume's top-up): announced afresh, offered again
      this._clockSaid = new Set();
      this._setExpired(false);
    }
    // a restatement (a snapshot rebuilds the deadline from its receipt):
    // follow its deadline, say nothing again
    this._clockSeen = { position: clock.position, deadline: clock.deadline };
    this._tickClock();
  }

  _tickClock() {
    this._clearClockTimer();
    const clock = this._myClock();
    if (!clock) {
      this._removeClock();
      return;
    }
    const ms = countdownMs(clock, bidClockNow());
    if (ms <= 0) {
      // 0: the countdown goes and the bid is not offered (the server bids
      // 0 next); offered again if nothing came after the grace
      this._removeClockEl();
      if (ms > -BID_CLOCK_EXPIRED_GRACE_MS) {
        this._setExpired(true);
        this._clockTimer = setTimeout(() => this._tickClock(), BID_CLOCK_EXPIRED_GRACE_MS + ms + 1);
      } else {
        this._setExpired(false);
      }
      return;
    }
    const secs = Math.ceil(ms / 1000);
    if (!this.clockEl && this.titleRow) {
      const el = document.createElement('span');
      el.className = 'bid-sheet__clock';
      el.setAttribute('role', 'timer');
      this.titleRow.appendChild(el);
      this.clockEl = el;
    }
    if (this.clockEl) {
      this.clockEl.textContent = String(secs);
      this.clockEl.setAttribute('aria-label', this.readOnly ? `${this.owner}: ${secondsToBid(secs)}` : secondsToBid(secs));
      this.clockEl.classList.toggle('bid-sheet__clock--low', secs <= BID_CLOCK_LOW_S);
    }
    // once when it appears, once at BID_CLOCK_LOW_S (one announcement if it
    // appears below that); a watched seat's clock is never announced
    if (this.readOnly) {
      // (nothing said: it is not my bid)
    } else if (!this._clockSaid.has('shown')) {
      this._clockSaid.add('shown');
      if (secs <= BID_CLOCK_LOW_S) this._clockSaid.add('low');
      announce(secondsToBid(secs));
    } else if (secs <= BID_CLOCK_LOW_S && !this._clockSaid.has('low')) {
      this._clockSaid.add('low');
      announce(secondsToBid(BID_CLOCK_LOW_S));
    }
    // the next whole second (a hidden tab's throttled timer just lands later)
    const next = ms - (secs - 1) * 1000;
    this._clockTimer = setTimeout(() => this._tickClock(), Math.max(1, Math.ceil(next)));
  }

  _setExpired(on) {
    this.expired = !!on;
    this.bidContainer?.classList.toggle('bid-sheet--expired', this.expired);
    for (const b of this.allBidButtons || []) {
      if (this.expired) b.setAttribute('aria-disabled', 'true');
      else b.removeAttribute('aria-disabled');
    }
  }

  _clearClockTimer() {
    if (this._clockTimer !== null) clearTimeout(this._clockTimer);
    this._clockTimer = null;
  }

  _removeClockEl() {
    this.clockEl?.remove();
    this.clockEl = null;
  }

  _removeClock() {
    this._clearClockTimer();
    this._removeClockEl();
    if (this.expired) this._setExpired(false);
    // _clockSeen and what was said stay: the same clock on a rebuilt
    // sheet is not announced again
  }

  /**
   * Hide and remove the bid UI.
   * @param {boolean} animate - Whether to animate out (default true)
   */
  hideBidUI(animate = true) {
    this._removeClock();
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
    this.titleRow = null;
    this.handSize = 0;
    this.readOnly = false;
    this.owner = null;
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

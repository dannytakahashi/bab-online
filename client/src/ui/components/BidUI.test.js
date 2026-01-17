import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBidUI, showBidUI, createBidBubble } from './BidUI.js';

describe('createBidUI', () => {
  let bidUI;

  afterEach(() => {
    if (bidUI) {
      bidUI.destroy();
      bidUI = null;
    }
  });

  it('creates bid container', () => {
    bidUI = createBidUI({});
    expect(bidUI.container).toBeDefined();
    expect(bidUI.container.id).toBe('bid-container');
  });

  it('creates bid buttons for each bid value', () => {
    bidUI = createBidUI({ maxBid: 5 });
    expect(bidUI.buttons).toHaveLength(6); // 0 to 5
  });

  it('calls onBid when button clicked', () => {
    const onBid = vi.fn();
    bidUI = createBidUI({ maxBid: 3, onBid });

    bidUI.buttons[2].click();

    expect(onBid).toHaveBeenCalledWith('2');
  });

  it('creates bore button when canBore is true', () => {
    bidUI = createBidUI({ canBore: true });
    expect(bidUI.boreBtn).toBeDefined();
    expect(bidUI.boreBtn.textContent).toContain('Bore');
  });

  it('does not create bore button when canBore is false', () => {
    bidUI = createBidUI({ canBore: false });
    expect(bidUI.boreBtn).toBeNull();
  });

  it('calls onBore when bore button clicked', () => {
    const onBore = vi.fn();
    bidUI = createBidUI({ canBore: true, onBore });

    bidUI.boreBtn.click();

    expect(onBore).toHaveBeenCalled();
  });

  it('destroy removes container', () => {
    bidUI = createBidUI({});
    document.body.appendChild(bidUI.container);

    expect(document.getElementById('bid-container')).toBeTruthy();

    bidUI.destroy();
    bidUI = null;

    expect(document.getElementById('bid-container')).toBeFalsy();
  });

  it('disable changes opacity and pointer events', () => {
    bidUI = createBidUI({});

    bidUI.disable();

    expect(bidUI.container.style.opacity).toBe('0.5');
    expect(bidUI.container.style.pointerEvents).toBe('none');
  });

  it('enable restores opacity and pointer events', () => {
    bidUI = createBidUI({});
    bidUI.disable();

    bidUI.enable();

    expect(bidUI.container.style.opacity).toBe('1');
    expect(bidUI.container.style.pointerEvents).toBe('auto');
  });
});

describe('showBidUI', () => {
  afterEach(() => {
    document.getElementById('bid-container')?.remove();
  });

  it('appends bid UI to body', () => {
    const ui = showBidUI({});

    expect(document.getElementById('bid-container')).toBeTruthy();

    ui.destroy();
  });
});

describe('createBidBubble', () => {
  it('creates bubble with bid text', () => {
    const bubble = createBidBubble({ bid: '3', x: 100, y: 200 });

    expect(bubble.container.textContent).toBe('3');
    expect(bubble.container.style.left).toBe('100px');
    expect(bubble.container.style.top).toBe('200px');

    bubble.destroy();
  });

  it('applies custom color', () => {
    const bubble = createBidBubble({ bid: '5', x: 0, y: 0, color: '#ff0000' });

    expect(bubble.container.style.background).toBe('rgb(255, 0, 0)');

    bubble.destroy();
  });
});

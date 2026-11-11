import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showChatBubble, showSpectatorChatBubble, clearChatBubbles, getActiveChatBubbles, SPECTATOR_BUBBLE_KEY } from './ChatBubble.js';
import { applyHudLayout, clearHud } from '../tableHud.js';
import { computeTableLayout, layoutForViewport } from '../../phaser/layout/computeTableLayout.js';

describe('ChatBubble fade identity guard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    clearChatBubbles();
    vi.useRealTimers();
  });

  it('a bubble shown during the previous one\'s fade-out keeps its slot', () => {
    showChatBubble('opp1', 'first', null, 1000);
    // the first bubble starts fading at 700 ms and is removed at 1000 ms
    vi.advanceTimersByTime(800);
    showChatBubble('opp1', 'second', null, 6000);
    const second = getActiveChatBubbles().opp1;
    expect(second.bubble.textContent).toBe('second');

    vi.advanceTimersByTime(300); // past the first bubble's removal
    expect(getActiveChatBubbles().opp1).toBe(second);
    expect(second.bubble.isConnected).toBe(true);
    expect(document.querySelectorAll('.chat-bubble')).toHaveLength(1);
  });

  it('a bubble that fades out on its own forgets its slot', () => {
    showChatBubble('partner', 'hi', null, 1000);
    vi.advanceTimersByTime(1000);
    expect(getActiveChatBubbles().partner).toBeUndefined();
    expect(document.querySelectorAll('.chat-bubble')).toHaveLength(0);
  });

  it('clearing a fading bubble cancels its pending removal too', () => {
    showChatBubble('opp2', 'a', null, 1000);
    vi.advanceTimersByTime(800); // fading
    clearChatBubbles();
    showChatBubble('opp2', 'b', null, 6000);
    vi.advanceTimersByTime(500);
    expect(getActiveChatBubbles().opp2.bubble.textContent).toBe('b');
  });
});

describe('ChatBubble on the HUD (ui-4, webclient-7)', () => {
  let container;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    container.id = 'game-container';
    document.body.appendChild(container);
  });
  afterEach(() => {
    clearChatBubbles();
    clearHud();
    container.remove();
    vi.useRealTimers();
  });

  it('my bubble is a child of my seat, at the layout\'s anchor next to my avatar, and follows a relayout', () => {
    const L = computeTableLayout({ w: 1600, h: 1080 });
    applyHudLayout(L);
    showChatBubble('me', '3', 'bid', 5000);
    const bubble = document.querySelector('.chat-bubble');
    const seat = bubble.closest('.hud-seat');
    expect(seat.dataset.seat).toBe('self');
    expect(bubble.parentElement.className).toBe('hud-bubble-slot');
    expect(bubble.classList.contains('bid')).toBe(true);
    // the seat node is at my avatar; the bubble offset is the layout's
    expect(seat.style.left).toBe(`${L.seats.self.avatar.x}px`);
    expect(seat.style.top).toBe(`${L.seats.self.avatar.y}px`);
    expect(seat.style.getPropertyValue('--bubble-dy')).toBe(`${L.seats.self.bubble.dy}px`);
    expect(Math.hypot(L.seats.self.bubble.dx, L.seats.self.bubble.dy)).toBeLessThanOrEqual(80);

    // a smaller window: the same bubble moves with the seat
    const small = computeTableLayout({ w: 1000, h: 620 });
    applyHudLayout(small);
    expect(bubble.isConnected).toBe(true);
    expect(seat.style.left).toBe(`${small.seats.self.avatar.x}px`);
    expect(seat.style.top).toBe(`${small.seats.self.avatar.y}px`);
  });

  it('each seat\'s bubble takes the layout\'s direction and width, clamps to its lines, and turns with a relayout', () => {
    const big = layoutForViewport({ vw: 1440, vh: 790 });
    applyHudLayout(big);
    const long = 'x'.repeat(40) + ' word'.repeat(80); // a 500-character chat
    for (const k of ['partner', 'opp1', 'opp2', 'me']) showChatBubble(k, long);
    for (const [k, seatKey] of [['partner', 'partner'], ['opp1', 'opp1'], ['opp2', 'opp2'], ['me', 'self']]) {
      const b = getActiveChatBubbles()[k].bubble;
      const seat = b.closest('.hud-seat');
      const want = big.seats[seatKey].bubble;
      expect(b.classList.contains(`tail-${want.tail}`), `${k} tail`).toBe(true);
      expect(seat.style.getPropertyValue('--bubble-w')).toBe(`${Math.round(want.w * 100) / 100}px`);
      // the text sits in the clamped box (CSS: --bubble-lines), all of it
      const text = b.querySelector(':scope > .chat-bubble-text');
      expect(text.textContent).toBe(long);
    }
    const hud = document.getElementById('table-hud');
    expect(hud.style.getPropertyValue('--bubble-lines')).toBe(String(big.bubbles.lines));
    expect(hud.style.getPropertyValue('--bubble-lh')).toBe(`${big.bubbles.lh}px`);

    // a layout that turns a seat's bubble turns the one already up
    const turned = structuredClone(big);
    turned.seats.opp1.bubble = { ...turned.seats.opp1.bubble, tail: 'left', dx: 50, dy: 0, w: 150 };
    applyHudLayout(turned);
    const b = getActiveChatBubbles().opp1.bubble;
    expect([...b.classList].filter((c) => c.startsWith('tail-'))).toEqual(['tail-left']);
    expect(b.closest('.hud-seat').style.getPropertyValue('--bubble-w')).toBe('150px');
  });

  it('the partner\'s bubble points left from the right of the avatar; a spectator\'s bottom seat is the self seat', () => {
    applyHudLayout(computeTableLayout({ w: 1600, h: 1080, isSpectator: true }));
    showChatBubble('partner', 'hi');
    showChatBubble('bottom', 'yo');
    const [p, b] = ['partner', 'bottom'].map((k) => getActiveChatBubbles()[k].bubble);
    expect(p.classList.contains('tail-left')).toBe(true);
    expect(p.closest('.hud-seat').dataset.seat).toBe('partner');
    expect(b.closest('.hud-seat').dataset.seat).toBe('self');
  });
});

describe('a spectator\'s chat by the badge (showSpectatorChatBubble)', () => {
  let container;
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    container.id = 'game-container';
    document.body.appendChild(container);
  });
  afterEach(() => {
    clearChatBubbles();
    clearHud();
    container.remove();
    vi.useRealTimers();
  });

  const slot = () => document.querySelector('#table-hud > .hud-spectator-bubble');

  it('"Name: text" in the badge\'s own slot (not the badge, not a seat), tinted, the seats\' text box', () => {
    const L = layoutForViewport({ vw: 1440, vh: 790 });
    applyHudLayout(L);
    const b = showSpectatorChatBubble('Zach', 'hello');
    expect(b.parentElement).toBe(slot());
    expect(b.closest('.hud-seat')).toBeNull();
    expect(b.closest('.hud-spectators')).toBeNull();
    expect(b.textContent).toBe('Zach: hello');
    expect(b.querySelector(':scope > .chat-bubble-text > .chat-bubble-name').textContent).toBe('Zach:');
    expect(b.classList.contains('is-spectator')).toBe(true);
    expect(b.classList.contains(`tail-${L.spectators.bubble.tail}`)).toBe(true);
    expect(getActiveChatBubbles()[SPECTATOR_BUBBLE_KEY].bubble).toBe(b);
    const hud = document.getElementById('table-hud');
    const px = (v) => `${Math.round(v * 100) / 100}px`;
    for (const [k, v] of [['--specbub-x', L.spectators.bubble.x], ['--specbub-y', L.spectators.bubble.y], ['--specbub-w', L.spectators.bubble.w],
      ['--specbub-tail', L.spectators.bubble.tailOffset], ['--specbub-min-w', L.spectators.bubble.minW]]) {
      expect(hud.style.getPropertyValue(k), k).toBe(px(v));
    }
    expect(slot().classList.contains(`align-${L.spectators.bubble.align}`)).toBe(true);
    expect(slot().hidden).toBe(false);
  });

  it('one at a time: a newer one replaces it, also during its fade; it lasts as a seat\'s chat (6 s)', () => {
    applyHudLayout(layoutForViewport({ vw: 1440, vh: 790 }));
    showSpectatorChatBubble('A', 'first');
    vi.advanceTimersByTime(5800); // fading
    showSpectatorChatBubble('B', 'second');
    expect([...slot().children].map((c) => c.textContent)).toEqual(['B: second']);
    vi.advanceTimersByTime(5699);
    expect(slot().childElementCount).toBe(1);
    vi.advanceTimersByTime(301);
    expect(slot().childElementCount).toBe(0);
    expect(getActiveChatBubbles()[SPECTATOR_BUBBLE_KEY]).toBeUndefined();
  });

  it('a seat\'s bubble and the badge\'s are separate; clearChatBubbles (the teardown) takes both', () => {
    applyHudLayout(layoutForViewport({ vw: 1440, vh: 790 }));
    showChatBubble('opp1', 'seat');
    showSpectatorChatBubble('Zach', 'badge');
    expect(document.querySelectorAll('.chat-bubble')).toHaveLength(2);
    clearChatBubbles();
    expect(document.querySelectorAll('.chat-bubble')).toHaveLength(0);
  });

  it('never at an unplaced spot: hidden until a layout places it, and where the layout has no spot', () => {
    showSpectatorChatBubble('Zach', 'early');
    expect(slot().hidden).toBe(true); // no layout yet
    applyHudLayout(layoutForViewport({ vw: 1440, vh: 790 }));
    expect(slot().hidden).toBe(false);
    applyHudLayout(computeTableLayout({ w: 680, h: 500, logW: 200 }));
    expect(slot().hidden).toBe(true);
    expect(slot().childElementCount).toBe(1);
  });

  it('a relayout turns the bubble that is up', () => {
    const L = layoutForViewport({ vw: 1440, vh: 790 });
    applyHudLayout(L);
    const b = showSpectatorChatBubble('Zach', 'turn');
    const turned = structuredClone(L);
    turned.spectators.bubble = { ...turned.spectators.bubble, tail: 'right', align: 'end' };
    applyHudLayout(turned);
    expect([...b.classList].filter((c) => c.startsWith('tail-'))).toEqual(['tail-right']);
    expect(slot().dataset.tail).toBe('right');
  });

  it('without a table: nothing (the log has the line)', () => {
    container.remove();
    expect(showSpectatorChatBubble('Zach', 'nowhere')).toBeNull();
    expect(document.querySelectorAll('.chat-bubble')).toHaveLength(0);
  });
});

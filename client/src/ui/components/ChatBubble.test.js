import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showChatBubble, clearChatBubbles, getActiveChatBubbles } from './ChatBubble.js';
import { applyHudLayout, clearHud } from '../tableHud.js';
import { computeTableLayout } from '../../phaser/layout/computeTableLayout.js';

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
    showChatBubble('me', '3', '#FF0000', 5000);
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

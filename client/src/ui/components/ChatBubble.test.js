import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showChatBubble, clearChatBubbles, getActiveChatBubbles } from './ChatBubble.js';

describe('ChatBubble fade identity guard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    clearChatBubbles();
    vi.useRealTimers();
  });

  it('a bubble shown during the previous one\'s fade-out keeps its slot', () => {
    showChatBubble('opp1', 100, 100, 'first', null, 1000);
    // the first bubble starts fading at 700 ms and is removed at 1000 ms
    vi.advanceTimersByTime(800);
    showChatBubble('opp1', 100, 100, 'second', null, 6000);
    const second = getActiveChatBubbles().opp1;
    expect(second.bubble.textContent).toBe('second');

    vi.advanceTimersByTime(300); // past the first bubble's removal
    expect(getActiveChatBubbles().opp1).toBe(second);
    expect(second.bubble.isConnected).toBe(true);
    expect(document.querySelectorAll('.chat-bubble')).toHaveLength(1);
  });

  it('a bubble that fades out on its own forgets its slot', () => {
    showChatBubble('partner', 100, 100, 'hi', null, 1000);
    vi.advanceTimersByTime(1000);
    expect(getActiveChatBubbles().partner).toBeUndefined();
    expect(document.querySelectorAll('.chat-bubble')).toHaveLength(0);
  });

  it('clearing a fading bubble cancels its pending removal too', () => {
    showChatBubble('opp2', 100, 100, 'a', null, 1000);
    vi.advanceTimersByTime(800); // fading
    clearChatBubbles();
    showChatBubble('opp2', 100, 100, 'b', null, 6000);
    vi.advanceTimersByTime(500);
    expect(getActiveChatBubbles().opp2.bubble.textContent).toBe('b');
  });
});

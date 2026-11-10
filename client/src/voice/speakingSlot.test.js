import { describe, it, expect } from 'vitest';
import { speakingSlotFor } from './speakingSlot.js';

// Seats 1..4; I am 1: partner 3, opp1 = rotate(1) = 2, opp2 = 4
const playerData = {
  position: [1, 2, 3, 4],
  socket: ['s-me', 's-bob', 's-cat', 's-dan'],
  username: [{ username: 'me' }, { username: 'bob' }, { username: 'cat' }, { username: 'dan' }],
};

describe('speakingSlotFor', () => {
  it('maps a peer to its seat by username', () => {
    expect(speakingSlotFor({ username: 'cat', socketId: 'x', playerData, myPosition: 1 })).toBe('partner');
    expect(speakingSlotFor({ username: 'bob', socketId: 'x', playerData, myPosition: 1 })).toBe('opp1');
    expect(speakingSlotFor({ username: 'dan', socketId: 'x', playerData, myPosition: 1 })).toBe('opp2');
  });

  it('a peer that reconnected (new socket id, stale playerData.socket) still lights its own seat', () => {
    expect(speakingSlotFor({ username: 'dan', socketId: 's-dan2', playerData, myPosition: 1 })).toBe('opp2');
    // even when its new id is an id playerData lists for someone else
    expect(speakingSlotFor({ username: 'dan', socketId: 's-bob', playerData, myPosition: 1 })).toBe('opp2');
  });

  it('falls back to the socket id for a peer with no username; null when unknown or self', () => {
    expect(speakingSlotFor({ username: null, socketId: 's-cat', playerData, myPosition: 1 })).toBe('partner');
    expect(speakingSlotFor({ username: 'zed', socketId: 's-zed', playerData, myPosition: 1 })).toBeNull();
    expect(speakingSlotFor({ username: 'me', socketId: 's-me', playerData, myPosition: 1 })).toBeNull();
    expect(speakingSlotFor({ username: 'cat', socketId: 's-cat', playerData: null, myPosition: 1 })).toBeNull();
  });

  it('accepts plain-string usernames too', () => {
    const pd = { ...playerData, username: ['me', 'bob', 'cat', 'dan'] };
    expect(speakingSlotFor({ username: 'bob', socketId: 'x', playerData: pd, myPosition: 3 })).toBe('opp2');
  });
});

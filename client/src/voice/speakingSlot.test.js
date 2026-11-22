import { describe, it, expect } from 'vitest';
import { speakingSlotFor, spectatorSpeakerFor } from './speakingSlot.js';

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

describe('speakingSlotFor for a spectator (the view from seat 1)', () => {
  it('seat 1\'s player lights the bottom seat, not nothing (a spectator is never seat 1)', () => {
    const owners = { 1: 'ann', 2: 'bob', 3: 'cat', 4: 'dan' };
    expect(speakingSlotFor({ username: 'ann', socketId: 'x', playerData, myPosition: 1, owners, spectator: true })).toBe('bottom');
    expect(speakingSlotFor({ username: 'cat', socketId: 'x', playerData, myPosition: 1, owners, spectator: true })).toBe('partner');
    expect(speakingSlotFor({ username: 'bob', socketId: 'x', playerData, myPosition: 1, owners, spectator: true })).toBe('opp1');
    // a seat owner's own view is unchanged
    expect(speakingSlotFor({ username: 'ann', socketId: 'x', playerData, myPosition: 1, owners })).toBeNull();
    // a watcher (no seat) lights no seat
    expect(speakingSlotFor({ username: 'zed', socketId: 'x', playerData, myPosition: 1, owners, spectator: true })).toBeNull();
  });
});

describe('speakingSlotFor without socket ids on the wire (V1_REMOVALS #6 / #14)', () => {
  // what GameState holds once gameStart.players and positionUpdate.sockets are gone
  const noSockets = { position: [1, 2, 3, 4], socket: [null, null, null, null], username: playerData.username };
  const owners = { 1: 'me', 2: 'bob', 3: 'cat', 4: 'dan' };

  it('maps every peer by username alone', () => {
    expect(speakingSlotFor({ username: 'cat', socketId: 'x', playerData: noSockets, myPosition: 1, owners })).toBe('partner');
    expect(speakingSlotFor({ username: 'bob', socketId: 'x', playerData: noSockets, myPosition: 1, owners })).toBe('opp1');
    expect(speakingSlotFor({ username: 'dan', socketId: 'x', playerData: noSockets, myPosition: 1, owners })).toBe('opp2');
  });

  it('a lazy owner (a bot plays the seat, the owner still talks) lights the seat by its owner', () => {
    const lazy = { ...noSockets, username: [{ username: 'me' }, { username: 'Bot Mary' }, { username: 'cat' }, { username: 'dan' }] };
    expect(speakingSlotFor({ username: 'bob', socketId: 's-bob2', playerData: lazy, myPosition: 1, owners })).toBe('opp1');
  });

  it('the owner wins over a stale socket id another seat lists', () => {
    expect(speakingSlotFor({ username: 'dan', socketId: 's-bob', playerData, myPosition: 1, owners })).toBe('opp2');
  });

  it('no owners known (an older page state): the shown name, then the socket id, as before', () => {
    expect(speakingSlotFor({ username: 'cat', socketId: 'x', playerData, myPosition: 1, owners: {} })).toBe('partner');
    expect(speakingSlotFor({ username: null, socketId: 's-dan', playerData, myPosition: 1, owners: {} })).toBe('opp2');
  });
});

describe('spectatorSpeakerFor: who lights the spectator badge (owner 2026-11-22)', () => {
  const owners = { 1: 'ann', 2: 'bob', 3: 'cat', 4: 'dan' };
  const seated = {
    position: [1, 2, 3, 4],
    socket: ['s-ann', 's-bob', 's-cat', 's-dan'],
    username: [{ username: 'ann' }, { username: 'bob' }, { username: 'cat' }, { username: 'dan' }],
  };
  const watching = { spectators: [{ username: 'eve' }, { username: 'fay' }, { username: 'me' }], count: 3 };
  const at = (args) => spectatorSpeakerFor({ me: 'me', owners, playerData: seated, watching, ...args });

  it('a listed spectator talking counts, by name', () => {
    expect(at({ username: 'eve', socketId: 's-eve' })).toEqual({ username: 'eve' });
    expect(at({ username: 'fay', socketId: 's-fay' })).toEqual({ username: 'fay' });
  });

  it('a seated player never counts (its seat glows), even if also listed', () => {
    expect(at({ username: 'bob', socketId: 's-bob' })).toBeNull();
    const w = { spectators: [...watching.spectators, { username: 'cat' }], count: 4 };
    expect(at({ username: 'cat', socketId: 's-cat2', watching: w })).toBeNull();
    // a seat shown by name only (no seatOwners yet)
    expect(at({ username: 'dan', socketId: 'x', owners: {}, watching: { spectators: [{ username: 'dan' }], count: 1 } })).toBeNull();
  });

  it('me never (my mic shows it): a second tab of mine with my name', () => {
    expect(at({ username: 'me', socketId: 's-me2' })).toBeNull();
  });

  it('a named peer not on the list is not placed (an entrant, the list not in yet)', () => {
    expect(at({ username: 'zed', socketId: 's-zed' })).toBeNull();
    expect(at({ username: 'eve', socketId: 's-eve', watching: null })).toBeNull();
  });

  it('a nameless peer: a spectator when it is at no seat of a seated table', () => {
    expect(at({ username: null, socketId: 's-anon' })).toEqual({ peerId: 's-anon' });
    expect(at({ username: null, socketId: 's-bob' })).toBeNull();
    // before the seating it may be an entrant
    expect(at({ username: null, socketId: 's-anon', owners: {}, playerData: null })).toBeNull();
    expect(at({ username: null, socketId: 'self' })).toBeNull();
    expect(at({ username: null, socketId: '' })).toBeNull();
  });
});

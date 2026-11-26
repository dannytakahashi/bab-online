/**
 * GameState.getSeatOwnerName (owner rule 2026-11-25, people by player names;
 * iOS PlayersSlice.ownerName after #427): what a seat's labels say. A lazy or
 * resigned seat is named by its owner, never the bot playing it; a seat back
 * from /lazy by its owner; a native bot seat by its persona. The avatars
 * (getPlayerNameByPosition, playerData) keep showing who plays.
 */
import { describe, it, expect } from 'vitest';
import { GameState } from './GameState.js';

function seated() {
  const s = new GameState();
  s.username = 'zed';
  s.isSpectator = true;
  s.seatOwners = { 1: 'ann', 2: 'bo', 3: 'cy', 4: '🤖 Mary' };
  s.setPlayerData({ position: [1, 2, 3, 4], sockets: ['s1', 's2', 's3', 'bot:4'], username: ['ann', 'bo', 'cy', '🤖 Mary'].map((username) => ({ username })), pics: [1, 2, 3, 4] });
  return s;
}

describe('getSeatOwnerName', () => {
  it('a lazy seat: its owner; the avatar keeps the bot', () => {
    const s = seated();
    s.applySeatDisplay(1, { username: '🤖 Zach', pic: 7 });
    expect(s.getPlayerNameByPosition(1)).toBe('🤖 Zach');
    expect(s.getSeatOwnerName(1)).toBe('ann');
  });

  it('a resigned seat: the owner who left', () => {
    const s = seated();
    s.applySeatDisplay(2, { username: '🤖 Gina', pic: 8 });
    expect(s.getPlayerNameByPosition(2)).toBe('🤖 Gina');
    expect(s.getSeatOwnerName(2)).toBe('bo');
  });

  it('a seat back from /lazy: its owner, one name again', () => {
    const s = seated();
    s.applySeatDisplay(3, { username: '🤖 Zach', pic: 7 });
    s.applySeatDisplay(3, { username: 'cy', pic: 3 });
    expect(s.getPlayerNameByPosition(3)).toBe('cy');
    expect(s.getSeatOwnerName(3)).toBe('cy');
  });

  it('a native bot seat: its persona', () => {
    const s = seated();
    expect(s.getSeatOwnerName(4)).toBe('🤖 Mary');
  });

  it('from a snapshot (a spectator joining while a bot plays a seat): ownerUsername', () => {
    const s = new GameState();
    s._seatsToPlayerData([
      { position: 1, username: '🤖 Zach', ownerUsername: 'ann', pic: 7 },
      { position: 2, username: 'bo', ownerUsername: 'bo', pic: 2 },
      { position: 3, username: '🤖 Gina', ownerUsername: 'cy', pic: 8 },
      { position: 4, username: '🤖 Mary', ownerUsername: null, pic: 4 },
    ]);
    expect([1, 2, 3, 4].map((p) => s.getSeatOwnerName(p))).toEqual(['ann', 'bo', 'cy', '🤖 Mary']);
  });

  it('nothing known: the same placeholder as the seat name', () => {
    expect(new GameState().getSeatOwnerName(2)).toBe('P2');
  });
});

describe('positionUpdate.owners (2026-11-26): a draw-phase leaver seated as a resign bot', () => {
  const seating = (extra = {}) => ({
    positions: [1, 2, 3, 4],
    sockets: ['s1', 'bot:z', 's3', 'bot:m'],
    usernames: [{ username: 'ann' }, { username: '🤖 Zach' }, { username: 'cy' }, { username: '🤖 Mary' }],
    pics: [1, 7, 3, 4],
    isBot: [false, true, false, true],
    nativeBot: [false, false, false, true],
    ...extra,
  });

  it('owners[] names the leaver on its seat; the seat itself shows the bot; a native bot keeps its persona', () => {
    const s = new GameState();
    s.username = 'ann';
    s.applyPositionUpdate(seating({ owners: ['ann', 'bo', 'cy', null] }));
    expect(s.seatOwners).toEqual({ 1: 'ann', 2: 'bo', 3: 'cy', 4: '🤖 Mary' });
    expect(s.getPlayerNameByPosition(2)).toBe('🤖 Zach');
    expect(s.getSeatOwnerName(2)).toBe('bo');
    expect(s.getSeatOwnerName(4)).toBe('🤖 Mary');
    expect(s.teamPlayerData.username.map((u) => u.username)).toEqual(['ann', 'bo', 'cy', '🤖 Mary']);
  });

  it('matches what a snapshot of the same table gives (a reload, a later spectator)', () => {
    const live = new GameState();
    live.applyPositionUpdate(seating({ owners: ['ann', 'bo', 'cy', null] }));
    const reloaded = new GameState();
    reloaded._seatsToPlayerData([
      { position: 1, username: 'ann', ownerUsername: 'ann', pic: 1 },
      { position: 2, username: '🤖 Zach', ownerUsername: 'bo', pic: 7 },
      { position: 3, username: 'cy', ownerUsername: 'cy', pic: 3 },
      { position: 4, username: '🤖 Mary', ownerUsername: null, pic: 4 },
    ]);
    expect(live.seatOwners).toEqual(reloaded.seatOwners);
    expect([1, 2, 3, 4].map((p) => live.getSeatOwnerName(p))).toEqual([1, 2, 3, 4].map((p) => reloaded.getSeatOwnerName(p)));
  });

  it('an older server (no owners): the names seated, as before', () => {
    const s = new GameState();
    s.applyPositionUpdate(seating());
    expect(s.seatOwners).toEqual({ 1: 'ann', 2: '🤖 Zach', 3: 'cy', 4: '🤖 Mary' });
  });

  it('a malformed owners entry falls back to that seat\'s name', () => {
    const s = new GameState();
    s.applyPositionUpdate(seating({ owners: ['ann', 7, '', null] }));
    expect(s.seatOwners).toEqual({ 1: 'ann', 2: '🤖 Zach', 3: 'cy', 4: '🤖 Mary' });
  });
});

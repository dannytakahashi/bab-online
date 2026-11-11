// @vitest-environment node
// (reads the server fixtures from disk)
/**
 * Who is watching in the table state (GameState is the one writer):
 * spectatorsUpdated (applySpectators) and snapshot v2 `watching`
 * (parseSnapshotV2 / parseWatching, applySnapshot), renderModel, a new
 * game and reset().
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { GameState } from './GameState.js';
import { parseSnapshotV2, parseWatching } from './snapshotV2.js';

const DIR = fileURLToPath(new URL('../../../contract/fixtures/v2/', import.meta.url));
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const W = (names, count = names.length) => ({ spectators: names.map((username) => ({ username, pic: 2 })), count });

describe('snapshot v2 watching (additive 2026-11-11)', () => {
  it('is copied when well-formed, left out when absent or malformed (the rest still parses)', () => {
    const raw = load('trick-resolving').snapshot;
    expect(raw.watching.count).toBeGreaterThan(0);
    expect(parseSnapshotV2(raw).snapshot.watching).toEqual(raw.watching);
    const { watching, ...older } = raw;
    expect(watching).toBeTruthy();
    const r = parseSnapshotV2(older);
    expect(r.ok).toBe(true);
    expect(r.snapshot.watching).toBeUndefined();
    expect(parseSnapshotV2({ ...raw, watching: { spectators: [{ username: 7 }], count: 1 } }).snapshot.watching).toBeUndefined();
  });

  it('parseWatching: a stock pic out of range reads as none, a foreign URL is dropped, the cap holds', () => {
    expect(parseWatching({ spectators: [{ username: 'a', pic: 99, avatarUrl: 'https://x.test/a.png' }], count: 1 }))
      .toEqual({ spectators: [{ username: 'a', pic: null }], count: 1 });
    expect(parseWatching({ spectators: [{ username: 'c', pic: null, avatarUrl: '/avatar/c?v=0123456789abcdef' }], count: 3 }))
      .toEqual({ spectators: [{ username: 'c', pic: null, avatarUrl: '/avatar/c?v=0123456789abcdef' }], count: 3 });
    expect(parseWatching({ spectators: Array.from({ length: 51 }, (_, i) => ({ username: `u${i}`, pic: null })), count: 51 })).toBeNull();
    expect(parseWatching({ spectators: [{ username: 'a' }], count: 0 })).toBeNull(); // count below the list
  });
});

describe('GameState.watching', () => {
  it('applies this game\'s list, ignores another game\'s and a malformed one', () => {
    const s = new GameState();
    s.gameId = 'g1';
    expect(s.applySpectators({ gameId: 'g1', ...W(['ann']) })).toBe(true);
    expect(s.renderModel().watching).toEqual(W(['ann']));
    expect(s.applySpectators({ gameId: 'g2', ...W(['x', 'y']) })).toBe(false);
    expect(s.applySpectators({ gameId: 'g1', spectators: 'nope', count: 1 })).toBe(false);
    expect(s.watching).toEqual(W(['ann']));
  });

  it('a snapshot replaces it; one without it keeps this game\'s list and clears another game\'s', () => {
    const s = new GameState();
    s.applySnapshot({ gameId: 'g1', stage: 'BIDDING', viewer: { role: 'spectator' }, watching: W(['ann', 'bob'], 7) });
    expect(s.watching).toEqual(W(['ann', 'bob'], 7));
    s.applySnapshot({ gameId: 'g1', stage: 'BIDDING', viewer: { role: 'spectator' } });
    expect(s.watching.count).toBe(7);
    s.applySnapshot({ gameId: 'g9', stage: 'BIDDING', viewer: { role: 'spectator' } });
    expect(s.watching).toEqual({ spectators: [], count: 0 });
  });

  it('a new game (another gameId\'s deal) and reset() start with nobody', () => {
    const s = new GameState();
    s.gameId = 'g1';
    s.applySpectators({ gameId: 'g1', ...W(['ann']) });
    s.applyDeal({ gameId: 'g2', currentHand: 12, hand: [] });
    expect(s.watching.count).toBe(0);
    s.applySpectators({ gameId: 'g2', ...W(['bob']) });
    expect(s.watching.count).toBe(1);
    s.reset();
    expect(s.watching).toEqual({ spectators: [], count: 0 });
  });
});

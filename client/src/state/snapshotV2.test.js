// @vitest-environment node
// (reads the server fixtures from disk: file: URLs need the node environment)
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  SNAPSHOT_VERSION, STAGES, parseSnapshotV2, classifySeq, seatAt, relativeSeat, isComplete, teamOf, mergeSnapshot,
} from './snapshotV2.js';

// Server-generated fixtures (npm run contract:fixtures; contractFixtures.test.js)
const DIR = fileURLToPath(new URL('../../../contract/fixtures/v2/', import.meta.url));
const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
const parsed = (name) => {
  const r = parseSnapshotV2(load(name).snapshot);
  if (!r.ok) throw new Error(`${name}: ${r.errors.join('; ')}`);
  return r.snapshot;
};

describe('every server fixture parses', () => {
  it('has the fixtures the contract promises', () => {
    expect(index.snapshotVersion).toBe(SNAPSHOT_VERSION);
    expect(index.fixtures.map((f) => f.name).sort()).toEqual(['action-rejected', 'between-tricks', 'bidding-mid',
      'created-countdown', 'draw-in-progress', 'hand-resolving', 'lazy-at-seat', 'lazy-watcher', 'presence-mixed',
      'spectator-mid-hand', 'teams-announced', 'tournament-game', 'trick-mid-lead3', 'trick-resolving']);
  });

  it.each(index.fixtures.map((f) => [f.name, f]))('%s', (name, meta) => {
    const s = parsed(name);
    expect(s.v).toBe(2);
    expect(s.viewer.role).toBe(meta.viewerRole);
    expect(s.stage).toBe(meta.stage);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.bids.byPosition)).toBe(true);
  });
});

describe('fixture semantics', () => {
  it('created-countdown: an entrant before the draw', () => {
    const s = parsed('created-countdown');
    expect(s).toMatchObject({ stage: 'CREATED', viewer: { role: 'entrant' }, seats: [], hand: null, deal: null, turn: null });
    expect(s.entrants).toHaveLength(4);
  });

  it('draw-in-progress: two drawn incl. a bot, no seats, own draw order', () => {
    const s = parsed('draw-in-progress');
    expect(s.draw.drawn).toHaveLength(2);
    expect(s.draw.drawn.some((d) => d.isBot)).toBe(true);
    expect(s.seats).toEqual([]);
    expect(s.draw.viewerDrawOrder).toBe(1);
    expect(s.draw.drawn.every((d) => d.position === null)).toBe(true);
  });

  it('teams-announced: positions from the draw, no deal yet', () => {
    const s = parsed('teams-announced');
    expect(s.deal).toBeNull();
    expect(s.draw.drawn.map((d) => d.position).sort()).toEqual([1, 2, 3, 4]);
    expect(s.seats).toHaveLength(4);
  });

  it('bidding-mid: two bids (one a bore), multiplier shown, no team bids', () => {
    const s = parsed('bidding-mid');
    expect(s.bids.byPosition.filter((b) => b !== null)).toHaveLength(2);
    expect(s.bids.byPosition).toContain('B');
    expect(Math.max(s.bids.mults.team1, s.bids.mults.team2)).toBeGreaterThan(1);
    expect(s.bids.teamBids).toBeNull();
    expect(s.turn.action).toBe('bid');
    expect(s.viewer.canAct).toBe(true);
  });

  it('trick-mid-lead3: seat 3 led, play order kept', () => {
    const s = parsed('trick-mid-lead3');
    expect(s.trick.leadPosition).toBe(3);
    expect(s.trick.cards.map((c) => c.position)).toEqual([3, 4]);
    expect(s.trick.number).toBe(1);
    expect(s.turn).toEqual({ position: 1, action: 'play' });
  });

  it('trick-resolving: a spectator sees 4 cards and no turn', () => {
    const s = parsed('trick-resolving');
    expect(s.viewer.role).toBe('spectator');
    expect(s.trick.cards).toHaveLength(4);
    expect(s.turn).toBeNull();
    expect(s.hand).toBeNull();
  });

  it('between-tricks: no lead, no cards; the winner is on turn', () => {
    const s = parsed('between-tricks');
    expect(s.stage).toBe('PLAYING');
    expect(s.trick.cards).toEqual([]);
    expect(s.trick.leadPosition).toBeNull();
    expect(s.trick.number).toBe(2);
    expect(s.turn.action).toBe('play');
  });

  it('hand-resolving: no turn, empty hands', () => {
    const s = parsed('hand-resolving');
    expect(s.stage).toBe('HAND_RESOLVING');
    expect(s.turn).toBeNull();
    expect(s.hand).toEqual([]);
    expect(s.tricks.team1 + s.tricks.team2).toBe(s.deal.handSize);
  });

  it('lazy-at-seat and lazy-watcher: the owner of a bot-played seat', () => {
    const atSeat = parsed('lazy-at-seat');
    expect(atSeat.viewer).toMatchObject({ role: 'lazyWatcher', ownerView: 'seat', canAct: false });
    expect(seatAt(atSeat, atSeat.viewer.position)).toMatchObject({ controller: 'lazyBot', lazy: true, isBot: true });
    const watcher = parsed('lazy-watcher');
    expect(watcher.viewer).toMatchObject({ role: 'lazyWatcher', ownerView: 'watch' });
    expect(watcher.hand.length).toBeGreaterThan(0);
  });

  it('spectator-mid-hand: no hand, no HSI', () => {
    const s = parsed('spectator-mid-hand');
    expect(s).toMatchObject({ viewer: { role: 'spectator', position: null }, hand: null, hsi: null });
    expect(s.spectatorCount).toBeGreaterThan(0);
  });

  it('presence-mixed: grace, resignable + offered, lazy', () => {
    const s = parsed('presence-mixed');
    const by = (p) => seatAt(s, p);
    expect(by(1)).toMatchObject({ presence: 'resignable', offered: true });
    expect(by(1).resignableAt).not.toBeNull();
    expect(by(2)).toMatchObject({ presence: 'grace', offered: false });
    expect(by(2).graceDeadline).not.toBeNull();
    expect(by(3)).toMatchObject({ controller: 'lazyBot', lazy: true });
  });

  it('tournament-game: round 1 of 4', () => {
    const s = parsed('tournament-game');
    expect(s.tournament).toMatchObject({ roundNumber: 1, totalRounds: 4 });
    expect(s.stage).toBe('BIDDING');
  });

  it('action-rejected: no log, no custom pictures', () => {
    const s = parsed('action-rejected');
    expect(s.partial).toEqual(['customPics', 'log']);
    expect(isComplete(s)).toBe(false);
    expect(s.log).toEqual([]);
    expect(s.seats.some((x) => x.hasCustomPic && x.customPic === null)).toBe(true);
  });
});

describe('mergeSnapshot: a partial snapshot keeps what it left out (README R5)', () => {
  it('actionRejected (no log, no custom pictures) after a full snapshot keeps the log and the picture', () => {
    const prev = parsed('trick-mid-lead3');
    const next = parsed('action-rejected');
    const m = mergeSnapshot(prev, next);
    expect(m.partial).toEqual([]);
    expect(m.log).toEqual(prev.log);
    expect(m.log.length).toBeGreaterThan(0);
    expect(seatAt(m, 2)).toMatchObject({ username: 'kim', hasCustomPic: true, customPic: seatAt(prev, 2).customPic });
    // everything else is the new snapshot's
    expect({ ...m, log: null, seats: null }).toEqual({ ...next, log: null, seats: null, partial: [] });
    expect(Object.isFrozen(m)).toBe(true);
    expect(isComplete(m)).toBe(true);
  });

  it('with nothing to keep (first snapshot, or another game) what is missing stays listed', () => {
    const next = parsed('action-rejected');
    expect(mergeSnapshot(null, next).partial).toEqual(['customPics', 'log']);
    const other = { ...parsed('trick-mid-lead3'), gameId: 'another-game' };
    const m = mergeSnapshot(other, next);
    expect(m.partial).toEqual(['customPics', 'log']);
    expect(m.log).toEqual([]);
  });

  it('pictures can come from the v1 payload the snapshot rode on (players[].pic by username)', () => {
    const next = parsed('spectator-mid-hand');
    expect(next.partial).toEqual(['customPics']);
    const m = mergeSnapshot(null, next, { pics: { kim: 'data:image/png;base64,AAAA', ivy: 12 } });
    expect(m.partial).toEqual([]);
    expect(m.seats.find((x) => x.username === 'kim').customPic).toBe('data:image/png;base64,AAAA');
    expect(m.log).toEqual(next.log);
  });

  it('a seat whose player changed does not inherit the old picture', () => {
    const prev = parsed('trick-mid-lead3');
    const next = JSON.parse(JSON.stringify(load('action-rejected').snapshot));
    next.seats[1].username = 'someone-else';
    const m = mergeSnapshot(prev, parseSnapshotV2(next).snapshot);
    expect(m.partial).toEqual(['customPics']);
    expect(m.seats[1].customPic).toBeNull();
  });
});

describe('the parser rejects malformed snapshots', () => {
  const base = () => JSON.parse(JSON.stringify(load('trick-mid-lead3').snapshot));

  it('v:1', () => {
    const s = base();
    s.v = 1;
    expect(parseSnapshotV2(s).ok).toBe(false);
  });

  it('a missing seats key', () => {
    const s = base();
    delete s.seats;
    const r = parseSnapshotV2(s);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/seats/);
  });

  it('an unknown stage', () => {
    const s = base();
    s.stage = 'PLAYING_FAST';
    expect(parseSnapshotV2(s).ok).toBe(false);
  });

  it('a 3-length array', () => {
    const s = base();
    s.bids.byPosition.pop();
    expect(parseSnapshotV2(s).ok).toBe(false);
  });

  it('a card without a suit', () => {
    const s = base();
    delete s.hand[0].suit;
    expect(parseSnapshotV2(s).ok).toBe(false);
  });

  it('a hand for a spectator', () => {
    const s = JSON.parse(JSON.stringify(load('spectator-mid-hand').snapshot));
    s.hand = [];
    expect(parseSnapshotV2(s).ok).toBe(false);
  });

  it('not an object', () => {
    expect(parseSnapshotV2(null).ok).toBe(false);
    expect(parseSnapshotV2('x').ok).toBe(false);
  });

  it('tolerates (and drops) an unknown key', () => {
    const s = base();
    s.futureField = { a: 1 };
    const r = parseSnapshotV2(s);
    expect(r.ok).toBe(true);
    expect('futureField' in r.snapshot).toBe(false);
  });
});

describe('helpers', () => {
  it.each([
    [0, 1, 'next'], [5, 6, 'next'], [5, 5, 'stale'], [5, 3, 'stale'], [5, 7, 'gap'], [0, 9, 'gap'],
  ])('classifySeq(%i, %i) = %s', (last, seq, want) => {
    expect(classifySeq(last, seq)).toBe(want);
  });

  it('relativeSeat: 0 self, 2 partner; spectators view from seat 1', () => {
    expect(relativeSeat(3, 3)).toBe(0);
    expect(relativeSeat(3, 1)).toBe(2);
    expect(relativeSeat(3, 4)).toBe(1);
    expect(relativeSeat(null, 2)).toBe(1);
  });

  it('teamOf and seatAt', () => {
    expect([1, 2, 3, 4].map(teamOf)).toEqual([1, 2, 1, 2]);
    expect(seatAt(parsed('created-countdown'), 1)).toBeNull();
    expect(STAGES).toHaveLength(12);
  });
});

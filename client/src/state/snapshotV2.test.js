// @vitest-environment node
// (reads the server fixtures from disk: file: URLs need the node environment)
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
// node:path: phaser (devDependency) installs the npm 'path' polyfill, which a bare 'path' resolves to here
import path from 'node:path';
import { fileURLToPath } from 'url';
import {
  SNAPSHOT_VERSION, STAGES, parseSnapshotV2, classifySeq, seatAt, relativeSeat, isComplete, teamOf, mergeSnapshot,
} from './snapshotV2.js';

// Server-generated fixtures (npm run contract:fixtures; contractFixtures.test.js)
const DIR = fileURLToPath(new URL('../../../contract/fixtures/v2/', import.meta.url));
const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const load = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
// strict: every enum value the server sends today is one the client knows
const parsed = (name) => {
  const r = parseSnapshotV2(load(name).snapshot, { strict: true });
  if (!r.ok) throw new Error(`${name}: ${r.errors.join('; ')}`);
  expect(r.warnings).toEqual([]);
  return r.snapshot;
};

describe('every server fixture parses', () => {
  it('has the fixtures the contract promises', () => {
    expect(index.snapshotVersion).toBe(SNAPSHOT_VERSION);
    expect(index.fixtures.map((f) => f.name).sort()).toEqual(['action-rejected', 'between-tricks', 'bid-clock-running', 'bidding-mid',
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

  it('action-rejected: no log; a custom picture is never inline (V1_REMOVALS #19 C)', () => {
    const s = parsed('action-rejected');
    expect(s.partial).toEqual(['log']);
    expect(isComplete(s)).toBe(false);
    expect(s.log).toEqual([]);
    expect(s.seats.some((x) => x.hasCustomPic && x.customPic === null)).toBe(true);
  });
});

// Since V1_REMOVALS #19 C the server never withholds a picture (customPic is
// always null, partial never lists 'customPics'); mergeSnapshot still handles
// that older shape, so these build it from the fixtures: the held picture
// (withPic) and the withheld one (withheld).
const PIC = 'data:image/png;base64,AAAA';
const withPic = (name, username = 'kim') => {
  const raw = JSON.parse(JSON.stringify(load(name).snapshot));
  raw.seats.find((x) => x.username === username).customPic = PIC;
  return parseSnapshotV2(raw).snapshot;
};
const withheld = (name, mutate = () => {}) => {
  const raw = JSON.parse(JSON.stringify(load(name).snapshot));
  if (raw.seats.some((x) => x.hasCustomPic) && !raw.partial.includes('customPics')) raw.partial = ['customPics', ...raw.partial];
  mutate(raw);
  return parseSnapshotV2(raw).snapshot;
};

describe('mergeSnapshot: a partial snapshot keeps what it left out (README R5)', () => {
  it('actionRejected (no log, no custom pictures) after a full snapshot keeps the log and the picture', () => {
    const prev = withPic('trick-mid-lead3');
    const next = withheld('action-rejected');
    const m = mergeSnapshot(prev, next);
    expect(m.partial).toEqual([]);
    expect(m.log).toEqual(prev.log);
    expect(m.log.length).toBeGreaterThan(0);
    expect(seatAt(m, 2)).toMatchObject({ username: 'kim', hasCustomPic: true, customPic: PIC });
    // everything else is the new snapshot's
    expect({ ...m, log: null, seats: null }).toEqual({ ...next, log: null, seats: null, partial: [] });
    expect(Object.isFrozen(m)).toBe(true);
    expect(isComplete(m)).toBe(true);
  });

  it('the server snapshot as sent since #19: only the log is kept, the seat stays null (its URL is avatarUrl)', () => {
    const prev = parsed('trick-mid-lead3');
    const m = mergeSnapshot(prev, parsed('action-rejected'));
    expect(m.partial).toEqual([]);
    expect(m.log).toEqual(prev.log);
    expect(seatAt(m, 2)).toMatchObject({ username: 'kim', hasCustomPic: true, customPic: null });
  });

  it('with nothing to keep (first snapshot, or another game) what is missing stays listed', () => {
    const next = withheld('action-rejected');
    expect(mergeSnapshot(null, next).partial).toEqual(['customPics', 'log']);
    const other = { ...withPic('trick-mid-lead3'), gameId: 'another-game' };
    const m = mergeSnapshot(other, next);
    expect(m.partial).toEqual(['customPics', 'log']);
    expect(m.log).toEqual([]);
  });

  it('pictures can come from the v1 payload the snapshot rode on (players[].pic by username)', () => {
    const next = withheld('spectator-mid-hand');
    expect(next.partial).toEqual(['customPics']);
    const m = mergeSnapshot(null, next, { pics: { kim: PIC, ivy: 12 } });
    expect(m.partial).toEqual([]);
    expect(m.seats.find((x) => x.username === 'kim').customPic).toBe(PIC);
    expect(m.log).toEqual(next.log);
  });

  it('a seat whose player changed does not inherit the old picture', () => {
    const prev = withPic('trick-mid-lead3');
    const next = withheld('action-rejected', (raw) => { raw.seats[1].username = 'someone-else'; });
    const m = mergeSnapshot(prev, next);
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

  it('strict (the fixture sweep): an unknown enum value is an error', () => {
    const s = base();
    s.seats[0].presence = 'ghost';
    const r = parseSnapshotV2(s, { strict: true });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/\$\.seats\[0\]\.presence: expected one of .*got "ghost"/);
  });

  it('an enum value that is not even a string is still an error', () => {
    const s = base();
    s.seats[0].controller = 7;
    expect(parseSnapshotV2(s).ok).toBe(false);
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

describe('optional resume (never required)', () => {
  it('a snapshot without resume still parses, and carries none', () => {
    const raw = load('trick-resolving').snapshot;
    const { resume, ...old } = raw;
    expect(resume).toBeDefined();
    const r = parseSnapshotV2(old);
    expect(r.ok).toBe(true);
    expect('resume' in r.snapshot).toBe(false);
  });

  it('copies a valid resume, frozen', () => {
    const s = parsed('trick-resolving');
    expect(s.resume).toEqual({ kind: 'trick', inMs: expect.any(Number) });
    expect(Object.isFrozen(s.resume)).toBe(true);
    expect(parsed('between-tricks').resume).toBeNull();
  });

  it('drops a malformed resume instead of failing the snapshot', () => {
    const raw = { ...load('trick-resolving').snapshot, resume: { kind: 'nap', inMs: -1 } };
    const r = parseSnapshotV2(raw);
    expect(r.ok).toBe(true);
    expect('resume' in r.snapshot).toBe(false);
  });
});

describe('unknown enum values from a newer server (later #17: as iOS, .unknown(raw))', () => {
  const base = () => JSON.parse(JSON.stringify(load('presence-mixed').snapshot));

  it('kept as the raw value with a warning, not a refused snapshot', () => {
    const s = base();
    s.seats[0].presence = 'napping';
    s.seats[1].controller = 'coachBot';
    s.partial = ['futureThing'];
    const r = parseSnapshotV2(s);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      '$.partial[0]: unknown value "futureThing"',
      '$.seats[0].presence: unknown value "napping"',
      '$.seats[1].controller: unknown value "coachBot"',
    ]);
    expect(r.snapshot.seats[0].presence).toBe('napping');
    // ... which none of the known values match: the table treats it as unknown
    expect(['connected', 'grace', 'resignable', 'away', 'gone', 'none']).not.toContain(r.snapshot.seats[0].presence);
    // an unknown partial key is still "something was left out"
    expect(isComplete(r.snapshot)).toBe(false);
  });

  it('an unknown owner view, turn action or entrant presence', () => {
    const s = base();
    s.viewer.ownerView = 'umpire';
    if (s.turn) s.turn.action = 'pass';
    const r = parseSnapshotV2(s);
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/viewer\.ownerView.*umpire/);
    const e = JSON.parse(JSON.stringify(load('created-countdown').snapshot));
    e.entrants[0].presence = 'teleported';
    expect(parseSnapshotV2(e)).toMatchObject({ ok: true, warnings: ['$.entrants[0].presence: unknown value "teleported"'] });
  });

  it('still closed: an unknown stage (a table this build cannot show; iOS unknownStage), a bad card, a broken shape', () => {
    const stage = base();
    stage.stage = 'OVERTIME';
    expect(parseSnapshotV2(stage).ok).toBe(false);
    // the viewer role picks the layout: web draws any role but spectator /
    // lazyWatcher as a seat, so an unknown one falls back to the v1 fields
    for (const hand of [[], null]) {
      const role = base();
      role.viewer.role = 'referee';
      role.hand = hand;
      expect(parseSnapshotV2(role)).toMatchObject({ ok: false });
      expect(parseSnapshotV2(role).errors.join()).toMatch(/viewer\.role/);
    }
    const card = base();
    if (card.hand?.length) {
      card.hand[0].suit = 'stars';
      expect(parseSnapshotV2(card).ok).toBe(false);
    }
    const shape = base();
    shape.seats[0].presence = null;
    expect(parseSnapshotV2(shape).ok).toBe(false);
  });
});

describe('the optional per-viewer and per-line extras (2026-11-19)', () => {
  it('viewer.assist: a seat owner\'s fixture has it, a spectator\'s has none; a malformed one is dropped with a warning', () => {
    expect(parsed('hand-resolving').viewer.assist).toEqual({ uses: 0, freeUses: 3, assisted: false });
    expect(parsed('spectator-mid-hand').viewer).not.toHaveProperty('assist');
    const raw = load('hand-resolving').snapshot;
    const bad = parseSnapshotV2({ ...raw, viewer: { ...raw.viewer, assist: { uses: -1, freeUses: 3, assisted: false } } });
    expect(bad.ok).toBe(true);
    expect(bad.snapshot.viewer).not.toHaveProperty('assist');
    expect(bad.warnings.some((w) => w.startsWith('$.viewer.assist'))).toBe(true);
  });

  it('a log item\'s fault is kept as sent', () => {
    const raw = load('hand-resolving').snapshot;
    const fault = { position: 2, bid: 3, took: 1 };
    const log = [...raw.log, { message: 'Fault: bob (bid 3, took 1)', type: 'system', position: null, at: 1, fault }];
    const r = parseSnapshotV2({ ...raw, log }, { strict: true });
    expect(r.ok).toBe(true);
    expect(r.snapshot.log.at(-1).fault).toEqual(fault);
  });
});

// A tournament table's planned teams (2026-11-25; contract/fixtures/pairings)
describe('draw.teams (a tournament table\'s draw for first deal)', () => {
  const PDIR = fileURLToPath(new URL('../../../contract/fixtures/pairings/', import.meta.url));
  const pairings = JSON.parse(fs.readFileSync(path.join(PDIR, 'events.json'), 'utf8'));
  const snapOf = (mode) => pairings[mode].find((e) => e.event === 'stateSnapshot').data.snapshot;

  it.each(['honest'])('%s: the server\'s mid-draw snapshot keeps its 2 x 2 teams', (mode) => {
    const r = parseSnapshotV2(snapOf(mode), { strict: true });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    const { teams } = r.snapshot.draw;
    expect(teams).toHaveLength(2);
    for (const t of teams) {
      expect(t).toHaveLength(2);
      for (const p of t) expect(Object.keys(p).sort()).toEqual(['isBot', 'username']);
    }
    // and startDraw named the same teams
    const start = pairings[mode].find((e) => e.event === 'startDraw').data.teams;
    expect(teams).toEqual(start);
    expect(Object.isFrozen(teams[0][0])).toBe(true);
  });

  it('absent (a casual table, an older server): no key', () => {
    const r = parseSnapshotV2(load('draw-in-progress').snapshot, { strict: true });
    expect(r.ok).toBe(true);
    expect('teams' in r.snapshot.draw).toBe(false);
  });

  it.each([
    ['one team', (t) => [t[0]]],
    ['a team of one', (t) => [[t[0][0]], t[1]]],
    ['no username', (t) => [[t[0][0], { isBot: false }], t[1]]],
    ['not an array', () => 'teams'],
  ])('malformed (%s): dropped with a warning, the snapshot still applies', (_label, mangle) => {
    const raw = JSON.parse(JSON.stringify(snapOf('honest')));
    raw.draw.teams = mangle(raw.draw.teams);
    const r = parseSnapshotV2(raw);
    expect(r.ok).toBe(true);
    expect('teams' in r.snapshot.draw).toBe(false);
    expect(r.warnings).toEqual(['$.draw.teams: malformed, dropped']);
  });
});

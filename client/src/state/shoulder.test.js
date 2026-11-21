// @vitest-environment node
// (reads the server's shoulder fixture from disk)
/**
 * The over-the-shoulder view's state (docs/claude/spectators.md
 * "Over-the-shoulder view"): the helpers, the parse of viewer.shoulder and
 * the entries' shoulder, GameState drawing the table from the watched seat
 * (applySnapshot, applyDeal, applyCardPlayed, renderModel, a stop, the
 * paused hold), the mirrored hints' liveness and footer, and ShoulderWatch:
 * what it sends and when (the default, a remembered pick, Table view, every
 * refusal, the re-send rule and the paused rule). The payloads are the
 * server's own (contract/fixtures/shoulder/events.json, a real game).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { GameState } from './GameState.js';
import { parseSnapshotV2, parseWatching } from './snapshotV2.js';
import { hintIsLive, assistFooter, isWatchedHint, FOOTER_BOT } from './assistHint.js';
import {
  ShoulderWatch, validShoulder, isShoulder, isPureSpectator, isViewedSeat, firstHumanSeat, ownSeatOf,
  watchersBySeat, watchTitle, watcherRow, watchingPillText, pausedText, PAUSE_LINE, RESUME_LINE, STORAGE_KEY,
} from './shoulder.js';

const FIXTURE = fileURLToPath(new URL('../../../contract/fixtures/shoulder/events.json', import.meta.url));
const events = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).events;
const pick = (name) => JSON.parse(JSON.stringify(events.find((e) => e.event === name).data));
const parse = (raw) => {
  const r = parseSnapshotV2(raw);
  expect(r.ok).toBe(true);
  return r.snapshot;
};

/** The watchHand reply for seat 2 (pia), scored so the sides differ. */
function replyRaw() {
  const raw = pick('stateSnapshot').snapshot;
  raw.score = { team1: 120, team2: -40 };
  return raw;
}
/** A full state of the same table without a watch (spectatorJoined, a reconnect). */
function fullRaw() {
  const raw = replyRaw();
  delete raw.viewer.shoulder;
  raw.partial = [];
  return raw;
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

let gs;
let sent;
let views;
let storage;
let watch;

beforeEach(() => {
  gs = new GameState();
  gs.username = 'sid';
  sent = [];
  views = 0;
  storage = memoryStorage();
  watch = new ShoulderWatch({ getState: () => gs, emit: (ev, p) => sent.push([ev, p]), onView: () => { views++; }, storage: () => storage });
});

const positions = () => sent.map(([ev, p]) => (ev === 'watchHand' ? p.position : `?${ev}`));

describe('helpers and words', () => {
  it('validShoulder takes a seat, real cards and a numeric HSI; anything else is null', () => {
    expect(validShoulder({ position: 2, hand: [{ suit: 'joker', rank: 'HI' }], hsi: 98.5 })).toEqual({ position: 2, hand: [{ suit: 'joker', rank: 'HI' }], hsi: 98.5 });
    expect(validShoulder({ position: 2, hand: [], hsi: null })).toEqual({ position: 2, hand: [], hsi: null });
    expect(validShoulder({ position: 0, hand: [] })).toBeNull();
    expect(validShoulder({ position: 2, hand: [{ suit: 'stars', rank: 'A' }] })).toBeNull();
    expect(validShoulder({ position: 2 })).toBeNull();
    expect(validShoulder(null)).toBeNull();
  });

  it('a watcher, a pure spectator and the viewed seat', () => {
    expect(isPureSpectator({ isSpectator: true })).toBe(true);
    expect(isShoulder({ isSpectator: true, shoulder: { position: 3 } })).toBe(true);
    expect(isPureSpectator({ isSpectator: true, shoulder: { position: 3 } })).toBe(false);
    expect(isShoulder({ isSpectator: true, isLazy: true, shoulder: { position: 3 } })).toBe(false);
    expect(isShoulder({ isSpectator: false, shoulder: { position: 3 } })).toBe(false);
    expect(isViewedSeat({ position: 2 }, 2)).toBe(true);
    expect(isViewedSeat({ position: 1, isSpectator: true }, 1)).toBe(false);
    expect(isViewedSeat({ position: 3, isSpectator: true, shoulder: { position: 3 } }, 3)).toBe(true);
  });

  it('the first human seat in seat order, seat 1 if none; my own seat by name', () => {
    expect(firstHumanSeat({ humanOwners: { 3: 'c', 2: 'b' } })).toBe(2);
    expect(firstHumanSeat({ humanOwners: {} })).toBe(1);
    expect(ownSeatOf({ username: 'b', seatOwners: { 1: 'a', 2: 'b' } })).toBe(2);
    expect(ownSeatOf({ username: 'z', seatOwners: { 1: 'a' } })).toBeNull();
  });

  it('by names, never seats or teams', () => {
    expect(watchTitle(['Zach'], 'Alice')).toBe("Zach is watching Alice's hand");
    expect(watchTitle(['Zach', 'Yan'], 'Alice')).toBe("Zach and Yan are watching Alice's hand");
    expect(watchTitle(['Zach', 'Yan', 'Xi'], 'Alice')).toBe("Zach, Yan and Xi are watching Alice's hand");
    expect(watchTitle(['Zach'], 'Alice', { me: 'Zach' })).toBe("You are watching Alice's hand");
    expect(watchTitle(['Zach'], 'Alice', { mine: true })).toBe('Zach is watching your hand');
    expect(watcherRow('Zach', 'Alice')).toBe('Zach · watching Alice');
    expect(watcherRow('Zach', null)).toBe('Zach');
    expect(watchingPillText('Alice')).toBe("Watching Alice's hand");
    expect(watchingPillText('Alice', { paused: true })).toBe("Watching Alice's hand · paused");
    expect(pausedText('Alice')).toBe("Paused: Alice's hand comes back when the game resumes.");
    expect(watchersBySeat({ spectators: [{ username: 'a', shoulder: 2 }, { username: 'b' }, { username: 'c', shoulder: 2 }] })).toEqual({ 2: ['a', 'c'] });
  });
});

describe('parsing (snapshot v2, spectatorsUpdated)', () => {
  it('viewer.shoulder is kept; a malformed one is dropped with a warning, the snapshot still applies', () => {
    const raw = replyRaw();
    expect(parse(raw).viewer.shoulder.position).toBe(2);
    raw.viewer.shoulder = { position: 9, hand: [] };
    const r = parseSnapshotV2(raw);
    expect(r.ok).toBe(true);
    expect(r.snapshot.viewer.shoulder).toBeUndefined();
    expect(r.warnings.some((w) => w.includes('viewer.shoulder'))).toBe(true);
  });

  it('an entry\'s shoulder (1-4) is kept, anything else left out', () => {
    expect(parseWatching(pick('spectatorsUpdated'))).toEqual({ spectators: [{ username: 'sid', pic: 7, shoulder: 2 }], count: 1 });
    expect(parseWatching({ spectators: [{ username: 'a', pic: 1, shoulder: 0 }, { username: 'b', pic: 1, shoulder: '2' }], count: 2 }).spectators)
      .toEqual([{ username: 'a', pic: 1 }, { username: 'b', pic: 1 }]);
  });
});

describe('GameState draws a watcher\'s table from the watched seat', () => {
  it('the watchHand reply: seat 2 at the bottom, its hand and HSI; the wire\'s viewer.position stays null', () => {
    const snap = parse(replyRaw());
    expect(snap.viewer.position).toBeNull();
    gs.applySnapshot(snap);
    expect(gs.isSpectator).toBe(true);
    expect(gs.shoulder).toEqual({ position: 2, paused: false });
    expect(gs.position).toBe(2);
    expect(gs.myCards).toEqual(snap.viewer.shoulder.hand);
    expect(gs.hsiValues).toEqual({ 2: snap.viewer.shoulder.hsi });
    // seat 2's side first: team 2's score is "mine"
    expect([gs.teamScore, gs.oppScore]).toEqual([-40, 120]);
    const m = gs.renderModel();
    expect(m.viewer).toEqual({ role: 'spectator', position: 2, canAct: false, shoulder: { position: 2, paused: false } });
    expect(m.hand).toHaveLength(12);
    expect(m.hsi).toBe(snap.viewer.shoulder.hsi);
    expect(m.seatCards[2]).toBe(12);
    // nothing can act, whoever's turn it is (seat 2 bids now)
    expect(gs.currentTurn).toBe(2);
    expect(gs.canAct()).toBe(false);
  });

  it('a plain spectator\'s model is as before: seat 1, no hand, no shoulder key', () => {
    gs.applySnapshot(parse(fullRaw()));
    expect(gs.shoulder).toBeNull();
    expect(gs.position).toBe(1);
    const m = gs.renderModel();
    expect(m.viewer).toEqual({ role: 'spectator', position: 1, canAct: false });
    expect(m.hand).toBeNull();
    expect([gs.teamScore, gs.oppScore]).toEqual([120, -40]);
  });

  it('a seat owner\'s snapshot never takes a shoulder (it is a spectator\'s key only)', () => {
    const raw = replyRaw();
    raw.viewer = { ...raw.viewer, role: 'seat', position: 1, ownerView: 'seat', canAct: false };
    raw.hand = [{ suit: 'hearts', rank: 'A' }];
    gs.applySnapshot(parse(raw));
    expect(gs.shoulder).toBeNull();
    expect(gs.position).toBe(1);
  });

  it('cardPlayed: the watched seat\'s card leaves its hand; another seat\'s only its count', () => {
    const raw = replyRaw();
    raw.stage = 'PLAYING';
    raw.turn = { position: 2, action: 'play' };
    raw.bids.byPosition = ['1', '1', '2', '1'];
    gs.applySnapshot(parse(raw));
    const card = gs.myCards[3];
    gs.applyCardPlayed({ position: 1, card: { suit: 'hearts', rank: 'K' } });
    expect(gs.myCards).toHaveLength(12);
    gs.applyCardPlayed({ position: 2, card });
    expect(gs.myCards).toHaveLength(11);
    expect(gs.myCards).not.toContainEqual(card);
    expect(gs.hasPlayedCard).toBe(true);
    expect(gs.renderModel().seatCards[2]).toBe(11);
  });

  it('a deal: the watched seat\'s new hand and its HSI only (gameStart.shoulder)', () => {
    gs.applySnapshot(parse(replyRaw()));
    const deal = pick('gameStart');
    gs.applyDeal(deal);
    expect(gs.position).toBe(2);
    expect(gs.myCards).toEqual(deal.shoulder.hand);
    expect(gs.hsiValues).toEqual({ 2: deal.shoulder.hsi });
    // a deal without it while watching: no stale cards (ShoulderWatch asks again)
    const { shoulder, ...plain } = deal;
    expect(shoulder).toBeTruthy();
    gs.applyDeal(plain);
    expect(gs.myCards).toEqual([]);
    expect(gs.hsiValues).toEqual({});
  });

  it('Table view (applyShoulderStop): seat 1 again, the sides turned back, no hand', () => {
    gs.applySnapshot(parse(replyRaw()));
    expect(gs.applyShoulderStop()).toBe(true);
    expect(gs.shoulder).toBeNull();
    expect(gs.position).toBe(1);
    expect(gs.myCards).toEqual([]);
    expect([gs.teamScore, gs.oppScore]).toEqual([120, -40]);
    expect(gs.renderModel().hand).toBeNull();
    expect(gs.applyShoulderStop()).toBe(false);
  });

  it('the paused hold: the seat stays, its hand area empty, through a snapshot without viewer.shoulder; another game drops it', () => {
    gs.applySnapshot(parse(replyRaw()));
    gs.setShoulderHold(2);
    expect(gs.shoulder).toEqual({ position: 2, paused: true });
    expect(gs.myCards).toEqual([]);
    gs.applySnapshot(parse(fullRaw()));
    expect(gs.shoulder).toEqual({ position: 2, paused: true });
    expect(gs.position).toBe(2);
    expect(gs.myCards).toEqual([]);
    expect(gs.renderModel().viewer.shoulder).toEqual({ position: 2, paused: true });
    // the reply restores it
    gs.applySnapshot(parse(replyRaw()));
    expect(gs.shoulder).toEqual({ position: 2, paused: false });
    expect(gs.myCards).toHaveLength(12);
    // another game: nothing held
    gs.setShoulderHold(2);
    const other = fullRaw();
    other.gameId = '00000000-0000-4000-8000-000000000009';
    gs.applySnapshot(parse(other));
    expect(gs.shoulder).toBeNull();
    expect(gs.position).toBe(1);
  });
});

describe('mirrored hints (assistHint watched)', () => {
  it('live on the watched seat\'s own turn only, while watching it (not paused)', () => {
    const hint = pick('assistHint');
    expect(isWatchedHint(hint)).toBe(true);
    gs.applySnapshot(parse(fullRaw()));
    expect(hintIsLive(hint, gs)).toBe(false);
    gs.applySnapshot(parse(replyRaw()));
    expect(hintIsLive(hint, gs)).toBe(true);
    // (nothing of mine is ever pending for it)
    expect(hintIsLive(hint, gs, { pending: true })).toBe(true);
    expect(hintIsLive({ ...hint, watched: 3 }, gs)).toBe(false);
    gs.setShoulderHold(2);
    expect(hintIsLive(hint, gs)).toBe(false);
  });

  it('the footer never shows the watched player\'s counts', () => {
    const hint = pick('assistHint');
    expect(hint.uses).toBe(1);
    expect(assistFooter(hint)).toBe(FOOTER_BOT);
    expect(assistFooter({ ...hint, uses: 4, assisted: true })).toBe(FOOTER_BOT);
    expect(assistFooter({ ...hint, confidence: 'only' })).toBe(FOOTER_BOT);
    expect(assistFooter({ ...hint, counted: false })).toBe(FOOTER_BOT);
    // my own still counts
    const { watched, ...own } = hint;
    expect(watched).toBe(2);
    expect(assistFooter(own)).toBe(`${FOOTER_BOT} · Help 1 of 3 free`);
  });
});

describe('ShoulderWatch: what is sent, and when', () => {
  it('a full state watches the first human seat; its reply is no reason to ask again', () => {
    const full = parse(fullRaw());
    gs.applySnapshot(full);
    watch.afterFullState(full);
    expect(sent).toEqual([['watchHand', { gameId: full.gameId, position: 1 }]]);
    const reply = parse(replyRaw());
    gs.applySnapshot(reply);
    watch.afterReply(reply);
    expect(watch.selected).toBe(2);
    expect(sent).toHaveLength(1);
    // a later full state that serves the same seat: nothing to send
    watch.afterFullState(reply);
    expect(sent).toHaveLength(1);
  });

  it('the re-send rule: a full state without viewer.shoulder sends the watch again', () => {
    const full = parse(fullRaw());
    gs.applySnapshot(full);
    watch.afterFullState(full);
    gs.applySnapshot(full);
    watch.afterFullState(full);
    expect(positions()).toEqual([1, 1]);
  });

  it('the person\'s pick for this game wins over the default (sessionStorage)', () => {
    const full = parse(fullRaw());
    gs.applySnapshot(full);
    watch.afterFullState(full);
    watch.choose(3);
    expect(JSON.parse(storage.getItem(STORAGE_KEY))).toEqual({ gameId: full.gameId, choice: 3 });
    const again = new ShoulderWatch({ getState: () => gs, emit: (ev, p) => sent.push([ev, p]), storage: () => storage });
    again.afterFullState(full);
    expect(positions()).toEqual([1, 3, 3]);
  });

  it('Table view: watchHand(null), the plain view at once, remembered; no default after it', () => {
    const reply = parse(replyRaw());
    gs.applySnapshot(reply);
    watch.afterReply(reply);
    expect(watch.stop()).toBe(true);
    expect(positions()).toEqual([null]);
    expect(gs.shoulder).toBeNull();
    expect(gs.position).toBe(1);
    expect(views).toBe(1);
    const full = parse(fullRaw());
    gs.applySnapshot(full);
    watch.afterFullState(full);
    expect(positions()).toEqual([null]);
    // an avatar click watches again (and is remembered)
    expect(watch.avatarClick(4)).toBe('watch');
    expect(positions()).toEqual([null, 4]);
    expect(JSON.parse(storage.getItem(STORAGE_KEY)).choice).toBe(4);
  });

  it('an avatar click: another seat watches it; the watched seat, a seat owner\'s page and no deal open the profile', () => {
    const reply = parse(replyRaw());
    gs.applySnapshot(reply);
    watch.afterReply(reply);
    expect(watch.avatarClick(2)).toBe('profile');
    expect(watch.avatarClick(1)).toBe('watch');
    expect(positions()).toEqual([1]);
    const seat = new GameState();
    const w2 = new ShoulderWatch({ getState: () => seat, emit: (ev, p) => sent.push([ev, p]), storage: () => storage });
    seat.isSpectator = false;
    seat.handNo = 1;
    expect(w2.avatarClick(3)).toBe('profile');
    const early = new GameState();
    early.isSpectator = true;
    const w3 = new ShoulderWatch({ getState: () => early, emit: (ev, p) => sent.push([ev, p]), storage: () => storage });
    expect(w3.avatarClick(3)).toBe('profile');
    expect(positions()).toEqual([1]);
  });

  it('never at a tournament table: nothing sent, every avatar a profile', () => {
    const raw = fullRaw();
    raw.tournament = { tournamentId: 'tour-1', name: 'Friday', roundNumber: 1, totalRounds: 4 };
    const snap = parseSnapshotV2(raw);
    expect(snap.ok).toBe(true);
    gs.applySnapshot(snap.snapshot);
    expect(gs.tournamentTable).toBe(true);
    watch.afterFullState(snap.snapshot);
    expect(sent).toEqual([]);
    expect(watch.allowed()).toBe(false);
    expect(watch.avatarClick(2)).toBe('profile');
  });

  it('the tournament refusal drops the view and offers nothing more', () => {
    const reply = parse(replyRaw());
    gs.applySnapshot(reply);
    watch.afterReply(reply);
    expect(watch.onRefused({ gameId: reply.gameId, position: 3, reason: 'tournament', message: 'x' })).toBe('blocked');
    expect(gs.shoulder).toBeNull();
    expect(watch.avatarClick(3)).toBe('profile');
  });

  it('the own-seat rule: my username\'s seat only (seatOwners), and the own_seat refusal switches silently', () => {
    gs.username = 'pia';
    const full = parse(fullRaw());
    gs.applySnapshot(full);
    watch.afterFullState(full);
    expect(positions()).toEqual([2]);
    expect(watch.avatarClick(3)).toBe('profile');
    gs.username = 'sid';
    const w = new ShoulderWatch({ getState: () => gs, emit: (ev, p) => sent.push([ev, p]), storage: () => storage });
    w.afterFullState(full);
    expect(w.onRefused(pick('watchHandRefused'))).toBe('own_seat');
    expect(positions()).toEqual([2, 1, 1]);
    expect(w.selected).toBe(1);
    expect(w.avatarClick(3)).toBe('profile');
  });

  it('the own-seat rule never forces a watch: Table view sticks through deals, full states and refusals', () => {
    gs.username = 'pia';
    const full = parse(fullRaw());
    gs.applySnapshot(full);
    watch.afterFullState(full);
    expect(positions()).toEqual([2]);
    const reply = parse(replyRaw());
    gs.applySnapshot(reply);
    watch.afterReply(reply);
    expect(watch.stop()).toBe(true);
    expect(positions()).toEqual([2, null]);
    // the next deal, full state (even a stale one still serving the seat), resume line: nothing
    const { shoulder, ...plain } = pick('gameStart');
    expect(shoulder).toBeTruthy();
    gs.applyDeal(plain);
    watch.onDeal(plain);
    gs.applySnapshot(full);
    watch.afterFullState(full);
    watch.onLogLine(RESUME_LINE);
    expect(positions()).toEqual([2, null]);
    gs.applySnapshot(reply);
    watch.afterFullState(reply);
    expect(positions()).toEqual([2, null, null]);
    // a fresh page of the same game remembers it
    const again = new ShoulderWatch({ getState: () => gs, emit: (ev, p) => sent.push([ev, p]), storage: () => storage });
    gs.applySnapshot(full);
    again.afterFullState(full);
    again.onDeal(plain);
    expect(positions()).toEqual([2, null, null]);
    // the own seat's avatar watches it again; another seat stays a profile
    expect(again.avatarClick(3)).toBe('profile');
    expect(again.avatarClick(2)).toBe('watch');
    expect(positions()).toEqual([2, null, null, 2]);
    // and the own_seat refusal's seat after a Table view: also only by a click
    // (nothing watched here: a stop has nothing to send, and is remembered)
    const w = new ShoulderWatch({ getState: () => gs, emit: (ev, p) => sent.push([ev, p]), storage: () => storage });
    expect(w.stop()).toBe(false);
    gs.username = 'sid';
    expect(w.onRefused(pick('watchHandRefused'))).toBe('own_seat');
    expect(w.ownSeat).toBe(1);
    w.afterFullState(full);
    w.onDeal(plain);
    expect(positions()).toEqual([2, null, null, 2]);
    expect(w.avatarClick(1)).toBe('watch');
    expect(positions()).toEqual([2, null, null, 2, 1]);
  });

  it('not_dealt (the draw): nothing until the first deal, which sends it', () => {
    const raw = fullRaw();
    raw.stage = 'DRAWING';
    raw.deal = null;
    const snap = parseSnapshotV2(raw);
    expect(snap.ok).toBe(true);
    gs.applySnapshot(snap.snapshot);
    watch.afterFullState(snap.snapshot);
    expect(sent).toEqual([]);
    // the first deal (no shoulder yet: nothing watched) sends the default
    const { shoulder, ...plain } = pick('gameStart');
    gs.applyDeal(plain);
    watch.onDeal(plain);
    expect(positions()).toEqual([1]);
    // a deal that carries the wanted seat's hand: nothing to ask
    gs.applyDeal({ ...plain, shoulder: { ...shoulder, position: 1 } });
    watch.onDeal({ ...plain, shoulder: { ...shoulder, position: 1 } });
    expect(positions()).toEqual([1]);
    expect(watch.onRefused({ gameId: snap.snapshot.gameId, position: 1, reason: 'not_dealt', message: 'x' })).toBe('later');
  });

  it('the paused rule: unavailable keeps the seat (no cards), re-sent after "Game resumed." and the next full state', () => {
    const reply = parse(replyRaw());
    gs.applySnapshot(reply);
    watch.afterReply(reply);
    expect(watch.onRefused({ gameId: reply.gameId, position: 2, reason: 'unavailable', message: 'x' })).toBe('paused');
    expect(gs.shoulder).toEqual({ position: 2, paused: true });
    expect(gs.myCards).toEqual([]);
    expect(views).toBe(1);
    // a full state without viewer.shoulder keeps the seat, and asks again
    const full = parse(fullRaw());
    gs.applySnapshot(full);
    watch.afterFullState(full);
    expect(gs.shoulder).toEqual({ position: 2, paused: true });
    expect(positions()).toEqual([2]);
    // the resume line asks again
    expect(watch.onLogLine(RESUME_LINE)).toBe(true);
    expect(positions()).toEqual([2, 2]);
    // the reply restores the hand
    gs.applySnapshot(reply);
    watch.afterReply(reply);
    expect(watch.paused).toBe(false);
    expect(gs.shoulder).toEqual({ position: 2, paused: false });
    expect(gs.myCards).toHaveLength(12);
    // "Game resumed." with nothing paused sends nothing
    watch.onLogLine(RESUME_LINE);
    expect(positions()).toEqual([2, 2]);
  });

  it('the room\'s pause line pauses a watch; a click while paused moves the held seat', () => {
    const reply = parse(replyRaw());
    gs.applySnapshot(reply);
    watch.afterReply(reply);
    expect(watch.onLogLine(PAUSE_LINE)).toBe(true);
    expect(gs.shoulder).toEqual({ position: 2, paused: true });
    // the held seat's own avatar asks for it again (nothing is shown for it)
    expect(watch.avatarClick(2)).toBe('watch');
    expect(watch.avatarClick(4)).toBe('watch');
    expect(gs.shoulder).toEqual({ position: 4, paused: true });
    expect(watch.onLogLine('Ann bid 2.')).toBe(false);
    watch.onLogLine(RESUME_LINE);
    expect(positions()).toEqual([2, 4, 4]);
  });

  it('another game\'s refusal is ignored; the game\'s end drops the selection and the view', () => {
    const reply = parse(replyRaw());
    gs.applySnapshot(reply);
    watch.afterReply(reply);
    expect(watch.onRefused({ gameId: '00000000-0000-4000-8000-000000000009', position: 1, reason: 'tournament', message: 'x' })).toBeNull();
    expect(gs.shoulder).toEqual({ position: 2, paused: false });
    watch.ended();
    expect(watch.selected).toBeNull();
    expect(gs.shoulder).toBeNull();
    expect(gs.position).toBe(1);
    expect(sent).toEqual([]);
  });
});

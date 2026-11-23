/**
 * Sound effects on the real page (events-bots-s12, real handlers, SeqGate,
 * GameState, director and GameScene): what the table asks the
 * SoundManager to play, counted against the recording itself.
 *
 *   - The draw for deal: one draw sound per playerDrew (four).
 *   - Live play: one card sound per cardPlayed, one deal per gameStart
 *     (when its cards go down), the tricks split by seat parity, one
 *     made / set per hand. The turn chime is a reminder (TURN_IDLE_MS):
 *     at most one per turn of mine, only while that turn is still open
 *     (this recorded seat is a scripted client that answers its turns at
 *     once, so most never chime; tableSounds.test.js has the timing).
 *   - The order: a hand's made / set is never followed by a turn chime
 *     before the next deal; the game end waits for the last made / set.
 *   - The socket dies mid-hand and the recorded rejoinSuccess lands: not a
 *     sound, and the turn it restores is no cue.
 *   - Play on to gameEnd: still one per event, one game end.
 *   - A spectator joining mid-hand: no sound for the join, no turn cue ever.
 *   - The table's toggle sits first in the HUD voice row and mutes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let sound;
const played = []; // {name, opts, t}
const flips = []; // trumpShown times
let GAME_END_AFTER_HAND_S;

const count = (name) => played.filter((p) => p.name === name).length;

/** Replay `log`, noting my bids and whether this deal's trump had flipped before each. */
function replayNoting(log, pos, opts = {}) {
  const bids = [];
  let dealAt = -Infinity;
  replay.replayLog(page, log, {
    ...opts,
    before: (e) => {
      if (e.dir !== 's2c') return;
      if (e.event === 'gameStart') dealAt = Date.now();
      if (e.event === 'bidReceived' && e.data.position === pos()) {
        const t = Date.now();
        bids.push({ t, afterFlip: flips.some((f) => f >= dealAt && f <= t) });
      }
    },
  });
  return bids;
}

/** After each made / set, no turn cue until the next deal: a bid cue waits for the cards and the flip. */
function checkOrder() {
  let handEnded = false;
  for (const [i, p] of played.entries()) {
    if (p.name === 'made' || p.name === 'set') handEnded = true;
    if (p.name === 'deal') handEnded = false;
    if (p.name === 'turn') expect(handEnded, `turn #${i} between a hand end and the next deal`).toBe(false);
    if (p.name === 'turn') expect(p.myTurn, `turn #${i} chimed when the turn was not mine`).toBe(true);
    if ((p.name === 'gameend' || p.name === 'gameend-lose') && played.some((q) => (q.name === 'made' || q.name === 'set') && q.t === p.t)) {
      expect(p.opts?.delay).toBeCloseTo(GAME_END_AFTER_HAND_S, 2);
    }
  }
}
const s2c = (log, event, from = 0) => log.slice(from).filter((e) => e.dir === 's2c' && e.event === event);

/** What the log says the sounds must be, for my seat. */
function expected(log, pos, from = 0) {
  const tricks = s2c(log, 'trickComplete', from);
  const mine = (e) => e.data.position === pos;
  return {
    card: s2c(log, 'cardPlayed', from).length,
    draw: s2c(log, 'playerDrew', from).length,
    deal: s2c(log, 'gameStart', from).length,
    // every turn of mine ends in my bid or my play (a human seat, never lazy here)
    turn: s2c(log, 'cardPlayed', from).filter(mine).length,
    'trick-ours': tricks.filter((e) => e.data.winner % 2 === pos % 2).length,
    trick: tricks.filter((e) => e.data.winner % 2 !== pos % 2).length,
    handEnd: s2c(log, 'handComplete', from).length,
    gameend: s2c(log, 'gameEnd', from).length,
  };
}

/** The game end's sound for my seat: the trombone when my team's final score is below the other's. */
function endSound(log, pos) {
  const sc = s2c(log, 'gameEnd').at(-1)?.data?.score;
  const [mine, theirs] = pos % 2 === 1 ? [sc.team1, sc.team2] : [sc.team2, sc.team1];
  return mine < theirs ? 'gameend-lose' : 'gameend';
}

function actual() {
  return {
    card: count('card'),
    draw: count('draw'),
    deal: count('deal'),
    turn: count('turn'),
    'trick-ours': count('trick-ours'),
    trick: count('trick'),
    handEnd: count('made') + count('set'),
    gameend: count('gameend') + count('gameend-lose'),
  };
}

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s12');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
  const { getSoundManager } = await import('../audio/SoundManager.js');
  const tableSounds = await import('../audio/tableSounds.js');
  ({ GAME_END_AFTER_HAND_S } = tableSounds);
  sound = getSoundManager();
  vi.spyOn(sound, 'play').mockImplementation((name, opts) => {
    played.push({ name, opts, t: Date.now(), myTurn: page.gameState.currentTurn === page.gameState.position });
    return true;
  });
  const ts = tableSounds.getTableSounds();
  const trumpShown = ts.trumpShown.bind(ts);
  vi.spyOn(ts, 'trumpShown').mockImplementation(() => {
    flips.push(Date.now());
    return trumpShown();
  });
});

afterAll(() => vi.useRealTimers());

describe('recorded game: one sound per moment, none for a rejoin', () => {
  it('live play to the disconnect', () => {
    const log = rec.logs.seat1;
    const bids = replayNoting(log, () => page.gameState.position);
    replay.advance(3000);
    const pos = page.gameState.position;
    expect(pos).toBeTruthy();
    const want = expected(log, pos);
    expect(bids.length).toBe(s2c(log, 'bidReceived').filter((e) => e.data.position === pos).length);
    // both kinds are in the recording: a bid after the flip, one before it
    expect(bids.some((b) => b.afterFlip)).toBe(true);
    expect(bids.some((b) => !b.afterFlip)).toBe(true);
    want.turn += bids.filter((b) => b.afterFlip).length;
    expect(want.card).toBeGreaterThan(20);
    expect(want.draw).toBe(4);
    expect(want.turn).toBeGreaterThan(5);
    const got = actual();
    expect(got.turn).toBeLessThanOrEqual(want.turn);
    expect({ ...got, turn: 0 }).toEqual({ ...want, turn: 0 });
    expect(count('overtrump')).toBe(0);
    checkOrder();
  });

  it('the reconnect and the recorded rejoinSuccess make no sound', () => {
    const before = played.length;
    flips.length = 0;
    const rejoin = rec.logs['seat1-rejoin'][0];
    expect(rejoin.event).toBe('rejoinSuccess');
    page.socket.reconnect('ios-h1-r1');
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    page.socket.fire('rejoinSuccess', JSON.parse(JSON.stringify(rejoin.data)));
    replay.advance(3000);
    expect(played.slice(before)).toEqual([]);
  });

  it('play on to gameEnd: still one sound per moment, a turn the rejoin restored is no cue', () => {
    played.length = 0;
    const log = rec.logs['seat1-rejoin'];
    const snap = log[0].data.snapshot;
    const bids = replayNoting(log, () => page.gameState.position, { from: 1 });
    replay.advance(3000);
    const pos = page.gameState.position;
    const want = expected(log, pos, 1);
    want.turn += bids.filter((b) => b.afterFlip).length;
    // the snapshot showed my turn: my next action answers it, no new cue
    if (snap.turn?.position === pos) want.turn -= 1;
    const got = actual();
    expect(got.turn).toBeLessThanOrEqual(want.turn);
    expect({ ...got, turn: 0 }).toEqual({ ...want, turn: 0 });
    expect(want.gameend).toBe(1);
    expect(page.session.screen).toBe('gameEnd');
    checkOrder();
    // the last hand's made / set and the flourish come in one tick: the flourish waits
    // the flourish, or the trombone for my team's loss (owner 2026-11-22)
    const end = played.findIndex((p) => p.name === 'gameend' || p.name === 'gameend-lose');
    expect(played[end].name).toBe(endSound(log, pos));
    expect(['made', 'set']).toContain(played[end - 1].name);
    expect(played[end].opts?.delay).toBeGreaterThan(0.4);
  });
});

describe('the table\'s toggle', () => {
  it('is first in the HUD voice row, a labelled toggle button, and mutes (persisting: SoundManager.test.js)', () => {
    const btn = document.getElementById('sound-toggle-btn');
    // the score modal keeps the table: its toggle is still there
    expect(btn).toBeTruthy();
    expect(btn.parentElement.classList.contains('hud-voice')).toBe(true);
    expect(btn.parentElement.firstElementChild).toBe(btn);
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.getAttribute('aria-label')).toBe('Mute sound effects');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toBe('Sound on');
    btn.click();
    expect(sound.muted).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.title).toBe('Sound off');
    btn.click();
    expect(sound.muted).toBe(false);
  });
});

/**
 * Sound effects on the real page (events-bots-s12, real handlers, SeqGate,
 * GameState, director and GameScene): what the table asks the
 * SoundManager to play, counted against the recording itself.
 *
 *   - Live play: one card sound per cardPlayed, one deal per gameStart
 *     (when its cards go down), one turn cue per play of mine and per bid
 *     of mine made once the trump was face up (this recorded seat is a
 *     scripted client that often bids before the web bid panel could
 *     open: that turn's cue is dropped, as no web player could have bid
 *     yet), the tricks split by seat parity, one made / set per hand.
 *   - The order: a hand's made / set is never followed by a turn cue
 *     before the next deal; a turn cue in the same tick as a card or trick
 *     starts TURN_DELAY_S later; the game end waits for the last made / set.
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
let TURN_DELAY_S;
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
    if (p.name === 'turn' && played.some((q) => q !== p && q.t === p.t && ['card', 'trick', 'trick-ours'].includes(q.name))) {
      expect(p.opts?.delay).toBe(TURN_DELAY_S);
    }
    if (p.name === 'gameend' && played.some((q) => (q.name === 'made' || q.name === 'set') && q.t === p.t)) {
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
    deal: s2c(log, 'gameStart', from).length,
    // every turn of mine ends in my bid or my play (a human seat, never lazy here)
    turn: s2c(log, 'cardPlayed', from).filter(mine).length,
    'trick-ours': tricks.filter((e) => e.data.winner % 2 === pos % 2).length,
    trick: tricks.filter((e) => e.data.winner % 2 !== pos % 2).length,
    handEnd: s2c(log, 'handComplete', from).length,
    gameend: s2c(log, 'gameEnd', from).length,
  };
}

function actual() {
  return {
    card: count('card'),
    deal: count('deal'),
    turn: count('turn'),
    'trick-ours': count('trick-ours'),
    trick: count('trick'),
    handEnd: count('made') + count('set'),
    gameend: count('gameend'),
  };
}

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s12');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
  const { getSoundManager } = await import('../audio/SoundManager.js');
  const tableSounds = await import('../audio/tableSounds.js');
  ({ TURN_DELAY_S, GAME_END_AFTER_HAND_S } = tableSounds);
  sound = getSoundManager();
  vi.spyOn(sound, 'play').mockImplementation((name, opts) => {
    played.push({ name, opts, t: Date.now() });
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
    expect(want.turn).toBeGreaterThan(5);
    expect(actual()).toEqual(want);
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
    expect(actual()).toEqual(want);
    expect(want.gameend).toBe(1);
    expect(page.session.screen).toBe('gameEnd');
    checkOrder();
    // the last hand's made / set and the flourish come in one tick: the flourish waits
    const end = played.findIndex((p) => p.name === 'gameend');
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

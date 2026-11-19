/**
 * The bid clock on the real page (events-bidclock-s16: the scripted seat
 * at position 2 idles through its first bid turn, bids mid-tune on the
 * next, then drops mid-clock and rejoins; real handlers, SeqGate,
 * GameState, director and GameScene):
 *
 *   - the tune starts at the recorded running (end-aligned), and the
 *     bidder's countdown shows on the bid sheet
 *   - the timeout: the tune rings out (the bid 0 and the updateTurn after
 *     it do not cut it), the toast "Time ran out: you bid 0", the server's
 *     log line, and the sheet goes
 *   - a bid mid-tune stops it with a fade, and takes the countdown away
 *   - the socket drops mid-clock: the tune and the countdown stop at once;
 *     the rejoin's snapshot (bidClock.inMs) starts the tune at its offset
 *     and the countdown at the seconds left; the bid after it stops both
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

const FILE_S = 30.0;
let page;
let replay;
let rec;
let setBidClockNow;
const tunes = []; // {offset, playing, stops, t}

const clockEl = () => document.querySelector('#bidContainer .bid-sheet__clock');
const toasts = () => Array.from(document.querySelectorAll('.kit-toast')).map((t) => t.textContent);
const feed = () => document.getElementById('gameFeed')?.textContent || '';

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bidclock-s16');
  page = await replay.realTablePage({ username: 'ios_kai', socketId: 'ios-k1' });
  ({ setBidClockNow } = await import('../state/bidClock.js'));
  // the fake timers own Date: the clock's monotonic time follows them
  setBidClockNow(() => Date.now());
  const { getSoundManager } = await import('../audio/SoundManager.js');
  const sound = getSoundManager();
  vi.spyOn(sound, 'play').mockImplementation(() => true);
  vi.spyOn(sound, 'duration').mockImplementation((name) => (name === 'bidclock' ? FILE_S : null));
  vi.spyOn(sound, 'start').mockImplementation((name, { offset = 0 } = {}) => {
    const h = {
      name,
      offset,
      t: Date.now(),
      playing: true,
      stops: [],
      stop(fade) {
        if (!h.playing) return;
        h.playing = false;
        h.stops.push(fade);
      },
    };
    tunes.push(h);
    return h;
  });
});

afterAll(() => {
  setBidClockNow?.(null);
  vi.useRealTimers();
});

// Where the replay is: the next entry of the log being played, and the recording's time now
let log = null;
let cursor = 0;
let simT = null;

/** Fire log[cursor .. to) at their recorded times. */
function playTo(to) {
  for (; cursor < to; cursor++) {
    const e = log[cursor];
    if (simT !== null && e.t > simT) replay.advance(e.t - simT);
    simT = simT === null ? e.t : Math.max(simT, e.t);
    if (e.dir === 's2c') page.socket.fire(e.event, JSON.parse(JSON.stringify(e.data)));
  }
}
function wait(ms) {
  replay.advance(ms);
  simT += ms;
}
/** The index of the next s2c `event` at or after the cursor that matches. */
const next = (event, pred = () => true) => {
  const i = log.findIndex((e, k) => k >= cursor && e.dir === 's2c' && e.event === event && pred(e));
  expect(i, event).toBeGreaterThan(-1);
  return i;
};

describe('recorded bid clock (seat 2)', () => {
  it('the clock runs at T0 + 10 s: the tune starts end-aligned, the bidder sees the countdown', () => {
    log = rec.logs.seat1;
    const at = next('bidClock');
    expect(log[at].data).toMatchObject({ position: 2, running: true, inMs: 30000, durationMs: 30000 });
    // the turn opened 10 s before
    expect(log[at - 1].event).toBe('updateTurn');
    expect(log[at].t - log[at - 1].t).toBe(10000);
    playTo(at);
    expect(tunes).toHaveLength(0);
    expect(clockEl()).toBe(null);
    playTo(at + 1);
    expect(page.gameState.position).toBe(2);
    expect(tunes).toHaveLength(1);
    expect(tunes[0].offset).toBeCloseTo(0, 5);
    expect(document.getElementById('bidContainer')?.classList.contains('is-open')).toBe(true);
    expect(clockEl()?.textContent).toBe('30');
    wait(20000);
    expect(clockEl()?.textContent).toBe('10');
    expect(clockEl().classList.contains('bid-sheet__clock--low')).toBe(true);
  });

  it('the timeout: the tune rings out over the bid 0 and the next turn; my toast, the log line; the sheet goes', () => {
    const stop = next('bidClock');
    expect(log[stop].data).toMatchObject({ running: false, reason: 'timeout' });
    const turn = next('updateTurn');
    playTo(turn + 1);
    wait(200);
    expect(tunes).toHaveLength(1);
    expect(tunes[0].playing).toBe(true);
    expect(toasts()).toContain('Time ran out: you bid 0');
    expect(feed()).toContain('ios_kai ran out of time.');
    expect(page.gameState.bids[2]).toBe('0');
    expect(page.gameState.bidClock).toBe(null);
    expect(clockEl()).toBe(null);
    expect(document.getElementById('bidContainer')?.classList.contains('is-open') ?? false).toBe(false);
  });

  it('the next clock cuts the ringing end; my bid mid-tune stops it with a fade and takes the countdown away', () => {
    const second = next('bidClock');
    expect(log[second].data.running).toBe(true);
    playTo(second + 1);
    expect(tunes).toHaveLength(2);
    expect(tunes[0].playing).toBe(false);
    expect(tunes[1].playing).toBe(true);
    expect(clockEl()?.textContent).toBe('30');
    const stop = next('bidClock');
    expect(log[stop].data.reason).toBe('bid');
    playTo(stop + 1);
    expect(tunes[1].playing).toBe(false);
    expect(tunes[1].stops[0]).toBeGreaterThan(0);
    expect(clockEl()).toBe(null);
  });

  it('dropped mid-clock: the tune and the countdown stop at once; the rejoin snapshot resumes both at the offset', () => {
    const last = log.length - 1;
    expect(log[last].data).toMatchObject({ running: true, position: 2 });
    playTo(log.length);
    expect(tunes).toHaveLength(3);
    expect(tunes[2].playing).toBe(true);
    expect(clockEl()?.textContent).toBe('30');
    // the drop at T0 + 20 s
    wait(10000);
    page.socket.reconnect('ios-k1-r1');
    expect(tunes[2].playing).toBe(false);
    expect(page.gameState.bidClock).toBe(null);
    expect(clockEl()).toBe(null);
    const rlog = rec.logs['seat1-rejoin'];
    const rejoin = rlog[0];
    expect(rejoin.event).toBe('rejoinSuccess');
    const inMs = rejoin.data.snapshot.bidClock.inMs;
    // the recording's own timeline: the clock started at log[last].t
    expect(log[last].t + 30000 - rejoin.t).toBe(inMs);
    wait(rejoin.t - simT);
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_kai', activeGameId: rec.gameId, blockedUsers: [] });
    log = rlog;
    cursor = 0;
    playTo(1);
    wait(1000);
    expect(tunes).toHaveLength(4);
    expect(tunes[3].offset).toBeCloseTo(FILE_S - inMs / 1000, 2);
    expect(page.gameState.bidClock?.position).toBe(2);
    expect(clockEl()?.textContent).toBe(String(Math.ceil((inMs - 750 - 1000) / 1000)));
    // the bid after the rejoin stops both
    const stop = next('bidClock');
    playTo(stop + 2);
    expect(tunes[3].playing).toBe(false);
    expect(clockEl()).toBe(null);
  });

  it('plays on to the game end with no other tune', () => {
    playTo(log.length);
    wait(3000);
    expect(tunes).toHaveLength(4);
    expect(tunes.every((t) => !t.playing)).toBe(true);
    expect(page.session.screen).toBe('gameEnd');
  });
});

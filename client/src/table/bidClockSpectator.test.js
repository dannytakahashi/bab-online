/**
 * The bid clock for a spectator (events-bidclock-s16's recorded spectator,
 * at the table from the draw, on the real page): it hears the tune for the
 * bidder's clock, end-aligned, rung out on the timeout and stopped by the
 * bid; it never sees a countdown or the bidder's toast.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let setBidClockNow;
const tunes = [];

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bidclock-s16');
  page = await replay.realTablePage({ username: 'ios_lia', socketId: 'ios-kspec' });
  ({ setBidClockNow } = await import('../state/bidClock.js'));
  setBidClockNow(() => Date.now());
  const { getSoundManager } = await import('../audio/SoundManager.js');
  const sound = getSoundManager();
  vi.spyOn(sound, 'play').mockImplementation(() => true);
  vi.spyOn(sound, 'duration').mockImplementation((name) => (name === 'bidclock' ? 30 : null));
  vi.spyOn(sound, 'start').mockImplementation((name, { offset = 0 } = {}) => {
    const h = { offset, playing: true, stop() { h.playing = false; } };
    tunes.push(h);
    return h;
  });
});

afterAll(() => {
  setBidClockNow?.(null);
  vi.useRealTimers();
});

describe('a spectator hears the bid clock, sees no countdown', () => {
  it('every recorded clock starts the tune; the timeout rings out, the bid stops it; no countdown, no toast', () => {
    const log = rec.logs.spectator;
    expect(log[0].event).toBe('spectatorJoined');
    const clocks = log.filter((e) => e.event === 'bidClock');
    const runs = clocks.filter((e) => e.data.running);
    expect(runs.length).toBe(3);
    const seen = [];
    replay.replayLog(page, log, {
      before: (e) => {
        if (e.event !== 'bidClock') return;
        seen.push({ reason: e.data.reason ?? 'running', tunes: tunes.length, playing: tunes.at(-1)?.playing ?? null });
      },
    });
    replay.advance(3000);
    expect(page.session.role).toBe('spectator');
    expect(tunes).toHaveLength(3);
    for (const t of tunes) expect(t.offset).toBeCloseTo(0, 5);
    // before the timeout's stop the first tune played; the second clock found it ringing and cut it
    expect(seen.map((x) => x.reason)).toEqual(['running', 'timeout', 'running', 'bid', 'running', 'bid']);
    expect(seen[1]).toMatchObject({ tunes: 1, playing: true });
    expect(seen[2]).toMatchObject({ tunes: 1, playing: true });
    expect(tunes.every((t) => !t.playing)).toBe(true);
    expect(document.querySelector('.bid-sheet__clock')).toBe(null);
    expect(Array.from(document.querySelectorAll('.kit-toast')).map((t) => t.textContent)).not.toContain('Time ran out: you bid 0');
    expect(page.session.screen).toBe('gameEnd');
  });
});

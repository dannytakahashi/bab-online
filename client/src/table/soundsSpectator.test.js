/**
 * Sound effects for a spectator (events-bots-s12's recorded spectator,
 * joining mid-hand on the real page): the join's snapshot is silent; then
 * the table's sounds (cards, deals, tricks, the hand ends, the game end),
 * every trick the neutral one and every hand end a quieter made (no team),
 * and never a turn cue.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
const played = [];
const count = (name) => played.filter((p) => p.name === name).length;
const s2c = (log, event, from) => log.slice(from).filter((e) => e.dir === 's2c' && e.event === event);

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s12');
  page = await replay.realTablePage({ username: 'ios_fan' });
  const { getSoundManager } = await import('../audio/SoundManager.js');
  vi.spyOn(getSoundManager(), 'play').mockImplementation((name, opts) => {
    played.push({ name, opts });
    return true;
  });
});

afterAll(() => vi.useRealTimers());

describe('a spectator hears the table, not a player\'s cues', () => {
  it('joining mid-hand makes no sound', () => {
    const join = rec.logs.spectator[0];
    expect(join.event).toBe('spectatorJoined');
    page.socket.fire('spectatorJoined', JSON.parse(JSON.stringify(join.data)));
    replay.advance(3000);
    expect(page.session.role).toBe('spectator');
    expect(played).toEqual([]);
  });

  it('to the game end: cards, deals, neutral tricks, a quieter made per hand, the flourish; no turn', async () => {
    const { SPECTATOR_HAND_END_GAIN } = await import('../audio/tableSounds.js');
    const log = rec.logs.spectator;
    replay.replayLog(page, log, { from: 1 });
    replay.advance(3000);
    expect(count('card')).toBe(s2c(log, 'cardPlayed', 1).length);
    expect(count('card')).toBeGreaterThan(20);
    expect(count('deal')).toBe(s2c(log, 'gameStart', 1).length);
    expect(count('trick')).toBe(s2c(log, 'trickComplete', 1).length);
    expect(count('trick-ours')).toBe(0);
    expect(count('turn')).toBe(0);
    expect(count('made')).toBe(s2c(log, 'handComplete', 1).length);
    expect(count('made')).toBeGreaterThan(1);
    expect(count('set')).toBe(0);
    for (const p of played.filter((q) => q.name === 'made')) expect(p.opts).toEqual({ gain: SPECTATOR_HAND_END_GAIN });
    expect(count('gameend')).toBe(1);
    expect(page.session.screen).toBe('gameEnd');
  });

  it('the toggle sits in the corner row (the spectator\'s voice slot)', () => {
    const btn = document.getElementById('sound-toggle-btn');
    expect(btn?.parentElement?.classList.contains('hud-voice')).toBe(true);
    expect(document.getElementById('table-hud').classList.contains('hud-spectator')).toBe(true);
  });
});

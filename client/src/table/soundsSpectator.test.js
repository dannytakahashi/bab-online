/**
 * Sound effects for a spectator (events-bots-s12's recorded spectator,
 * joining mid-hand on the real page): the join's snapshot is silent; then
 * the table's sounds (cards, deals, tricks, the game end), every trick the
 * neutral one, and never a turn cue or a made / set (no team).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
const played = [];
const count = (name) => played.filter((n) => n === name).length;
const s2c = (log, event, from) => log.slice(from).filter((e) => e.dir === 's2c' && e.event === event);

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s12');
  page = await replay.realTablePage({ username: 'ios_fan' });
  const { getSoundManager } = await import('../audio/SoundManager.js');
  vi.spyOn(getSoundManager(), 'play').mockImplementation((name) => {
    played.push(name);
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

  it('to the game end: cards, deals, neutral tricks, the flourish; no turn, no made / set', () => {
    const log = rec.logs.spectator;
    replay.replayLog(page, log, { from: 1 });
    replay.advance(3000);
    expect(count('card')).toBe(s2c(log, 'cardPlayed', 1).length);
    expect(count('card')).toBeGreaterThan(20);
    expect(count('deal')).toBe(s2c(log, 'gameStart', 1).length);
    expect(count('trick')).toBe(s2c(log, 'trickComplete', 1).length);
    expect(count('trick-ours')).toBe(0);
    expect(count('turn')).toBe(0);
    expect(count('made') + count('set')).toBe(0);
    expect(count('gameend')).toBe(1);
    expect(page.session.screen).toBe('gameEnd');
  });

  it('the toggle sits in the corner row (the spectator\'s voice slot)', () => {
    const btn = document.getElementById('sound-toggle-btn');
    expect(btn?.parentElement?.classList.contains('hud-voice')).toBe(true);
    expect(document.getElementById('table-hud').classList.contains('hud-spectator')).toBe(true);
  });
});

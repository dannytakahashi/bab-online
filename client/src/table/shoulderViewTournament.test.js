/**
 * Never at a tournament table (owner 2026-11-21; docs/claude/spectators.md
 * "Over-the-shoulder view"): events-tournament-s15's recorded spectator
 * (ios_tom) on the real page gets the plain spectator view as before: no
 * watchHand after its full state or a deal, avatar clicks open profiles,
 * the pill is today's.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-tournament-s15');
  page = await replay.realTablePage({ username: 'ios_tom', socketId: 'ios-tspec' });
});

afterAll(() => vi.useRealTimers());

describe('a tournament table offers no shoulder view', () => {
  it('the whole recorded watch: never a watchHand, the plain spectator view', () => {
    const log = rec.logs.spectator;
    expect(log[0].data.snapshot.tournament).toBeTruthy();
    replay.replayLog(page, log, { to: Math.min(log.length, 200) });
    replay.advance(500);
    expect(page.session.role).toBe('spectator');
    expect(page.socket.emitted('watchHand')).toEqual([]);
    expect(page.scene.getLayout().isSpectator).toBe(true);
    expect(document.getElementById('spectating-indicator').textContent).toBe('Spectating — type /leave to exit');
  });

  it('an avatar click opens the profile', () => {
    page.socket.clearEmits();
    const avatar = document.querySelector('#opponent-avatar-partner');
    avatar.click();
    expect(page.socket.emitted('watchHand')).toEqual([]);
    expect(page.socket.emitted('getPlayerProfile').map((p) => p.username)).toEqual([avatar.dataset.username]);
  });
});

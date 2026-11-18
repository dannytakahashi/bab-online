/**
 * A family lobby's extra at the start of a game (owner play test
 * 2026-11-17: "seeing the table behind the draw for deal on a second game,
 * refresh cleaned it up"). The extra is put at the table at CREATED
 * (spectatorJoined with the CREATED snapshot, before the room's startDraw),
 * which is how a player of the last game who did not get a seat in the next
 * one (play again, role swap) watches it. Nothing from the last game is
 * involved: a fresh page in the lobby did the same.
 *
 * The draw for deal must be on the bare felt (no play zone, no hand box),
 * as a seat and a spectator who comes in mid-draw (a refresh:
 * drawSpectator.test.js) see it; the room's startDraw takes the extra's
 * log down (a seat's draw has none: spectatorScoreHeaderExtra.test.js), so
 * its column goes too. Before the fix the CREATED render drew the play zone
 * and the startDraw left the log's column on with no log in it: the play
 * zone's rail and an empty dark column behind the draw. Then the game goes
 * on as any spectator's (the recorded spectator's draws, teams, deal and
 * every table checkpoint to the game end).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../testing/files.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let log;

/**
 * The server's spectatorJoined full state for an extra: a CREATED snapshot
 * (contract fixture, seq 0, the recording's game id), before the startDraw.
 */
function createdForSpectator(gameId) {
  const fx = JSON.parse(readFileSync(resolve(REPO_ROOT, 'contract/fixtures/v2/created-countdown.json'), 'utf8'));
  const snapshot = { ...fx.snapshot, gameId, viewer: { role: 'spectator', position: null, ownerView: null, canAct: false } };
  return { gameId, players: [], trump: null, snapshot };
}

const hud = () => document.getElementById('table-hud');
const drawHud = () => hud()?.querySelector(':scope > .hud-draw') ?? null;
const playZone = () => document.getElementById('playZoneDom');
const logUp = () => !!document.getElementById('gameFeed')?.isConnected;
const logColumnOn = () => !!document.getElementById('game-container')?.classList.contains('in-game');

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-humans-s13');
  log = rec.logs.spectator;
  page = await replay.realTablePage({ username: 'oli' });
});

afterAll(() => vi.useRealTimers());

describe('a lobby extra put at the table at CREATED, then the draw for deal', () => {
  it('the CREATED join: the bare felt (no play zone yet), the log up in its column', () => {
    page.socket.fire('spectatorJoined', createdForSpectator(log[0].data.snapshot.gameId));
    replay.advance(50);
    expect(page.session.role).toBe('spectator');
    expect(page.session.screen).toBe('table');
    expect(playZone()).toBeNull();
    expect(logUp()).toBe(true);
    expect(logColumnOn()).toBe(true);
  });

  it('startDraw: the draw on the bare felt, the log and its column down (as a seat\'s draw)', () => {
    // the room's startDraw (seq 1) as the recorded seats got it
    const start = rec.logs.seat1.find((e) => e.event === 'startDraw');
    expect(start.data.seq).toBe(1);
    page.socket.fire('startDraw', JSON.parse(JSON.stringify(start.data)));
    replay.advance(50);
    expect(drawHud()).toBeTruthy();
    expect(drawHud().classList.contains('is-spectator')).toBe(true);
    expect(page.session.role).toBe('spectator');
    expect(playZone()).toBeNull();
    // never an empty dark column with no log in it
    expect(logUp()).toBe(false);
    expect(logColumnOn()).toBe(false);
  });

  it('the draws and the teams on the bare felt; the play zone comes with the deal; then every checkpoint matches', () => {
    const teams = log.findIndex((e) => e.event === 'teamsAnnounced');
    // the room's events the recorded spectator came in after (the first
    // draw, seq 2; the spectatorJoined notice, seq 3), as a seat got them;
    // then the spectator's own log
    const seat = rec.logs.seat1;
    const before = seat.filter((e) => e.dir === 's2c' && e.to === 'room' && e.data?.seq > 1 && e.data.seq < 4);
    expect(before.map((e) => e.data.seq)).toEqual([2, 3]);
    before.forEach((e) => page.socket.fire(e.event, JSON.parse(JSON.stringify(e.data))));
    const draws = [...before, ...log.slice(1, teams)].filter((e) => e.event === 'playerDrew').length;
    expect(draws).toBe(4);
    replay.replayLog(page, log, { from: 1, to: teams });
    replay.advance(1000);
    expect(page.scene.drawManager.drawnCards()).toHaveLength(draws);
    expect(playZone()).toBeNull();
    replay.replayLog(page, log, { from: teams, to: teams + 1 });
    replay.advance(100);
    expect(hud().querySelector(':scope > .hud-teams')).toBeTruthy();
    expect(playZone()).toBeNull();
    const deal = log.findIndex((e) => e.event === 'gameStart');
    expect(deal).toBeGreaterThan(teams);
    replay.replayLog(page, log, { from: teams + 1, to: deal + 1 });
    replay.advance(3000);
    // the deal: the play zone, and the log (createUI) back in its column
    expect(playZone()).toBeTruthy();
    expect(logUp()).toBe(true);
    expect(logColumnOn()).toBe(true);
    const { results, bad } = replay.replayViewer(page, rec, 'spectator', { from: deal + 1 });
    expect(results.length).toBeGreaterThan(50);
    expect(bad).toEqual([]);
    expect(page.session.screen).toBe('gameEnd');
  });
});

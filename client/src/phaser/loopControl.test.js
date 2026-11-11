/**
 * The Phaser loop sleeps off the table (item 18a, cli-23 / webclient-10)
 * and the avatars are built once per game (webclient-21).
 *
 * The fake clock models Phaser: while the game's loop sleeps, scene time
 * stands still (no tween, no delayed call). So every recorded-game test of
 * the suite also proves that nothing the table needs runs on scene time
 * while the loop is asleep; this file checks the switching itself through
 * the real page: the main room sleeps, a deal / a rejoin / a spectate wakes
 * it before any table work, the score modal keeps it, an exit sleeps it
 * again after one more frame, and a tab return in the main room does not
 * leave it running.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { installLoopControl, LOOP_SCREENS } from './loopControl.js';
import { ClientSession, SCREEN, ROLE } from '../state/ClientSession.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

/** A Phaser.Game stand-in for the unit tests. */
function unitGame() {
  const handlers = new Map();
  const events = {
    once(ev, fn) { (handlers.get(ev) || handlers.set(ev, []).get(ev)).push({ fn, once: true }); },
    on(ev, fn) { (handlers.get(ev) || handlers.set(ev, []).get(ev)).push({ fn, once: false }); },
    off(ev, fn) { handlers.set(ev, (handlers.get(ev) || []).filter((h) => h.fn !== fn)); },
    emit(ev) { const hs = handlers.get(ev) || []; handlers.set(ev, hs.filter((h) => !h.once)); hs.forEach((h) => h.fn()); },
  };
  const loop = {
    running: true,
    sleep: vi.fn(function () { this.running = false; }),
    wake: vi.fn(function () { this.running = true; }),
    resetDelta: vi.fn(),
  };
  // a frame, then the task after it (the loop sleeps outside the frame callback)
  const frame = () => { events.emit('postrender'); vi.advanceTimersByTime(1); };
  return { events, loop, frame, tabReturn: () => { loop.wake(); events.emit('resume'); } };
}

describe('loop control (unit)', () => {
  beforeAll(() => vi.useFakeTimers());
  afterAll(() => vi.useRealTimers());

  it('sleeps outside the frame callback (Phaser 3.55 re-requests a frame after it)', () => {
    const session = new ClientSession({ strict: true });
    const game = unitGame();
    const ctl = installLoopControl({ session, getGame: () => game });
    session.transition(SCREEN.SIGN_IN);
    game.events.emit('postrender');
    expect(game.loop.sleep).not.toHaveBeenCalled(); // not inside the frame
    vi.advanceTimersByTime(1);
    expect(game.loop.sleep).toHaveBeenCalledTimes(1);
    ctl.dispose();
  });

  it('runs on TABLE and GAME_END only; sleeps one frame after leaving; wakes at once on entering', () => {
    expect(LOOP_SCREENS).toEqual([SCREEN.TABLE, SCREEN.GAME_END]);
    const session = new ClientSession({ strict: true });
    const game = unitGame();
    const ctl = installLoopControl({ session, getGame: () => game });
    session.transition(SCREEN.SIGN_IN);
    expect(game.loop.running).toBe(true); // the frame first (a restart, a cleared canvas)
    game.frame();
    expect(game.loop.running).toBe(false);
    session.transition(SCREEN.MAIN_ROOM);
    game.frame();
    expect(game.loop.sleep).toHaveBeenCalledTimes(1);

    // a table: awake before anything else runs, with a fresh delta
    session.enterTable(ROLE.PLAYER, 'g1');
    expect(game.loop.running).toBe(true);
    expect(game.loop.resetDelta).toHaveBeenCalled();
    session.endGame();
    game.frame();
    expect(game.loop.running).toBe(true); // the score modal is over the table

    // leave, then come back before the next frame: never slept
    session.exitTable('test');
    session.enterTable(ROLE.SPECTATOR, 'g2');
    game.frame();
    expect(game.loop.running).toBe(true);
    session.exitTable('test');
    game.frame();
    expect(game.loop.running).toBe(false);
    expect(ctl.stats).toMatchObject({ sleeps: 2, wakes: 1 });

    // Phaser resumes its loop when a hidden tab comes back: off the table it sleeps again
    game.tabReturn();
    expect(game.loop.running).toBe(true);
    game.frame();
    expect(game.loop.running).toBe(false);
    ctl.dispose();
  });
});

describe('the real page: the loop follows the table (recorded game, events-bots-s12)', () => {
  let page;
  let replay;
  let rec;
  let game;
  let clock;
  let log;
  let at = 0;

  beforeAll(async () => {
    replay = await import('../testing/replay.js');
    ({ clock } = await import('../testing/fakePhaser.js'));
    rec = replay.loadRecording('events-bots-s12');
    log = rec.logs.seat1;
    page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
    game = (await import('./PhaserGame.js')).getPhaserGame();
  });
  afterAll(() => vi.useRealTimers());

  const replayTo = (i) => { at = replay.replayLog(page, log, { from: at, to: i }); };

  it('the main room: asleep, scene time stands still', () => {
    replay.advance(50);
    expect(page.session.screen).toBe(SCREEN.MAIN_ROOM);
    expect(game.loop.running).toBe(false);
    const before = clock.stepsWhileAsleep;
    replay.advance(500);
    expect(clock.stepsWhileAsleep).toBeGreaterThan(before);
  });

  it('a tab return in the main room does not leave it running', () => {
    game.loop.resume();
    expect(game.loop.running).toBe(true);
    replay.advance(50); // a frame, then the task after it
    expect(game.loop.running).toBe(false);
  });

  it('the draw wakes it before the deck is dealt; the director\'s work runs; avatars are built once per game', () => {
    const startDraw = log.findIndex((e) => e.event === 'startDraw');
    replayTo(startDraw + 1);
    expect(game.loop.running).toBe(true);
    replay.advance(1200);
    expect(page.scene.drawManager.deckCards()).toHaveLength(54);

    // through the first deal and into the second hand
    const starts = log.map((e, i) => [e, i]).filter(([e]) => e.event === 'gameStart').map(([, i]) => i);
    replayTo(starts[0] + 1);
    replay.advance(6000);
    const om = page.scene.opponentManager;
    const imgs = () => ['partner', 'opp1', 'opp2'].map((k) => om._avatarDoms[k]?.querySelector('img'));
    const first = imgs();
    expect(first.every(Boolean)).toBe(true);
    const builds = om.avatarBuilds;
    expect(builds).toBe(3);
    const frog = document.querySelector('.dealer-button');
    expect(frog).toBeTruthy();
    // the turn ring of the seat to play survives the next hand's gameStart
    replayTo(starts[1] + 1);
    replay.advance(4000);
    expect(imgs()).toEqual(first);
    expect(om.avatarBuilds).toBe(builds);
    expect(om.dealerBuilds).toBe(1);
    expect(document.querySelector('.dealer-button')).toBe(frog);
    // a render (a resync) keeps them too
    page.scene.render();
    expect(imgs()).toEqual(first);
    expect(om.avatarBuilds).toBe(builds);
    expect(document.querySelectorAll('.opponent-avatar-container')).toHaveLength(3);
    expect(game.loop.running).toBe(true);
  });

  it('an abort leaves the table: asleep after one more frame', () => {
    page.socket.fire('abortGame', { reason: 'test' });
    expect(page.session.screen).toBe(SCREEN.MAIN_ROOM);
    replay.advance(50);
    expect(game.loop.running).toBe(false);
  });

  it('a rejoin (reload) wakes it; the table matches the server to the game end; the score modal keeps it; Return to Lobby sleeps it', () => {
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    const rest = replay.replayViewer(page, rec, 'seat1-rejoin');
    expect(rest.results.length).toBeGreaterThan(50);
    expect(rest.bad).toEqual([]);
    expect(page.session.screen).toBe(SCREEN.GAME_END);
    replay.advance(200);
    expect(game.loop.running).toBe(true);
    document.querySelector('#finalScoreOverlay button').click();
    expect(page.session.screen).toBe(SCREEN.MAIN_ROOM);
    replay.advance(50);
    expect(game.loop.running).toBe(false);
  });

  it('a spectate wakes it at once and the joined table draws', () => {
    const join = rec.logs.spectator[0];
    page.socket.fire('spectatorJoined', JSON.parse(JSON.stringify(join.data)));
    expect(game.loop.running).toBe(true);
    replay.advance(50);
    expect(replay.liveCounts(page.scene)).toEqual(replay.expectedCounts(join.data.snapshot));
    expect(page.session.role).toBe(ROLE.SPECTATOR);
  });
});

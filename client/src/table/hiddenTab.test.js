/**
 * A hidden tab mid-trick (events-bots-s12, seat 1): Phaser's loop stops
 * while the page keeps receiving events, so their tweens and timers queue
 * up. On return the TableDirector cancels all of it and renders the model:
 * no face-up card left in the middle, no stale stack, nothing still
 * flying, exactly the server's table; the >5 s background also pings the
 * socket, and that reply renders the same table again.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let clock;

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  Object.defineProperty(document, 'hidden', { value: state === 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  ({ clock } = await import('../testing/fakePhaser.js'));
  rec = replay.loadRecording('events-bots-s12');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
});

afterAll(() => {
  setVisibility('visible');
  vi.useRealTimers();
});

describe('a hidden tab mid-trick', () => {
  it('fast-forwards on return: the server\'s table, nothing left in flight', () => {
    const log = rec.logs.seat1;
    const cps = new Map(rec.checkpoints.filter((c) => c.viewer === 'seat1').map((c) => [c.afterIndex, c.snapshot]));
    // hide mid-trick (cards on the table); come back tricks later, mid-trick again
    const keys = [...cps.keys()].sort((a, b) => a - b);
    const hideAt = keys.find((i) => i > 60 && cps.get(i).stage === 'PLAYING' && cps.get(i).trick.cards.length >= 1);
    const showAt = keys.find((i) => i > hideAt + 25 && cps.get(i).stage === 'PLAYING' && cps.get(i).trick.cards.length >= 2);
    expect(hideAt).toBeGreaterThan(0);
    expect(showAt).toBeGreaterThan(hideAt);
    replay.replayLog(page, log, { to: hideAt });

    setVisibility('hidden');
    clock.paused = true; // requestAnimationFrame stops: no Phaser step
    const added = page.scene.tweens.added;
    // the page keeps applying events (DOM timers still run, throttled)
    replay.replayLog(page, log, { from: hideAt, to: showAt });
    expect(page.scene.tweens.added).toBeGreaterThan(added); // animations queued while frozen
    replay.advance(6000); // > 5 s hidden

    clock.paused = false;
    page.socket.clearEmits();
    setVisibility('visible');
    const want = cps.get(showAt);
    expect(replay.liveCounts(page.scene)).toEqual(replay.expectedCounts(want));
    // no tween at all (the hand's 50 ms re-layout timer runs on the next frames)
    expect(page.scene.tweens.active).toBe(0);
    replay.advance(100);
    expect(page.scene.director.pending()).toBe(0);
    // every card in the middle is a trick card, face up, at its slot
    const trick = page.scene.trickManager.getCurrentTrickSprites();
    expect(trick.every((s) => s.texture.key === 'cards' && s.scaleX === 1.5)).toBe(true);
    // every stacked card sits on its stack, no tween left on it
    const stacks = [...page.scene.trickManager._teamTrickHistory, ...page.scene.trickManager._oppTrickHistory];
    for (const st of stacks) for (const c of st.cards) expect([c.x, c.y]).toEqual([st.position.x, st.position.y]);
    // nothing else is alive on the canvas: equal to the census of a render of the same model
    const census = page.scene.census();
    page.scene.render();
    expect(page.scene.census()).toEqual(census);

    // the background ping and its answer
    const ping = page.socket.emitted('requestSnapshot').find((d) => String(d.requestId).startsWith('ping-'));
    expect(ping).toBeTruthy();
    page.socket.fire('stateSnapshot', { snapshot: JSON.parse(JSON.stringify(want)), requestId: ping.requestId });
    replay.advance(50);
    expect(replay.liveCounts(page.scene)).toEqual(replay.expectedCounts(want));
    expect(page.scene.census()).toEqual(census);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TableDirector, keyAt, WHISK_TIMEOUT_MS, READY_POLL_MS } from './TableDirector.js';
import { removeTransitionOverlay } from '../ui/transitionOverlay.js';

/** A scene with Phaser's time and tweens (handles record stop/remove). */
function fakeScene() {
  const timers = [];
  const tweens = [];
  return {
    cardManager: {},
    timers,
    tweens: {
      add: vi.fn((cfg) => {
        const t = { cfg, state: 23, stop: vi.fn(function stop() { this.state = 25; }) };
        tweens.push(t);
        return t;
      }),
      list: tweens,
    },
    time: {
      delayedCall: vi.fn((ms, cb) => {
        const t = { ms, cb, removed: false, remove: vi.fn(function remove() { this.removed = true; }) };
        timers.push(t);
        return t;
      }),
    },
  };
}

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
};

describe('TableDirector', () => {
  let d;
  let gen;

  beforeEach(() => {
    vi.useFakeTimers();
    gen = 1;
    d = new TableDirector();
    d.configure({ generation: () => gen });
  });

  afterEach(() => {
    setVisibility('visible');
    vi.useRealTimers();
  });

  it('keys: game, hand, deal, trick prefixes', () => {
    const k = { gameId: 'g', handNo: 3, deal: 4, trickNo: 2 };
    expect(keyAt(k, 'hand')).toBe('g:3');
    expect(keyAt(k, 'deal')).toBe('g:3:4');
    expect(keyAt(k)).toBe('g:3:4:2');
  });

  it('buffers work until the scene has its managers, in order; a newer generation drops it (webclient-2)', () => {
    const ran = [];
    d.run(() => ran.push('a'), { kind: 'draw' });
    d.run(() => ran.push('b'), { kind: 'draw' });
    gen = 2;
    d.run(() => ran.push('c'), { kind: 'draw' });
    const scene = fakeScene();
    scene.cardManager = null;
    d.attach(scene);
    expect(ran).toEqual([]);
    scene.cardManager = {};
    vi.advanceTimersByTime(READY_POLL_MS);
    expect(ran).toEqual(['c']);
    expect(d.stats.dropped).toBe(2);
    d.run(() => ran.push('d'));
    expect(ran).toEqual(['c', 'd']); // ready: at once
  });

  it('a flush that ran table work ends with one render of the model', () => {
    const render = vi.fn();
    d.configure({ render, isLive: () => true });
    d.run(() => {}, { kind: 'draw' });
    d.attach(fakeScene());
    expect(render).not.toHaveBeenCalled();
    d.detach();
    d.run(() => {});
    d.run(() => {});
    d.attach(fakeScene());
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('owns timers and tweens: reset cancels every one; scoped work skips a later deal or trick', () => {
    const scene = fakeScene();
    d.attach(scene);
    d.setKey({ gameId: 'g', handNo: 1, deal: 1, trickNo: 1 });
    const flipped = vi.fn();
    d.delay(2000, flipped, { scope: 'deal' });
    const collected = vi.fn();
    d.tween({ targets: {}, x: 1, onComplete: collected }, { scope: 'trick' });
    expect(d.pending()).toBe(2);
    // the next deal: the old flip never fires (cli-19: no stale bid panel),
    // nor the old trick's scoped completion
    d.setKey({ deal: 2, trickNo: 1 });
    scene.timers[0].cb();
    scene.tweens.list[0].cfg.onComplete();
    expect(flipped).not.toHaveBeenCalled();
    expect(collected).not.toHaveBeenCalled();
    // work of the current trick, and unscoped work, runs
    const done = vi.fn();
    d.tween({ targets: {}, x: 1, onComplete: done }, { scope: 'trick' });
    const always = vi.fn();
    d.delay(10, always);
    d.setKey({ trickNo: 2 });
    scene.timers.at(-1).cb();
    expect(always).toHaveBeenCalled();
    scene.tweens.list.at(-1).cfg.onComplete();
    expect(done).not.toHaveBeenCalled(); // a later trick: skipped
    const now = vi.fn();
    d.tween({ targets: {}, x: 1, onComplete: now }, { scope: 'trick' });
    scene.tweens.list.at(-1).cfg.onComplete();
    expect(now).toHaveBeenCalled();
    d.delay(100, () => {});
    d.tween({ targets: {}, x: 2 });
    d.reset();
    expect(scene.timers.at(-1).remove).toHaveBeenCalledWith(false);
    expect(scene.tweens.list.at(-1).stop).toHaveBeenCalled();
    expect(d.pending()).toBe(0);
  });

  it('the deal waits for the first hand\'s fade, then for a whisk; a removed overlay supersedes it', () => {
    d.attach(fakeScene());
    d.setKey({ gameId: 'g', handNo: 1, deal: 1 });
    const dealt = vi.fn();
    d.beginFade();
    expect(d.afterTransition(dealt)).toBe(false);
    d.endFade();
    expect(dealt).toHaveBeenCalledTimes(1);

    d.beginWhisk();
    const next = vi.fn();
    d.setKey({ handNo: 2, deal: 2 });
    d.afterTransition(next);
    expect(next).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WHISK_TIMEOUT_MS); // a whisk that never lands still ends
    expect(next).toHaveBeenCalledTimes(1);

    const late = vi.fn();
    d.beginFade();
    d.afterTransition(late);
    removeTransitionOverlay(); // a rejoin / exit: its render owns the table
    expect(d.uiReady).toBe(true);
    expect(d.waiting).toBe(0);
    expect(late).not.toHaveBeenCalled();
  });

  it('a play during the wait puts the deal down first (settleDeal); another deal\'s waiter is dropped', () => {
    d.attach(fakeScene());
    d.setKey({ gameId: 'g', handNo: 1, deal: 1 });
    const dealt = vi.fn();
    d.beginFade();
    d.afterTransition(dealt);
    d.settleDeal();
    expect(dealt).toHaveBeenCalledTimes(1);
    const stale = vi.fn();
    d.afterTransition(stale);
    d.setKey({ deal: 2 });
    d.settleDeal();
    expect(stale).not.toHaveBeenCalled();
  });

  it('a hidden tab that changed (or had work in flight) renders the model on return', () => {
    const render = vi.fn();
    d.configure({ render, isLive: () => true });
    d.attach(fakeScene());
    setVisibility('hidden');
    d.onVisibilityChange();
    d.noteChange();
    setVisibility('visible');
    d.onVisibilityChange();
    expect(render).toHaveBeenCalledTimes(1);
    // nothing changed and nothing in flight: no render
    setVisibility('hidden');
    d.onVisibilityChange();
    setVisibility('visible');
    d.onVisibilityChange();
    expect(render).toHaveBeenCalledTimes(1);
  });
});

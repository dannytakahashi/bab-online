import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DrawManager } from './DrawManager.js';

// Phaser game object stand-in: every setter chains, destroy is tracked
function createGameObject() {
  const obj = { destroy: vi.fn() };
  const proxy = new Proxy(obj, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => proxy;
    },
  });
  return proxy;
}

describe('DrawManager fade timer', () => {
  let scene;
  let timer;
  let fadeCallback;

  beforeEach(() => {
    fadeCallback = null;
    timer = { remove: vi.fn() };
    scene = {
      scale: { width: 1920, height: 953 },
      add: { rectangle: vi.fn(createGameObject), text: vi.fn(createGameObject) },
      tweens: { add: vi.fn() },
      time: {
        delayedCall: vi.fn((delay, cb) => {
          fadeCallback = cb;
          return timer;
        }),
      },
    };
  });

  afterEach(() => {
    document.getElementById('transition-overlay')?.remove();
  });

  it('cleanup cancels the fade-to-black scheduled by handleTeamsAnnounced', () => {
    const dm = new DrawManager(scene);
    dm.deckConfig = { startX: 0, startY: 100 };

    dm.handleTeamsAnnounced({ team1: ['a', 'b'], team2: ['c', 'd'] });
    expect(scene.time.delayedCall).toHaveBeenCalledWith(2000, expect.any(Function));

    // createUI arrives (e.g. timer delayed while the tab was hidden)
    dm.cleanup();

    expect(timer.remove).toHaveBeenCalledWith(false);
    expect(dm._fadeTimer).toBeNull();
  });

  it('a fade that already ran is not removed again', () => {
    const dm = new DrawManager(scene);
    dm.deckConfig = { startX: 0, startY: 100 };

    dm.handleTeamsAnnounced({ team1: ['a', 'b'], team2: ['c', 'd'] });
    fadeCallback();
    expect(document.getElementById('transition-overlay')).toBeTruthy();

    dm.cleanup();
    expect(timer.remove).not.toHaveBeenCalled();
  });
});

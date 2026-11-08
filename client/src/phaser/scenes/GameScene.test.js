import { describe, it, expect, beforeAll, vi } from 'vitest';

// Phaser is a CDN global in production; the scene only needs a base class here
globalThis.Phaser = { Scene: class Scene {} };

vi.mock('../managers/LayoutManager.js', () => ({ LayoutManager: class { update() {} } }));
vi.mock('../managers/CardManager.js', () => ({ CardManager: class {} }));
vi.mock('../managers/OpponentManager.js', () => ({ OpponentManager: class {} }));
vi.mock('../managers/TrickManager.js', () => ({ TrickManager: class {} }));
vi.mock('../managers/EffectsManager.js', () => ({ EffectsManager: class {} }));
vi.mock('../managers/DrawManager.js', () => ({ DrawManager: class {} }));
vi.mock('../managers/BidManager.js', () => ({ BidManager: class {} }));

// Minimal event emitter with the on/off/once/emit surface Phaser exposes
function createEmitter(extra = {}) {
  const listeners = new Map();
  const emitter = {
    ...extra,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push({ fn, once: false });
      return emitter;
    },
    once(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push({ fn, once: true });
      return emitter;
    },
    off(event, fn) {
      listeners.set(event, (listeners.get(event) || []).filter((l) => l.fn !== fn));
      return emitter;
    },
    emit(event, ...args) {
      const current = listeners.get(event) || [];
      listeners.set(event, current.filter((l) => !l.once));
      current.forEach((l) => l.fn(...args));
    },
    listenerCount(event) {
      return (listeners.get(event) || []).length;
    },
  };
  return emitter;
}

let GameScene;

beforeAll(async () => {
  ({ GameScene } = await import('./GameScene.js'));
});

describe('GameScene resize listener', () => {
  it('keeps a single scale resize listener across scene restarts', () => {
    const scene = new GameScene();
    // ScaleManager is game-wide and outlives restarts; scene events do not
    scene.scale = createEmitter({ width: 1920, height: 953 });
    scene.events = createEmitter();
    scene.handleResize = vi.fn();

    for (let i = 0; i < 3; i++) {
      scene.create();
      expect(scene.scale.listenerCount('resize')).toBe(1);
      scene.events.emit('shutdown');
    }
    expect(scene.scale.listenerCount('resize')).toBe(0);

    scene.create();
    scene.scale.emit('resize', { width: 800, height: 600 });
    expect(scene.handleResize).toHaveBeenCalledTimes(1);
    expect(scene.handleResize).toHaveBeenCalledWith(800, 600);
  });
});

describe('GameScene preload', () => {
  it('does not preload profile avatars as textures', () => {
    const scene = new GameScene();
    const image = vi.fn();
    scene.load = { atlas: vi.fn(), image };

    scene.preload();

    const keys = image.mock.calls.map(([key]) => key);
    expect(keys.some((key) => key.startsWith('profile'))).toBe(false);
    expect(keys).not.toContain('background');
    // Textures the scene does draw are still loaded
    expect(keys).toEqual(expect.arrayContaining(['cardBack', 'rainbow', 'ot', 'b', '2b', '3b', '4b']));
  });
});

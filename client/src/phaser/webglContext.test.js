import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../testing/files.js';
import {
  installContextLossHandling, CONTEXT_LOST, CONTEXT_RESTORED, GL_RELOAD_KEY, GL_RELOAD_WINDOW_MS, RESTORE_WAIT_MS, GL_TEXT,
} from './webglContext.js';

function fakeGame() {
  const listeners = new Map();
  return {
    events: {
      on: (e, fn) => listeners.set(e, fn),
      off: (e) => listeners.delete(e),
    },
    fire: (e) => listeners.get(e)?.(),
    listening: () => listeners.size,
  };
}

function storage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

let game;
let store;
let notify;
let reload;
let clock;
let uninstall;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  game = fakeGame();
  store = storage();
  notify = vi.fn();
  reload = vi.fn();
  clock = 1_000_000;
  uninstall = installContextLossHandling({ game, notify, reload, storage: store, now: () => clock });
});

describe('WebGL context loss (later #17)', () => {
  it('restored: Phaser 3.55 lost the textures, so the page reloads once, with a message', () => {
    game.fire(CONTEXT_LOST);
    expect(reload).not.toHaveBeenCalled();
    game.fire(CONTEXT_RESTORED);
    expect(notify).toHaveBeenCalledWith('reloading', GL_TEXT.RELOADING);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.getItem(GL_RELOAD_KEY)).toBe(String(clock));
  });

  it('never restored: reloads after RESTORE_WAIT_MS', () => {
    game.fire(CONTEXT_LOST);
    vi.advanceTimersByTime(RESTORE_WAIT_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    // a late restore does not reload twice
    game.fire(CONTEXT_RESTORED);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('lost again right after its reload: asks for a manual reload instead of looping', () => {
    store.setItem(GL_RELOAD_KEY, String(clock - 1000));
    game.fire(CONTEXT_LOST);
    game.fire(CONTEXT_RESTORED);
    expect(reload).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('stuck', GL_TEXT.STUCK);
  });

  it('a loss long after the last one reloads again', () => {
    store.setItem(GL_RELOAD_KEY, String(clock - GL_RELOAD_WINDOW_MS - 1));
    game.fire(CONTEXT_LOST);
    game.fire(CONTEXT_RESTORED);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a reload that throws says so', () => {
    reload.mockImplementation(() => { throw new Error('blocked'); });
    game.fire(CONTEXT_RESTORED);
    expect(notify).toHaveBeenLastCalledWith('stuck', GL_TEXT.STUCK);
  });

  it('the event names are Phaser 3.55\'s own, and its renderer restores no textures (why this reloads)', () => {
    const phaser = (f) => readFileSync(resolve(REPO_ROOT, 'node_modules/phaser/src', f), 'utf8');
    expect(phaser('core/events/CONTEXT_LOST_EVENT.js')).toContain(`module.exports = '${CONTEXT_LOST}';`);
    expect(phaser('core/events/CONTEXT_RESTORED_EVENT.js')).toContain(`module.exports = '${CONTEXT_RESTORED}';`);
    const renderer = phaser('renderer/webgl/WebGLRenderer.js');
    const restored = renderer.slice(renderer.indexOf('this.contextRestoredHandler = function'), renderer.indexOf("canvas.addEventListener('webglcontextlost'"));
    expect(restored).toMatch(/_this\.init\(_this\.config\)/);
    expect(restored).not.toMatch(/texture/i);
  });

  it('off the table (main room, admin panel, a form): no reload until the table shows', () => {
    uninstall();
    let screen = 'mainRoom';
    const listeners = new Set();
    uninstall = installContextLossHandling({
      game, notify, reload, storage: store, now: () => clock,
      isTableShowing: () => screen === 'table',
      onScreenChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    });
    const show = (s) => { screen = s; [...listeners].forEach((fn) => fn(s)); };
    game.fire(CONTEXT_LOST);
    vi.advanceTimersByTime(RESTORE_WAIT_MS);
    game.fire(CONTEXT_RESTORED);
    expect(reload).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    show('profile');
    expect(reload).not.toHaveBeenCalled();
    show('table');
    expect(notify).toHaveBeenCalledWith('reloading', GL_TEXT.RELOADING);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    show('mainRoom');
    show('table');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('storage blocked (the guard would not survive the reload): asks for a manual reload, never loops', () => {
    uninstall();
    const blocked = { ...storage(), persistent: false };
    uninstall = installContextLossHandling({ game, notify, reload, storage: blocked, now: () => clock });
    game.fire(CONTEXT_LOST);
    game.fire(CONTEXT_RESTORED);
    expect(reload).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('stuck', GL_TEXT.STUCK);
  });

  it('storage blocked for real (safeSessionStorage over a throwing sessionStorage) is not persistent', async () => {
    const { safeSessionStorage } = await import('../utils/safeStorage.js');
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
      uninstall();
      uninstall = installContextLossHandling({ game, notify, reload, storage: safeSessionStorage(), now: () => clock });
      game.fire(CONTEXT_RESTORED);
      expect(reload).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith('stuck', GL_TEXT.STUCK);
    } finally {
      if (desc) Object.defineProperty(globalThis, 'sessionStorage', desc);
      else delete globalThis.sessionStorage;
      safeSessionStorage()._forget();
    }
  });

  it('uninstall stops listening; a game without events (the canvas renderer, tests) is a no-op', () => {
    uninstall();
    expect(game.listening()).toBe(0);
    expect(installContextLossHandling({ game: {}, notify })()).toBeUndefined();
  });
});

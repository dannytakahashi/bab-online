/**
 * WebGL context loss (later #17). A GPU reset, a driver update or too many
 * contexts in the browser takes the canvas's WebGL context away. Phaser
 * 3.55 marks the renderer lost and, when the browser gives a context back,
 * rebuilds its pipelines but NOT the textures: every texture (the card
 * atlas, avatars, text) points at a dead GL handle, so the table would draw
 * blank or garbage cards. The page has a tested way to rebuild everything
 * from the server (a reload restores the session and rejoins the seat, the
 * spectator view or the screen), so it reloads, with a message, once the
 * context is back or after RESTORE_WAIT_MS without it.
 *
 * Loop guard: sessionStorage GL_RELOAD_KEY holds when this tab last
 * reloaded for this; a second loss within GL_RELOAD_WINDOW_MS shows a
 * message asking for a manual reload instead.
 */
import { safeSessionStorage } from '../utils/safeStorage.js';

export const CONTEXT_LOST = 'contextlost'; // Phaser.Core.Events.CONTEXT_LOST
export const CONTEXT_RESTORED = 'contextrestored'; // Phaser.Core.Events.CONTEXT_RESTORED
export const GL_RELOAD_KEY = 'bab.glReload';
export const GL_RELOAD_WINDOW_MS = 2 * 60 * 1000;
export const RESTORE_WAIT_MS = 5000;

export const GL_TEXT = Object.freeze({
  RELOADING: 'The graphics were reset. Reloading the table...',
  STUCK: 'The graphics stopped working. Reload the page to continue.',
});

/**
 * @param {Object} o
 * @param {{events: {on: Function, off?: Function}}} o.game - the Phaser game
 * @param {Function} o.notify - (kind: 'reloading' | 'stuck', text) => void
 * @param {Function} [o.reload] - () => void
 * @param {Object} [o.storage] - sessionStorage-like (never throws: safeSessionStorage)
 * @param {Function} [o.now]
 * @param {Function} [o.setTimer]
 * @param {Function} [o.clearTimer]
 * @returns {Function} uninstall
 */
export function installContextLossHandling({
  game, notify, reload = () => globalThis.location?.reload(), storage = safeSessionStorage(),
  now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
}) {
  const events = game?.events;
  if (!events?.on) return () => {};
  let timer = null;
  let done = false;

  const recover = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (done) return;
    done = true;
    const last = Number(storage.getItem(GL_RELOAD_KEY));
    if (last > 0 && now() - last < GL_RELOAD_WINDOW_MS) {
      notify('stuck', GL_TEXT.STUCK);
      return;
    }
    storage.setItem(GL_RELOAD_KEY, String(now()));
    notify('reloading', GL_TEXT.RELOADING);
    try {
      reload();
    } catch {
      notify('stuck', GL_TEXT.STUCK);
    }
  };

  const onLost = () => {
    console.warn('WebGL context lost');
    if (done || timer !== null) return;
    // Wait a moment for the browser to hand a context back (a reload
    // before that may get no WebGL at all), then reload either way
    timer = setTimer(recover, RESTORE_WAIT_MS);
  };
  const onRestored = () => {
    console.warn('WebGL context restored: its textures are gone, reloading');
    recover();
  };

  events.on(CONTEXT_LOST, onLost);
  events.on(CONTEXT_RESTORED, onRestored);
  return () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    events.off?.(CONTEXT_LOST, onLost);
    events.off?.(CONTEXT_RESTORED, onRestored);
  };
}

/**
 * TableDirector: the one owner of the table's timed presentation work.
 *
 * Every delayedCall and tween the table starts goes through it
 * (sceneDelay / sceneTween below), tagged with the key it belongs to,
 * {gameId, handNo, deal, trickNo} (deal = the deal's seq, so a zero-bid
 * redeal is a new deal of the same hand). It replaces the window flags and
 * events that used to sequence a hand (window._transitionOverlay,
 * _readyForGameUI, _tricksAnimating; trumpFlipComplete, gameUIReady,
 * tricksCleared):
 *
 *   - uiReady: false while the teams fade / createUI fade-out is up; a deal
 *     that arrives meanwhile waits (afterTransition) and its trump flips
 *     later (FLIP_AFTER_FADE_MS).
 *   - whisking: the previous hand's tricks flying back to the trump; the
 *     next deal waits for it (a WHISK_TIMEOUT_MS fallback ends it).
 *   - work scoped 'hand' / 'trick' never runs for a later hand / trick
 *     (the old trumpFlipComplete listener fired for the next game).
 *
 * Scene readiness: run(fn) defers work until the scene exists and has its
 * managers (events before GameScene.create() are buffered, never dropped;
 * webclient-2), tagged with the table generation (an exit or a newer
 * rebuild drops it). A flush that ran table work ends with one render of
 * the current model, so a late scene always shows exactly the state.
 *
 * Visibility: Phaser freezes in a hidden tab, so tweens and timers queued
 * there would replay on return. When the tab is visible again and anything
 * changed or was in flight while hidden, the director cancels all of it
 * and renders the current model (fastForward): no face-up leftovers, stale
 * stacks or black overlay.
 *
 * reset() cancels everything it owns; GameScene.render calls it first, so
 * a render is a clean slate.
 */

import { removeTransitionOverlay, onTransitionRemoved } from '../ui/transitionOverlay.js';

/** gameUIReady used to follow the createUI fade-out by this long. */
export const UI_READY_DELAY_MS = 500;
/** The trump flip after a deal (first hand: after the createUI fade). */
export const FLIP_AFTER_DEAL_MS = 2000;
export const FLIP_AFTER_FADE_MS = 3500;
/** The end-of-hand whisk never holds the next deal longer than this. */
export const WHISK_TIMEOUT_MS = 2000;
/** Scene readiness is polled this often while work is queued. */
export const READY_POLL_MS = 100;

const SCOPES = ['game', 'hand', 'deal', 'trick'];
const TWEEN_PENDING_REMOVE = 25;

/** The key's prefix up to `scope` ('game' | 'hand' | 'deal' | 'trick'). */
export function keyAt(key, scope = 'trick') {
  const k = key || {};
  const parts = [k.gameId || '-', k.handNo || 0, k.deal ?? 0, k.trickNo || 0];
  return parts.slice(0, SCOPES.indexOf(scope) + 1).join(':');
}

export class TableDirector {
  constructor({ setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._scene = null;
    this._queue = [];
    this._pollTimer = null;
    this._work = new Set();
    this.key = { gameId: null, handNo: 0, deal: 0, trickNo: 0 };
    this.uiReady = true;
    this.whisking = false;
    this._whiskTimer = null;
    this._waiters = [];
    this._generation = () => 0;
    this._renderer = null;
    this._isLive = () => false;
    this._hiddenAt = null;
    this._changedWhileHidden = false;
    this.stats = { renders: 0, fastForwards: 0, dropped: 0, flushed: 0, resets: 0 };
    this._visibilityInstalled = false;
    onTransitionRemoved(() => this.cancelFade());
  }

  /**
   * @param {Object} deps
   * @param {Function} [deps.generation] - () => the session's tableGeneration
   * @param {Function} [deps.render] - (scene) => render the current model
   * @param {Function} [deps.isLive] - () => a dealt hand is on the table
   */
  configure({ generation, render, isLive } = {}) {
    if (generation) this._generation = generation;
    if (render) this._renderer = render;
    if (isLive) this._isLive = isLive;
    this._installVisibility();
  }

  // ============================================
  // Scene readiness (webclient-2)
  // ============================================

  get scene() {
    return this._scene;
  }

  /** The scene exists and created its managers. */
  get ready() {
    return !!(this._scene && this._scene.cardManager);
  }

  attach(scene) {
    if (this._scene && this._scene !== scene) this.reset();
    this._scene = scene;
    this.flush();
  }

  /** The scene is going away (teardown, restart): nothing it owned may run. */
  detach() {
    this.reset();
    this._scene = null;
  }

  /**
   * Run fn(scene) now, or once the scene is ready (in arrival order).
   * @param {Function} fn
   * @param {Object} [opts]
   * @param {string} [opts.kind='table'] - 'table' / 'deal' (renderable state), 'draw' (replayed as is) or 'render'
   */
  run(fn, { kind = 'table' } = {}) {
    if (this.ready && this._queue.length === 0) {
      fn(this._scene);
      return true;
    }
    this._queue.push({ fn, kind, generation: this._generation() });
    this._schedulePoll();
    return false;
  }

  get queued() {
    return this._queue.length;
  }

  /** Drop queued work (an exit). */
  clearQueue() {
    this._queue = [];
    if (this._pollTimer) this._clearTimer(this._pollTimer);
    this._pollTimer = null;
  }

  _schedulePoll() {
    if (this._pollTimer) return;
    this._pollTimer = this._setTimer(() => {
      this._pollTimer = null;
      this.flush();
    }, READY_POLL_MS);
  }

  flush() {
    if (!this._queue.length) return;
    if (!this.ready) {
      this._schedulePoll();
      return;
    }
    const queued = this._queue;
    this._queue = [];
    const gen = this._generation();
    let ranTable = false;
    for (const item of queued) {
      if (item.generation !== gen) {
        this.stats.dropped++;
        continue;
      }
      try {
        item.fn(this._scene);
        this.stats.flushed++;
        // Table events animated late: settle on the model ('draw' replays
        // as is; a 'render' is the model already)
        if (item.kind !== 'draw') ranTable = item.kind !== 'render' || ranTable;
      } catch (err) {
        console.error('Deferred table work failed:', err);
      }
    }
    // Late events stack their animations: settle on the model once
    if (ranTable && this._isLive()) this.fastForward('flush');
  }

  // ============================================
  // Owned work
  // ============================================

  setKey(next = {}) {
    this.key = { ...this.key, ...next };
    return this.key;
  }

  /** Not-yet-finished timers and tweens (optionally only those of `key`'s `scope`). */
  pending(scope = null) {
    let n = 0;
    const want = scope ? keyAt(this.key, scope) : null;
    for (const w of this._work) {
      if (w.done || w.isDone()) continue;
      if (want && keyAt(w.key, scope) !== want) continue;
      n++;
    }
    return n;
  }

  _prune() {
    for (const w of this._work) if (w.done || w.isDone()) this._work.delete(w);
  }

  /**
   * A delayed call owned by the director.
   * @param {number} ms
   * @param {Function} fn
   * @param {Object} [opts]
   * @param {string} [opts.scope] - 'hand' | 'deal' | 'trick': skipped when the key moved past it
   * @returns {{remove: Function}} the handle (remove(false) cancels)
   */
  delay(ms, fn, { scope = null } = {}) {
    this._prune();
    const key = { ...this.key };
    const entry = { kind: 'timer', key, done: false, isDone: () => entry.done };
    const run = () => {
      if (entry.done) return;
      entry.done = true;
      this._work.delete(entry);
      if (scope && keyAt(this.key, scope) !== keyAt(key, scope)) {
        this.stats.dropped++;
        return;
      }
      fn();
    };
    const time = this._scene?.time;
    if (time && typeof time.delayedCall === 'function') {
      const handle = time.delayedCall(ms, run);
      entry.cancel = () => handle?.remove?.(false);
      entry.handle = handle;
    } else {
      const t = this._setTimer(run, ms);
      entry.cancel = () => this._clearTimer(t);
      entry.handle = { remove: () => { entry.done = true; this._clearTimer(t); } };
    }
    this._work.add(entry);
    const handle = entry.handle;
    return {
      remove: (dispatch = false) => {
        if (entry.done) return;
        entry.done = true;
        this._work.delete(entry);
        entry.cancel();
        if (dispatch) fn();
      },
      get handle() { return handle; },
    };
  }

  /**
   * A tween owned by the director (returns the Phaser tween).
   * @param {Object} config - Phaser tween config
   * @param {Object} [opts]
   * @param {string} [opts.scope] - its onComplete is skipped when the key moved past it
   */
  tween(config, { scope = null } = {}) {
    const tweens = this._scene?.tweens;
    if (!tweens || typeof tweens.add !== 'function') return null;
    this._prune();
    const key = { ...this.key };
    const entry = { kind: 'tween', key, done: false, isDone: () => entry.done };
    const onComplete = config.onComplete;
    const cfg = {
      ...config,
      onComplete: (...args) => {
        entry.done = true;
        this._work.delete(entry);
        if (scope && keyAt(this.key, scope) !== keyAt(key, scope)) {
          this.stats.dropped++;
          return;
        }
        onComplete?.(...args);
      },
    };
    const tween = tweens.add(cfg);
    entry.handle = tween;
    // Phaser 3.55 Tween states: PENDING_REMOVE 25, REMOVED 26 (killTweensOf
    // or stop() elsewhere ends a tween without its onComplete)
    entry.isDone = () => entry.done || (typeof tween?.state === 'number' && tween.state >= TWEEN_PENDING_REMOVE);
    entry.cancel = () => tween?.stop?.();
    this._work.add(entry);
    return tween;
  }

  /** Cancel every owned timer and tween, the waiters and the hand flags. */
  reset() {
    this.stats.resets++;
    for (const w of this._work) {
      if (!w.done) {
        w.done = true;
        try {
          w.cancel?.();
        } catch {
          /* a destroyed scene's handle */
        }
      }
    }
    this._work.clear();
    this._waiters = [];
    this.uiReady = true;
    this._endWhiskFlag();
  }

  // ============================================
  // Hand start: fade, whisk, then the deal
  // ============================================

  /** The teams fade to black started (DrawManager). */
  beginFade() {
    this.uiReady = false;
  }

  /** createUI's fade-out finished (plus UI_READY_DELAY_MS): the first deal may show. */
  endFade() {
    this.uiReady = true;
    this._release('ui');
  }

  /** A rejoin or an exit removed the overlay: whatever it gated was superseded. */
  cancelFade() {
    if (this.uiReady) return;
    this.uiReady = true;
    this._waiters = this._waiters.filter((w) => w.cond !== 'ui');
  }

  /** The previous hand's tricks are flying back to the trump. */
  beginWhisk() {
    this._endWhiskFlag();
    this.whisking = true;
    this._whiskTimer = this._setTimer(() => this.endWhisk(), WHISK_TIMEOUT_MS);
  }

  endWhisk() {
    if (!this.whisking) return;
    this._endWhiskFlag();
    this._release('whisk');
  }

  _endWhiskFlag() {
    this.whisking = false;
    if (this._whiskTimer) this._clearTimer(this._whiskTimer);
    this._whiskTimer = null;
  }

  /**
   * Run fn once the fade (first hand) or the whisk (later hands) is over;
   * skipped if the deal changed meanwhile.
   * @returns {boolean} whether it ran at once
   */
  afterTransition(fn) {
    const cond = !this.uiReady ? 'ui' : (this.whisking ? 'whisk' : null);
    if (!cond) {
      fn();
      return true;
    }
    this._waiters.push({ cond, fn, deal: keyAt(this.key, 'deal') });
    return false;
  }

  _release(cond) {
    const ready = this._waiters.filter((w) => w.cond === cond);
    this._waiters = this._waiters.filter((w) => w.cond !== cond);
    for (const w of ready) {
      if (w.deal !== keyAt(this.key, 'deal')) {
        this.stats.dropped++;
        continue;
      }
      // still behind the other gate (a whisk during the first fade)
      if (!this.uiReady || this.whisking) {
        this._waiters.push({ ...w, cond: !this.uiReady ? 'ui' : 'whisk' });
        continue;
      }
      try {
        w.fn();
      } catch (err) {
        console.error('Deal step failed:', err);
      }
    }
  }

  get waiting() {
    return this._waiters.length;
  }

  // ============================================
  // Fast-forward (render the model)
  // ============================================

  /** Cancel everything in flight and render the current model. */
  fastForward(reason = 'manual') {
    if (!this.ready || !this._renderer) return false;
    this.stats.fastForwards++;
    this.reset();
    removeTransitionOverlay();
    try {
      this._renderer(this._scene, reason);
      this.stats.renders++;
    } catch (err) {
      console.error('Fast-forward render failed:', err);
    }
    return true;
  }

  /** Something changed the table (an applied event): a hidden tab must re-render on return. */
  noteChange() {
    if (this._hidden()) this._changedWhileHidden = true;
  }

  _hidden() {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  _installVisibility() {
    if (this._visibilityInstalled || typeof document === 'undefined') return;
    this._visibilityInstalled = true;
    document.addEventListener('visibilitychange', () => this.onVisibilityChange());
  }

  onVisibilityChange() {
    if (this._hidden()) {
      this._hiddenAt = Date.now();
      if (this.pending() > 0) this._changedWhileHidden = true;
      return;
    }
    const wasHidden = this._hiddenAt !== null;
    this._hiddenAt = null;
    const dirty = this._changedWhileHidden || this.pending() > 0 || this.waiting > 0;
    this._changedWhileHidden = false;
    if (wasHidden && dirty && this._isLive()) this.fastForward('visible');
  }
}

let instance = null;

export function getTableDirector() {
  if (!instance) instance = new TableDirector();
  return instance;
}

/** For tests. */
export function resetTableDirector(options) {
  instance = new TableDirector(options);
  return instance;
}

/** scene.director.delay when the scene has one (managers under unit tests may not). */
export function sceneDelay(scene, ms, fn, opts) {
  if (scene?.director) return scene.director.delay(ms, fn, opts);
  return scene.time.delayedCall(ms, fn);
}

/** scene.director.tween when the scene has one. */
export function sceneTween(scene, config, opts) {
  if (scene?.director) return scene.director.tween(config, opts);
  return scene.tweens.add(config);
}

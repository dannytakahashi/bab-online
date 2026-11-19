/**
 * Table sound effects (owner 2026-11-15: tasteful, on by default at a quiet
 * volume, one easy mute remembered per device). Web Audio, its OWN
 * AudioContext: voice chat (voice/VoiceChatManager.js) keeps its own, so a
 * suspended or closed voice context never silences the table and the
 * reverse.
 *
 * - The context is created on the first user gesture (browsers refuse
 *   audio before one) and the 12 files are fetched and decoded once then
 *   (a file that failed is fetched again on a later gesture, LOAD_TRIES in
 *   all); until it runs every play() is a silent no-op.
 * - Off the table (setActive(false), main.js) the context is suspended: a
 *   running one keeps the audio device and its render thread awake.
 * - Muted, or the tab hidden: nothing plays (sounds are never queued, so a
 *   tab coming back makes no burst).
 * - The same sound (the card-* variants count as one; a draw's card is its
 *   own) at most once per THROTTLE_MS.
 * - It never throws: a failure is logged once and the sound skipped.
 * - start() is the one sound that runs on and can be stopped: the bid
 *   clock's tune (audio/tableSounds.js), from an offset into its file; mute
 *   and volume reach it through the master gain while it plays.
 *
 * The files are built by scripts/build-sounds.py (npm run build:sounds);
 * imported with ?url so the build gives them hashed /dist/assets names.
 */

import dealUrl from '../../assets/sounds/deal.m4a?url';
import card1Url from '../../assets/sounds/card-1.m4a?url';
import card2Url from '../../assets/sounds/card-2.m4a?url';
import card3Url from '../../assets/sounds/card-3.m4a?url';
import trickUrl from '../../assets/sounds/trick.m4a?url';
import trickOursUrl from '../../assets/sounds/trick-ours.m4a?url';
import turnUrl from '../../assets/sounds/turn.m4a?url';
import madeUrl from '../../assets/sounds/made.m4a?url';
import setUrl from '../../assets/sounds/set.m4a?url';
import gameEndUrl from '../../assets/sounds/gameend.m4a?url';
import overTrumpUrl from '../../assets/sounds/overtrump.m4a?url';
import bidClockUrl from '../../assets/sounds/bidclock.m4a?url';

export const SOUND_URLS = Object.freeze({
  deal: dealUrl,
  'card-1': card1Url,
  'card-2': card2Url,
  'card-3': card3Url,
  trick: trickUrl,
  'trick-ours': trickOursUrl,
  turn: turnUrl,
  made: madeUrl,
  set: setUrl,
  gameend: gameEndUrl,
  overtrump: overTrumpUrl,
  // the bid clock's tune (30 s; started with start(), not play())
  bidclock: bidClockUrl,
});

/** play('card') picks one of these (never the one just played). */
export const CARD_VARIANTS = Object.freeze(['card-1', 'card-2', 'card-3']);
/**
 * Names that play a card variant: 'card' (a card played) and 'draw' (a card
 * turned up in the draw for deal: its own name, so its own throttle).
 */
const CARD_NAMES = new Set(['card', 'draw']);
/** Master gain: quiet by default (the files are mastered to -24 dBFS RMS). */
export const DEFAULT_VOLUME = 0.35;
export const STORAGE_KEY = 'bab.sound';
export const THROTTLE_MS = 80;
/** Gestures that may start audio (touchend: older iOS Safari). */
const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'];
/** Loads of the files that are still missing: the first and two retries, LOAD_RETRY_MS apart at least. */
export const LOAD_TRIES = 3;
export const LOAD_RETRY_MS = 5000;
/** start()'s handle: stop() fades out over this by default (seconds). */
export const STOP_FADE_S = 0.12;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** localStorage, or null where it throws (a blocked or private window). */
function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export class SoundManager {
  /**
   * @param {Object} [deps] - for tests; the defaults are the browser's
   */
  constructor({
    urls = SOUND_URLS,
    storage = defaultStorage(),
    AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext || null,
    fetchImpl = (...a) => globalThis.fetch(...a),
    now = () => globalThis.performance?.now?.() ?? Date.now(),
    doc = globalThis.document || null,
    random = Math.random,
  } = {}) {
    this._urls = urls;
    this._storage = storage;
    this._AudioContext = AudioContextImpl;
    this._fetch = fetchImpl;
    this._now = now;
    this._doc = doc;
    this._random = random;
    this.ctx = null;
    this._master = null;
    this._buffers = new Map();
    this._loading = null;
    this._loadBusy = false;
    this._loadTries = 0;
    this._loadAt = 0;
    this._active = true;
    this._last = new Map();
    this._lastCard = null;
    this._warned = new Set();
    this._listeners = new Set();
    this._readyListeners = new Set();
    this._unlockTarget = null;
    this.muted = false;
    this.volume = DEFAULT_VOLUME;
    this._loadPrefs();
  }

  // ---------- preferences (per device) ----------

  _loadPrefs() {
    let raw = null;
    try {
      raw = this._storage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      raw = null;
    }
    let prefs = null;
    try {
      prefs = raw ? JSON.parse(raw) : null;
    } catch {
      prefs = null;
    }
    this.muted = prefs?.muted === true;
    const v = Number(prefs?.volume);
    this.volume = prefs && Number.isFinite(v) ? clamp01(v) : DEFAULT_VOLUME;
  }

  _savePrefs() {
    try {
      this._storage?.setItem(STORAGE_KEY, JSON.stringify({ muted: this.muted, volume: this.volume }));
    } catch {
      // blocked storage: the choice holds for this page only
    }
  }

  /** Another tab changed the preference (the storage event): follow it. */
  reloadPrefs() {
    const before = `${this.muted}/${this.volume}`;
    this._loadPrefs();
    this._applyGain();
    if (`${this.muted}/${this.volume}` !== before) this._notify();
  }

  /** @param {(state: {muted: boolean, volume: number}) => void} fn @returns {Function} unsubscribe */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    for (const fn of [...this._listeners]) {
      try {
        fn({ muted: this.muted, volume: this.volume });
      } catch (err) {
        this._warnOnce('listener', err);
      }
    }
  }

  setMuted(muted) {
    const m = !!muted;
    if (m === this.muted) return;
    this.muted = m;
    this._savePrefs();
    this._applyGain();
    // unmuting is a click: the context can start now
    if (!m) this.unlock();
    this._notify();
  }

  /** @returns {boolean} the new muted state */
  toggleMuted() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setVolume(volume) {
    const v = Number(volume);
    if (!Number.isFinite(v)) return;
    this.volume = clamp01(v);
    this._savePrefs();
    this._applyGain();
    this._notify();
  }

  _applyGain() {
    if (!this._master) return;
    const g = this.muted ? 0 : this.volume;
    try {
      // at once, also over a sound already playing
      this._master.gain.value = g;
    } catch (err) {
      this._warnOnce('gain', err);
    }
  }

  // ---------- the context ----------

  /**
   * Listen for the gestures that may start audio (kept for good: iOS
   * Safari suspends the context in the background and only a gesture
   * resumes it).
   */
  installUnlock(target = globalThis.window) {
    if (!target?.addEventListener || this._unlockTarget) return;
    this._unlockTarget = target;
    this._onGesture = () => this.unlock();
    for (const type of UNLOCK_EVENTS) target.addEventListener(type, this._onGesture, { capture: true, passive: true });
    this._onStorage = (e) => {
      if (e?.key === STORAGE_KEY || e?.key === null) this.reloadPrefs();
    };
    target.addEventListener('storage', this._onStorage);
  }

  uninstallUnlock() {
    const target = this._unlockTarget;
    if (!target) return;
    for (const type of UNLOCK_EVENTS) target.removeEventListener(type, this._onGesture, { capture: true });
    target.removeEventListener('storage', this._onStorage);
    this._unlockTarget = null;
  }

  /**
   * From a user gesture: create / resume the context and load the files.
   * Muted: nothing yet. Off the table the context is made (the gesture is
   * what allows it) but left suspended until setActive(true).
   */
  unlock() {
    if (this.muted) return;
    try {
      if (!this.ctx) {
        if (!this._AudioContext) return;
        this.ctx = new this._AudioContext({ latencyHint: 'interactive' });
        this._master = this.ctx.createGain();
        this._master.connect(this.ctx.destination);
        this._applyGain();
        if (!this._active) this._suspend();
      }
      if (this._active) this._resume();
      this._loadAll();
    } catch (err) {
      this._warnOnce('context', err);
    }
  }

  /**
   * At a table (TABLE / GAME_END) or not: off it nothing plays, so the
   * context is suspended; back at one it resumes (the page's earlier
   * gesture allows that; where a browser still refuses, the next gesture
   * at the table does it).
   */
  setActive(active) {
    const a = !!active;
    if (a === this._active) return;
    this._active = a;
    if (!this.ctx) return;
    if (!a) this._suspend();
    else if (!this.muted) this._resume();
  }

  _resume() {
    if (this.ctx.state === 'running' || typeof this.ctx.resume !== 'function') return;
    try {
      const p = this.ctx.resume();
      p?.then?.(() => this._notifyReady(), (err) => this._warnOnce('resume', err));
    } catch (err) {
      this._warnOnce('resume', err);
    }
  }

  _suspend() {
    if (this.ctx.state === 'closed' || typeof this.ctx.suspend !== 'function') return;
    try {
      const p = this.ctx.suspend();
      p?.catch?.((err) => this._warnOnce('suspend', err));
    } catch (err) {
      this._warnOnce('suspend', err);
    }
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /**
   * Called each time sound may have become playable: the context resumed,
   * or a load of the files finished (the tune can start then).
   * @param {Function} fn @returns {Function} unsubscribe
   */
  onReady(fn) {
    this._readyListeners.add(fn);
    return () => this._readyListeners.delete(fn);
  }

  _notifyReady() {
    if (!this.ready) return;
    for (const fn of [...this._readyListeners]) {
      try {
        fn();
      } catch (err) {
        this._warnOnce('readyListener', err);
      }
    }
  }

  /** A decoded file's length in seconds, or null (not loaded). */
  duration(name) {
    const d = this._buffers.get(name)?.duration;
    return typeof d === 'number' && Number.isFinite(d) ? d : null;
  }

  /**
   * Fetch and decode the files not loaded yet. A failure (a network blip,
   * a long-lived tab's hashed URL gone after a deploy) is retried by a
   * later gesture, at most LOAD_TRIES loads in all.
   */
  _loadAll() {
    if (!this.ctx || this._loadBusy) return this._loading;
    const missing = Object.entries(this._urls).filter(([name]) => !this._buffers.has(name));
    if (!missing.length || this._loadTries >= LOAD_TRIES) return this._loading;
    const t = this._now();
    if (this._loadTries > 0 && t - this._loadAt < LOAD_RETRY_MS) return this._loading;
    this._loadTries++;
    this._loadAt = t;
    this._loadBusy = true;
    const ctx = this.ctx;
    this._loading = Promise.all(missing.map(async ([name, url]) => {
      try {
        const res = await this._fetch(url);
        if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
        const data = await res.arrayBuffer();
        this._buffers.set(name, await decode(ctx, data));
      } catch (err) {
        this._warnOnce(`load:${name}`, err);
      }
    })).then((done) => {
      this._loadBusy = false;
      this._notifyReady();
      return done;
    });
    return this._loading;
  }

  // ---------- playing ----------

  /**
   * Play a sound now (or `delay` s later), if it may. 'card' and 'draw' pick a variant.
   * @param {string} name
   * @param {Object} [opts]
   * @param {number} [opts.delay] - seconds after now
   * @param {number} [opts.gain] - relative to the master volume
   * @returns {boolean} whether it was started
   */
  play(name, { delay = 0, gain = 1 } = {}) {
    try {
      if (this.muted || this.volume <= 0) return false;
      if (this._doc?.hidden) return false;
      if (!this._active || !this.ready) return false;
      const t = this._now();
      const last = this._last.get(name);
      if (last !== undefined && t - last < THROTTLE_MS) return false;
      const file = CARD_NAMES.has(name) ? this._pickCard() : name;
      const buffer = this._buffers.get(file);
      if (!buffer) return false;
      this._last.set(name, t);
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      let out = src;
      if (gain !== 1) {
        const g = ctx.createGain();
        g.gain.value = clamp01(gain);
        src.connect(g);
        out = g;
      }
      out.connect(this._master);
      src.start(ctx.currentTime + Math.max(0, delay));
      if (CARD_NAMES.has(name)) this._lastCard = file;
      return true;
    } catch (err) {
      this._warnOnce(`play:${name}`, err);
      return false;
    }
  }

  /**
   * Start a sound that runs on until it ends or is stopped (the bid clock's
   * tune), `offset` s into its file. The same refusals as play(): muted,
   * volume 0, a hidden tab, off the table, not ready, not loaded (no
   * throttle). Mute and volume apply to it while it plays (the master gain).
   * @param {string} name
   * @param {Object} [opts]
   * @param {number} [opts.offset] - seconds into the file
   * @param {number} [opts.gain] - relative to the master volume
   * @returns {{stop: Function, playing: boolean, position: number}|null}
   *   stop(fadeS = STOP_FADE_S) fades it out and stops it (0: at once);
   *   playing turns false once stopped or ended; position is the second of
   *   the file playing now (the context's clock: it stands still while the
   *   context is suspended)
   */
  start(name, { offset = 0, gain = 1 } = {}) {
    try {
      if (this.muted || this.volume <= 0) return null;
      if (this._doc?.hidden) return null;
      if (!this._active || !this.ready) return null;
      const buffer = this._buffers.get(name);
      if (!buffer) return null;
      const length = typeof buffer.duration === 'number' ? buffer.duration : Infinity;
      const at = Math.max(0, Number(offset) || 0);
      if (at >= length) return null;
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const g = ctx.createGain();
      g.gain.value = clamp01(gain);
      src.connect(g);
      g.connect(this._master);
      let playing = true;
      const startedAt = ctx.currentTime;
      src.onended = () => {
        playing = false;
      };
      src.start(startedAt, at);
      const warn = (err) => this._warnOnce(`stop:${name}`, err);
      return {
        get playing() {
          return playing;
        },
        get position() {
          return at + Math.max(0, ctx.currentTime - startedAt);
        },
        stop(fadeS = STOP_FADE_S) {
          if (!playing) return;
          playing = false;
          try {
            const t = ctx.currentTime;
            const fade = Math.max(0, Number(fadeS) || 0);
            if (fade > 0) {
              g.gain.cancelScheduledValues?.(t);
              g.gain.setValueAtTime?.(g.gain.value, t);
              g.gain.linearRampToValueAtTime?.(0, t + fade);
              src.stop(t + fade);
            } else {
              src.stop();
            }
          } catch (err) {
            warn(err);
            try { src.stop(); } catch { /* already stopped */ }
          }
        },
      };
    } catch (err) {
      this._warnOnce(`start:${name}`, err);
      return null;
    }
  }

  _pickCard() {
    const choices = CARD_VARIANTS.filter((v) => v !== this._lastCard && this._buffers.has(v));
    if (!choices.length) return this._lastCard || CARD_VARIANTS[0];
    return choices[Math.min(choices.length - 1, Math.floor(this._random() * choices.length))];
  }

  _warnOnce(key, err) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    try {
      console.warn(`[Sound] ${key} failed:`, err?.message || err);
    } catch {
      // nothing to do
    }
  }
}

/** decodeAudioData, promise or (older Safari) callback form. */
function decode(ctx, data) {
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

let instance = null;

export function getSoundManager() {
  if (!instance) instance = new SoundManager();
  return instance;
}

/** For tests. */
export function resetSoundManager(options) {
  instance?.uninstallUnlock();
  instance = options === null ? null : new SoundManager(options);
  return instance;
}

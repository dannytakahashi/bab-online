/**
 * Test harness: a small stand-in for the slice of Phaser 3.55 the table
 * uses, so the REAL GameScene and its managers run under Vitest (jsdom has
 * no canvas). Game objects are plain records the tests can count; tweens
 * and delayed calls run on a scene clock that the test steps (the director
 * and the managers see Phaser's API: add, tweens.add / killTweensOf,
 * time.delayedCall, Tween.stop, TimerEvent.remove).
 *
 *   installFakePhaser()          globalThis.Phaser (Scene base class, Geom)
 *   clock.step(ms)               run due timers and finish due tweens
 *   clock.paused = true          a hidden tab: Phaser's loop does not step
 *   scene.liveObjects()          every active game object (leak checks)
 */
import { vi } from 'vitest';

const TWEEN_ACTIVE = 23;
const TWEEN_PENDING_REMOVE = 25;
const TWEEN_REMOVED = 26;

/** One clock per page: Phaser's game loop. */
export class FakeClock {
  constructor() {
    this.now = 0;
    this.paused = false;
    this._seq = 0;
    this._queue = []; // {at, seq, run, alive()}
  }

  schedule(ms, run, alive = () => true) {
    const item = { at: this.now + Math.max(0, ms || 0), seq: this._seq++, run, alive };
    this._queue.push(item);
    return item;
  }

  /** Advance `ms`, running what falls due in time order (nothing while paused). */
  step(ms) {
    if (this.paused) return;
    const end = this.now + ms;
    for (;;) {
      this._queue = this._queue.filter((i) => i.alive());
      this._queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this._queue[0];
      if (!next || next.at > end) break;
      this._queue.shift();
      this.now = next.at;
      next.run();
    }
    this.now = end;
  }

  get pending() {
    return this._queue.filter((i) => i.alive()).length;
  }
}

function emitterMixin(obj) {
  const listeners = new Map();
  obj.on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push({ fn, once: false });
    return obj;
  };
  obj.once = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push({ fn, once: true });
    return obj;
  };
  obj.off = (event, fn) => {
    listeners.set(event, (listeners.get(event) || []).filter((l) => l.fn !== fn));
    return obj;
  };
  obj.emit = (event, ...args) => {
    const current = listeners.get(event) || [];
    listeners.set(event, current.filter((l) => !l.once));
    current.forEach((l) => l.fn(...args));
    return obj;
  };
  obj.removeAllListeners = () => {
    listeners.clear();
    return obj;
  };
  obj.listenerCount = (event) => (listeners.get(event) || []).length;
  return obj;
}

let objectIds = 0;

function makeObject(scene, kind, x, y, texture, frame) {
  const data = new Map();
  const obj = emitterMixin({
    id: ++objectIds,
    kind,
    x: x ?? 0,
    y: y ?? 0,
    scaleX: 1,
    scaleY: 1,
    alpha: 1,
    rotation: 0,
    depth: 0,
    tint: null,
    active: true,
    scene,
    interactive: false,
    texture: { key: texture ?? null },
    frame: { name: frame ?? null },
    displayWidth: 64,
    displayHeight: 90,
    style: {},
  });
  Object.defineProperty(obj, 'scale', {
    get() { return obj.scaleX; },
    set(v) { obj.scaleX = v; obj.scaleY = v; },
  });
  const chain = (fn) => (...args) => { fn(...args); return obj; };
  Object.assign(obj, {
    setScale: chain((sx, sy) => { obj.scaleX = sx; obj.scaleY = sy ?? sx; }),
    setDepth: chain((d) => { obj.depth = d; }),
    setRotation: chain((r) => { obj.rotation = r; }),
    setAlpha: chain((a) => { obj.alpha = a; }),
    setPosition: chain((px, py) => { obj.x = px; obj.y = py; }),
    setOrigin: chain(() => {}),
    setTexture: chain((key, fr) => { obj.texture = { key }; obj.frame = { name: fr ?? null }; }),
    setTint: chain((t) => { obj.tint = t; }),
    clearTint: chain(() => { obj.tint = null; }),
    // A hit area is in the frame's local pixels (0,0 = the frame's top-left), as Phaser's
    setInteractive: chain((shape) => { obj.interactive = true; if (shape) obj.hitArea = shape; }),
    disableInteractive: chain(() => { obj.interactive = false; }),
    setStrokeStyle: chain(() => {}),
    setText: chain(() => {}),
    getData: (k) => data.get(k),
    setData: chain((k, v) => { data.set(k, v); }),
    destroy: () => {
      if (!obj.active) return;
      obj.active = false;
      obj.scene = undefined;
      scene._objects.delete(obj);
    },
    // Graphics
    clear: chain(() => {}),
    fillStyle: chain(() => {}),
    fillRoundedRect: chain(() => {}),
    lineStyle: chain(() => {}),
    strokeRoundedRect: chain(() => {}),
  });
  scene._objects.add(obj);
  return obj;
}

class FakeTweenManager {
  constructor(scene, clock) {
    this._scene = scene;
    this._clock = clock;
    this._tweens = new Set();
    this.added = 0;
  }

  add(cfg) {
    this.added++;
    const targets = [].concat(cfg.targets).filter(Boolean);
    const tween = emitterMixin({ state: TWEEN_ACTIVE, targets, config: cfg });
    const finalValue = (target, key, v) => {
      if (v && typeof v === 'object' && 'to' in v) return v.to;
      if (typeof v === 'function') return v(target);
      return v;
    };
    const skip = new Set(['targets', 'duration', 'delay', 'ease', 'onComplete', 'onUpdate', 'onStart', 'repeat', 'yoyo', 'hold', 'paused', 'props']);
    tween.stop = () => {
      if (tween.state >= TWEEN_PENDING_REMOVE) return tween;
      tween.state = TWEEN_PENDING_REMOVE;
      this._tweens.delete(tween);
      return tween;
    };
    tween.remove = tween.stop;
    tween.isPlaying = () => tween.state === TWEEN_ACTIVE;
    const run = () => {
      if (tween.state !== TWEEN_ACTIVE) return;
      for (const target of targets) {
        if (!target || target.active === false) continue;
        for (const [k, v] of Object.entries(cfg)) {
          if (skip.has(k)) continue;
          const val = finalValue(target, k, v);
          if (k === 'scale') { target.scaleX = val; target.scaleY = val; } else target[k] = val;
        }
      }
      tween.state = TWEEN_REMOVED;
      this._tweens.delete(tween);
      cfg.onComplete?.(tween, targets);
    };
    this._tweens.add(tween);
    this._clock.schedule((cfg.delay || 0) + (cfg.duration || 0), run, () => tween.state === TWEEN_ACTIVE);
    return tween;
  }

  killTweensOf(target) {
    for (const t of [...this._tweens]) if (t.targets.includes(target)) t.stop();
  }

  get active() {
    return [...this._tweens].filter((t) => t.state === TWEEN_ACTIVE).length;
  }
}

class FakeTime {
  constructor(clock) {
    this._clock = clock;
  }

  delayedCall(ms, cb) {
    const ev = { removed: false, dispatched: false };
    ev.remove = (dispatch) => {
      if (ev.removed || ev.dispatched) return;
      ev.removed = true;
      if (dispatch) cb();
    };
    this._clock.schedule(ms, () => {
      ev.dispatched = true;
      cb();
    }, () => !ev.removed && !ev.dispatched);
    return ev;
  }
}

/** The page's one Phaser clock (shared by every scene instance of a test file). */
export const clock = new FakeClock();

/** Phaser.Scene stand-in: what GameScene and its managers touch. */
export class FakeSceneBase {
  constructor() {
    this._objects = new Set();
    this._clock = clock;
    this.add = {
      image: (x, y, tex, frame) => makeObject(this, 'image', x, y, tex, frame),
      sprite: (x, y, tex, frame) => makeObject(this, 'sprite', x, y, tex, frame),
      rectangle: (x, y) => makeObject(this, 'rectangle', x, y, null),
      text: (x, y) => makeObject(this, 'text', x, y, null),
      graphics: () => makeObject(this, 'graphics', 0, 0, null),
    };
    this.tweens = new FakeTweenManager(this, clock);
    this.time = new FakeTime(clock);
    this.scale = emitterMixin({ width: 1920, height: 953, resize() {} });
    this.events = emitterMixin({});
    this.input = { setDefaultCursor: vi.fn() };
    this.load = { atlas() {}, image() {} };
    this.children = { removeAll: () => this._destroyAll() };
    this.game = { loop: { step: () => {} }, scale: this.scale };
    this.restarts = 0;
    this.scene = {
      restart: () => {
        // Phaser restarts on its next step: shutdown, a fresh display list, create()
        this.restarts++;
        setTimeout(() => {
          this.events.emit('shutdown');
          this._destroyAll();
          this.events = emitterMixin({});
          this.create();
        }, 0);
      },
    };
  }

  _destroyAll() {
    for (const o of [...this._objects]) o.destroy();
  }

  /**
   * Phaser's input with topOnly: the interactive objects under (x, y), by
   * their hit area (in frame pixels, origin at the centre, scaled; no
   * rotation), the topmost first (higher depth, then later in the display
   * list). pointerDownAt emits pointerdown on the topmost.
   */
  objectsAt(x, y) {
    const hits = this.liveObjects().filter((o) => {
      if (!o.interactive) return false;
      const fw = 64;
      const fh = 64;
      const lx = (x - o.x) / (o.scaleX || 1) + fw / 2;
      const ly = (y - o.y) / (o.scaleY || 1) + fh / 2;
      const a = o.hitArea || { x: 0, y: 0, w: fw, h: fh };
      return lx >= a.x && lx <= a.x + a.w && ly >= a.y && ly <= a.y + a.h;
    });
    return hits.sort((a, b) => b.depth - a.depth || b.id - a.id);
  }

  pointerDownAt(x, y) {
    const top = this.objectsAt(x, y)[0] || null;
    top?.emit('pointerdown', { x, y });
    return top;
  }

  /** Every active game object, by kind and texture (leak checks). */
  liveObjects() {
    return [...this._objects].filter((o) => o.active);
  }

  /** A stable census: counts by "kind:texture" (card frames collapsed to 'card'). */
  census() {
    const out = {};
    for (const o of this.liveObjects()) {
      const tex = o.texture?.key === 'cards' ? 'card' : (o.texture?.key || '-');
      const k = `${o.kind}:${tex}`;
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }
}

export function installFakePhaser() {
  globalThis.Phaser = {
    Scene: FakeSceneBase,
    Game: class {},
    AUTO: 0,
    Scale: { RESIZE: 0, CENTER_BOTH: 0, FIT: 0 },
    Geom: { Rectangle: class { constructor(x, y, w, h) { Object.assign(this, { x, y, w, h }); } static Contains() { return true; } } },
  };
  return globalThis.Phaser;
}

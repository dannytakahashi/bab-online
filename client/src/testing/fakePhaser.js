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

/** A sprite showing the card atlas's back (item 18a: one 'cards' texture, frame 'back'). */
export const isCardBack = (o) => o?.texture?.key === 'cards' && o.frame?.name === 'back';
/** A sprite showing a card face of the atlas. */
export const isCardFace = (o) => o?.texture?.key === 'cards' && !!o.frame?.name && o.frame.name !== 'back' && o.frame.name !== 'shadow';

/**
 * Phaser's default origins and sizes by kind: an image is its texture
 * frame's size about its centre (the card atlas's frames: FakeTextures), a
 * Rectangle shape its own size about its centre, Text sits at its top-left
 * (origin 0) until setOrigin.
 */
const ORIGIN = { image: 0.5, sprite: 0.5, rectangle: 0.5, text: 0, graphics: 0 };

/** A texture frame's size in the scene's texture manager (64 x 64 for an unknown one). */
function frameSize(scene, texture, frame) {
  const f = scene?.textures?.get?.(texture)?.frames?.[frame];
  return f ? { w: f.width, h: f.height } : { w: 64, h: 64 };
}

function makeObject(scene, kind, x, y, texture, frame, size = null) {
  const data = new Map();
  const isFrame = kind === 'image' || kind === 'sprite';
  if (isFrame && !size) size = frameSize(scene, texture, frame);
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
    type: { image: 'Image', sprite: 'Sprite', rectangle: 'Rectangle', text: 'Text', graphics: 'Graphics' }[kind],
    width: size ? size.w : 0,
    height: size ? size.h : 0,
    originX: ORIGIN[kind] ?? 0.5,
    originY: ORIGIN[kind] ?? 0.5,
    // drawn shapes (graphics): what fillRoundedRect / strokeRoundedRect drew since clear()
    drawn: [],
  });
  // Phaser's Origin component: the display origin is origin x size, and
  // only setOrigin / updateDisplayOrigin recompute it (Rectangle.setSize in
  // 3.55 does not: a resized shape keeps its old origin until told)
  obj.updateDisplayOrigin = () => {
    obj.displayOriginX = obj.originX * obj.width;
    obj.displayOriginY = obj.originY * obj.height;
    return obj;
  };
  obj.updateDisplayOrigin();
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
    setOrigin: chain((ox = 0.5, oy = ox) => { obj.originX = ox; obj.originY = oy; obj.updateDisplayOrigin(); }),
    // Shape.setSize (Rectangle): the size and geometry, not the display origin
    setSize: chain((w, h) => { obj.width = w; obj.height = h; }),
    /** Phaser's getBounds for an unrotated object: position less the display origin, scaled. */
    getBounds: () => {
      const bx = obj.x - obj.displayOriginX * obj.scaleX;
      const by = obj.y - obj.displayOriginY * obj.scaleY;
      const w = obj.width * obj.scaleX;
      const h = obj.height * obj.scaleY;
      return { x: bx, y: by, width: w, height: h, centerX: bx + w / 2, centerY: by + h / 2 };
    },
    // Phaser's setTexture -> setFrame: the size follows the frame (the scale stays)
    setTexture: chain((key, fr) => { obj.texture = { key }; obj.frame = { name: fr ?? null }; obj.setSizeToFrame(); }),
    setFrame: chain((fr) => { obj.frame = { name: fr ?? null }; obj.setSizeToFrame(); }),
    setSizeToFrame: chain(() => {
      if (!isFrame) return;
      const f = frameSize(scene, obj.texture.key, obj.frame.name);
      obj.width = f.w;
      obj.height = f.h;
      obj.updateDisplayOrigin();
    }),
    setTint: chain((t) => { obj.tint = t; }),
    clearTint: chain(() => { obj.tint = null; }),
    // A hit area is in the frame's local pixels (0,0 = the frame's top-left),
    // as Phaser's; without one, Phaser's default: the whole frame
    // (Phaser keeps it on obj.input.hitArea; without a shape, the frame's size at that time)
    setInteractive: chain((shape) => {
      obj.interactive = true;
      const hitArea = shape || obj.input?.hitArea || new globalThis.Phaser.Geom.Rectangle(0, 0, obj.width, obj.height);
      obj.input = { hitArea, enabled: true };
    }),
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
    // Graphics (the drawn rects are kept, in the graphics' local space)
    clear: chain(() => { obj.drawn = []; }),
    fillStyle: chain(() => {}),
    fillRoundedRect: chain((rx, ry, rw, rh) => { obj.drawn.push({ op: 'fill', x: rx, y: ry, w: rw, h: rh }); }),
    lineStyle: chain(() => {}),
    strokeRoundedRect: chain((rx, ry, rw, rh) => { obj.drawn.push({ op: 'stroke', x: rx, y: ry, w: rw, h: rh }); }),
  });
  scene._objects.add(obj);
  return obj;
}

/**
 * Text measures its content as Phaser's does (Text.width: the drawn text
 * plus its stroke, before scale), approximately: each character 0.6 em,
 * the line 1.2 em. setText and setFontSize re-measure, and the display
 * origin follows (Phaser's updateText calls updateDisplayOrigin).
 */
export const TEXT_EM = 0.6;
function makeText(scene, x, y, content, style = {}) {
  const obj = makeObject(scene, 'text', x, y, null);
  obj.text = String(content ?? '');
  obj.style = { ...(style || {}) };
  const measure = () => {
    const px = parseFloat(obj.style.fontSize) || 16;
    const lines = obj.text.split('\n');
    const longest = Math.max(0, ...lines.map((l) => Array.from(l).length));
    const stroke = Number(obj.style.strokeThickness) || 0;
    obj.width = obj.text ? longest * px * TEXT_EM + stroke : 0;
    obj.height = obj.text ? lines.length * px * 1.2 + stroke : 0;
    obj.updateDisplayOrigin();
    return obj;
  };
  obj.setText = (t) => { obj.text = Array.isArray(t) ? t.join('\n') : String(t ?? ''); return measure(); };
  obj.setFontSize = (size) => { obj.style.fontSize = typeof size === 'number' ? `${size}px` : size; return measure(); };
  obj.setResolution = (r) => { obj.style.resolution = r; return obj; };
  Object.defineProperty(obj, 'displayWidth', { get() { return obj.width * obj.scaleX; }, configurable: true });
  Object.defineProperty(obj, 'displayHeight', { get() { return obj.height * obj.scaleY; }, configurable: true });
  return measure();
}

/**
 * The texture manager (game-wide in Phaser: one per page here): canvas
 * textures with named frames (CardAtlas adds 'cards'), images by key.
 */
export class FakeTextures {
  constructor() {
    this._tex = new Map();
    this.uploads = 0;
    this.drawCalls = 0;
  }

  /**
   * CardAtlas's canvas (no jsdom canvas): a 2D context that only counts
   * what is drawn (cards/CardAtlas.test.js records a real draw).
   */
  _createAtlasCanvas() {
    const textures = this;
    const ctx = new Proxy({}, {
      get(_t, k) {
        if (k === 'measureText') return (t) => ({ width: String(t).length * 20 });
        return (...args) => { if (k === 'fill' || k === 'fillText' || k === 'stroke') textures.drawCalls++; return args && undefined; };
      },
      set() { return true; },
    });
    return { width: 0, height: 0, getContext: () => ctx };
  }

  exists(key) {
    return this._tex.has(key);
  }

  get(key) {
    return this._tex.get(key) || null;
  }

  remove(key) {
    this._tex.delete(key);
  }

  addCanvas(key, canvas) {
    const textures = this;
    const tex = {
      key,
      canvas,
      frames: {},
      width: canvas.width,
      height: canvas.height,
      filter: null,
      add(name, _source, x, y, w, h) {
        const frame = { name, cutX: x, cutY: y, width: w, height: h, setSize(fw, fh, fx, fy) { Object.assign(this, { width: fw, height: fh, cutX: fx, cutY: fy }); return this; } };
        this.frames[name] = frame;
        return frame;
      },
      setSize(w, h) {
        canvas.width = w;
        canvas.height = h;
        this.width = w;
        this.height = h;
        return this;
      },
      setFilter(mode) { this.filter = mode; return this; },
      refresh() { textures.uploads++; return this; },
    };
    this._tex.set(key, tex);
    return tex;
  }
}

/** The page's one texture manager (Phaser's outlives scene restarts too). */
export const textures = new FakeTextures();

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
      rectangle: (x, y, w, h) => makeObject(this, 'rectangle', x, y, null, null, { w: w ?? 128, h: h ?? 128 }),
      text: (x, y, content, style) => makeText(this, x, y, content, style),
      graphics: () => makeObject(this, 'graphics', 0, 0, null),
    };
    this.tweens = new FakeTweenManager(this, clock);
    this.time = new FakeTime(clock);
    this.scale = emitterMixin({ width: 1920, height: 953, resize() {} });
    this.textures = textures;
    this.cameras = { main: { originX: 0.5, originY: 0.5, zoom: 1, setOrigin(x, y) { this.originX = x; this.originY = y ?? x; return this; }, setZoom(z) { this.zoom = z; return this; } } };
    this.events = emitterMixin({});
    this.input = { setDefaultCursor: vi.fn() };
    this.load = { atlas() {}, image() {} };
    const scene = this;
    this.children = { removeAll: () => this._destroyAll(), get list() { return scene.liveObjects(); } };
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
   * rotation; no hit area: the whole frame), the topmost first (higher depth, then later in the display
   * list). pointerDownAt emits pointerdown on the topmost.
   */
  objectsAt(x, y) {
    const hits = this.liveObjects().filter((o) => {
      if (!o.interactive) return false;
      const fw = o.width || 64;
      const fh = o.height || 64;
      const lx = (x - o.x) / (o.scaleX || 1) + fw / 2;
      const ly = (y - o.y) / (o.scaleY || 1) + fh / 2;
      const a = o.input?.hitArea || { x: 0, y: 0, width: fw, height: fh };
      return lx >= a.x && lx <= a.x + a.width && ly >= a.y && ly <= a.y + a.height;
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
      const tex = o.texture?.key === 'cards' ? (o.frame?.name === 'back' ? 'cardBack' : 'card') : (o.texture?.key || '-');
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
    Scale: { RESIZE: 0, NONE: 0, NO_CENTER: 0, CENTER_BOTH: 0, FIT: 0 },
    Geom: {
      Rectangle: class {
        constructor(x = 0, y = 0, width = 0, height = 0) { Object.assign(this, { x, y, width, height }); }
        setSize(width, height = width) { this.width = width; this.height = height; return this; }
        static Contains() { return true; }
      },
    },
    Textures: { FilterMode: { LINEAR: 0, NEAREST: 1 } },
  };
  return globalThis.Phaser;
}

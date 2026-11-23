/**
 * SoundManager on a fake Web Audio context: quiet default, the per-device
 * mute (honoured at once, kept across loads, blocked storage), nothing
 * before a gesture or while the tab is hidden, the throttle and the card
 * variants, failures that are logged once and never thrown, a failed load
 * retried by a later gesture, and the context suspended off the table.
 * start(): the bid clock's tune from an offset, the same refusals as
 * play(), a stop that fades, the handle that clears on its end, and the
 * ready notification.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SoundManager, SOUND_URLS, CARD_VARIANTS, DEFAULT_VOLUME, STORAGE_KEY, THROTTLE_MS, LOAD_TRIES, LOAD_RETRY_MS, STOP_FADE_S,
} from './SoundManager.js';

/** A minimal AudioContext: buffers are {name}, start() is recorded. */
function fakeAudio({ failSource = false, startRunning = false } = {}) {
  const contexts = [];
  class FakeContext {
    constructor(opts) {
      this.opts = opts;
      this.state = startRunning ? 'running' : 'suspended';
      this.currentTime = 10;
      this.destination = { node: 'destination' };
      this.started = [];
      this.sources = [];
      this.gains = [];
      contexts.push(this);
    }
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
    suspend() {
      this.state = 'suspended';
      return Promise.resolve();
    }
    createGain() {
      const ramps = [];
      const g = {
        gain: {
          value: 1,
          ramps,
          cancelScheduledValues: vi.fn(),
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn((v, t) => ramps.push({ v, t })),
        },
        connect: vi.fn(),
      };
      this.gains.push(g);
      return g;
    }
    createBufferSource() {
      if (failSource) throw new Error('no source');
      const ctx = this;
      const src = {
        buffer: null,
        onended: null,
        stoppedAt: null,
        connect: vi.fn(),
        start(t, offset) {
          ctx.started.push({ name: this.buffer.name, t, ...(offset !== undefined && { offset }) });
          ctx.sources.push(src);
        },
        stop(t) {
          src.stoppedAt = t === undefined ? 'now' : t;
        },
      };
      return src;
    }
    decodeAudioData(data) {
      if (data.bad) return Promise.reject(new Error('undecodable'));
      return Promise.resolve({ name: data.name, duration: data.name === 'bidclock' ? 30.02 : 0.4 });
    }
  }
  return { FakeContext, contexts };
}

const nameOf = (url) => Object.keys(SOUND_URLS).find((k) => SOUND_URLS[k] === url);

function fakeFetch({ bad = [] } = {}) {
  return vi.fn(async (url) => ({ ok: true, arrayBuffer: async () => ({ name: nameOf(url), bad: bad.includes(nameOf(url)) }) }));
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
}

let now;
let audio;
let doc;
let warn;

function make(opts = {}) {
  return new SoundManager({
    AudioContextImpl: audio.FakeContext,
    fetchImpl: fakeFetch(opts.fetch),
    storage: 'storage' in opts ? opts.storage : memoryStorage(),
    now: () => now,
    doc,
    random: opts.random || (() => 0),
  });
}

/** A manager whose context runs and whose files are decoded. */
async function ready(opts) {
  const m = make(opts);
  m.unlock();
  await m._loading;
  return m;
}

const started = (m) => m.ctx.started.map((s) => s.name);

beforeEach(() => {
  now = 1000;
  audio = fakeAudio();
  doc = { hidden: false };
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe('defaults and the context', () => {
  it('is on, at the quiet default volume, with one master gain', async () => {
    const m = await ready();
    expect(m.muted).toBe(false);
    expect(m.volume).toBe(DEFAULT_VOLUME);
    expect(DEFAULT_VOLUME).toBe(0.35);
    expect(audio.contexts).toHaveLength(1);
    expect(audio.contexts[0].gains[0].gain.value).toBe(0.35);
    expect(audio.contexts[0].gains[0].connect).toHaveBeenCalledWith(audio.contexts[0].destination);
  });

  it('makes no context before a gesture, and plays nothing until it runs', () => {
    const m = make();
    expect(audio.contexts).toHaveLength(0);
    expect(m.play('deal')).toBe(false);
    expect(audio.contexts).toHaveLength(0);
  });

  it('a gesture on the page (pointerdown / keydown) creates and resumes the context and loads every file once', async () => {
    const target = new EventTarget();
    const fetchImpl = fakeFetch();
    const m = new SoundManager({ AudioContextImpl: audio.FakeContext, fetchImpl, storage: memoryStorage(), now: () => now, doc });
    m.installUnlock(target);
    target.dispatchEvent(new Event('pointerdown'));
    target.dispatchEvent(new Event('keydown'));
    await m._loading;
    expect(audio.contexts).toHaveLength(1);
    expect(m.ready).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(Object.keys(SOUND_URLS).length);
    expect(m.play('deal')).toBe(true);
    m.uninstallUnlock();
  });

  it('a context suspended later (iOS in the background) resumes on the next gesture', async () => {
    const m = await ready();
    m.ctx.state = 'suspended';
    expect(m.play('deal')).toBe(false);
    m.unlock();
    expect(m.play('deal')).toBe(true);
  });

  it('without Web Audio nothing happens and nothing throws', () => {
    const m = new SoundManager({ AudioContextImpl: null, storage: memoryStorage(), doc });
    expect(() => m.unlock()).not.toThrow();
    expect(m.play('deal')).toBe(false);
  });

  it('every sound is a bundled file (12 of them, the bid clock\'s tune included)', () => {
    expect(Object.keys(SOUND_URLS).sort()).toEqual(['bidclock', 'card-1', 'card-2', 'card-3', 'deal', 'gameend', 'gameend-lose', 'made', 'overtrump', 'set', 'trick', 'trick-ours', 'turn']);
    for (const url of Object.values(SOUND_URLS)) expect(url).toMatch(/\.m4a$/);
  });
});

describe('mute and volume (per device)', () => {
  it('mute silences at once (the master gain), is saved, and a new page load keeps it', async () => {
    const storage = memoryStorage();
    const m = await ready({ storage });
    m.setMuted(true);
    expect(m.ctx.gains[0].gain.value).toBe(0);
    expect(m.play('deal')).toBe(false);
    expect(JSON.parse(storage.data[STORAGE_KEY])).toEqual({ muted: true, volume: DEFAULT_VOLUME });

    const again = make({ storage });
    expect(again.muted).toBe(true);
    again.unlock();
    // muted: no context until the player turns sound on (a click)
    expect(audio.contexts).toHaveLength(1);
    again.setMuted(false);
    await again._loading;
    expect(audio.contexts).toHaveLength(2);
    expect(again.play('deal')).toBe(true);
    expect(JSON.parse(storage.data[STORAGE_KEY]).muted).toBe(false);
  });

  it('toggleMuted flips it and tells every listener', async () => {
    const m = await ready();
    const seen = [];
    const off = m.onChange((s) => seen.push(s.muted));
    expect(m.toggleMuted()).toBe(true);
    expect(m.toggleMuted()).toBe(false);
    off();
    m.toggleMuted();
    expect(seen).toEqual([true, false]);
  });

  it('a volume is kept (clamped to 0..1) and 0 plays nothing', async () => {
    const storage = memoryStorage();
    const m = await ready({ storage });
    m.setVolume(0.6);
    expect(m.ctx.gains[0].gain.value).toBe(0.6);
    expect(make({ storage }).volume).toBe(0.6);
    m.setVolume(7);
    expect(m.volume).toBe(1);
    m.setVolume(0);
    expect(m.play('deal')).toBe(false);
  });

  it('storage that throws or holds junk: the defaults, no throw, the choice kept for this page', async () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const m = await ready({ storage: throwing });
    expect(m.muted).toBe(false);
    expect(m.volume).toBe(DEFAULT_VOLUME);
    expect(() => m.setMuted(true)).not.toThrow();
    expect(m.muted).toBe(true);
    expect(make({ storage: memoryStorage({ [STORAGE_KEY]: '{not json' }) }).muted).toBe(false);
    expect(make({ storage: memoryStorage({ [STORAGE_KEY]: '{"muted":"yes","volume":"loud"}' }) })).toMatchObject({ muted: false, volume: DEFAULT_VOLUME });
    expect(make({ storage: null }).muted).toBe(false);
  });

  it('another tab\'s change (the storage event) is followed', async () => {
    const storage = memoryStorage();
    const target = new EventTarget();
    const m = new SoundManager({ AudioContextImpl: audio.FakeContext, fetchImpl: fakeFetch(), storage, now: () => now, doc });
    m.installUnlock(target);
    const seen = vi.fn();
    m.onChange(seen);
    storage.setItem(STORAGE_KEY, JSON.stringify({ muted: true, volume: 0.35 }));
    const e = new Event('storage');
    e.key = STORAGE_KEY;
    target.dispatchEvent(e);
    expect(m.muted).toBe(true);
    expect(seen).toHaveBeenCalledWith({ muted: true, volume: 0.35 });
    m.uninstallUnlock();
  });
});

describe('when a sound plays', () => {
  it('never while the tab is hidden (nothing is queued for its return)', async () => {
    const m = await ready();
    doc.hidden = true;
    expect(m.play('turn')).toBe(false);
    doc.hidden = false;
    expect(started(m)).toEqual([]);
    expect(m.play('turn')).toBe(true);
    expect(started(m)).toEqual(['turn']);
  });

  it('the same sound at most once per THROTTLE_MS; others are not held up', async () => {
    const m = await ready();
    expect(THROTTLE_MS).toBe(80);
    expect(m.play('trick')).toBe(true);
    now += 40;
    expect(m.play('trick')).toBe(false);
    expect(m.play('turn')).toBe(true);
    now += 40;
    expect(m.play('trick')).toBe(true);
    expect(started(m)).toEqual(['trick', 'turn', 'trick']);
  });

  it('card picks a variant, never the one just played, and the variants share one throttle', async () => {
    let r = 0;
    const m = await ready({ random: () => [0, 0.99, 0.5, 0, 0.99][r++ % 5] });
    const picks = [];
    for (let i = 0; i < 5; i++) {
      expect(m.play('card')).toBe(true);
      picks.push(started(m).at(-1));
      expect(m.play('card')).toBe(false); // same instant: throttled
      now += THROTTLE_MS;
    }
    for (const p of picks) expect(CARD_VARIANTS).toContain(p);
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1]);
  });

  it('draw plays a card variant too, never the one just played, with its own throttle', async () => {
    const m = await ready({ random: () => 0 });
    expect(m.play('card')).toBe(true);
    const card = started(m).at(-1);
    expect(m.play('draw', { gain: 0.8 })).toBe(true); // same instant: not the card's throttle
    const draw = started(m).at(-1);
    expect(CARD_VARIANTS).toContain(draw);
    expect(draw).not.toBe(card);
    expect(m.ctx.gains.at(-1).gain.value).toBe(0.8);
    expect(m.play('draw')).toBe(false); // its own throttle
    now += THROTTLE_MS;
    expect(m.play('draw')).toBe(true);
    expect(started(m).at(-1)).not.toBe(draw);
  });

  it('a delayed, quieter accent starts later on the context clock through its own gain', async () => {
    const m = await ready();
    expect(m.play('overtrump', { delay: 0.09, gain: 0.8 })).toBe(true);
    expect(m.ctx.started.at(-1)).toEqual({ name: 'overtrump', t: 10.09 });
    expect(m.ctx.gains.at(-1).gain.value).toBe(0.8);
  });

  it('an unknown name or an undecodable file plays nothing; the rest still play', async () => {
    const m = await ready({ fetch: { bad: ['set'] } });
    expect(m.play('nope')).toBe(false);
    expect(m.play('set')).toBe(false);
    expect(m.play('made')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('load:set');
  });

  it('a failing context is logged once and never throws', async () => {
    audio = fakeAudio({ failSource: true });
    const m = await ready();
    expect(() => m.play('deal')).not.toThrow();
    expect(m.play('deal')).toBe(false);
    now += 1000;
    expect(m.play('deal')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a fetch that fails (offline, 404) is logged and skipped', async () => {
    const m = new SoundManager({
      AudioContextImpl: audio.FakeContext,
      fetchImpl: vi.fn(async () => ({ ok: false, status: 404 })),
      storage: memoryStorage(),
      now: () => now,
      doc,
    });
    m.unlock();
    await expect(m._loading).resolves.toBeDefined();
    expect(m.play('deal')).toBe(false);
  });
});

describe('a load that failed is retried', () => {
  it('a later gesture fetches only the missing file again, LOAD_RETRY_MS apart, LOAD_TRIES in all', async () => {
    let failing = true;
    const fetchImpl = vi.fn(async (url) => (nameOf(url) === 'deal' && failing
      ? { ok: false, status: 404 }
      : { ok: true, arrayBuffer: async () => ({ name: nameOf(url) }) }));
    const m = new SoundManager({ AudioContextImpl: audio.FakeContext, fetchImpl, storage: memoryStorage(), now: () => now, doc });
    m.unlock();
    await m._loading;
    expect(m.play('deal')).toBe(false);
    expect(m.play('turn')).toBe(true);
    const calls = fetchImpl.mock.calls.length;
    // a gesture right away: no hammering
    m.unlock();
    await m._loading;
    expect(fetchImpl.mock.calls.length).toBe(calls);
    // later: only deal, and it works now
    now += LOAD_RETRY_MS;
    failing = false;
    m.unlock();
    await m._loading;
    expect(fetchImpl.mock.calls.slice(calls).map(([u]) => nameOf(u))).toEqual(['deal']);
    expect(m.play('deal')).toBe(true);
    // everything is in: no more fetches
    now += LOAD_RETRY_MS;
    m.unlock();
    await m._loading;
    expect(fetchImpl.mock.calls.length).toBe(calls + 1);
  });

  it('a file that never loads is given up on after LOAD_TRIES, logged once', async () => {
    const fetchImpl = vi.fn(async (url) => (nameOf(url) === 'deal' ? { ok: false, status: 404 } : { ok: true, arrayBuffer: async () => ({ name: nameOf(url) }) }));
    const m = new SoundManager({ AudioContextImpl: audio.FakeContext, fetchImpl, storage: memoryStorage(), now: () => now, doc });
    for (let i = 0; i < LOAD_TRIES + 3; i++) {
      m.unlock();
      await m._loading;
      now += LOAD_RETRY_MS;
    }
    expect(fetchImpl.mock.calls.filter(([u]) => nameOf(u) === 'deal')).toHaveLength(LOAD_TRIES);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('off the table', () => {
  it('suspends the context and plays nothing; back at a table it resumes', async () => {
    const m = await ready();
    m.setActive(false);
    expect(m.ctx.state).toBe('suspended');
    expect(m.play('deal')).toBe(false);
    // a click in the main room does not wake it
    m.unlock();
    expect(m.ctx.state).toBe('suspended');
    m.setActive(true);
    expect(m.ctx.state).toBe('running');
    expect(m.play('deal')).toBe(true);
  });

  it('a first gesture off the table makes the context and loads the files, but leaves it suspended', async () => {
    const m = make();
    m.setActive(false);
    m.unlock();
    await m._loading;
    expect(audio.contexts).toHaveLength(1);
    expect(m.ctx.state).toBe('suspended');
    expect(m._buffers.size).toBe(Object.keys(SOUND_URLS).length);
    m.setActive(true);
    expect(m.play('turn')).toBe(true);
  });

  it('a muted device stays suspended at the table until it is unmuted', async () => {
    const m = await ready();
    m.setActive(false);
    m.setMuted(true);
    m.setActive(true);
    expect(m.ctx.state).toBe('suspended');
    m.setMuted(false);
    expect(m.ctx.state).toBe('running');
  });
});

describe('start(): a sound that runs on (the bid clock\'s tune)', () => {
  const tune = (m) => m.ctx.started.filter((x) => x.name === 'bidclock');
  const srcs = (m) => m.ctx.sources.filter((x) => x.buffer.name === 'bidclock');

  it('starts the file at an offset through its own gain into the master, and reports where it plays', async () => {
    const m = await ready();
    expect(m.duration('bidclock')).toBe(30.02);
    expect(m.duration('nope')).toBe(null);
    const h = m.start('bidclock', { offset: 12.5 });
    expect(h).toBeTruthy();
    expect(h.playing).toBe(true);
    expect(tune(m)).toHaveLength(1);
    expect(tune(m)[0]).toMatchObject({ t: 10, offset: 12.5 });
    const g = m.ctx.gains[1];
    expect(g.connect).toHaveBeenCalledWith(m.ctx.gains[0]);
    expect(h.position).toBe(12.5);
    m.ctx.currentTime = 13;
    expect(h.position).toBe(15.5);
    // no throttle: the next start is another tune
    expect(m.start('bidclock', { offset: 1 })).toBeTruthy();
  });

  it('refuses as play() does: muted, volume 0, a hidden tab, off the table, not ready, not loaded, an offset past the end', async () => {
    const before = make();
    expect(before.start('bidclock')).toBe(null);
    const m = await ready();
    m.setMuted(true);
    expect(m.start('bidclock')).toBe(null);
    m.setMuted(false);
    m.setVolume(0);
    expect(m.start('bidclock')).toBe(null);
    m.setVolume(0.5);
    doc.hidden = true;
    expect(m.start('bidclock')).toBe(null);
    doc.hidden = false;
    m.setActive(false);
    expect(m.start('bidclock')).toBe(null);
    m.setActive(true);
    await Promise.resolve();
    expect(m.start('nope')).toBe(null);
    expect(m.start('bidclock', { offset: 31 })).toBe(null);
    expect(m.start('bidclock', { offset: 3 })).toBeTruthy();
  });

  it('stop() fades the gain to 0 and stops the source at the fade\'s end; stop(0) at once; twice is a no-op', async () => {
    const m = await ready();
    const h = m.start('bidclock', { offset: 2 });
    const g = m.ctx.gains[1];
    const src = srcs(m)[0];
    h.stop();
    expect(h.playing).toBe(false);
    expect(g.gain.ramps).toEqual([{ v: 0, t: 10 + STOP_FADE_S }]);
    expect(src.stoppedAt).toBe(10 + STOP_FADE_S);
    h.stop();
    expect(g.gain.ramps).toHaveLength(1);
    const h2 = m.start('bidclock', { offset: 2 });
    h2.stop(0);
    expect(srcs(m)[1].stoppedAt).toBe('now');
  });

  it('the handle clears when the file ends on its own', async () => {
    const m = await ready();
    const h = m.start('bidclock', { offset: 29 });
    srcs(m)[0].onended();
    expect(h.playing).toBe(false);
  });

  it('mute and volume reach a playing tune through the master gain', async () => {
    const m = await ready();
    const h = m.start('bidclock');
    m.setMuted(true);
    expect(m.ctx.gains[0].gain.value).toBe(0);
    expect(h.playing).toBe(true);
    m.setMuted(false);
    expect(m.ctx.gains[0].gain.value).toBe(DEFAULT_VOLUME);
  });

  it('a failing context is logged once and returns null', async () => {
    audio = fakeAudio({ failSource: true });
    const m = await ready();
    expect(m.start('bidclock')).toBe(null);
    expect(m.start('bidclock')).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('onReady fires when the files are decoded and when the context runs again', async () => {
    const m = make();
    const fn = vi.fn();
    const off = m.onReady(fn);
    m.unlock();
    await m._loading;
    await Promise.resolve();
    expect(fn).toHaveBeenCalled();
    const n = fn.mock.calls.length;
    m.ctx.state = 'suspended';
    m.unlock();
    await Promise.resolve();
    await Promise.resolve();
    expect(fn.mock.calls.length).toBeGreaterThan(n);
    off();
    const k = fn.mock.calls.length;
    m.ctx.state = 'suspended';
    m.unlock();
    await Promise.resolve();
    await Promise.resolve();
    expect(fn.mock.calls.length).toBe(k);
  });
});

/**
 * The boot path and the gate screen (web roadmap item 19): a gated phone
 * never imports the app chunk; "Continue" remembers and boots it; the
 * gate's DOM (variant, App Store link, focus order, viewport) and the
 * page's index.html (Smart App Banner, the entry).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runBoot, startApp } from './boot.js';
import { showGate, GATE_ID } from './gateScreen.js';
import { _resetPageChoice, CONTINUE_KEY, APP_STORE_URL, VARIANT } from './deviceGate.js';
import { focusables } from '../ui/kit/modal.js';
import { readClientFile } from '../testing/files.js';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
}

/**
 * A window over jsdom's document with a chosen device. `win.screen` can be
 * reassigned and `win.fire('resize')` / `win.fireMedia()` run the
 * listeners; `win.location.reload` / `replace` are spies.
 */
function fakeWin({ phone = true, ua = IPHONE_UA, search = '', storage = memoryStorage(), readyState = 'complete', onLine = true } = {}) {
  const features = phone ? { '(pointer: coarse)': true, '(hover: none)': true } : {};
  const listeners = { window: new Map(), media: new Set() };
  return {
    // jsdom's document (the parts the gate uses), with a readyState the test picks
    document: { readyState, get body() { return document.body; }, querySelector: (s) => document.querySelector(s) },
    matchMedia: (q) => ({
      matches: !!features[q],
      media: q,
      addEventListener: (type, fn) => { if (type === 'change') listeners.media.add(fn); },
      removeEventListener: (type, fn) => { if (type === 'change') listeners.media.delete(fn); },
    }),
    screen: phone ? { width: 390, height: 844 } : { width: 1920, height: 1080 },
    navigator: { userAgent: ua, maxTouchPoints: phone ? 5 : 0, onLine },
    location: { search, href: `https://babonline.io/${search}`, reload: vi.fn(), replace: vi.fn() },
    localStorage: storage,
    addEventListener: (type, fn) => {
      if (!listeners.window.has(type)) listeners.window.set(type, new Set());
      listeners.window.get(type).add(fn);
    },
    removeEventListener: (type, fn) => listeners.window.get(type)?.delete(fn),
    fire: (type) => [...(listeners.window.get(type) || [])].forEach((fn) => fn()),
    fireMedia: () => [...listeners.media].forEach((fn) => fn()),
    listenerCount: () => listeners.media.size + [...listeners.window.values()].reduce((n, set) => n + set.size, 0),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  document.body.innerHTML = '<div id="table-shell"><div id="game-container"></div></div>';
  document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
  _resetPageChoice();
});

const gate = () => document.getElementById(GATE_ID);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('runBoot', () => {
  it('a non-phone imports the app at once and starts it (the chunk arrived after load)', async () => {
    const app = { startApp: vi.fn() };
    const loadApp = vi.fn(async () => app);
    const res = runBoot({ win: fakeWin({ phone: false, ua: DESKTOP_UA }), loadApp });
    expect(res).toMatchObject({ gated: false, reason: 'not-phone' });
    expect(loadApp).toHaveBeenCalledTimes(1);
    await res.app;
    expect(app.startApp).toHaveBeenCalledTimes(1);
    expect(gate()).toBeNull();
  });

  it('before the load event, main.js\'s own load listener starts it (boot does not)', async () => {
    const app = { startApp: vi.fn() };
    const res = runBoot({ win: fakeWin({ phone: false, ua: DESKTOP_UA, readyState: 'interactive' }), loadApp: async () => app });
    await res.app;
    expect(app.startApp).not.toHaveBeenCalled();
  });

  it('a gated phone never imports the app module', async () => {
    const loadApp = vi.fn(async () => ({ startApp: vi.fn() }));
    const res = runBoot({ win: fakeWin(), loadApp });
    expect(res).toMatchObject({ gated: true, variant: VARIANT.IOS, reason: 'phone' });
    await flush();
    expect(loadApp).not.toHaveBeenCalled();
    expect(gate()).not.toBeNull();
  });

  it('"Continue in browser anyway" remembers the choice, then boots the app and removes the gate', async () => {
    const storage = memoryStorage();
    const app = { startApp: vi.fn() };
    let resolveLoad;
    const loadApp = vi.fn(() => new Promise((r) => { resolveLoad = r; }));
    runBoot({ win: fakeWin({ storage }), loadApp });

    const btn = gate().querySelector('[data-gate="continue"]');
    btn.click();
    await flush();
    expect(storage.getItem(CONTINUE_KEY)).toBe('1');
    expect(loadApp).toHaveBeenCalledTimes(1);
    // still loading: the gate stays, busy, the button can't be pressed twice
    expect(gate()).not.toBeNull();
    expect(btn.disabled).toBe(true);
    expect(gate().querySelector('[role="status"]').textContent).toMatch(/Loading/);
    btn.click();
    expect(loadApp).toHaveBeenCalledTimes(1);

    resolveLoad(app);
    await flush();
    expect(app.startApp).toHaveBeenCalledTimes(1);
    expect(gate()).toBeNull();
    expect(document.querySelector('meta[name="viewport"]').getAttribute('content')).toBe('width=device-width, initial-scale=1.0');

    // the next page load boots straight into the app
    _resetPageChoice();
    const loadAgain = vi.fn(async () => app);
    expect(runBoot({ win: fakeWin({ storage }), loadApp: loadAgain })).toMatchObject({ gated: false, reason: 'continued' });
    expect(loadAgain).toHaveBeenCalledTimes(1);
  });

  it('offline, a failed app load leaves the gate usable with a message (no reload)', async () => {
    let fail = true;
    const app = { startApp: vi.fn() };
    const loadApp = vi.fn(async () => {
      if (fail) throw new Error('offline');
      return app;
    });
    const win = fakeWin({ onLine: false });
    runBoot({ win, loadApp });
    const btn = gate().querySelector('[data-gate="continue"]');
    btn.click();
    await flush();
    await flush();
    expect(gate()).not.toBeNull();
    expect(btn.disabled).toBe(false);
    expect(gate().querySelector('[role="status"]').textContent).toMatch(/Couldn't load/);
    expect(win.location.reload).not.toHaveBeenCalled();
    fail = false;
    btn.click();
    await flush();
    await flush();
    expect(app.startApp).toHaveBeenCalledTimes(1);
    expect(gate()).toBeNull();
  });

  it('a failed app load (a deploy removed the chunk) reloads the page once; the choice is remembered', async () => {
    const storage = memoryStorage();
    const win = fakeWin({ storage });
    const loadApp = vi.fn(async () => { throw new TypeError('Failed to fetch dynamically imported module: /dist/assets/main-Old999.js'); });
    runBoot({ win, loadApp });
    const btn = gate().querySelector('[data-gate="continue"]');
    btn.click();
    await flush();
    await flush();
    expect(win.location.reload).toHaveBeenCalledTimes(1);
    expect(win.location.replace).not.toHaveBeenCalled();
    expect(storage.getItem(CONTINUE_KEY)).toBe('1');
    // the gate stays busy while the page reloads: no "check your connection"
    expect(btn.disabled).toBe(true);
    expect(gate().querySelector('[role="status"]').textContent).not.toMatch(/Couldn't load/);
    // and the reload boots straight into the app
    _resetPageChoice();
    expect(runBoot({ win: fakeWin({ storage }), loadApp: vi.fn(async () => ({})) }).gated).toBe(false);
  });

  it('a failed app load with storage that throws reloads with ?web=1 (the choice would be lost)', async () => {
    const win = fakeWin({ search: '?ref=x' });
    Object.defineProperty(win, 'localStorage', { get() { throw new Error('SecurityError'); } });
    runBoot({ win, loadApp: async () => { throw new Error('404'); } });
    gate().querySelector('[data-gate="continue"]').click();
    await flush();
    await flush();
    expect(win.location.reload).not.toHaveBeenCalled();
    expect(win.location.replace).toHaveBeenCalledWith('https://babonline.io/?ref=x&web=1');
  });

  it('a reload that throws falls back to the message', async () => {
    const win = fakeWin();
    win.location.reload = () => { throw new Error('blocked'); };
    runBoot({ win, loadApp: async () => { throw new Error('404'); } });
    const btn = gate().querySelector('[data-gate="continue"]');
    btn.click();
    await flush();
    await flush();
    expect(btn.disabled).toBe(false);
    expect(gate().querySelector('[role="status"]').textContent).toMatch(/Couldn't load/);
  });

  it('a foldable unfolded to a tablet-size screen lifts the gate and boots, without remembering Continue', async () => {
    const storage = memoryStorage();
    const win = fakeWin({ ua: ANDROID_UA, storage });
    win.screen = { width: 344, height: 882 }; // the cover screen
    const app = { startApp: vi.fn() };
    const loadApp = vi.fn(async () => app);
    expect(runBoot({ win, loadApp })).toMatchObject({ gated: true, variant: VARIANT.OTHER });

    // rotating the cover screen: same short side, still a phone
    win.screen = { width: 882, height: 344 };
    win.fire('resize');
    win.fireMedia();
    await flush();
    expect(loadApp).not.toHaveBeenCalled();
    expect(gate()).not.toBeNull();

    win.screen = { width: 673, height: 841 }; // unfolded: the inner display
    win.fireMedia();
    win.fire('resize'); // both fire on a real fold: one load only
    await flush();
    await flush();
    expect(loadApp).toHaveBeenCalledTimes(1);
    expect(app.startApp).toHaveBeenCalledTimes(1);
    expect(gate()).toBeNull();
    expect(storage.getItem(CONTINUE_KEY)).toBeNull(); // folded again next time: the gate shows
    expect(win.listenerCount()).toBe(0);
  });

  it('the screen watcher: a resize alone lifts it too; Continue stops it; a forced gate never lifts', async () => {
    const win = fakeWin();
    const loadApp = vi.fn(async () => ({}));
    runBoot({ win, loadApp });
    win.screen = { width: 669, height: 900 }; // the opened iPhone Duo-style fold
    win.fire('resize');
    await flush();
    await flush();
    expect(loadApp).toHaveBeenCalledTimes(1);
    expect(gate()).toBeNull();

    document.body.innerHTML = '';
    const win2 = fakeWin();
    const load2 = vi.fn(async () => ({}));
    runBoot({ win: win2, loadApp: load2 });
    expect(win2.listenerCount()).toBeGreaterThan(0);
    gate().querySelector('[data-gate="continue"]').click();
    await flush();
    await flush();
    expect(win2.listenerCount()).toBe(0);
    expect(load2).toHaveBeenCalledTimes(1);

    document.body.innerHTML = '';
    const desk = fakeWin({ phone: false, ua: DESKTOP_UA, search: '?gate=1' });
    const load3 = vi.fn(async () => ({}));
    runBoot({ win: desk, loadApp: load3 });
    desk.fire('resize');
    desk.fireMedia();
    await flush();
    expect(load3).not.toHaveBeenCalled();
    expect(gate()).not.toBeNull();
    expect(desk.listenerCount()).toBe(0);
  });

  it('storage that throws: the gate shows and Continue still boots (for this page)', async () => {
    const win = fakeWin();
    Object.defineProperty(win, 'localStorage', { get() { throw new Error('SecurityError'); } });
    const app = { startApp: vi.fn() };
    runBoot({ win, loadApp: async () => app });
    gate().querySelector('[data-gate="continue"]').click();
    await flush();
    await flush();
    expect(app.startApp).toHaveBeenCalledTimes(1);
  });

  it('?web=1 on a phone boots the app; ?gate=1 on a desktop shows the gate', async () => {
    const load1 = vi.fn(async () => ({}));
    expect(runBoot({ win: fakeWin({ search: '?web=1' }), loadApp: load1 }).gated).toBe(false);
    expect(load1).toHaveBeenCalledTimes(1);
    _resetPageChoice();
    const load2 = vi.fn(async () => ({}));
    expect(runBoot({ win: fakeWin({ phone: false, ua: DESKTOP_UA, search: '?gate=1' }), loadApp: load2 }))
      .toMatchObject({ gated: true, variant: VARIANT.OTHER });
    expect(load2).not.toHaveBeenCalled();
  });

  it('a gate that cannot be drawn boots the app instead of a blank page', async () => {
    const win = fakeWin();
    win.document = { readyState: 'complete', querySelector: () => null, body: null };
    const app = { startApp: vi.fn() };
    const res = runBoot({ win, loadApp: async () => app });
    expect(res).toMatchObject({ gated: false, reason: 'gate-error' });
    await res.app;
    expect(app.startApp).toHaveBeenCalled();
  });

  it('startApp tolerates a module without startApp', async () => {
    await expect(startApp({ win: { document: { readyState: 'complete' } }, loadApp: async () => ({}) })).resolves.toEqual({});
  });
});

describe('the gate screen', () => {
  it('iPhone: icon, name, one line, "Get the iPhone app" to the App Store, then Continue', () => {
    showGate({ variant: VARIANT.IOS, onContinue: () => {} });
    const root = gate();
    expect(root.tagName).toBe('MAIN');
    expect(root.dataset.variant).toBe('ios');
    expect(root.getAttribute('aria-labelledby')).toBe('phone-gate-title');
    expect(root.querySelector('h1').textContent).toBe('BAB Online');
    expect(root.querySelector('img.gate__icon').getAttribute('alt')).toBe('');
    expect(root.querySelector('img.gate__icon').getAttribute('src')).toBe('assets/app-icon.webp');

    const store = root.querySelector('[data-gate="store"]');
    expect(store.tagName).toBe('A');
    expect(store.getAttribute('href')).toBe(APP_STORE_URL);
    expect(store.textContent).toBe('Get the iPhone app');
    expect(store.className).toContain('kit-btn--primary');
    expect(store.hasAttribute('target')).toBe(false);

    const cont = root.querySelector('[data-gate="continue"]');
    expect(cont.tagName).toBe('BUTTON');
    expect(cont.getAttribute('type')).toBe('button');
    expect(cont.textContent).toBe('Continue in browser anyway');

    // focus order: the store link, then Continue (nothing else is focusable)
    expect(focusables(root)).toEqual([store, cont]);
    store.focus();
    expect(document.activeElement).toBe(store);
  });

  it('Android and other phones: "made for bigger screens", no store button', () => {
    showGate({ variant: VARIANT.OTHER, onContinue: () => {} });
    const root = gate();
    expect(root.dataset.variant).toBe('other');
    expect(root.textContent).toContain('BAB Online is made for bigger screens.');
    expect(root.textContent).toContain('Play on a computer or tablet.');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).not.toMatch(/App Store/);
    expect(focusables(root)).toEqual([root.querySelector('[data-gate="continue"]')]);
  });

  it('covers the notch while up (viewport-fit=cover) and restores the viewport on close', () => {
    const meta = document.querySelector('meta[name="viewport"]');
    const { close } = showGate({ variant: VARIANT.IOS, onContinue: () => {} });
    expect(meta.getAttribute('content')).toBe('width=device-width, initial-scale=1.0, viewport-fit=cover');
    expect(meta.getAttribute('content')).not.toMatch(/maximum-scale|user-scalable/);
    close();
    expect(meta.getAttribute('content')).toBe('width=device-width, initial-scale=1.0');
    expect(gate()).toBeNull();
  });

  it('never touches saved sessions: storage sees only the continue key', async () => {
    const calls = [];
    const backing = memoryStorage();
    backing.setItem('sessionToken', 'tok');
    backing.setItem('username', 'ann');
    const storage = new Proxy(backing, {
      get(target, prop) {
        if (typeof target[prop] !== 'function') return target[prop];
        return (...args) => {
          calls.push([prop, args[0]]);
          return target[prop](...args);
        };
      },
    });
    const app = { startApp: vi.fn() };
    runBoot({ win: fakeWin({ storage }), loadApp: async () => app });
    gate().querySelector('[data-gate="continue"]').click();
    await flush();
    await flush();
    expect(app.startApp).toHaveBeenCalledTimes(1);
    expect(calls.every(([, key]) => key === CONTINUE_KEY)).toBe(true);
    expect(calls.map(([m]) => m)).toEqual(['getItem', 'setItem']);
    expect(backing.getItem('sessionToken')).toBe('tok');
    expect(backing.getItem('username')).toBe('ann');
  });
});

describe('the page', () => {
  const html = readClientFile('index.html');

  it('the entry is the boot module; Smart App Banner with the app id; no zoom lock', () => {
    expect(html).toContain('<script type="module" src="/src/entry.js"></script>');
    expect(html).toContain('<meta name="apple-itunes-app" content="app-id=6759510890">');
    expect(html).toContain('<html lang="en">');
    expect(html).toMatch(/<title>BAB Online<\/title>/);
    expect(html).not.toMatch(/maximum-scale|user-scalable/);
    expect(html).toContain('href="/styles/gate.css"');
  });

  it('the entry imports the app only through the dynamic import', () => {
    const entry = readClientFile('src/entry.js');
    expect(entry).toMatch(/import\('\.\/main\.js'\)/);
    expect(entry).not.toMatch(/^import .*main\.js/m);
    for (const f of ['src/boot/boot.js', 'src/boot/deviceGate.js', 'src/boot/gateScreen.js']) {
      const imports = readClientFile(f).split('\n').filter((l) => /^import /.test(l));
      expect(imports.join('\n'), f).not.toMatch(/main\.js|phaser|socket|vendor/i);
    }
  });

  it('gate.css: no idle animation; reduced motion drops the press scale', () => {
    const css = readClientFile('styles/gate.css');
    expect(css).not.toMatch(/animation\s*:/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
    expect(css).toMatch(/env\(safe-area-inset-top\)/);
    expect(css).toMatch(/height: 100vh;\s*height: 100dvh;/);
    expect(css).toMatch(/\.gate :is\(a, button\):focus-visible/);
    expect(css).toMatch(/min-height: var\(--hit-target\)/);
  });
});


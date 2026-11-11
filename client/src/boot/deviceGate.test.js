/**
 * Phone gate detection and decision (web roadmap item 19): the device
 * matrix, the escape hatches, storage that throws, and the non-phone media
 * query of the app chunk's preload kept in step with isPhone.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isPhone, variantFor, decideBoot, rememberContinue, hasContinued, readEnv, safeLocalStorage,
  _resetPageChoice, CONTINUE_KEY, PHONE_MAX_SHORT_SIDE, NOT_PHONE_MEDIA, APP_STORE_URL, APP_STORE_ID, VARIANT,
} from './deviceGate.js';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1',
  ipod: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
};

/**
 * A matchMedia over a feature set: pointer (coarse|fine|none), hover
 * (hover|none) and the screen (for min-device-*). Answers comma lists (OR)
 * and "and" chains the way a browser does, for the media queries used here.
 */
function fakeMatchMedia({ pointer, hover, screen }) {
  const one = (q) => {
    q = q.trim().replace(/^\(|\)$/g, '');
    const [k, v] = q.split(':').map((s) => s.trim());
    if (k === 'pointer') return v === pointer;
    if (k === 'hover') return v === hover;
    if (k === 'min-device-width') return screen.width >= parseFloat(v);
    if (k === 'min-device-height') return screen.height >= parseFloat(v);
    throw new Error(`unknown media feature ${k}`);
  };
  return (query) => ({ matches: query.split(',').some((alt) => alt.split(' and ').every(one)), media: query });
}

function device({ ua, pointer, hover, w, h, touch = 0 }) {
  const screen = { width: w, height: h };
  return { matchMedia: fakeMatchMedia({ pointer, hover, screen }), screen, userAgent: ua, maxTouchPoints: touch };
}

const DEVICES = {
  'iPhone 16 portrait': [device({ ua: UA.iphone, pointer: 'coarse', hover: 'none', w: 393, h: 852, touch: 5 }), VARIANT.IOS],
  // iOS reports the portrait screen in either orientation; a browser that
  // swaps them still has the same short side
  'iPhone 16 landscape': [device({ ua: UA.iphone, pointer: 'coarse', hover: 'none', w: 852, h: 393, touch: 5 }), VARIANT.IOS],
  'iPhone Pro Max (440)': [device({ ua: UA.iphone, pointer: 'coarse', hover: 'none', w: 440, h: 956, touch: 5 }), VARIANT.IOS],
  'iPhone SE (320)': [device({ ua: UA.iphone, pointer: 'coarse', hover: 'none', w: 320, h: 568, touch: 5 }), VARIANT.IOS],
  'Chrome on iPhone': [device({ ua: UA.iphoneChrome, pointer: 'coarse', hover: 'none', w: 390, h: 844, touch: 5 }), VARIANT.IOS],
  'iPhone requesting the desktop site': [device({ ua: UA.mac, pointer: 'coarse', hover: 'none', w: 390, h: 844, touch: 5 }), VARIANT.IOS],
  'iPod touch': [device({ ua: UA.ipod, pointer: 'coarse', hover: 'none', w: 320, h: 568, touch: 5 }), VARIANT.IOS],
  'Android phone': [device({ ua: UA.android, pointer: 'coarse', hover: 'none', w: 412, h: 915, touch: 5 }), VARIANT.OTHER],
  'Android phone landscape': [device({ ua: UA.android, pointer: 'coarse', hover: 'none', w: 915, h: 412, touch: 5 }), VARIANT.OTHER],
  'Android tablet 600': [device({ ua: UA.androidTablet, pointer: 'coarse', hover: 'none', w: 600, h: 960, touch: 10 }), null],
  'Android tablet 800': [device({ ua: UA.androidTablet, pointer: 'coarse', hover: 'none', w: 800, h: 1280, touch: 10 }), null],
  'iPad mini (744)': [device({ ua: UA.ipad, pointer: 'coarse', hover: 'none', w: 744, h: 1133, touch: 5 }), null],
  'iPadOS desktop-mode Safari': [device({ ua: UA.mac, pointer: 'coarse', hover: 'none', w: 820, h: 1180, touch: 5 }), null],
  'iPad with a trackpad': [device({ ua: UA.mac, pointer: 'fine', hover: 'hover', w: 820, h: 1180, touch: 5 }), null],
  'desktop': [device({ ua: UA.windows, pointer: 'fine', hover: 'hover', w: 1920, h: 1080 }), null],
  'Mac': [device({ ua: UA.mac, pointer: 'fine', hover: 'hover', w: 1512, h: 982 }), null],
  'touch laptop (coarse, but hover)': [device({ ua: UA.windows, pointer: 'coarse', hover: 'hover', w: 1366, h: 768, touch: 10 }), null],
  // the window may be 380 px wide: the screen decides
  'narrow desktop window': [device({ ua: UA.windows, pointer: 'fine', hover: 'hover', w: 1920, h: 1080 }), null],
  'a small old laptop screen (fine pointer)': [device({ ua: UA.windows, pointer: 'fine', hover: 'hover', w: 1024, h: 576 }), null],
  'TV / no pointer': [device({ ua: UA.windows, pointer: 'none', hover: 'none', w: 960, h: 540 }), null],
};

describe('the device matrix', () => {
  for (const [name, [env, expected]] of Object.entries(DEVICES)) {
    it(`${name}: ${expected ? `gated (${expected})` : 'not gated'}`, () => {
      expect(isPhone(env)).toBe(expected !== null);
      const decision = decideBoot({ env });
      expect(decision.gate).toBe(expected !== null);
      if (expected) expect(decision.variant).toBe(expected);
    });

    it(`${name}: the preload media query agrees (preload exactly when not gated)`, () => {
      expect(env.matchMedia(NOT_PHONE_MEDIA).matches).toBe(expected === null);
    });
  }

  it('the short-side threshold sits between phones (<= 440) and tablets (>= 600)', () => {
    expect(PHONE_MAX_SHORT_SIDE).toBe(600);
    const at = (w) => isPhone(device({ ua: UA.android, pointer: 'coarse', hover: 'none', w, h: 1000 }));
    expect(at(440)).toBe(true);
    expect(at(599)).toBe(true);
    expect(at(600)).toBe(false);
    expect(at(744)).toBe(false);
  });

  it('variantFor: iPhone/iPod (or a touch "Macintosh") only', () => {
    expect(variantFor({ userAgent: UA.iphone })).toBe(VARIANT.IOS);
    expect(variantFor({ userAgent: UA.ipod })).toBe(VARIANT.IOS);
    expect(variantFor({ userAgent: UA.mac, maxTouchPoints: 5 })).toBe(VARIANT.IOS);
    expect(variantFor({ userAgent: UA.mac, maxTouchPoints: 0 })).toBe(VARIANT.OTHER);
    expect(variantFor({ userAgent: UA.android })).toBe(VARIANT.OTHER);
    expect(variantFor({})).toBe(VARIANT.OTHER);
  });
});

describe('missing or broken APIs fail open', () => {
  const phone = DEVICES['iPhone 16 portrait'][0];
  const cases = {
    'no matchMedia': { ...phone, matchMedia: undefined },
    'no screen': { ...phone, screen: undefined },
    'matchMedia throws': { ...phone, matchMedia: () => { throw new Error('nope'); } },
    'matchMedia returns null': { ...phone, matchMedia: () => null },
    'screen of zeros': { ...phone, screen: { width: 0, height: 0 } },
    'screen of garbage': { ...phone, screen: { width: 'x', height: undefined } },
    'empty env': {},
  };
  for (const [name, env] of Object.entries(cases)) {
    it(name, () => {
      expect(isPhone(env)).toBe(false);
      expect(decideBoot({ env }).gate).toBe(false);
    });
  }

  it('readEnv survives getters that throw', () => {
    const win = {};
    Object.defineProperty(win, 'matchMedia', { get() { throw new Error('blocked'); } });
    Object.defineProperty(win, 'screen', { get() { throw new Error('blocked'); } });
    Object.defineProperty(win, 'navigator', { get() { throw new Error('blocked'); } });
    const env = readEnv(win);
    expect(env.matchMedia).toBeUndefined();
    expect(decideBoot({ env }).gate).toBe(false);
  });

  it('safeLocalStorage: null when reading localStorage throws', () => {
    const win = {};
    Object.defineProperty(win, 'localStorage', { get() { throw new Error('SecurityError'); } });
    expect(safeLocalStorage(win)).toBeNull();
  });
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
}
const throwingStorage = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
};

describe('escape hatches and the remembered choice', () => {
  const phone = DEVICES['iPhone 16 portrait'][0];
  const android = DEVICES['Android phone'][0];
  const desktop = DEVICES.desktop[0];
  beforeEach(() => _resetPageChoice());

  it('?web=1 boots the app on a phone and remembers it', () => {
    const storage = memoryStorage();
    expect(decideBoot({ env: phone, search: '?web=1', storage })).toEqual({ gate: false, reason: 'param-web' });
    expect(storage.getItem(CONTINUE_KEY)).toBe('1');
    expect(decideBoot({ env: phone, search: '', storage }).gate).toBe(false);
  });

  it('?gate=1 shows the gate on a desktop (bigger screens) and on an iPhone (app)', () => {
    expect(decideBoot({ env: desktop, search: '?gate=1' })).toMatchObject({ gate: true, variant: VARIANT.OTHER });
    expect(decideBoot({ env: phone, search: '?gate=1' })).toMatchObject({ gate: true, variant: VARIANT.IOS });
    expect(decideBoot({ env: desktop, search: '?gate=ios' })).toMatchObject({ gate: true, variant: VARIANT.IOS });
    expect(decideBoot({ env: phone, search: '?gate=other' })).toMatchObject({ gate: true, variant: VARIANT.OTHER });
  });

  it('?gate=1 wins over a remembered choice; unknown values are ignored', () => {
    const storage = memoryStorage();
    rememberContinue(storage);
    expect(decideBoot({ env: phone, search: '?gate=1', storage }).gate).toBe(true);
    _resetPageChoice();
    expect(decideBoot({ env: desktop, search: '?gate=yes&web=0', storage: memoryStorage() }).gate).toBe(false);
  });

  it('the remembered choice boots the app on a phone (any variant)', () => {
    const storage = memoryStorage();
    expect(decideBoot({ env: android, storage }).gate).toBe(true);
    rememberContinue(storage);
    expect(storage._m.get(CONTINUE_KEY)).toBe('1');
    _resetPageChoice(); // a new page load: only the storage remembers
    expect(decideBoot({ env: android, storage })).toEqual({ gate: false, reason: 'continued' });
  });

  it('storage that throws: never gates wrongly, and "continue" holds for the page only', () => {
    expect(hasContinued(throwingStorage)).toBe(false);
    expect(decideBoot({ env: phone, storage: throwingStorage }).gate).toBe(true);
    expect(rememberContinue(throwingStorage)).toBe(false);
    expect(decideBoot({ env: phone, storage: throwingStorage }).gate).toBe(false);
    _resetPageChoice(); // reload: the choice is gone
    expect(decideBoot({ env: phone, storage: throwingStorage }).gate).toBe(true);
    expect(decideBoot({ env: phone, search: '?web=1', storage: throwingStorage }).gate).toBe(false);
  });

  it('no storage at all', () => {
    expect(decideBoot({ env: phone, storage: null }).gate).toBe(true);
    expect(rememberContinue(null)).toBe(true);
    expect(decideBoot({ env: phone, storage: null }).gate).toBe(false);
  });

  it('a garbled query string is ignored', () => {
    expect(decideBoot({ env: desktop, search: '?%E0%A4%A' }).gate).toBe(false);
  });
});

describe('the App Store link', () => {
  it('one id, the storefront-neutral https URL', () => {
    expect(APP_STORE_ID).toBe('6759510890');
    expect(APP_STORE_URL).toBe('https://apps.apple.com/app/id6759510890');
  });
});

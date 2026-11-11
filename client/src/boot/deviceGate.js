/**
 * Phone gate (web roadmap item 19, owner decision 2026-11-11): phones get
 * the native iOS app (or, without one, a "bigger screens" note) instead of
 * the web client, which has no phone layout. Pure detection and decision;
 * the screen is gateScreen.js and the boot order is boot.js.
 *
 * A phone is a device whose primary pointer is coarse with no hover AND
 * whose screen's short side is under PHONE_MAX_SHORT_SIDE CSS px. The
 * screen, not the window: rotating, a split-view window or a narrow
 * desktop window never changes the answer. Anything missing or throwing
 * fails OPEN (no gate): the gate must never lock a player out.
 *
 * Escape hatches (CLAUDE.md "Phone gate"):
 * - "Continue in browser anyway" on the gate, remembered on the device
 *   (localStorage CONTINUE_KEY; if storage throws, for this page only);
 * - `?web=1` does the same from a link (support, testing);
 * - `?gate=1` shows the gate on any device (`?gate=ios` / `?gate=other`
 *   pick the variant), ignoring a remembered choice.
 */

// Owner's link: https://apps.apple.com/us/app/bab-online/id6759510890
// The button uses the storefront-neutral form so a player outside the US
// lands in their own store (Apple redirects).
export const APP_STORE_ID = '6759510890';
export const APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`;

/**
 * Phones are below this short side, tablets are at or above it (CSS px,
 * Math.min(screen.width, screen.height)). Every iPhone is at most 440
 * (Pro Max 440 x 956), big Android phones and folded foldables are about
 * 360-480; the smallest iPad (mini, 744 x 1133) and small Android tablets
 * (600 x 960 class, 7-inch) are 600 or more, and unfolded foldables are
 * 670+. 600 sits in the gap with room on both sides, and it is the iOS
 * app's own phone/tablet line (docs/ios-table-store.md, "Orientation").
 */
export const PHONE_MAX_SHORT_SIDE = 600;

/** localStorage key of the remembered "Continue in browser anyway". */
export const CONTINUE_KEY = 'bab.phoneGate.continue';

export const VARIANT = Object.freeze({ IOS: 'ios', OTHER: 'other' });

/** "Continue" chosen on this page when storage threw (page lifetime only). */
let continuedThisPage = false;

/** Test hook: forget the page-lifetime choice. */
export function _resetPageChoice() {
  continuedThisPage = false;
}

/**
 * Is this a phone? Pure: everything comes from `env`.
 * @param {Object} env
 * @param {Function} [env.matchMedia] - window.matchMedia (bound)
 * @param {{width:number, height:number}} [env.screen]
 * @returns {boolean} false whenever an API is missing or throws
 */
export function isPhone({ matchMedia, screen } = {}) {
  try {
    if (typeof matchMedia !== 'function' || !screen) return false;
    const coarse = matchMedia('(pointer: coarse)');
    const noHover = matchMedia('(hover: none)');
    if (!coarse || !noHover || coarse.matches !== true || noHover.matches !== true) return false;
    const w = Number(screen.width);
    const h = Number(screen.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
    return Math.min(w, h) < PHONE_MAX_SHORT_SIDE;
  } catch {
    return false;
  }
}

/**
 * iPhone / iPod (any iOS browser: they all carry "iPhone" or "iPod"), or an
 * iPhone asking for the desktop site (a Macintosh UA with touch points; a
 * real Mac reports 0 and never passes isPhone anyway).
 */
export function isIOSPhoneUA({ userAgent = '', maxTouchPoints = 0 } = {}) {
  const ua = String(userAgent || '');
  if (/iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && Number(maxTouchPoints) > 1;
}

/** The gate variant for this device: the App Store screen or "bigger screens". */
export function variantFor(env = {}) {
  return isIOSPhoneUA(env) ? VARIANT.IOS : VARIANT.OTHER;
}

/** The remembered "Continue in browser anyway" (storage that throws: false). */
export function hasContinued(storage) {
  if (continuedThisPage) return true;
  try {
    return storage?.getItem(CONTINUE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remember "Continue in browser anyway" on this device (or this page, if storage throws). */
export function rememberContinue(storage) {
  continuedThisPage = true;
  try {
    storage?.setItem(CONTINUE_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/** The page's localStorage, or null where reading it throws (blocked storage). */
export function safeLocalStorage(win) {
  try {
    return win.localStorage || null;
  } catch {
    return null;
  }
}

function readParams(search) {
  try {
    return new URLSearchParams(search || '');
  } catch {
    return new URLSearchParams();
  }
}

/**
 * What to boot.
 * @param {Object} o
 * @param {Object} o.env - { matchMedia, screen, userAgent, maxTouchPoints }
 * @param {string} [o.search] - location.search
 * @param {Storage|null} [o.storage]
 * @returns {{gate: false, reason: string} | {gate: true, variant: string, reason: string}}
 */
export function decideBoot({ env = {}, search = '', storage = null } = {}) {
  const params = readParams(search);
  if (params.get('web') === '1') {
    rememberContinue(storage);
    return { gate: false, reason: 'param-web' };
  }
  const forced = params.get('gate');
  if (forced === '1' || forced === VARIANT.IOS || forced === VARIANT.OTHER) {
    const variant = forced === '1' ? variantFor(env) : forced;
    return { gate: true, variant, reason: 'param-gate' };
  }
  if (hasContinued(storage)) return { gate: false, reason: 'continued' };
  if (!isPhone(env)) return { gate: false, reason: 'not-phone' };
  return { gate: true, variant: variantFor(env), reason: 'phone' };
}

/** The detection inputs from a window (any getter that throws: left out). */
export function readEnv(win) {
  const env = {};
  try { env.matchMedia = typeof win.matchMedia === 'function' ? win.matchMedia.bind(win) : undefined; } catch { /* fail open */ }
  try { env.screen = win.screen; } catch { /* fail open */ }
  try { env.userAgent = win.navigator?.userAgent || ''; } catch { /* fail open */ }
  try { env.maxTouchPoints = win.navigator?.maxTouchPoints || 0; } catch { /* fail open */ }
  return env;
}

/**
 * The media query of the NON-phone path (index.html's modulepreload of the
 * app chunk uses it, so a phone never fetches Phaser): any hover or fine
 * pointer (or no pointer), or a screen at least PHONE_MAX_SHORT_SIDE on
 * both sides. Kept in step with isPhone by deviceGate.test.js. A phone
 * that continued simply loads the chunk when it imports it.
 */
export const NOT_PHONE_MEDIA = `(hover: hover), (pointer: fine), (pointer: none), (min-device-width: ${PHONE_MAX_SHORT_SIDE}px) and (min-device-height: ${PHONE_MAX_SHORT_SIDE}px)`;

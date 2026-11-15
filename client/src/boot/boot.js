/**
 * The page's boot (web roadmap item 19): decide, then either import the
 * app chunk (main.js: Phaser, Socket.IO, every screen) or show the phone
 * gate. A gated phone never downloads or runs the app chunk, so it opens
 * no socket and never shows as online. The entry (src/entry.js) is this
 * plus the gate; the CSP allows no inline script, hence a module.
 *
 * Saved sessions are never read or cleared here: "Continue" (or the app
 * itself on a non-phone) finds the player signed in exactly as before.
 */
import {
  decideBoot, readEnv, rememberContinue, safeLocalStorage, isPhone, NOT_PHONE_MEDIA,
} from './deviceGate.js';
import { showGate } from './gateScreen.js';

/**
 * Start the app: import the chunk, wait for the window load event (now, if
 * it has fired), then run it. Boot is the only caller of main.js startApp,
 * so a throw from it (no WebGL, no canvas) always lands in this promise and
 * its reload-once / static notice, whichever side of load the chunk lands.
 */
export function startApp({ win, loadApp }) {
  return Promise.resolve(loadApp()).then((app) => afterLoad(win).then(() => {
    app?.startApp?.();
    return app;
  }));
}

function afterLoad(win) {
  if (win.document?.readyState === 'complete' || typeof win.addEventListener !== 'function') return Promise.resolve();
  return new Promise((resolve) => win.addEventListener('load', () => resolve(), { once: true }));
}

/**
 * startApp on the ungated path. A failed load (a deploy replaced the build
 * since index.html arrived, a dropped connection, startApp throwing)
 * reloads the page once; failing again, the page's static "Couldn't load"
 * notice (index.html #boot-fallback) shows instead of a blank page. The
 * promise still rejects for callers.
 */
function loadLogged(o) {
  const app = startApp(o).then((a) => {
    clearReloadMark(o.win);
    return a;
  }, (err) => {
    console.error('BAB Online failed to load', err);
    if (reloadPage(o.win, false)) return new Promise(() => {});
    setFallback(o.win, true);
    throw err;
  });
  app.catch(() => {}); // logged above
  return app;
}

/** index.html's static notice: hidden once boot runs, shown when the app cannot load. */
export const FALLBACK_ID = 'boot-fallback';

function setFallback(win, show) {
  try {
    const node = win.document?.querySelector?.(`#${FALLBACK_ID}`);
    if (!node) return;
    node.hidden = !show;
    node.classList?.toggle('is-shown', show);
  } catch { /* no notice */ }
}

/**
 * The loop guard of the reload: sessionStorage RELOAD_KEY holds when this
 * tab last reloaded for a failed load, so a second failure within
 * RELOAD_WINDOW_MS shows a message instead of reloading again. Storage that
 * throws: the reload's URL carries ?bootReload=1 instead. A load that
 * works clears both. (Its own few lines, not utils/safeStorage.js: the
 * entry may import nothing the app chunk shares; vite.config.js.)
 */
export const RELOAD_KEY = 'bab.bootReload';
export const RELOAD_PARAM = 'bootReload';
export const RELOAD_WINDOW_MS = 2 * 60 * 1000;

function hasReloadParam(win) {
  try {
    return new URLSearchParams(win.location?.search || '').has(RELOAD_PARAM);
  } catch {
    return false;
  }
}

/** Did this tab already reload for a failed load moments ago? */
export function reloadedRecently(win, now = Date.now()) {
  if (hasReloadParam(win)) return true;
  try {
    const at = Number(win.sessionStorage?.getItem(RELOAD_KEY));
    return at > 0 && now - at < RELOAD_WINDOW_MS;
  } catch {
    return false;
  }
}

/** @returns {boolean} whether sessionStorage holds the mark */
function markReload(win, now = Date.now()) {
  try {
    if (!win.sessionStorage) return false;
    win.sessionStorage.setItem(RELOAD_KEY, String(now));
    return win.sessionStorage.getItem(RELOAD_KEY) === String(now);
  } catch {
    return false;
  }
}

function clearReloadMark(win) {
  try { win.sessionStorage?.removeItem(RELOAD_KEY); } catch { /* nothing kept */ }
  if (!hasReloadParam(win)) return;
  try {
    const url = new URL(win.location.href);
    url.searchParams.delete(RELOAD_PARAM);
    win.history?.replaceState?.(win.history.state, '', url.toString());
  } catch { /* the param stays: harmless */ }
}

/**
 * @param {Object} o
 * @param {Window} o.win
 * @param {Function} o.loadApp - () => import('../main.js')
 * @returns {{gated: boolean, variant?: string, reason: string, app?: Promise}}
 */
export function runBoot({ win, loadApp }) {
  // Boot runs: the page's static notice (shown if it never does) goes
  setFallback(win, false);
  let decision;
  const storage = safeLocalStorage(win);
  try {
    decision = decideBoot({ env: readEnv(win), search: win.location?.search || '', storage });
  } catch {
    decision = { gate: false, reason: 'error' }; // fail open
  }

  if (!decision.gate) {
    return { gated: false, reason: decision.reason, app: loadLogged({ win, loadApp }) };
  }

  let gate;
  let stopWatching = () => {};
  try {
    gate = showGate({
      variant: decision.variant,
      doc: win.document,
      onContinue: () => {
        stopWatching();
        const remembered = rememberContinue(storage) && !!storage;
        return reloadOnLoadFailure(startApp({ win, loadApp }), { win, addWebParam: !remembered });
      },
    });
  } catch {
    // The gate could not be drawn: never leave a blank page
    return { gated: false, reason: 'gate-error', app: loadLogged({ win, loadApp }) };
  }
  // A forced gate (?gate=1) is for looking at: only a real phone's gate
  // lifts itself when the screen grows
  if (decision.reason === 'phone') stopWatching = watchScreen({ win, gate, loadApp });
  return { gated: true, variant: decision.variant, reason: decision.reason };
}

/**
 * The gated page loads the app chunk only on Continue, maybe long after
 * the page loaded. If a deploy replaced the build since, the page's
 * main-[hash].js is gone (a 404 on every retry), so a failed import reloads
 * the page once instead: the fresh index.html points at the current chunk,
 * and the choice is already remembered, so it boots straight into the app.
 * Storage that does not hold the choice: the reload carries ?web=1. Offline
 * (navigator.onLine false) the gate keeps its "check your connection"
 * message rather than reloading into the browser's offline page.
 * @returns {Promise} the app, or (reloading) a promise that never settles,
 *   so the gate stays busy until the page goes
 */
export function reloadOnLoadFailure(app, { win, addWebParam = false }) {
  return app.then((a) => {
    clearReloadMark(win);
    return a;
  }, (err) => {
    console.error('BAB Online failed to load', err);
    if (!reloadPage(win, addWebParam)) throw err;
    return new Promise(() => {});
  });
}

/** Reload once (never twice in a row: reloadedRecently). @returns {boolean} whether it did */
function reloadPage(win, addWebParam) {
  try {
    if (win.navigator?.onLine === false) return false;
    if (reloadedRecently(win)) return false;
    const marked = markReload(win);
    if (addWebParam || !marked) {
      const url = new URL(win.location.href);
      if (addWebParam) url.searchParams.set('web', '1');
      if (!marked) url.searchParams.set(RELOAD_PARAM, '1');
      win.location.replace(url.toString());
    } else {
      win.location.reload();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * While a phone's gate is up, re-check the screen when it changes: a
 * foldable opened from its cover screen to its tablet-size inner display
 * is no longer a phone by the gate's own rule, so the gate lifts and the
 * app boots, WITHOUT remembering "Continue" (folded again next time, the
 * gate shows). Rotation never lifts it (the screen's short side is the
 * same). Any API missing or throwing: no watching, the gate stays.
 */
export function watchScreen({ win, gate, loadApp }) {
  const stops = [];
  const stop = () => { while (stops.length) { try { stops.pop()(); } catch { /* ignore */ } } };
  const check = () => {
    let phone = true;
    try { phone = isPhone(readEnv(win)); } catch { /* stay gated */ }
    if (phone) return;
    stop();
    gate.proceed(() => reloadOnLoadFailure(startApp({ win, loadApp }), { win }));
  };
  try {
    const mql = win.matchMedia?.(NOT_PHONE_MEDIA);
    if (mql?.addEventListener) {
      mql.addEventListener('change', check);
      stops.push(() => mql.removeEventListener('change', check));
    } else if (mql?.addListener) {
      mql.addListener(check);
      stops.push(() => mql.removeListener(check));
    }
  } catch { /* the resize listener still covers it */ }
  try {
    if (typeof win.addEventListener === 'function') {
      win.addEventListener('resize', check);
      stops.push(() => win.removeEventListener('resize', check));
    }
  } catch { /* no watching */ }
  return stop;
}

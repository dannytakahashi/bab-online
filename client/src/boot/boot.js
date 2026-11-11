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
 * Start the app: import the chunk, then run it. main.js starts on the
 * window load event; when the chunk arrives after load (it usually does
 * now that it is imported, not a static script), start it here instead.
 * startApp runs once either way.
 */
export function startApp({ win, loadApp }) {
  return Promise.resolve(loadApp()).then((app) => {
    if (win.document.readyState === 'complete') app?.startApp?.();
    return app;
  });
}

/** startApp with its failure logged (the promise still rejects for callers). */
function loadLogged(o) {
  const app = startApp(o);
  app.catch((err) => console.error('BAB Online failed to load', err));
  return app;
}

/**
 * @param {Object} o
 * @param {Window} o.win
 * @param {Function} o.loadApp - () => import('../main.js')
 * @returns {{gated: boolean, variant?: string, reason: string, app?: Promise}}
 */
export function runBoot({ win, loadApp }) {
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
  return app.catch((err) => {
    console.error('BAB Online failed to load', err);
    if (!reloadPage(win, addWebParam)) throw err;
    return new Promise(() => {});
  });
}

function reloadPage(win, addWebParam) {
  try {
    if (win.navigator?.onLine === false) return false;
    if (addWebParam) {
      const url = new URL(win.location.href);
      url.searchParams.set('web', '1');
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

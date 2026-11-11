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
import { decideBoot, readEnv, rememberContinue, safeLocalStorage } from './deviceGate.js';
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

  try {
    showGate({
      variant: decision.variant,
      doc: win.document,
      onContinue: () => {
        rememberContinue(storage);
        return startApp({ win, loadApp });
      },
    });
  } catch {
    // The gate could not be drawn: never leave a blank page
    return { gated: false, reason: 'gate-error', app: loadLogged({ win, loadApp }) };
  }
  return { gated: true, variant: decision.variant, reason: decision.reason };
}

/**
 * The mute choice of this tab's session (owner 2026-11-19: "once you
 * unmute in a session it should stay unmuted"). The very first voice start
 * of a tab is muted (owner 2026-11-18); once the person unmutes by hand,
 * every later start in the same tab (play again's Return to Lobby, a new
 * lobby, a new table, voice back after company returns, a reconnect, a
 * reload of the tab) starts unmuted, and a mute by hand is kept the same
 * way. Kept in sessionStorage, so a reload keeps it and a new tab starts
 * muted; with storage blocked it lasts for this page (safeStorage). The
 * choice is one person's: a sign-out forgets it (forgetSessionMute).
 *
 * An unmuted start needs the microphone already allowed (no prompt at a
 * voice start): `micAlreadyAllowed`. Otherwise the start is muted as before.
 */

import { safeSessionStorage } from '../utils/safeStorage.js';

export const SESSION_MUTE_KEY = 'bab.voiceUnmuted';

/** Did the person last unmute by hand in this tab (and not mute again since)? */
export function sessionWantsUnmuted() {
  return safeSessionStorage().getItem(SESSION_MUTE_KEY) === '1';
}

/** The person muted (true) or unmuted (false) by hand: later starts in this tab follow it. */
export function rememberSessionMute(muted) {
  safeSessionStorage().setItem(SESSION_MUTE_KEY, muted ? '0' : '1');
}

/**
 * A new voice session in this tab: the tab drops its identity (Sign Out, a
 * deleted account, a failed restore or reconnect; clearAllSessionData and
 * main.js), so the next person to sign in here starts muted and never
 * inherits a live microphone. Tests: a fresh tab.
 */
export function forgetSessionMute() {
  safeSessionStorage().removeItem(SESSION_MUTE_KEY);
}

/**
 * May this page open the microphone with no prompt? The browser's
 * permission says so ('granted'; 'denied' never), else this page already
 * got it once (`grantedThisPage`: Safari and Firefox keep a page's grant
 * without reporting it as 'granted'). A browser without the Permissions
 * API, or one that does not know 'microphone', answers from the page.
 * @param {{grantedThisPage?: boolean}} [o]
 * @returns {Promise<boolean>}
 */
export async function micAlreadyAllowed({ grantedThisPage = false } = {}) {
  try {
    const status = await globalThis.navigator?.permissions?.query?.({ name: 'microphone' });
    if (status?.state === 'granted') return true;
    if (status?.state === 'denied') return false;
  } catch { /* no such permission name here: the page's own word below */ }
  return !!grantedThisPage;
}

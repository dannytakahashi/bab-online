/**
 * "Stay signed in" for the web client.
 *
 * The active session lives in sessionStorage (per tab, so local testing can
 * still run four different players in four tabs). The most recent sign-in is
 * also saved in localStorage, so opening the site in a new tab or after
 * closing the browser resumes it instead of asking for the password again.
 * The server keeps one token per device (see server/utils/sessionTokens.js).
 */

export const SAVED_SESSION_KEY = 'bab.savedSession';

function readSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_SESSION_KEY) || 'null');
    return saved && saved.username && saved.sessionToken ? saved : null;
  } catch {
    return null;
  }
}

/** Save this device's session after a successful sign-in or sign-up. */
export function rememberSession(username, sessionToken) {
  if (!username || !sessionToken) return;
  try {
    localStorage.setItem(SAVED_SESSION_KEY, JSON.stringify({ username, sessionToken }));
  } catch {
    // Storage blocked (private mode etc.): the tab session still works
  }
}

/**
 * Forget the saved session. With a token, only forget it if it's the one
 * saved, so a stale tab can't wipe a newer sign-in from another tab.
 */
export function forgetSession(sessionToken = null) {
  try {
    const saved = readSaved();
    if (sessionToken && saved && saved.sessionToken !== sessionToken) return;
    localStorage.removeItem(SAVED_SESSION_KEY);
  } catch {
    // ignore
  }
}

/**
 * On page load: if this tab has no session of its own, adopt the device's
 * saved one. Returns true if a saved session was adopted.
 */
export function adoptSavedSession() {
  try {
    if (sessionStorage.getItem('username') && sessionStorage.getItem('sessionToken')) return false;
    const saved = readSaved();
    if (!saved) return false;
    sessionStorage.setItem('username', saved.username);
    sessionStorage.setItem('sessionToken', saved.sessionToken);
    return true;
  } catch {
    return false;
  }
}

/**
 * Was this device signed out? True when localStorage can be read and holds
 * no saved session (Profile Sign Out, or a delete, in any tab clears it;
 * every sign-in writes it). Storage that throws says nothing: false.
 * A parked tab checks it before it offers to continue (review 2026-11-12):
 * its own sessionStorage copy of the session must not outlive a sign-out.
 */
export function isDeviceSignedOut() {
  try {
    const raw = localStorage.getItem(SAVED_SESSION_KEY);
    if (raw == null) return true;
    const saved = JSON.parse(raw);
    return !(saved && saved.username && saved.sessionToken);
  } catch {
    return false;
  }
}

/** Sign out this tab and this device. */
export function clearAllSessionData() {
  forgetSession();
  try {
    sessionStorage.removeItem('username');
    sessionStorage.removeItem('sessionToken');
    sessionStorage.removeItem('gameId');
    sessionStorage.removeItem('spectatingGameId');
    sessionStorage.removeItem('lobbyId');
  } catch {
    // ignore
  }
}

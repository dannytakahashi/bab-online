/**
 * No voice alone (owner 2026-11-19): voice (the WebRTC session, the
 * microphone, the audio context) runs only while at least one OTHER human
 * shares my room. In a lobby: another human member (bots never count). At
 * a table: another human seat owner whose presence is not gone (connected,
 * in reconnect grace, a lazy or resigned owner watching or away), or a
 * spectator. Alone with bots, voice is not started at all; when another
 * human arrives it starts (muted, as every start is); when the last one
 * leaves it stops after VOICE_ALONE_GRACE_MS, so a quick reconnect or step
 * away does not flap. docs/claude/voice.md, "No voice alone".
 *
 * The page (main.js) says when its screen wants voice (`want`: the lobby,
 * a seat, a voice spectator) and when that ends (`release`: every stop);
 * `update` re-reads the company after any change of who is here.
 */

/** How long voice keeps running after the last other human left. */
export const VOICE_ALONE_GRACE_MS = 30000;

/**
 * The other humans of a lobby payload (lobbyCreated, lobbyPlayerJoined,
 * lobbyPlayerLeft, playerReadyUpdate, lobbyReturn): `members` (family
 * lobbies), else the frozen `players`. Bots never count, nor my own name
 * (another tab of mine). A seat held for its reconnect grace and a play
 * again place kept for someone not back yet still count (not gone).
 * @param {Object|null} data
 * @param {string|null} me
 * @returns {Set<string>}
 */
export function lobbyOthers(data, me) {
  const rows = Array.isArray(data?.members) ? data.members : Array.isArray(data?.players) ? data.players : [];
  const names = new Set();
  for (const m of rows) {
    if (!m || m.isBot || typeof m.username !== 'string' || !m.username) continue;
    if (m.username === me) continue;
    names.add(m.username);
  }
  return names;
}

/**
 * Start and stop voice by company.
 * @param {Object} o
 * @param {() => boolean} o.hasCompany - is another human here now
 * @param {() => boolean} o.isRunning - voice is running or starting
 * @param {() => void} o.start - start voice (muted)
 * @param {() => void} o.suspend - stop voice, keeping the screen's voice state (the last human left)
 * @param {() => void} o.stop - stop voice for good (the screen no longer wants it)
 * @param {number} [o.graceMs]
 * @param {Function} [o.setTimer]
 * @param {Function} [o.clearTimer]
 */
export function createVoiceGate({
  hasCompany, isRunning, start, suspend, stop,
  graceMs = VOICE_ALONE_GRACE_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
}) {
  let wanted = false;
  let timer = null;

  function cancelGrace() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function update() {
    if (!wanted) {
      cancelGrace();
      return;
    }
    if (hasCompany()) {
      cancelGrace();
      if (!isRunning()) start();
      return;
    }
    // Alone: nothing to start; a running voice ends after the grace
    if (!isRunning() || timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      if (wanted && isRunning() && !hasCompany()) suspend();
    }, graceMs);
  }

  return {
    /** This screen wants voice (it runs while another human is here). */
    want() {
      wanted = true;
      update();
    },
    /** This screen no longer wants voice: stop it now. */
    release() {
      wanted = false;
      cancelGrace();
      stop();
    },
    update,
    get wanted() { return wanted; },
    /** The last other human left and voice ends when this runs out. */
    get graceRunning() { return timer !== null; },
  };
}

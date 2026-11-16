/**
 * Starting and stopping voice from the page (main.js), across the
 * microphone prompt (later #17). The prompt can stay open for as long as
 * the player likes: answered after they left the lobby or table (stop ran
 * meanwhile), the start used to go on and draw a mute button for a voice
 * session that was already shut down (a dead button), or warn "Microphone
 * access denied" on a screen with no voice. Every stop now ends the start
 * in flight: its late answer draws nothing and says nothing (the manager's
 * own generation check already releases the microphone).
 *
 * A start may name the talk mode (`{talk}`, family lobbies 2026-11-16: a
 * spectator starts listen-only, no mic prompt). A second start while one is
 * in flight returns that one and hands its mode to the manager (`setMode`),
 * so a voiceSettings arriving during the prompt is not lost: the running
 * initialize reads the latest mode before it builds a connection.
 */

/**
 * @param {Object} o
 * @param {{active: boolean}} o.manager - the VoiceChatManager
 * @param {Function} o.connect - (opts) => Promise: manager.initialize(socketManager, opts) (asks for the mic unless opts.talk is false)
 * @param {Function} o.onStarted - draw the controls (mute button, speaking indicators)
 * @param {Function} o.onUnavailable - (err) => tell the player (no WebRTC; a refused mic is listen-only, not a failure)
 * @param {Function} o.teardown - shut the manager down and remove the controls
 * @param {Function} [o.setMode] - (talk) => the desired mode of a start in flight
 * @returns {{start: (opts?: {talk?: boolean}) => Promise<boolean>, stop: () => void, readonly starting: boolean}}
 */
export function createVoiceLifecycle({ manager, connect, onStarted, onUnavailable, teardown, setMode = null }) {
  let generation = 0;
  let inFlight = null;

  function start(opts = {}) {
    if (manager.active) return Promise.resolve(true);
    if (inFlight) {
      if (typeof opts.talk === 'boolean') setMode?.(opts.talk);
      return inFlight;
    }
    const gen = generation;
    let run = null;
    let settled = false;
    run = (async () => {
      try {
        await connect(opts);
      } catch (err) {
        if (gen === generation) onUnavailable(err);
        return false;
      } finally {
        settled = true;
        if (inFlight === run) inFlight = null;
      }
      // Stopped while the prompt was up (or the manager did not start):
      // nothing to draw. A newer start owns whatever is live now
      if (gen !== generation || !manager.active) return false;
      onStarted();
      return true;
    })();
    if (!settled) inFlight = run;
    return run;
  }

  function stop() {
    generation++;
    inFlight = null;
    teardown();
  }

  return {
    start,
    stop,
    get starting() {
      return inFlight !== null;
    },
  };
}

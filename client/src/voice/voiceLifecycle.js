/**
 * Starting and stopping voice from the page (main.js), across the
 * microphone prompt (later #17). The prompt can stay open for as long as
 * the player likes: answered after they left the lobby or table (stop ran
 * meanwhile), the start used to go on and draw a mute button for a voice
 * session that was already shut down (a dead button), or warn "Microphone
 * access denied" on a screen with no voice. Every stop now ends the start
 * in flight: its late answer draws nothing and says nothing (the manager's
 * own generation check already releases the microphone).
 */

/**
 * @param {Object} o
 * @param {{active: boolean}} o.manager - the VoiceChatManager
 * @param {Function} o.connect - () => Promise: manager.initialize(socketManager) (asks for the mic)
 * @param {Function} o.onStarted - draw the controls (mute button, speaking indicators)
 * @param {Function} o.onUnavailable - (err) => tell the player (mic denied, no WebRTC)
 * @param {Function} o.teardown - shut the manager down and remove the controls
 * @returns {{start: () => Promise<boolean>, stop: () => void, readonly starting: boolean}}
 */
export function createVoiceLifecycle({ manager, connect, onStarted, onUnavailable, teardown }) {
  let generation = 0;
  let inFlight = null;

  function start() {
    if (manager.active) return Promise.resolve(true);
    if (inFlight) return inFlight;
    const gen = generation;
    let run = null;
    let settled = false;
    run = (async () => {
      try {
        await connect();
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

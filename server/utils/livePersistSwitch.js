/**
 * LIVE_PERSIST: whether live games and tournaments are saved to MongoDB so a
 * deploy or a crash does not end them. In a module with no dependencies,
 * like upgradeGateSwitch.js, so any layer can read it.
 *
 *   off   (default) today's code paths, byte for byte
 *   write live state is written, tombstoned and deleted; no handoff, no
 *         adoption, no resolve wait, no new notices
 *   on    everything: hand off to an 'on' successor, adopt, resume
 *
 * Unset or blank means off. Any other value (case and surrounding spaces
 * ignored) that is not one of the three means off too, with one warning.
 * The process reads it once, at boot (bootLivePersistMode): a change takes
 * effect with the next deploy, which Railway starts when a variable changes.
 *
 * Read by the live persist store only (server/game/persist/liveStore.js,
 * getLiveStore: deploy survival PR 4); everything else asks the store.
 * Until handoff and adoption land (PR 5), 'on' runs as 'write'.
 */

'use strict';

const MODES = Object.freeze(['off', 'write', 'on']);

/**
 * Parse a raw LIVE_PERSIST value.
 * @param {*} raw
 * @returns {{mode: 'off'|'write'|'on', unknown: boolean}} unknown: a
 *   non-blank value that is not one of MODES (read as off)
 */
function parseLivePersist(raw) {
    const v = raw == null ? '' : String(raw).trim().toLowerCase();
    if (v === '') return { mode: 'off', unknown: false };
    if (MODES.includes(v)) return { mode: v, unknown: false };
    return { mode: 'off', unknown: true };
}

/**
 * The mode `env` asks for. An unknown value warns (through `warn`) and
 * reads as off. Not cached: bootLivePersistMode is the process's reading.
 * @param {Object} [env]
 * @param {{warn?: Function}} [opts]
 * @returns {'off'|'write'|'on'}
 */
function livePersistMode(env = process.env, { warn = console.warn } = {}) {
    const { mode, unknown } = parseLivePersist(env.LIVE_PERSIST);
    if (unknown) {
        warn(`Ignoring LIVE_PERSIST=${JSON.stringify(String(env.LIVE_PERSIST).slice(0, 20))} (expected one of ${MODES.join(', ')}); using off`);
    }
    return mode;
}

let bootMode = null;

/**
 * The mode this process runs in: read on the first call and kept for the
 * life of the process (so the one warning is printed once).
 * @param {Object} [env]
 * @param {{warn?: Function}} [opts]
 * @returns {'off'|'write'|'on'}
 */
function bootLivePersistMode(env = process.env, opts = {}) {
    if (bootMode === null) bootMode = livePersistMode(env, opts);
    return bootMode;
}

/** Tests only: forget the boot reading. */
function _resetForTests() {
    bootMode = null;
}

module.exports = { MODES, parseLivePersist, livePersistMode, bootLivePersistMode, _resetForTests };

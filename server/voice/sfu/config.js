/**
 * Cloudflare Realtime SFU voice: settings (docs/claude/voice.md, "SFU voice
 * (server)"). Everything is read from the environment at call time, so a
 * test or a restart with a new value needs no reload; nothing here is ever
 * logged or sent to a client except the flag's value.
 *
 *   VOICE_SFU             off (default) | tournament. tournament: a
 *                         tournament's voice room (the lobby screen, between
 *                         rounds) is an SFU room when its first member enters
 *                         (and the app credentials below are set); tables,
 *                         lobbies and casual games stay on the peer-to-peer
 *                         mesh. Anything else counts as off (one warning).
 *   CF_SFU_APP_ID         the Cloudflare Realtime SFU app id (goes in the API path)
 *   CF_SFU_APP_SECRET     its secret (the Bearer token; never logged, never
 *                         sent to a client). Both unset with the flag on: the
 *                         room stays a mesh (one warning)
 *   CF_SFU_API_BASE       tests / dev only: a fake Cloudflare (ignored, with
 *                         one warning, when NODE_ENV=production)
 *   VOICE_SFU_ROOM_MAX    the SFU room's safety ceiling (default 100, 2..500)
 *   VOICE_SFU_GRACE_MS    how long a dropped member's session stays listed as
 *                         "reconnecting" (default 38000, 5000..120000)
 *   VOICE_SFU_TIMEOUT_MS  one Cloudflare call's timeout (default 8000, 1000..30000)
 *
 * The mesh's own limit (owner 2026-11-26: "keep 8 as the direct limit"):
 * with the flag on, every peer-to-peer room is at most MESH_MAX_WITH_SFU (8)
 * people; with it off, today's TOURNAMENT_VOICE_MAX (default 20) is unchanged
 * (server/voice/tournamentVoice.js meshMax).
 */

'use strict';

const { socketLogger } = require('../../utils/logger');

const DEFAULT_API_BASE = 'https://rtc.live.cloudflare.com';
const MESH_MAX_WITH_SFU = 8;
const ROOM_MAX_DEFAULT = 100;
const ROOM_MAX_MIN = 2;
const ROOM_MAX_MAX = 500;
const GRACE_DEFAULT_MS = 38000;
const TIMEOUT_DEFAULT_MS = 8000;

const warned = new Set();
function warnOnce(key, msg, meta) {
    if (warned.has(key)) return;
    warned.add(key);
    socketLogger.warn(msg, meta);
}

/** 'off' | 'tournament' (VOICE_SFU; anything else off). */
function mode(env = process.env) {
    const raw = String(env?.VOICE_SFU ?? '').trim().toLowerCase();
    if (raw === '' || raw === 'off') return 'off';
    if (raw === 'tournament') return 'tournament';
    warnOnce(`mode:${raw}`, 'Voice SFU: unknown VOICE_SFU value, treated as off', { value: raw.slice(0, 32) });
    return 'off';
}

/** The flag is on for tournaments (whether or not the credentials are set). */
const flagOn = (env = process.env) => mode(env) === 'tournament';

/**
 * The Cloudflare app settings, or null (not configured). The secret is only
 * ever handed to the Cloudflare client (cloudflareClient.js).
 */
function appConfig(env = process.env) {
    const appId = String(env?.CF_SFU_APP_ID || '').trim();
    const secret = String(env?.CF_SFU_APP_SECRET || '').trim();
    if (!appId || !secret) return null;
    // The app id goes into the URL path
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(appId)) {
        warnOnce('appId', 'Voice SFU: CF_SFU_APP_ID is malformed, SFU off');
        return null;
    }
    let base = DEFAULT_API_BASE;
    const override = String(env?.CF_SFU_API_BASE || '').trim();
    if (override) {
        if (env.NODE_ENV === 'production') {
            warnOnce('base', 'Voice SFU: CF_SFU_API_BASE is ignored in production');
        } else if (/^https?:\/\/[^\s]+$/.test(override)) {
            base = override.replace(/\/+$/, '');
        }
    }
    return { appId, secret, base };
}

/** Rooms made now are SFU rooms: the flag on AND the app configured (else one warning, mesh). */
function sfuEnabled(env = process.env) {
    if (!flagOn(env)) return false;
    if (appConfig(env)) return true;
    warnOnce('nocreds', 'Voice SFU: VOICE_SFU=tournament but CF_SFU_APP_ID / CF_SFU_APP_SECRET are not set; tournament voice stays peer to peer (at most 8)');
    return false;
}

function intEnv(env, key, def, min, max) {
    const raw = env?.[key];
    if (typeof raw !== 'string' || !/^\s*\d+\s*$/.test(raw)) return def;
    return Math.min(max, Math.max(min, Number.parseInt(raw, 10)));
}

/** The SFU room's safety ceiling (members admitted to voice). */
const roomMax = (env = process.env) => intEnv(env, 'VOICE_SFU_ROOM_MAX', ROOM_MAX_DEFAULT, ROOM_MAX_MIN, ROOM_MAX_MAX);
/** The "reconnecting" grace for a dropped member's session (Cloudflare's ~30-35 s session window, plus margin). */
const graceMs = (env = process.env) => intEnv(env, 'VOICE_SFU_GRACE_MS', GRACE_DEFAULT_MS, 5000, 120000);
/** One Cloudflare call's timeout: above Cloudflare's own 5 s wait for connectivity, so a dead session answers 410 first. */
const timeoutMs = (env = process.env) => intEnv(env, 'VOICE_SFU_TIMEOUT_MS', TIMEOUT_DEFAULT_MS, 1000, 30000);

module.exports = {
    DEFAULT_API_BASE,
    MESH_MAX_WITH_SFU,
    ROOM_MAX_DEFAULT,
    ROOM_MAX_MIN,
    ROOM_MAX_MAX,
    GRACE_DEFAULT_MS,
    TIMEOUT_DEFAULT_MS,
    mode,
    flagOn,
    appConfig,
    sfuEnabled,
    roomMax,
    graceMs,
    timeoutMs,
    _resetWarningsForTests: () => warned.clear(),
};

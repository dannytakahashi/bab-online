/**
 * Media direction of an SDP offer / answer, for the casual-spectator voice
 * gate (server/voice/gameVoice.js; docs/claude/voice.md, Spectator voice).
 *
 * A voice spectator who may not talk (spectatorsCanTalk off, or a main-room
 * spectator at a table with no capable controller) may only signal SDP that
 * sends nothing: every ACTIVE audio/video m-section must have an effective
 * direction of recvonly or inactive. The effective direction of a section is
 * its own a=sendrecv|sendonly|recvonly|inactive line, else the session-level
 * one (before the first m= line), else sendrecv (RFC 8866 / 3264 default).
 *
 * Active: a section whose port is not 0, or one marked a=bundle-only (a
 * BUNDLE member may carry port 0 and still flow). Port 0 without bundle-only
 * is a rejected / stopped section and carries nothing. Only m=audio and
 * m=video carry media; m=application (a data channel) has no direction
 * attribute that means anything and is ignored.
 *
 * The server never decodes anything else, never logs the SDP (it carries the
 * ICE ufrag / pwd and the DTLS fingerprint), and an unparseable SDP counts as
 * sending (fails closed for a gated spectator; players are never gated).
 */

'use strict';

const DIRECTIONS = new Set(['sendrecv', 'sendonly', 'recvonly', 'inactive']);
const MEDIA = new Set(['audio', 'video']);

/**
 * The m-sections of `sdp`: [{kind, port, direction, active}], direction the
 * effective one. Returns null for something that is not an SDP string.
 */
function sections(sdp) {
    if (typeof sdp !== 'string' || sdp.length === 0) return null;
    const lines = sdp.split(/\r?\n/);
    let sessionDir = null;
    const out = [];
    let cur = null;
    for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith('m=')) {
            // m=<media> <port>[/<count>] <proto> <fmt> ...
            const parts = line.slice(2).split(/\s+/);
            const port = Number.parseInt((parts[1] || '').split('/')[0], 10);
            cur = { kind: parts[0] || '', port: Number.isFinite(port) ? port : -1, direction: null, bundleOnly: false };
            out.push(cur);
            continue;
        }
        if (!line.startsWith('a=')) continue;
        const attr = line.slice(2);
        if (DIRECTIONS.has(attr)) {
            if (cur) cur.direction = attr;
            else sessionDir = attr;
        } else if (attr === 'bundle-only' && cur) {
            cur.bundleOnly = true;
        }
    }
    return out.map((s) => ({
        kind: s.kind,
        port: s.port,
        direction: s.direction || sessionDir || 'sendrecv',
        active: s.port !== 0 || s.bundleOnly,
    }));
}

/**
 * Does `sdp` send nothing? True when every active audio/video section is
 * recvonly or inactive (also when there is none). False for anything
 * unparseable.
 */
function isListenOnly(sdp) {
    const list = sections(sdp);
    if (list === null) return false;
    return list
        .filter((s) => s.active && MEDIA.has(s.kind))
        .every((s) => s.direction === 'recvonly' || s.direction === 'inactive');
}

/** 'listen' (sends nothing: isListenOnly) or 'send' — what voiceOfferDir records. */
function summary(sdp) {
    return isListenOnly(sdp) ? 'listen' : 'send';
}

module.exports = { sections, isListenOnly, summary };

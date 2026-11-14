/**
 * Emit-time mapping of seat and profile pictures for the wire (roadmap item
 * 10; docs/avatars.md).
 *
 * Since contract/V1_REMOVALS.md #19 (2026-11-12) no payload carries a
 * picture inline: a picture slot on the wire is a stock number (1-82) or
 * null, and a custom picture travels only as its URL
 * (/avatar/<username>?v=<version>, in avatarUrls / avatarUrl), the same for
 * every recipient (the clientHello avatarUrl cap is no longer checked: web
 * on main and iOS 1.2.0 send it, and the builds that did not are gated).
 * Until the rendition exists (first sight after a restart, a full derive
 * queue), for a stored value that is not a safe image (hostile), or with
 * the pipeline off, a custom picture has no URL and its slot is null: the
 * clients show their neutral picture (web: assets/default_avatar.png via
 * seatAvatarSrc, never stock #1; iOS 1.2.0: the name's initial).
 */

'use strict';

const avatarStore = require('./avatarStore');

const isCustom = (p) => typeof p === 'string' && p.startsWith('data:image');
const avatarPath = (username, v) => `/avatar/${encodeURIComponent(username)}?v=${v}`;

/** The URL custom picture `pic` of `username` has on the wire now, or null. */
function resolve(pic, username, v) {
    if (!avatarStore.available() || !isCustom(pic) || !username) return { url: null };
    const ver = v || avatarStore.versionOf(pic);
    const e = avatarStore.peek(ver);
    if (!e || e.status === 'pending') {
        avatarStore.warm(username, pic);
        return { url: null };
    }
    // hostile, undecodable, or a transient 'error' (retried after 60 s): no URL
    if (e.status !== 'ok') return { url: null };
    avatarStore.markOwner(ver, username);
    return { url: avatarPath(username, ver) };
}

/** A picture slot on the wire: a stock number as is, anything else null. */
const slot = (pic) => (Number.isInteger(pic) ? pic : null);

/** resolve() for a seat of `game` (the version hashed at seating when known). */
function seatResolve(game, pic, username) {
    return resolve(pic, username, isCustom(pic) ? game?.avatarVersions?.get(username) : undefined);
}

/**
 * players[] ({position, username, pic, ...}): every pic a slot, plus
 * avatarUrls {[position]: url} (undefined when empty).
 * @returns {{players: Object[], avatarUrls: (Object|undefined)}}
 */
function mapPlayers(game, players) {
    let avatarUrls;
    const out = players.map((p) => {
        if (isCustom(p.pic)) {
            const r = seatResolve(game, p.pic, p.username);
            if (r.url) (avatarUrls = avatarUrls || {})[p.position] = r.url;
        }
        const pic = slot(p.pic);
        return pic === p.pic ? p : { ...p, pic };
    });
    return { players: out, avatarUrls };
}

/**
 * A snapshot carrier's v1 part (players[] inside; snapshotHandlers.carrierFor):
 * players mapped, avatarUrls added when there is a URL. A shallow copy;
 * the input is never mutated.
 */
function wireClientState(game, state) {
    if (!state || !Array.isArray(state.players)) return state;
    const { players, avatarUrls } = mapPlayers(game, state.players);
    if (players === state.players && !avatarUrls) return state;
    const out = { ...state, players };
    if (avatarUrls) out.avatarUrls = avatarUrls;
    return out;
}

/**
 * resolve() for a stored users.customProfilePic read for a profile reply
 * (leaderboard, search, profiles): the rendition is awaited (derived now
 * if needed). A full derive queue answers without a URL.
 */
async function resolveStored(raw, username) {
    if (!avatarStore.available() || !isCustom(raw) || !username) return { url: null };
    try {
        await avatarStore.ensure(username, raw);
    } catch (e) {
        if (e.code !== 'AVATAR_BUSY') throw e;
        return { url: null };
    }
    return resolve(raw, username);
}

/**
 * Profile rows ({username, customProfilePic, ...}): customProfilePic null
 * on every row, plus avatarUrls {username: url} (undefined when empty). At
 * most 2 rows derive at once, so a fill never overflows the derive queue by
 * itself. Rows without a custom picture are shared, never copied.
 * @returns {Promise<{rows: Object[], avatarUrls: (Object|undefined)}>}
 */
async function mapProfileRows(rows) {
    const out = rows.map((row) => (row.customProfilePic == null ? row : { ...row, customProfilePic: null }));
    let avatarUrls;
    const todo = rows.filter((row) => isCustom(row.customProfilePic));
    const worker = async () => {
        for (let row = todo.shift(); row; row = todo.shift()) {
            const r = await resolveStored(row.customProfilePic, row.username);
            if (r.url) (avatarUrls = avatarUrls || {})[row.username] = r.url;
        }
    };
    await Promise.all([worker(), worker()]);
    return { rows: out, avatarUrls };
}

module.exports = { isCustom, avatarPath, resolve, resolveStored, slot, seatResolve, mapPlayers, wireClientState, mapProfileRows };

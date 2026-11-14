/**
 * Emit-time mapping of seat pictures for the wire (roadmap item 10;
 * docs/avatars.md, invariants I1-I6).
 *
 * A seat picture is a number (stock art 1-82, sent as is), null, or a
 * custom data:image string. For a custom one, resolve() gives
 *   legacy: what a socket without the avatarUrl capability gets in the pic
 *           slot: the small derived inline WebP (or, with
 *           AVATAR_LEGACY_INLINE=raw, the stored string; or the generic
 *           placeholder for a hostile stored value). Never a URL.
 *   url:    /avatar/<username>?v=<version>, once the rendition exists.
 * Until the rendition is ready (or with the pipeline off) a custom picture
 * is exactly today's value and there is no URL, for every recipient; the
 * avatar keys are then omitted, so such payloads are byte-identical to
 * fcdd885.
 *
 * Per-socket payloads pick a shape by recipient: capable (clientHello caps
 * 'avatarUrl') -> slot null + avatarUrls; legacy -> slot = legacy, no
 * avatar keys (today's keys exactly). Room broadcasts are never split:
 * slot = legacy for everyone plus the additive avatarUrls (legacy clients
 * ignore the key, capable clients prefer it).
 */

'use strict';

const avatarStore = require('./avatarStore');
const { PLACEHOLDER_INLINE } = require('./placeholder');

const isCustom = (p) => typeof p === 'string' && p.startsWith('data:image');
const avatarPath = (username, v) => `/avatar/${encodeURIComponent(username)}?v=${v}`;

/** What custom picture `pic` of `username` becomes on the wire. */
function resolve(pic, username, v) {
    if (!avatarStore.available() || !isCustom(pic) || !username) return { legacy: pic, url: null };
    const ver = v || avatarStore.versionOf(pic);
    const e = avatarStore.peek(ver);
    if (!e || e.status === 'pending') {
        avatarStore.warm(username, pic);
        return { legacy: pic, url: null };
    }
    if (e.status === 'hostile') return { legacy: PLACEHOLDER_INLINE, url: null };
    // undecodable, or a transient 'error' (retried after 60 s): today's shape
    if (e.status !== 'ok') return { legacy: pic, url: null };
    avatarStore.markOwner(ver, username);
    return {
        legacy: avatarStore.legacyInlineMode() === 'raw' ? pic : e.inline,
        url: avatarPath(username, ver),
    };
}

/** The pic slot a recipient gets: capable + URL -> null (it reads avatarUrl(s)). */
const slot = (r, capable) => (capable && r.url ? null : r.legacy);

/** resolve() for a seat of `game` (the version hashed at seating when known). */
function seatResolve(game, pic, username) {
    return resolve(pic, username, isCustom(pic) ? game?.avatarVersions?.get(username) : undefined);
}

/**
 * players[] ({position, username, pic, ...}) for one recipient kind.
 * @param {'capable'|'legacy'|'broadcast'} kind
 * @returns {{players: Object[], avatarUrls: (Object|undefined)}} avatarUrls
 *   {[position]: url}; undefined when empty, and always for 'legacy'
 */
function mapPlayers(game, players, kind) {
    let avatarUrls;
    const out = players.map((p) => {
        if (!isCustom(p.pic)) return p;
        const r = seatResolve(game, p.pic, p.username);
        if (r.url && kind !== 'legacy') (avatarUrls = avatarUrls || {})[p.position] = r.url;
        const pic = slot(r, kind === 'capable');
        return pic === p.pic ? p : { ...p, pic };
    });
    return { players: out, avatarUrls };
}

/**
 * A snapshot carrier's v1 part (players[] inside; snapshotHandlers.carrierFor) for one
 * recipient: players mapped, avatarUrls added for a capable one when there
 * is a URL. A shallow copy; the input is never mutated.
 */
function wireClientState(game, state, capable) {
    if (!state || !Array.isArray(state.players)) return state;
    const { players, avatarUrls } = mapPlayers(game, state.players, capable ? 'capable' : 'legacy');
    if (players === state.players && !avatarUrls) return state;
    const out = { ...state, players };
    if (avatarUrls) out.avatarUrls = avatarUrls;
    return out;
}

/**
 * resolve() for a stored users.customProfilePic read for a profile reply
 * (leaderboard, search, profiles): the rendition is awaited (derived now
 * if needed). A full derive queue falls back to today's value, no URL.
 */
async function resolveStored(raw, username) {
    if (!avatarStore.available() || !isCustom(raw) || !username) return { legacy: raw, url: null };
    try {
        await avatarStore.ensure(username, raw);
    } catch (e) {
        if (e.code !== 'AVATAR_BUSY') throw e;
        return { legacy: raw, url: null };
    }
    return resolve(raw, username);
}

/**
 * Profile rows ({username, customProfilePic, ...}) in both shapes:
 * legacy (customProfilePic = the inline rendition / placeholder / today's
 * value) and capable (customProfilePic null where there is a URL), plus
 * avatarUrls {username: url} (undefined when empty). At most 2 rows derive
 * at once, so a fill never overflows the derive queue by itself. Rows
 * without a custom picture are shared, never copied.
 */
async function mapProfileRows(rows) {
    const legacy = rows.slice();
    const capable = rows.slice();
    let avatarUrls;
    const todo = rows.map((row, i) => [row, i]).filter(([row]) => isCustom(row.customProfilePic));
    const worker = async () => {
        for (let next = todo.shift(); next; next = todo.shift()) {
            const [row, i] = next;
            const r = await resolveStored(row.customProfilePic, row.username);
            if (r.legacy !== row.customProfilePic) legacy[i] = { ...row, customProfilePic: r.legacy };
            if (r.url) {
                capable[i] = { ...row, customProfilePic: null };
                (avatarUrls = avatarUrls || {})[row.username] = r.url;
            } else {
                capable[i] = legacy[i];
            }
        }
    };
    await Promise.all([worker(), worker()]);
    return { legacy, capable, avatarUrls };
}

module.exports = { isCustom, avatarPath, resolve, resolveStored, slot, seatResolve, mapPlayers, wireClientState, mapProfileRows };

/**
 * The spectator list on the wire (spectatorsUpdated and snapshot v2
 * `spectators`). Pure (its one require is a constant): snapshotV2.js uses it too.
 *
 * Each entry is {username, pic, avatarUrl?}:
 *   - pic: a stock avatar number (server/avatar/stockAvatars.js), else null;
 *   - a custom picture is never inline here: pic is null and `avatarUrl`
 *     (GET /avatar/<name>?v=) is present once its rendition exists
 *     (docs/avatars.md). Only clients that read this list (web since the
 *     badge) see it, and every one of them is avatarUrl-capable; a custom
 *     picture without a rendition yet shows the default avatar.
 * At most SPECTATOR_LIST_MAX entries; `count` is always the true total.
 */

'use strict';

const { isStockPic: isStock } = require('../avatar/stockAvatars');

const SPECTATOR_LIST_MAX = 50;

const isCustom = (p) => typeof p === 'string' && p.startsWith('data:image');

/**
 * @param {Array<{username, pic}>} list - GameState.spectatorList()
 * @param {Function|null} resolve - (pic, username) -> {legacy, url}
 *   (avatarWire.seatResolve for the game); null: no URLs
 * @returns {{spectators: Object[], count: number}}
 */
function spectatorsWire(list, resolve = null) {
    const spectators = list.slice(0, SPECTATOR_LIST_MAX).map(({ username, pic }) => {
        const entry = { username, pic: isStock(pic) ? pic : null };
        if (isCustom(pic) && resolve) {
            const r = resolve(pic, username);
            if (r && r.url) entry.avatarUrl = r.url;
        }
        return entry;
    });
    return { spectators, count: list.length };
}

module.exports = { spectatorsWire, SPECTATOR_LIST_MAX };

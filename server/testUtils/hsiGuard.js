/**
 * Jest setupFilesAfterEnv hook: no socket ever receives another seat's HSI
 * (hand strength; owner 2026-11-21). Checked on every emit recorded through
 * a gameDriver makeIo / makeSocket log (contractCheck.onEmit), so every
 * suite that drives the real handlers is covered: each deal's and redeal's
 * gameStart, rejoinSuccess, restorePlayerState, stateSnapshot,
 * actionRejected, the spectator full state, lazy watchers and the restored
 * tables of the deploy-survival tests.
 *
 * Per emit:
 *   1. shape: a gameStart's `hsiValues` holds at most its own `position`'s
 *      key (none for a spectator gameStart) and a snapshot's `hsi` has a
 *      number at most at `viewer.position`, and only for a seat owner
 *      (role seat / lazyWatcher);
 *   2. recipient: when the payload's game is live in gameManager, a private
 *      emit's HSI belongs to the seat the receiving socket owns at that
 *      moment, with that seat's value; a room emit ('game:' / 'tournament:'
 *      / '*') carries no HSI at all;
 *   3. values: no non-integer number in the payload (anywhere, any key)
 *      equals the current HSI of a seat the receiver does not own (gameEnd,
 *      whose end-of-game stats are public, excepted).
 *
 *   hsiGuard.skip(reason)  this test only (none today)
 *   BAB_HSI_GUARD=0        turns the check off for a run
 */

'use strict';

const contractCheck = require('./contractCheck');

let violations = [];
let skipped = null;
const MAX = 20;

const enabled = () => process.env.BAB_HSI_GUARD !== '0';
const fail = (why, entry, extra = {}) => {
    if (violations.length < MAX) violations.push({ why, event: entry.event, to: entry.to, ...extra });
};

const isRoom = (to) => to === '*' || to.startsWith('game:') || to.startsWith('tournament:') ||
    to.startsWith('lobby:') || to === 'mainRoom' || to === 'main';

function gameFor(gameId) {
    if (typeof gameId !== 'string') return null;
    try {
        const gm = require('../game/GameManager');
        return gm.getGame ? gm.getGame(gameId) : gm.games?.get(gameId) || null;
    } catch {
        return null;
    }
}

/** Every {pos, value} the payload's HSI fields name (number values only), and the snapshot(s) found. */
function hsiFields(event, wire) {
    const found = [];
    const snaps = [];
    const walk = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 6) return;
        if (Array.isArray(o)) {
            for (const v of o) walk(v, depth + 1);
            return;
        }
        if (o.v === 2 && o.viewer && 'hsi' in o) snaps.push(o);
        for (const [k, v] of Object.entries(o)) {
            if (k === 'hsiValues' && v && typeof v === 'object' && !Array.isArray(v)) {
                for (const [p, x] of Object.entries(v)) if (typeof x === 'number') found.push({ pos: Number(p), value: x, field: 'hsiValues', holder: o });
            } else if (k === 'hsi' && Array.isArray(v)) {
                v.forEach((x, i) => { if (typeof x === 'number') found.push({ pos: i + 1, value: x, field: 'hsi', holder: o }); });
            } else {
                walk(v, depth + 1);
            }
        }
    };
    walk(wire, 0);
    return { found, snaps };
}

function numbers(o, out = [], depth = 0) {
    if (typeof o === 'number') out.push(o);
    else if (o && typeof o === 'object' && depth < 12) for (const v of Object.values(o)) numbers(v, out, depth + 1);
    return out;
}

function checkEntry(entry, wire) {
    if (!enabled() || wire == null || typeof wire !== 'object') return;
    const to = String(entry.to);
    const room = isRoom(to);
    const sid = room ? null : (to.startsWith('self:') ? to.slice(5) : to);
    const { found, snaps } = hsiFields(entry.event, wire);

    // 1. shape
    for (const f of found) {
        if (f.field === 'hsiValues') {
            const own = entry.event === 'gameStart' && f.holder === wire ? wire.position : f.holder.position;
            if (own == null || f.pos !== Number(own)) fail('hsiValues names a seat other than the payload\'s own position', entry, { pos: f.pos, own });
        } else {
            const viewer = f.holder.viewer;
            if (!viewer || !['seat', 'lazyWatcher'].includes(viewer.role)) fail('snapshot hsi given to a viewer who owns no seat', entry, { pos: f.pos, role: viewer?.role });
            else if (f.pos !== viewer.position) fail('snapshot hsi names a seat other than the viewer\'s', entry, { pos: f.pos, own: viewer.position });
        }
    }
    if (room && found.length > 0) fail('HSI in a room emit', entry, { positions: found.map((f) => f.pos) });

    // 2 + 3 need the live game
    const gameId = (typeof wire.gameId === 'string' && wire.gameId) || snaps[0]?.gameId ||
        (to.startsWith('game:') ? to.slice(5) : null);
    const game = gameFor(gameId);
    if (!game || !game.hsiValues) return;
    const ownPos = sid != null && typeof game.seatByOwnerSocket === 'function' ? game.seatByOwnerSocket(sid) : null;
    for (const f of found) {
        if (room) continue;
        if (f.pos !== ownPos) fail('HSI of a seat the receiver does not own', entry, { pos: f.pos, ownPos, sid });
        else if (game.hsiValues[f.pos] !== f.value) fail('own HSI differs from the game\'s', entry, { pos: f.pos, sent: f.value, game: game.hsiValues[f.pos] });
    }
    if (entry.event === 'gameEnd') return;
    const others = new Map();
    for (const [p, v] of Object.entries(game.hsiValues)) {
        if (Number(p) === ownPos || typeof v !== 'number' || Number.isInteger(v)) continue;
        if (ownPos != null && v === game.hsiValues[ownPos]) continue;
        others.set(v, Number(p));
    }
    if (others.size === 0) return;
    for (const n of numbers(wire)) {
        if (others.has(n)) {
            fail('another seat\'s HSI value appears in the payload', entry, { pos: others.get(n), ownPos, sid });
            break;
        }
    }
}

contractCheck.onEmit((entry, wire) => {
    try {
        checkEntry(entry, wire);
    } catch (err) {
        if (violations.length < MAX) violations.push({ why: `hsiGuard threw: ${err.message}`, event: entry?.event });
    }
});

function skip(reason) {
    if (!reason) throw new Error('hsiGuard.skip needs a reason');
    skipped = reason;
}

afterEach(() => {
    const v = violations;
    violations = [];
    const why = skipped;
    skipped = null;
    if (why || v.length === 0) return;
    let name = '';
    try {
        name = expect.getState().currentTestName || '';
    } catch {
        // outside a test
    }
    throw new Error(`HSI leak (${v.length}) in "${name}": a socket received another seat's hand strength\n` +
        v.slice(0, 5).map((x) => JSON.stringify(x)).join('\n'));
});

module.exports = { skip, checkEntry, _take: () => { const v = violations; violations = []; return v; } };

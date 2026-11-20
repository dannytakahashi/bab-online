/**
 * Records superlatives (owner-approved 2026-11-20): per period and stats
 * scope, six titles, each won by the human player with the best value
 * among players with at least SUPERLATIVE_MIN_GAMES games in the period.
 * Pure: profileHandlers.fillRecords feeds it the same gameRecords
 * documents (same finds, scope filter and projection) as the team records,
 * one `add(record)` per document inside its loop, then `result()`.
 *
 * Wire: recordsResponse.records.<period>.superlatives =
 *   [{ id, title, names: [string], detail }]
 * in TITLES order, a title nobody qualifies for left out. Both clients
 * render the entries generically (title, names joined with ", ", detail),
 * so a new title needs no client release.
 *
 * Which records count: only those whose seats can be named, i.e. with
 * per-seat counters (`statsDeltas.byPosition`, written since 2026-11-15):
 *   - `statsDeltas.names {<pos>: username}` (written since 2026-11-20,
 *     kept in step by the account rename / merge / delete code), else
 *   - a read-time reconstruction, only when unambiguous: per team, the
 *     byPosition seats of that team in seat order against the record's
 *     teamNPlayers (human owners in seat order) with equal counts;
 *     any other record is skipped whole.
 * A player's games are the records they are named in (once per record).
 * Never a winner: '[deleted]', a non-string or empty name, or a name the
 * record also lists as a bot persona (teamNBots). Bots have no
 * byPosition seat, so they never get a value anyway.
 *
 * The titles (value per player, over their counted games):
 *   bagBoy          bags / games. A bag is a trick over the seat's own bid
 *                   in a hand (a bore never bags): byPosition.totalBags
 *                   (since 2026-11-20), else, for an older record,
 *                   max(0, totalTricksTaken - totalTricksBid) of that seat
 *   luckyDuck       highest sum totalHSI / sum totalHands
 *   cursed          lowest sum totalHSI / sum totalHands
 *   botFriends      solo games: exactly one human seat and three native bot
 *                   seats (teamNPlayers 1 name, teamNBots 3; a resign bot
 *                   keeps its owner in teamNPlayers, lazy bots too). Only
 *                   bot-game records carry teamNBots, so it never appears
 *                   in the human scope
 *   helpFromFriends counted /help uses (statsDeltas.assist[pos].help: only
 *                   what the player asked for; the tutorial's own advice is
 *                   counted in `tips`, never here, and /help while the
 *                   tutorial is on is not counted: assistHandlers.help)
 *   anchor          sum totalSets / sum totalHands: totalSets is TEAM
 *                   based (seatStatsDelta: handStats.teamNSets, the hands
 *                   the player's own team took fewer tricks than its bid),
 *                   so this is the share of their hands their team was set
 * Count-like titles (bagBoy, botFriends, helpFromFriends, anchor) are left
 * out when the best value is 0; the HSI titles need totalHands > 0.
 * Ties: up to MAX_NAMES names, alphabetical (case-insensitive); more tied
 * players add " (+N more)" to the detail.
 */

'use strict';

const SUPERLATIVE_MIN_GAMES = 5;
const MAX_NAMES = 3;
const DELETED_NAME = '[deleted]';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * {pos: name} for a record's human seats, or null when the record has no
 * per-seat counters or its seats cannot be named unambiguously.
 */
function seatNames(record) {
    const sd = record && record.statsDeltas;
    if (!isPlainObject(sd) || !isPlainObject(sd.byPosition)) return null;
    const positions = Object.keys(sd.byPosition)
        .filter((k) => /^[1-4]$/.test(k) && isPlainObject(sd.byPosition[k]))
        .map(Number)
        .sort((a, b) => a - b);
    if (positions.length === 0) return null;

    const out = {};
    if (isPlainObject(sd.names)) {
        for (const pos of positions) {
            const name = sd.names[pos];
            if (typeof name !== 'string') return null; // a seat without a name: not ours to guess
            out[pos] = name;
        }
        return out;
    }
    // Older record (2026-11-15 .. 2026-11-20): seat order against teamNPlayers
    for (const n of [1, 2]) {
        const seats = positions.filter((pos) => (pos % 2 === 1 ? 1 : 2) === n);
        const players = record[`team${n}Players`];
        if (!Array.isArray(players) || players.length !== seats.length) return null;
        seats.forEach((pos, i) => { out[pos] = players[i]; });
    }
    return out;
}

/** Native bot personas a record lists (bot-game records only). */
function botNames(record) {
    const bots = [];
    for (const n of [1, 2]) {
        const list = record[`team${n}Bots`];
        if (Array.isArray(list)) for (const b of list) if (typeof b === 'string' && b.length > 0) bots.push(b);
    }
    return bots;
}

/** A solo game: one human seat and three native bot seats. */
function isSolo(record) {
    const humans = [1, 2].reduce((sum, n) => {
        const list = record[`team${n}Players`];
        return sum + (Array.isArray(list) ? list.length : 0);
    }, 0);
    return humans === 1 && botNames(record).length === 3;
}

/** A seat's bags in one game: the per-hand counter, else the legacy net fallback. */
function seatBags(delta) {
    if (delta.totalBags !== undefined && Number.isFinite(Number(delta.totalBags))) return Math.max(0, Number(delta.totalBags));
    return Math.max(0, num(delta.totalTricksTaken) - num(delta.totalTricksBid));
}

const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

/**
 * The titles, in wire order. `value(p)` is the player's value or null (no
 * value: not a candidate); `best` 'max' | 'min'; `zeroOmits` leaves the
 * title out when the best value is 0.
 */
const TITLES = Object.freeze([
    {
        id: 'bagBoy', title: 'Bag Boy', best: 'max', zeroOmits: true,
        value: (p) => p.bags / p.games,
        detail: (v) => `${fmt1(v)} bags a game`
    },
    {
        id: 'luckyDuck', title: 'Lucky Duck', best: 'max', zeroOmits: false,
        value: (p) => (p.hands > 0 ? p.hsi / p.hands : null),
        detail: (v) => `${fmt1(v)} avg HSI`
    },
    {
        id: 'cursed', title: 'Cursed', best: 'min', zeroOmits: false,
        value: (p) => (p.hands > 0 ? p.hsi / p.hands : null),
        detail: (v) => `${fmt1(v)} avg HSI`
    },
    {
        id: 'botFriends', title: 'Some of my best friends are bots', best: 'max', zeroOmits: true,
        value: (p) => p.solo,
        detail: (v) => `${v} solo ${plural(v, 'game', 'games')}`
    },
    {
        id: 'helpFromFriends', title: 'A little help from my friends', best: 'max', zeroOmits: true,
        value: (p) => p.help,
        detail: (v) => `${v} /help ${plural(v, 'use', 'uses')}`
    },
    {
        id: 'anchor', title: 'Anchor', best: 'max', zeroOmits: true,
        value: (p) => (p.hands > 0 ? p.sets / p.hands : null),
        detail: (v) => `${Math.round(v * 100)}% of hands set`
    }
]);

/** Equal for a title: ratios within a relative 1e-9 (sums of integers, mostly). */
function same(a, b) {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function byName(a, b) {
    const ci = a.localeCompare(b, 'en', { sensitivity: 'base' });
    if (ci !== 0) return ci;
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * An accumulator for one period: `add(record)` per gameRecords document,
 * then `result()` (the superlatives array).
 * @param {{minGames?: number}} [opts]
 */
function createSuperlatives({ minGames = SUPERLATIVE_MIN_GAMES } = {}) {
    const players = new Map();
    const player = (name) => {
        let p = players.get(name);
        if (!p) {
            p = { name, games: 0, bags: 0, hsi: 0, hands: 0, sets: 0, solo: 0, help: 0 };
            players.set(name, p);
        }
        return p;
    };

    function add(record) {
        if (!record) return;
        const names = seatNames(record);
        if (!names) return;
        const sd = record.statsDeltas;
        const bots = new Set(botNames(record));
        const solo = isSolo(record);
        const seen = new Set();
        for (const [posKey, name] of Object.entries(names)) {
            if (typeof name !== 'string' || name.length === 0 || name === DELETED_NAME || bots.has(name)) continue;
            const delta = sd.byPosition[posKey];
            const p = player(name);
            // Once per record (a merge can leave one player in two seats)
            if (!seen.has(name)) {
                seen.add(name);
                p.games++;
                if (solo) p.solo++;
            }
            p.bags += seatBags(delta);
            p.hsi += num(delta.totalHSI);
            p.hands += num(delta.totalHands);
            p.sets += num(delta.totalSets);
            const assist = isPlainObject(sd.assist) ? sd.assist[posKey] : null;
            if (isPlainObject(assist) && Number.isSafeInteger(assist.help) && assist.help > 0) p.help += assist.help;
        }
    }

    function result() {
        const eligible = [...players.values()].filter((p) => p.games >= minGames);
        const out = [];
        for (const t of TITLES) {
            let bestValue = null;
            let winners = [];
            for (const p of eligible) {
                const v = t.value(p);
                if (v === null || !Number.isFinite(v)) continue;
                if (bestValue === null || (!same(v, bestValue) && (t.best === 'max' ? v > bestValue : v < bestValue))) {
                    bestValue = v;
                    winners = [p.name];
                } else if (same(v, bestValue)) {
                    winners.push(p.name);
                }
            }
            if (bestValue === null) continue;
            if (t.zeroOmits && same(bestValue, 0)) continue;
            winners.sort(byName);
            const more = winners.length - MAX_NAMES;
            const detail = t.detail(bestValue) + (more > 0 ? ` (+${more} more)` : '');
            out.push({ id: t.id, title: t.title, names: winners.slice(0, MAX_NAMES), detail });
        }
        return out;
    }

    return { add, result };
}

/** The superlatives of one period's records (the same as add() each, then result()). */
function computeSuperlatives(records, opts) {
    const acc = createSuperlatives(opts);
    for (const r of records || []) acc.add(r);
    return acc.result();
}

module.exports = {
    SUPERLATIVE_MIN_GAMES,
    TITLE_IDS: TITLES.map((t) => t.id),
    createSuperlatives,
    computeSuperlatives,
    seatNames,
    isSolo
};

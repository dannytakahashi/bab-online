/**
 * Records superlatives (owner-approved 2026-11-20): per period and stats
 * scope, seven titles, each won by the human player with the best value
 * among the players eligible for it (below).
 * Pure: profileHandlers.fillRecords feeds it the same gameRecords
 * documents (same finds, scope filter and projection) as the team records,
 * one `add(record)` per document inside its loop, then `result()`.
 *
 * Who is eligible (owner 2026-11-24, after a player's All Time Delusions of
 * Grandeur showed 30%+ against a much lower leaderboard Set %: per-seat
 * counters exist only for games ended after 2026-11-15, and old games used
 * to make up the 5):
 *   - game-level titles (botFriends): SUPERLATIVE_MIN_GAMES games of the
 *     period, every record that names the player;
 *   - per-seat titles (bagBoy, luckyDuck, cursed, helpFromFriends,
 *     delusionsOfGrandeur): SUPERLATIVE_MIN_GAMES games WITH per-seat
 *     counters naming the player at a seat (`statGames`, once per record:
 *     a merge that left one player in two seats of a game counts it once;
 *     the values still add every seat);
 *   - myQuantitative: SUPERLATIVE_MIN_GAMES games whose spot-on counter
 *     (statsDeltas.exact) covers one of the player's seats with hands > 0
 *     (`spotGames`, once per record): the games its value is drawn from.
 *   - ALL TIME only, the `account` titles (luckyDuck, cursed,
 *     delusionsOfGrandeur: their data is in the account totals too) come
 *     from `accounts` instead: the scope's stats bucket of every account
 *     (users.stats for human, botStats for bots, both summed for all,
 *     exactly the leaderboard's and the profile's; never a merged-away or
 *     deleted account's tombstone), eligible with SUPERLATIVE_MIN_GAMES
 *     gamesPlayed in that scope, so All Time's numbers ARE the leaderboard's
 *     (Set % = totalSets / totalHands, avg HSI = totalHSI / totalHands).
 *     The other titles' data is only in gameRecords: they stay from records.
 *     Without `accounts` (the users read failed) they fall back to records.
 *
 * Wire: recordsResponse.records.<period>.superlatives =
 *   [{ id, title, names: [string], detail }]
 * in TITLES order, a title nobody qualifies for left out. Both clients
 * render the entries generically (title, names joined with ", ", detail),
 * so a new title needs no client release.
 *
 * Which records count, for whom:
 *   - games (the game-level threshold) and solo games: every
 *     record of the period, once per record per human it names (a merge
 *     can leave one player in two seats). The seat names when the record
 *     has them (below), else its teamNPlayers: a record from before the
 *     per-seat counters (2026-11-15) still names who played, so it counts
 *     as a game (and a solo game) without per-seat values;
 *   - the per-seat values (bags, HSI, sets, /help): only records with
 *     per-seat counters (`statsDeltas.byPosition`, since 2026-11-15) whose
 *     seats can be named: `statsDeltas.names {<pos>: username}` (since
 *     2026-11-20, kept in step by this release's account rename / merge /
 *     delete code), only while it agrees with teamNPlayers: every seat's
 *     name is in its team's array (odd seats team1Players, even seats
 *     team2Players, as often as the seats name it). The release before
 *     (a rollback, or the old process during a deploy) rewrites only
 *     teamNPlayers, so a names map it left stale (a deleted player's real
 *     name, a name before a rename or merge) is ignored for that record.
 *     Then, or for a record without names, a read-time reconstruction,
 *     only when unambiguous: per team, the byPosition seats of that team
 *     in seat order against the record's teamNPlayers (human owners in
 *     seat order) with equal counts. A record with per-seat counters that
 *     cannot be named that way is skipped whole (not even a game).
 * Never a winner: '[deleted]', a non-string or empty name, or a name the
 * record also lists as a bot persona (teamNBots). Bots have no
 * byPosition seat, so they never get a value anyway.
 *
 * The titles (value per player, over their counted games):
 *   bagBoy          bags per seat-game (each named seat of a record is one
 *                   seat-game, so a merged player in two seats averages
 *                   them). A bag is a trick over the seat's own bid in a
 *                   hand; a hand in which either seat of the team bid a
 *                   bore has none (the team's contract was the whole hand,
 *                   rules.seatBags): `statsDeltas.bags[pos]` (since
 *                   2026-11-20, only for a game whose counter saw every
 *                   hand: profileHandlers.buildGameEndRecord), else
 *                   max(0, totalTricksTaken - totalTricksBid) of that seat
 *   luckyDuck       highest sum totalHSI / sum totalHands (the leaderboard's
 *                   avg HSI; All Time: from the accounts)
 *   cursed          lowest sum totalHSI / sum totalHands; left out when it
 *                   equals Lucky Duck's (one qualifier, or all tied: the
 *                   same people would be both lucky and cursed)
 *   botFriends      solo games: exactly one human seat and three native bot
 *                   seats (teamNPlayers 1 name, teamNBots 3; a resign bot
 *                   keeps its owner in teamNPlayers, lazy bots too). Only
 *                   bot-game records carry teamNBots, so it never appears
 *                   in the human scope
 *   helpFromFriends counted /help uses (statsDeltas.assist[pos].help: only
 *                   what the player asked for; the tutorial's own advice is
 *                   counted in `tips`, never here, and /help while the
 *                   tutorial is on is not counted: assistHandlers.help)
 *   myQuantitative  spot-on bids per hand (owner 2026-11-20): sum
 *                   statsDeltas.exact[pos] / sum of that seat's totalHands,
 *                   over records that carry the counter only (games ended
 *                   after it shipped; rules.seatSpotOn: own tricks equal a
 *                   numeric bid, or a bore team that took every trick)
 *   delusionsOfGrandeur (was Anchor; renamed 2026-11-20, owner: "stupidly optimistic")
 *                   sum totalSets / sum totalHands: totalSets is TEAM
 *                   based (seatStatsDelta: handStats.teamNSets, the hands
 *                   the player's own team took fewer tricks than its bid),
 *                   so this is the share of their hands their team was set:
 *                   the leaderboard's Set % (All Time: from the accounts),
 *                   printed as it is (one decimal: "28.6% of hands set")
 * Count-like titles (bagBoy, botFriends, helpFromFriends, myQuantitative,
 * delusionsOfGrandeur) are left out when the best value SHOWS as 0 ("0.0
 * bags a game", "0.0% of hands set"); the per-seat titles need per-seat data
 * (seat-games / hands > 0), the account titles totalHands > 0.
 * Ties: up to MAX_NAMES names, alphabetical (case-insensitive); more tied
 * players add " (+N more)" to the detail. The same for an account title.
 */

'use strict';

const SUPERLATIVE_MIN_GAMES = 5;
const MAX_NAMES = 3;
const DELETED_NAME = '[deleted]';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (n, one, many) => (n === 1 ? one : many);

/** The stats bucket fields accountTotals() reads (fillRecords projects `<bucket>.<field>`). */
const ACCOUNT_FIELDS = Object.freeze(['gamesPlayed', 'totalHands', 'totalSets', 'totalHSI']);

/** The fields add() reads, as a find projection (profileHandlers.fillRecords). */
const SEAT_FIELDS = ['totalTricksTaken', 'totalTricksBid', 'totalHSI', 'totalHands', 'totalSets'];
const SUPERLATIVES_PROJECTION = Object.freeze({
    ...Object.fromEntries([1, 2, 3, 4].flatMap((pos) => SEAT_FIELDS.map((f) => [`statsDeltas.byPosition.${pos}.${f}`, 1]))),
    'statsDeltas.bags': 1,
    'statsDeltas.exact': 1,
    'statsDeltas.names': 1,
    'statsDeltas.assist': 1
});

/** The record's byPosition seats ('1'..'4' with an object), in seat order. */
function seatPositions(record) {
    const sd = record && record.statsDeltas;
    if (!isPlainObject(sd) || !isPlainObject(sd.byPosition)) return [];
    return Object.keys(sd.byPosition)
        .filter((k) => /^[1-4]$/.test(k) && isPlainObject(sd.byPosition[k]))
        .map(Number)
        .sort((a, b) => a - b);
}

/** The seat's team (odd seats team 1, even seats team 2: buildGameRecord). */
const teamOf = (pos) => (pos % 2 === 1 ? 1 : 2);

/**
 * Every seat's name is a string its team's teamNPlayers lists, as often as
 * that team's seats name it (a merge can put one player in two seats).
 */
function namesMatchTeams(record, positions, named) {
    for (const n of [1, 2]) {
        const players = record[`team${n}Players`];
        if (!Array.isArray(players)) return false;
        const left = new Map();
        for (const name of players) left.set(name, (left.get(name) || 0) + 1);
        for (const pos of positions.filter((p) => teamOf(p) === n)) {
            const name = named[pos];
            const count = left.get(name) || 0;
            if (typeof name !== 'string' || count === 0) return false;
            left.set(name, count - 1);
        }
    }
    return true;
}

/**
 * {pos: name} for a record's human seats, or null when the record has no
 * per-seat counters or its seats cannot be named unambiguously.
 */
function seatNames(record) {
    const positions = seatPositions(record);
    if (positions.length === 0) return null;
    const sd = record.statsDeltas;

    if (isPlainObject(sd.names)) {
        const named = {};
        for (const pos of positions) named[pos] = sd.names[pos];
        if (namesMatchTeams(record, positions, named)) return named;
        // Stale (rewritten in teamNPlayers only) or incomplete: not trusted
    }
    // Seat order against teamNPlayers: an older record (2026-11-15 ..
    // 2026-11-20), or one whose names map disagrees with it
    const out = {};
    for (const n of [1, 2]) {
        const seats = positions.filter((pos) => teamOf(pos) === n);
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

/** The record's human names (teamNPlayers), as stored. */
function teamPlayers(record) {
    const out = [];
    for (const n of [1, 2]) {
        const list = record[`team${n}Players`];
        if (Array.isArray(list)) out.push(...list);
    }
    return out;
}

/** A solo game: one human seat and three native bot seats. */
function isSolo(record) {
    return teamPlayers(record).length === 1 && botNames(record).length === 3;
}

/**
 * A seat's bags in one game: the per-hand counter (statsDeltas.bags, only
 * present for a game that counted it from hand 1), else the legacy net
 * fallback of that seat.
 */
function seatBags(sd, posKey) {
    const counted = isPlainObject(sd.bags) ? sd.bags[posKey] : undefined;
    if (typeof counted === 'number' && Number.isFinite(counted)) return Math.max(0, counted);
    const delta = sd.byPosition[posKey];
    return Math.max(0, num(delta.totalTricksTaken) - num(delta.totalTricksBid));
}

const round1 = (v) => Math.round(v * 10) / 10;
const fmt1 = (v) => round1(v).toFixed(1);
const pct = (v) => Math.round(v * 100);
// A share as the leaderboard and profiles print Set % (one decimal,
// `(sets / hands * 100).toFixed(1)`: LeaderboardPage formatStatValue,
// ProfilePage, PlayerProfile.swift), so the two screens read the same.
const pct1 = (v) => (v * 100).toFixed(1);

/**
 * The titles, in wire order. `value(p)` is the player's value or null (no
 * value: not a candidate); `best` 'max' | 'min'; `zeroOmits` leaves the
 * title out when the best value shows as 0 (`shown(v)`, the number the
 * detail prints); `notSameAs` leaves it out when that earlier title's best
 * value is the same. `basis` is who is eligible from the records (ELIGIBLE);
 * `account` marks a title the account totals carry (users.stats /
 * botStats): with `accounts` (All Time) it comes from them instead.
 */
const TITLES = Object.freeze([
    {
        id: 'bagBoy', title: 'Bag Boy', best: 'max', zeroOmits: true, basis: 'seat',
        value: (p) => (p.seatGames > 0 ? p.bags / p.seatGames : null),
        shown: round1,
        detail: (v) => `${fmt1(v)} bags a game`
    },
    {
        id: 'luckyDuck', title: 'Lucky Duck', best: 'max', zeroOmits: false, basis: 'seat', account: true,
        value: (p) => (p.hands > 0 ? p.hsi / p.hands : null),
        detail: (v) => `${fmt1(v)} avg HSI`
    },
    {
        id: 'cursed', title: 'Cursed', best: 'min', zeroOmits: false, notSameAs: 'luckyDuck', basis: 'seat', account: true,
        value: (p) => (p.hands > 0 ? p.hsi / p.hands : null),
        detail: (v) => `${fmt1(v)} avg HSI`
    },
    {
        id: 'botFriends', title: 'Some of my best friends are bots', best: 'max', zeroOmits: true, basis: 'game',
        value: (p) => p.solo,
        shown: (v) => v,
        detail: (v) => `${v} solo ${plural(v, 'game', 'games')}`
    },
    {
        id: 'helpFromFriends', title: 'A little help from my friends', best: 'max', zeroOmits: true, basis: 'seat',
        value: (p) => p.help,
        shown: (v) => v,
        detail: (v) => `${v} /help ${plural(v, 'use', 'uses')}`
    },
    {
        id: 'myQuantitative', title: 'My Quantitative', best: 'max', zeroOmits: true, basis: 'spot',
        value: (p) => (p.spotHands > 0 ? p.spotOn / p.spotHands : null),
        shown: pct,
        detail: (v) => `${pct(v)}% of bids spot on`
    },
    {
        id: 'delusionsOfGrandeur', title: 'Delusions of Grandeur', best: 'max', zeroOmits: true, basis: 'seat', account: true,
        value: (p) => (p.hands > 0 ? p.sets / p.hands : null),
        shown: (v) => Number(pct1(v)),
        detail: (v) => `${pct1(v)}% of hands set`
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
 * Who is eligible for a title from the records, by its `basis`:
 *   game  games of the period (every record naming the player);
 *   seat  games with per-seat counters naming the player at a seat
 *         (`statGames`: once per record, so a merge that left one player in
 *         two seats of a game counts that game once);
 *   spot  games whose spot-on counter covers one of the player's seats
 *         (`spotGames`, once per record): My Quantitative's own hands.
 */
const ELIGIBLE = Object.freeze({
    game: (p, minGames) => p.games >= minGames,
    seat: (p, minGames) => p.statGames >= minGames,
    spot: (p, minGames) => p.spotGames >= minGames
});

/** A name that can win: a non-empty string, never '[deleted]'. */
const winnable = (name) => typeof name === 'string' && name.length > 0 && name !== DELETED_NAME;

/**
 * One account's totals for the `account` titles, from the scope's stats
 * bucket exactly as the leaderboard reads it ({gamesPlayed, totalHands,
 * totalSets, totalHSI}, missing = 0), or null for a name that cannot win.
 */
function accountTotals(name, bucket) {
    if (!winnable(name)) return null;
    const b = isPlainObject(bucket) ? bucket : {};
    return { name, games: num(b.gamesPlayed), hands: num(b.totalHands), sets: num(b.totalSets), hsi: num(b.totalHSI) };
}

/**
 * An accumulator for one period: `add(record)` per gameRecords document,
 * then `result()` (the superlatives array).
 *
 * `accounts` (All Time only: profileHandlers.fillRecords): the scope's
 * accounts as accountTotals() gives them (never a merged-away or deleted
 * account's tombstone). The `account` titles then come from these totals,
 * the leaderboard's numbers (Set % = totalSets / totalHands, avg HSI =
 * totalHSI / totalHands), among accounts with at least `minGames`
 * gamesPlayed in the scope; the other titles still from the records.
 * @param {{minGames?: number, accounts?: Array<Object|null>|null}} [opts]
 */
function createSuperlatives({ minGames = SUPERLATIVE_MIN_GAMES, accounts = null } = {}) {
    const players = new Map();
    const player = (name) => {
        let p = players.get(name);
        if (!p) {
            p = { name, games: 0, statGames: 0, spotGames: 0, seatGames: 0, bags: 0, hsi: 0, hands: 0, sets: 0, solo: 0, help: 0, spotOn: 0, spotHands: 0 };
            players.set(name, p);
        }
        return p;
    };

    function add(record) {
        if (!record) return;
        const hasSeats = seatPositions(record).length > 0;
        const names = hasSeats ? seatNames(record) : null;
        if (hasSeats && !names) return; // per-seat counters we cannot name: skipped whole
        const bots = new Set(botNames(record));
        const human = (name) => winnable(name) && !bots.has(name);

        // Games and solo games: once per record per player (a merge can
        // leave one player in two seats)
        const solo = isSolo(record);
        for (const name of new Set((names ? Object.values(names) : teamPlayers(record)).filter(human))) {
            const p = player(name);
            p.games++;
            if (solo) p.solo++;
        }
        if (!names) return; // no per-seat counters (before 2026-11-15)

        // Per-seat values: every named seat is one seat-game; the record is
        // one game with per-seat data (and maybe spot-on data) per player
        const sd = record.statsDeltas;
        const seated = new Set();
        const spotted = new Set();
        for (const [posKey, name] of Object.entries(names)) {
            if (!human(name)) continue;
            const delta = sd.byPosition[posKey];
            const p = player(name);
            seated.add(p);
            p.seatGames++;
            p.bags += seatBags(sd, posKey);
            p.hsi += num(delta.totalHSI);
            p.hands += num(delta.totalHands);
            p.sets += num(delta.totalSets);
            // My Quantitative: only records with the spot-on counter (games
            // that ended after it shipped and counted every hand)
            const spot = isPlainObject(sd.exact) ? sd.exact[posKey] : undefined;
            if (Number.isSafeInteger(spot) && spot >= 0 && num(delta.totalHands) > 0) {
                p.spotOn += Math.min(spot, num(delta.totalHands));
                p.spotHands += num(delta.totalHands);
                spotted.add(p);
            }
            const assist = isPlainObject(sd.assist) ? sd.assist[posKey] : null;
            if (isPlainObject(assist) && Number.isSafeInteger(assist.help) && assist.help > 0) p.help += assist.help;
        }
        for (const p of seated) p.statGames++;
        for (const p of spotted) p.spotGames++;
    }

    function result() {
        const fromRecords = [...players.values()];
        let fromAccounts = null;
        if (Array.isArray(accounts)) {
            // One entry per name (a legacy duplicate document: the first)
            const byAccount = new Map();
            for (const a of accounts) {
                if (a && winnable(a.name) && a.games >= minGames && !byAccount.has(a.name)) byAccount.set(a.name, a);
            }
            fromAccounts = [...byAccount.values()];
        }
        const out = [];
        const bests = {};
        for (const t of TITLES) {
            const pool = t.account && fromAccounts
                ? fromAccounts
                : fromRecords.filter((p) => ELIGIBLE[t.basis](p, minGames));
            let bestValue = null;
            let winners = [];
            for (const p of pool) {
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
            bests[t.id] = bestValue;
            if (t.zeroOmits && t.shown(bestValue) === 0) continue;
            if (t.notSameAs && bests[t.notSameAs] !== undefined && same(bests[t.notSameAs], bestValue)) continue;
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
    SUPERLATIVES_PROJECTION,
    ACCOUNT_FIELDS,
    TITLE_IDS: TITLES.map((t) => t.id),
    ACCOUNT_TITLE_IDS: TITLES.filter((t) => t.account).map((t) => t.id),
    accountTotals,
    createSuperlatives,
    computeSuperlatives,
    seatNames,
    isSolo
};

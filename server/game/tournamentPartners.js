/**
 * Tournament partner rotation (owner 2026-11-24: "ideally you don't play
 * with the same partner again during the tournament; if you must, it
 * shouldn't be in a row").
 *
 * A round's tables and teams are planned here, from the members playing
 * the round and the partnerships of the rounds before (TournamentState
 * partnerHistory). Partners are seats 1&3 and 2&4; only a HUMAN partner
 * counts (a bot partner is never a repeat). The table shapes stay those of
 * TournamentState.distributePlayersIntoGames (table balance unchanged): a
 * 4-human table is two human pairs, a 3-human table one human pair and one
 * human with a bot partner, a 2-human table two humans each with a bot
 * partner (they face each other, so they are never partners), a 1-human
 * table one human with bots.
 *
 * So a round is a choice of which members are paired with a bot (the
 * "singles", a number fixed by the shapes) and a matching of the rest,
 * at the least cost, lexicographically:
 *   1. members partnered with the partner of the last round they played
 *      (a member who sat a round out still has the partner of the round
 *      before it as their last one; a bot partner leaves none), counted
 *      per member: a pair who are each other's last partner (in a row for
 *      both) costs two, a reunion after one of them sat out (in a row for
 *      that one only) one;
 *   2. then the number of times each pair was partners before (a third
 *      partnership costs more than a second).
 * Ties are broken at random. Exact by branch and bound, which stops at the
 * first cost-0 plan; past NODE_BUDGET nodes the best plan found is used
 * (only reachable for large rounds, where a cost-0 plan always exists: with
 * at most 3 earlier partners each, 8 or more members always have one, and
 * the first descent, which tries the cheapest partners first, finds it).
 * The round is planned greedily, one round at a time (who plays the next
 * round is not known yet); tournamentPartners.test.js checks that for
 * small fields this is as good as the best whole-tournament plan.
 *
 * The teams are shown openly (owner 2026-11-25): each round's plan goes out
 * as `pairings` on the tournament events (TournamentState.pairingsWire) and
 * as `teams` on the table's startDraw / snapshot draw. At the table
 * (GameState.drawTeams, set by socket/tournamentHandlers.createRoundTable)
 * the draw then decides only the seats and who deals first: each player
 * gets the card they picked and rules.seatPlannedTeams seats the plan (the
 * highest card's team at 1 & 3, that card at 1: it deals first). Every
 * client the upgrade gate lets in shows that draw for first deal (the
 * clientHello cap PAIRINGS_CAP: the web, iOS from build 41), so there is no
 * staged draw any more; a cached web tab from before 2026-11-25 still
 * reads its old "two highest cards are partners" copy, and the room's
 * "Partners this round" log line (gameLifecycle.beginDraw) says who is
 * partnered. The draw is a real draw on the wire (startDraw, youDrew,
 * playerDrew, teamsAnnounced, positionUpdate unchanged).
 */

'use strict';

// Lexicographic weight of a back-to-back partnership over repeats
const CONSECUTIVE = 1e6;
const NODE_BUDGET = 200000;
/**
 * The clientHello cap of a client that shows the round pairings and, at a
 * tournament table, startDraw.teams / snapshot draw.teams as a draw for
 * first deal (socket/clientInfo.js KNOWN_CAPS)
 */
const PAIRINGS_CAP = 'tournamentPairings';

const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/**
 * A partnership history with no rounds: `counts` (pairKey → times the two
 * were partners) and `last` (username → the human partner of the last
 * round they played, null for a bot partner). TournamentState
 * partnerHistory fills one with addRound, round by round.
 * @returns {{counts: Map<string, number>, last: Map<string, string|null>}}
 */
function emptyHistory() {
    return { counts: new Map(), last: new Map() };
}

/** Add one round's teams (pairs of usernames, null for a bot) to `history`. */
function addRound(history, teams) {
    for (const [a, b] of teams) {
        if (a && b) {
            const k = pairKey(a, b);
            history.counts.set(k, (history.counts.get(k) || 0) + 1);
        }
        if (a) history.last.set(a, b || null);
        if (b) history.last.set(b, a || null);
    }
    return history;
}

/**
 * How many of a and b would partner the other in a row: 0, 1 (one of them
 * sat out since, while the other played with someone else) or 2 (each
 * other's last partner, so in a row for both).
 */
function inARow(history, a, b) {
    return (history.last.get(a) === b ? 1 : 0) + (history.last.get(b) === a ? 1 : 0);
}

/** The cost of pairing a with b given `history` (0: never partners). */
function pairCost(history, a, b) {
    return inARow(history, a, b) * CONSECUTIVE + (history.counts.get(pairKey(a, b)) || 0);
}

/**
 * Cost split of a set of pairs: {consecutive (members who partner their
 * last partner again, inARow summed), repeats}.
 */
function planCost(history, pairs) {
    let consecutive = 0;
    let repeats = 0;
    for (const [a, b] of pairs) {
        consecutive += inARow(history, a, b);
        repeats += history.counts.get(pairKey(a, b)) || 0;
    }
    return { consecutive, repeats };
}

/** Table sizes (humans per table) for n players, as distributePlayersIntoGames makes them. */
function tableShapes(n) {
    const TournamentState = require('./TournamentState');
    return TournamentState.distributePlayersIntoGames(Array.from({ length: n }, (_, i) => i))
        .map((a) => a.humans.length);
}

function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/** Pairs and singles a set of table shapes needs. */
function slotsOf(shapes) {
    let pairs = 0;
    let singles = 0;
    for (const s of shapes) {
        if (s === 4) pairs += 2;
        else if (s === 3) { pairs += 1; singles += 1; }
        else singles += s;
    }
    return { pairs, singles };
}

/**
 * The cheapest choice of `pairs` pairs and `singles` singles over
 * `players` (exactly 2 * pairs + singles of them).
 * @returns {{pairs: Array<[string, string]>, singles: string[], cost: number, exact: boolean}}
 */
function bestMatching(players, history, nPairs, nSingles, rng = Math.random) {
    const order = shuffle([...players], rng);
    const used = new Set();
    const pairs = [];
    const singles = [];
    let best = null;
    let nodes = 0;
    let exhausted = false;

    const firstFree = () => order.find((p) => !used.has(p));

    function dfs(cost, pairsLeft, singlesLeft) {
        if (best && (cost >= best.cost || best.cost === 0)) return;
        if (++nodes > NODE_BUDGET && best) { exhausted = true; return; }
        const p = firstFree();
        if (p === undefined) {
            best = { pairs: pairs.map((x) => [...x]), singles: [...singles], cost };
            return;
        }
        const options = [];
        if (singlesLeft > 0) options.push({ q: null, c: 0 });
        if (pairsLeft > 0) {
            for (const q of order) {
                if (q !== p && !used.has(q)) options.push({ q, c: pairCost(history, p, q) });
            }
        }
        // Random among equals (order is shuffled), cheapest first
        shuffle(options, rng).sort((x, y) => x.c - y.c);
        used.add(p);
        for (const { q, c } of options) {
            if (exhausted || (best && best.cost === 0)) break;
            if (q === null) {
                singles.push(p);
                dfs(cost, pairsLeft, singlesLeft - 1);
                singles.pop();
            } else {
                used.add(q);
                pairs.push([p, q]);
                dfs(cost + c, pairsLeft - 1, singlesLeft);
                pairs.pop();
                used.delete(q);
            }
        }
        used.delete(p);
    }

    dfs(0, nPairs, nSingles);
    return { ...best, exact: !exhausted };
}

/**
 * Plan a round's tables.
 * @param {string[]} usernames - the members playing the round (any order)
 * @param {{counts: Map, last: Map}} history - from TournamentState.partnerHistory
 * @param {Function} [rng=Math.random]
 * @returns {Array<{humans: string[], botCount: number, teams: Array<[string|null, string|null]>}>}
 *   distributePlayersIntoGames's shape plus the two teams of each table
 *   (null: a bot); `humans` lists the table's members team by team
 */
function planRoundTables(usernames, history = emptyHistory(), rng = Math.random) {
    const n = usernames.length;
    if (n === 0) return [];
    const shapes = tableShapes(n);
    const { pairs: nPairs, singles: nSingles } = slotsOf(shapes);
    const m = bestMatching(usernames, history, nPairs, nSingles, rng);
    const pairs = shuffle(m.pairs.map((p) => shuffle(p, rng)), rng);
    const singles = shuffle([...m.singles], rng);
    const tables = shuffle([...shapes], rng).map((size) => {
        let teams;
        if (size === 4) teams = [pairs.pop(), pairs.pop()];
        else if (size === 3) teams = shuffle([pairs.pop(), [singles.pop(), null]], rng);
        else if (size === 2) teams = [[singles.pop(), null], [singles.pop(), null]];
        // One member with bots: nothing to plan (no random draw either, so
        // a 1-human round uses Math.random exactly as the shuffle it replaced)
        else teams = [[singles.pop(), null], [null, null]];
        const humans = teams.flat().filter(Boolean);
        return { humans, botCount: 4 - humans.length, teams };
    });
    return tables;
}

/**
 * A table's planned teams in words, plan order, never a team number
 * ("Hannah & Danny vs Clara & 🤖 Mary").
 * @param {Array<Array<{username: string}>>} teams - plannedTeamsWire
 */
function teamsText(teams) {
    return teams.map((t) => t.map((p) => p.username).join(' & ')).join(' vs ');
}

module.exports = {
    PAIRINGS_CAP,
    teamsText,
    CONSECUTIVE,
    NODE_BUDGET,
    pairKey,
    emptyHistory,
    addRound,
    inARow,
    pairCost,
    planCost,
    tableShapes,
    slotsOf,
    bestMatching,
    planRoundTables
};

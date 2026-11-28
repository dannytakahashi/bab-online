/**
 * The scorecard (owner 2026-11-27, a player's ask): the table people keep
 * with real cards, one row per completed hand in play order (12, 10, 8, ...,
 * 13). Built ONLY here, at each hand's end, from the very values that hand
 * was scored with (gameHandlers.scoreClassicHand / scoreGybHand call it
 * right after they add the points), and kept on the game
 * (`game.scorecard`, saved with it: persist/gameCodec SAVED), so every
 * reader shows the same numbers:
 *
 *   - handComplete.scorecardRow: the row just finished (clients append it)
 *   - gameStart.scorecardRows: a COUNT of the rows so far, every deal (a
 *     new client's feature flag before the first row; the rows themselves
 *     come only as handComplete.scorecardRow and in the snapshot)
 *   - snapshot v2 `scorecard`: the rows so far (a rejoin, reload, spectator)
 *   - gameEnd.scorecard: the whole game (the results' Scorecard tab)
 *   - the game's record (gameRecords.scorecard, for a later history view)
 *
 * An all-zero redeal (both teams bid 0, the base game) is never a row: no
 * hand completes, so nothing is appended; the row that hand size gets is
 * the deal that was played (its dealer, trump and bids).
 *
 * Row (contract $defs.scorecardHand), seat arrays by position - 1 (three
 * seats in Get Your Bid, four in the base game):
 *   handNo     1..13, the hand's place in the game (HAND_PROGRESSION + 1)
 *   handSize   1..13 (the "12" of the Hand column)
 *   trump      the turned card ({suit, rank}; a joker: the no-trump hand)
 *   dealer     the dealing position
 *   bids       each seat's bid as the bid string ('0'..'13', 'B'..'4B')
 *   took       each seat's tricks this hand
 *   points     the hand's points: [team1, team2], or each seat's (GYB)
 *   scores     the running totals after the hand, same shape
 *   faults     positions at fault (rules.handFaults: a player on a SET
 *              team who took fewer than their own bid, a bore counting as
 *              0; exactly the "Fault:" log lines); always [] in GYB, which
 *              has no fault (its log lines name none)
 *   set        base game only: [team1 set, team2 set] (took fewer than the
 *              team's bid; a bore team short of the hand). A bore cell on
 *              a set team is drawn red (a bore that was set)
 *   forbidden  GYB only: the last bidder's Forbidden Bid {position, bid}
 *              of this deal, or null (hands under 5 cards)
 *
 * Pure: no emit, no Math.random, no await (it runs inside the scoring).
 */

const { HAND_PROGRESSION } = require('./rules');

const card = (c) => (c && c.suit && c.rank ? { suit: c.suit, rank: c.rank } : null);
const seatList = (n) => Array.from({ length: n }, (_, i) => i + 1);
const int = (v) => (Number.isInteger(v) ? v : (parseInt(v, 10) || 0));

/** A seat's bid as the wire's bid string ('B'..'4B' kept, a number as its digits). */
function bidString(b) {
    if (b === null || b === undefined) return '0';
    const s = String(b);
    return /^(?:[0-9]|1[0-3]|[2-4]?B)$/.test(s) ? s : String(int(s));
}

function handNoOf(handSize) {
    const i = HAND_PROGRESSION.indexOf(handSize);
    return i === -1 ? 1 : i + 1;
}

/**
 * The base game's row for the hand just scored.
 * @param {Object} game - GameState after scoreClassicHand added the points
 * @param {Object} o
 * @param {{team1: number, team2: number}} o.oldScore - the scores before this hand
 * @param {{position: number}[]} o.faults - rules.handFaults of this hand
 */
function classicRow(game, { oldScore, faults }) {
    const seats = seatList(4);
    const teamBids = game.bids || {};
    const teamTricks = game.tricks || {};
    return {
        handNo: handNoOf(game.currentHand),
        handSize: game.currentHand,
        trump: card(game.trump),
        dealer: game.dealer,
        bids: seats.map((p) => bidString(game.playerBids?.[p - 1])),
        took: seats.map((p) => int(game.handTricks?.[p])),
        points: [game.score.team1 - oldScore.team1, game.score.team2 - oldScore.team2],
        scores: [game.score.team1, game.score.team2],
        faults: (faults || []).map((f) => f.position),
        set: ['team1', 'team2'].map((t) => int(teamTricks[t]) < int(teamBids[t])),
    };
}

/**
 * A Get Your Bid row (three seats): scoreGybHand's own seat list.
 * @param {Object} game
 * @param {Object} o
 * @param {{position: number, bid: number, took: number, points: number}[]} o.seats
 * @param {{position: number, bid: number}|null} o.forbidden
 * @param {number[]} o.scores - each seat's total after the hand
 */
function gybRow(game, { seats, forbidden, scores }) {
    const byPos = new Map(seats.map((s) => [s.position, s]));
    const n = game.seatCount || 3;
    const list = seatList(n);
    return {
        handNo: handNoOf(game.currentHand),
        handSize: game.currentHand,
        trump: card(game.trump),
        dealer: game.dealer,
        bids: list.map((p) => bidString(byPos.get(p)?.bid)),
        took: list.map((p) => int(byPos.get(p)?.took)),
        points: list.map((p) => int(byPos.get(p)?.points)),
        scores: list.map((p, i) => int(scores[i])),
        faults: [],
        forbidden: forbidden ? { position: forbidden.position, bid: forbidden.bid } : null,
    };
}

/** Append a finished hand's row (once per handNo) and return it. */
function appendRow(game, row) {
    if (!Array.isArray(game.scorecard)) game.scorecard = [];
    const at = game.scorecard.findIndex((r) => r.handNo === row.handNo);
    if (at === -1) game.scorecard.push(row);
    else game.scorecard[at] = row;
    return row;
}

/** The rows so far as the wire sends them (copies: nothing shares the game's objects). */
function scorecardWire(game) {
    return Array.isArray(game.scorecard) ? game.scorecard.map((r) => JSON.parse(JSON.stringify(r))) : [];
}

/** A saved scorecard read back (persist): the well-formed rows, else []. */
function normalizeScorecard(v) {
    if (!Array.isArray(v)) return [];
    return v.filter((r) => r && typeof r === 'object' && Number.isInteger(r.handNo) && Array.isArray(r.bids)
        && Array.isArray(r.took) && Array.isArray(r.points) && Array.isArray(r.scores))
        .slice(0, 13)
        .map((r) => JSON.parse(JSON.stringify(r)));
}

module.exports = { classicRow, gybRow, appendRow, scorecardWire, normalizeScorecard, bidString, handNoOf };

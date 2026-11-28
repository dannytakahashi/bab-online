/**
 * The scorecard (owner 2026-11-27): the table people keep with real cards,
 * one row per completed hand. The server builds every row
 * (server/game/scorecard.js) and the page computes no score: it keeps the
 * rows it is sent (handComplete.scorecardRow, appended; the v2 snapshot's
 * and gameEnd's `scorecard`, whole) and lays them out here.
 *
 * Pure: no DOM, no GameState import. The table (ui/components/Scorecard.js)
 * draws `buildScorecard(...)`; Vitest checks both.
 *
 * Wire row (contract $defs.scorecardHand), seat arrays by position - 1:
 *   {handNo, handSize, trump, dealer, bids, took, points, scores, faults,
 *    set?, forbidden?}
 * points / scores: [team1, team2] in the base game, per seat in Get Your Bid.
 */

import { seatsAround, seatLetter, team } from '../utils/positions.js';

const BID_RE = /^(?:[0-9]|1[0-3]|[2-4]?B)$/;
const int = (v) => Number.isInteger(v);
const ints = (a, min, max) => Array.isArray(a) && a.length >= min && a.length <= max && a.every(int);

/** A row as the contract has it (lenient on extras, strict on what the table reads). */
export function validRow(r) {
  if (!r || typeof r !== 'object') return false;
  if (!int(r.handNo) || r.handNo < 1 || r.handNo > 13) return false;
  if (!int(r.handSize) || r.handSize < 1 || r.handSize > 13) return false;
  if (!int(r.dealer)) return false;
  if (!Array.isArray(r.bids) || r.bids.length < 3 || r.bids.length > 4 || !r.bids.every((b) => BID_RE.test(String(b)))) return false;
  if (!ints(r.took, r.bids.length, r.bids.length)) return false;
  if (!ints(r.points, 2, 3) || !ints(r.scores, r.points.length, r.points.length)) return false;
  if (r.faults !== undefined && !ints(r.faults, 0, 4)) return false;
  return true;
}

/** The well-formed rows of a wire list, by handNo (one each); null when it is not a list. */
export function parseRows(raw) {
  if (!Array.isArray(raw)) return null;
  let rows = [];
  for (const r of raw) if (validRow(r)) rows = mergeRow(rows, r);
  return rows;
}

/** `rows` with `row` in its place (a row for the same hand is replaced). */
export function mergeRow(rows, row) {
  const copy = JSON.parse(JSON.stringify(row));
  const out = (rows || []).filter((r) => r.handNo !== copy.handNo);
  out.push(copy);
  out.sort((a, b) => a.handNo - b.handNo);
  return out;
}

/** "+41", "−50", "0" (a true minus, as the mockup). */
export function signed(n) {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${-n}`;
  return '0';
}

const SUITS = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
const SUIT_WORDS = { spades: 'spades', hearts: 'hearts', diamonds: 'diamonds', clubs: 'clubs' };

/**
 * The Hand column: the hand size and the trump's suit; a turned joker (the
 * no-trump hand) shows the joker's own index, HI or LO, as the card does.
 */
export function handLabel(handSize, trump) {
  const suit = trump?.suit;
  if (suit === 'joker') {
    const hi = trump.rank === 'HI';
    return { size: handSize, symbol: hi ? 'HI' : 'LO', red: hi, joker: true, spoken: `Hand ${handSize}, no trump, ${hi ? 'high' : 'low'} joker` };
  }
  if (SUITS[suit]) {
    return { size: handSize, symbol: SUITS[suit], red: suit === 'hearts' || suit === 'diamonds', joker: false, spoken: `Hand ${handSize}, ${SUIT_WORDS[suit]}` };
  }
  return { size: handSize, symbol: '', red: false, joker: false, spoken: `Hand ${handSize}` };
}

const isBore = (b) => String(b).includes('B');

/**
 * The columns for the viewer: the base game's two pairs, mine first (me,
 * partner; then the next seat in turn and its partner; a spectator's seats
 * 1 and 3, then 2 and 4), each pair under its names in its team's colour
 * (seats 1 and 3 team A, 2 and 4 team B: the score header's colours); Get
 * Your Bid's three players, mine first, each its own colour.
 * @param {{solo: boolean, me: number|null, name: (pos: number) => string}} o
 */
export function scorecardColumns({ solo = false, me = null, name = () => '' }) {
  const seats = solo ? 3 : 4;
  const viewer = me && me >= 1 && me <= seats ? me : 1;
  if (solo) {
    const a = seatsAround(viewer, 3);
    const order = [viewer, a.opp1, a.opp2];
    return {
      solo: true,
      players: order.map((pos) => ({ position: pos, name: name(pos) || `P${pos}`, letter: seatLetter(pos, 3), mine: pos === me })),
      groups: [],
      scores: order.map((pos) => ({ index: pos - 1, letter: seatLetter(pos, 3), label: name(pos) || `P${pos}` })),
    };
  }
  const a = seatsAround(viewer, 4);
  const pairs = [[viewer, team(viewer)], [a.opp1, a.opp2]];
  const groups = pairs.map((pair) => {
    const names = pair.map((p) => name(p) || `P${p}`);
    return { positions: pair, letter: seatLetter(pair[0], 4), label: `${names[0]} & ${names[1]}`, spoken: `${names[0]} and ${names[1]}`, teamIndex: pair[0] % 2 === 1 ? 0 : 1 };
  });
  return {
    solo: false,
    players: pairs.flat().map((pos) => ({ position: pos, name: name(pos) || `P${pos}`, letter: seatLetter(pos, 4), mine: pos === me })),
    groups,
    scores: groups.map((g) => ({ index: g.teamIndex, letter: g.letter, label: g.label, spoken: g.spoken })),
  };
}

/**
 * One seat's cell of a row: "bid → took" with what colours it.
 *   extra: took > its numeric bid (gold, the over-trick pip's colour)
 *   fault: the server's fault list has the seat (red pill)
 *   bore:  a B..4B bid (green outline); boreSet: its team was set (red pill + red outline)
 *   forbidden: Get Your Bid, the seat's Forbidden Bid this deal (struck)
 */
export function cellOf(row, pos, { current = false } = {}) {
  const i = pos - 1;
  const rawBid = row.bids?.[i];
  const bid = rawBid === null || rawBid === undefined ? null : String(rawBid);
  const took = current ? null : (int(row.took?.[i]) ? row.took[i] : null);
  const bore = bid !== null && isBore(bid);
  const teamIndex = pos % 2 === 1 ? 0 : 1;
  const extra = !bore && bid !== null && took !== null && took > (parseInt(bid, 10) || 0);
  const fault = !current && Array.isArray(row.faults) && row.faults.includes(pos);
  const boreSet = bore && !current && Array.isArray(row.set) && row.set[teamIndex] === true;
  const forbidden = row.forbidden && row.forbidden.position === pos ? row.forbidden.bid : null;
  return { position: pos, bid, took, extra, fault, bore, boreSet, forbidden };
}

function cellWords(name, c) {
  if (c.bid === null) return `${name} not bid yet`;
  const bidWord = c.bore ? `bid ${c.bid === 'B' ? 'a bore' : `bore ${c.bid}`}` : `bid ${c.bid}`;
  if (c.took === null) return `${name} ${bidWord}`;
  let s = `${name} ${bidWord}, took ${c.took}`;
  if (c.extra) {
    const n = c.took - (parseInt(c.bid, 10) || 0);
    s += `, ${n === 1 ? 'one extra' : `${n} extra`}`;
  }
  if (c.boreSet) s += ', set';
  else if (c.fault) s += ', at fault';
  if (c.forbidden !== null) s += `, forbidden bid ${c.forbidden}`;
  return s;
}

const spokenNumber = (n) => (n < 0 ? `minus ${-n}` : `${n}`);
const spokenDelta = (n) => (n > 0 ? `plus ${n}` : n < 0 ? `minus ${-n}` : 'no change');

/**
 * The whole card: the columns, then one row per completed hand and, while
 * a hand is in play, its row with the bids only (current).
 * @param {Object} o
 * @param {Array} o.rows - the server's rows (parseRows)
 * @param {boolean} [o.solo] - a Get Your Bid table
 * @param {number|null} [o.me] - the viewer's seat (null: a spectator, seen from seat 1)
 * @param {(pos: number) => string} [o.name] - a seat's name (the owner rule)
 * @param {{handSize, trump, dealer, bids}|null} [o.current] - the hand in play
 */
export function buildScorecard({ rows = [], solo = false, me = null, name = () => '', current = null } = {}) {
  const cols = scorecardColumns({ solo, me, name });
  const out = (rows || []).map((r) => rowModel(r, cols, name, false));
  if (current && int(current.handSize) && current.handSize >= 1) {
    const handNo = int(current.handNo) ? current.handNo : null;
    if (!handNo || !out.some((r) => r.handNo === handNo)) {
      out.push(rowModel({ handNo: handNo ?? 0, handSize: current.handSize, trump: current.trump, dealer: current.dealer, bids: current.bids || [], took: [], points: [], scores: [], faults: [] }, cols, name, true));
    }
  }
  return { ...cols, rows: out };
}

function rowModel(r, cols, name, current) {
  const hand = handLabel(r.handSize, r.trump);
  const cells = cols.players.map((p) => cellOf(r, p.position, { current }));
  const dealerName = int(r.dealer) ? (name(r.dealer) || `P${r.dealer}`) : '';
  const scores = current ? cols.scores.map(() => null) : cols.scores.map((s) => ({
    total: r.scores[s.index],
    delta: r.points[s.index],
    // the first hand's change is its total: no delta line (owner 2026-11-27)
    showDelta: r.handNo !== 1,
    letter: s.letter,
  }));
  const parts = [hand.spoken + '.', dealerName ? `Dealer ${dealerName}.` : ''];
  cells.forEach((c, i) => parts.push(cellWords(cols.players[i].name, c) + '.'));
  if (!current) {
    cols.scores.forEach((s, i) => {
      const sc = scores[i];
      parts.push(`${s.spoken || s.label} ${spokenNumber(sc.total)}${sc.showDelta ? `, ${spokenDelta(sc.delta)}` : ''}.`);
    });
  } else {
    parts.push('Hand in play.');
  }
  return { handNo: r.handNo, hand, dealerName, cells, scores, current, spoken: parts.filter(Boolean).join(' ') };
}

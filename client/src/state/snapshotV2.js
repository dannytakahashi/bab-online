/**
 * Table snapshot v2: a pure parser / validator for the web client.
 *
 * The server sends a v2 snapshot as `snapshot` on rejoinSuccess,
 * restorePlayerState, actionRejected and the spectator full state, and as
 * stateSnapshot.snapshot (the reply to requestSnapshot). Contract:
 * contract/events.schema.json $defs.snapshotV2; consumer rules (seq, gaps,
 * presence): contract/README.md.
 *
 * Not wired into rendering yet (roadmap item 16) and not imported by
 * main.js, so it is not in the bundle. No imports: safe anywhere.
 */

export const SNAPSHOT_VERSION = 2;
export const STAGES = Object.freeze(['CREATED', 'DRAWING', 'DRAW_RESOLVING', 'TEAMS_ANNOUNCED', 'DEALING', 'BIDDING',
  'REDEAL', 'PLAYING', 'TRICK_RESOLVING', 'HAND_RESOLVING', 'ENDED', 'ABORTED']);
export const CONTROLLERS = Object.freeze(['human', 'lazyBot', 'resignBot', 'bot']);
export const PRESENCES = Object.freeze(['connected', 'grace', 'resignable', 'away', 'gone', 'none']);
export const ROLES = Object.freeze(['seat', 'lazyWatcher', 'spectator', 'entrant', 'none']);

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs', 'joker'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', 'HI', 'LO'];
const BIDS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', 'B', '2B', '3B', '4B'];
const ENTRANT_PRESENCES = ['connected', 'disconnected', 'left'];

// The known keys, in order. Unknown keys are ignored (forward compatible).
const TOP_KEYS = ['v', 'gameId', 'seq', 'serverTime', 'stage', 'partial', 'viewer', 'hand', 'deal', 'trump', 'trumpBroken',
  'turn', 'bids', 'trick', 'tricks', 'tricksByPosition', 'score', 'rainbows', 'hsi', 'seats', 'entrants', 'draw',
  'spectatorCount', 'tournament', 'log'];

/** A small checker that collects errors with paths. */
function checker() {
  const errors = [];
  const fail = (path, msg) => { errors.push(`${path}: ${msg}`); return false; };
  const c = {
    errors,
    fail,
    obj: (v, path) => (v !== null && typeof v === 'object' && !Array.isArray(v)) || fail(path, 'expected an object'),
    arr: (v, path, len) => {
      if (!Array.isArray(v)) return fail(path, 'expected an array');
      if (len !== undefined && v.length !== len) return fail(path, `expected ${len} items, got ${v.length}`);
      return true;
    },
    int: (v, path, min = -Infinity, max = Infinity) => (Number.isInteger(v) && v >= min && v <= max) || fail(path, `expected an integer in [${min}, ${max}]`),
    num: (v, path) => (typeof v === 'number' && Number.isFinite(v)) || fail(path, 'expected a number'),
    str: (v, path) => typeof v === 'string' || fail(path, 'expected a string'),
    bool: (v, path) => typeof v === 'boolean' || fail(path, 'expected a boolean'),
    oneOf: (v, path, list) => list.includes(v) || fail(path, `expected one of ${list.join('|')}, got ${JSON.stringify(v)}`),
    pos: (v, path) => c.int(v, path, 1, 4),
    nullable: (v, path, fn) => v === null || fn(v, path),
    card: (v, path) => c.obj(v, path) && c.oneOf(v.suit, `${path}.suit`, SUITS) && c.oneOf(v.rank, `${path}.rank`, RANKS),
    pair: (v, path) => c.obj(v, path) && c.int(v.team1, `${path}.team1`) && c.int(v.team2, `${path}.team2`),
    has: (v, keys, path) => keys.every((k) => (k in v) || fail(path, `missing '${k}'`)),
  };
  return c;
}

function validate(s, c) {
  if (!c.obj(s, '$')) return;
  if (s.v !== SNAPSHOT_VERSION) { c.fail('$.v', `expected ${SNAPSHOT_VERSION}, got ${JSON.stringify(s.v)}`); return; }
  if (!c.has(s, TOP_KEYS, '$')) return;
  c.str(s.gameId, '$.gameId');
  c.int(s.seq, '$.seq', 0);
  c.int(s.serverTime, '$.serverTime');
  c.oneOf(s.stage, '$.stage', STAGES);
  if (c.arr(s.partial, '$.partial')) s.partial.forEach((p, i) => c.oneOf(p, `$.partial[${i}]`, ['customPics', 'log']));

  const vw = s.viewer;
  if (c.obj(vw, '$.viewer') && c.has(vw, ['role', 'position', 'ownerView', 'canAct'], '$.viewer')) {
    c.oneOf(vw.role, '$.viewer.role', ROLES);
    c.nullable(vw.position, '$.viewer.position', c.pos);
    c.nullable(vw.ownerView, '$.viewer.ownerView', (v, p) => c.oneOf(v, p, ['seat', 'watch']));
    c.bool(vw.canAct, '$.viewer.canAct');
    const ownsHand = vw.role === 'seat' || vw.role === 'lazyWatcher';
    if (ownsHand !== (s.hand !== null)) c.fail('$.hand', `must be ${ownsHand ? 'an array' : 'null'} for role ${vw.role}`);
  }
  if (s.hand !== null && c.arr(s.hand, '$.hand')) s.hand.forEach((x, i) => c.card(x, `$.hand[${i}]`));

  c.nullable(s.deal, '$.deal', (d, p) => c.obj(d, p) && c.has(d, ['handNo', 'handSize', 'dealer', 'bidder', 'dealSeq'], p) &&
    c.int(d.handNo, `${p}.handNo`, 1, 13) && c.int(d.handSize, `${p}.handSize`, 1, 13) && c.pos(d.dealer, `${p}.dealer`) &&
    c.pos(d.bidder, `${p}.bidder`) && c.nullable(d.dealSeq, `${p}.dealSeq`, (x, q) => c.int(x, q, 1)));
  c.nullable(s.trump, '$.trump', c.card);
  c.bool(s.trumpBroken, '$.trumpBroken');
  c.nullable(s.turn, '$.turn', (t, p) => c.obj(t, p) && c.pos(t.position, `${p}.position`) && c.oneOf(t.action, `${p}.action`, ['bid', 'play']));

  const b = s.bids;
  if (c.obj(b, '$.bids') && c.has(b, ['byPosition', 'order', 'teamBids', 'mults'], '$.bids')) {
    if (c.arr(b.byPosition, '$.bids.byPosition', 4)) b.byPosition.forEach((x, i) => c.nullable(x, `$.bids.byPosition[${i}]`, (v, p) => c.oneOf(v, p, BIDS)));
    if (c.arr(b.order, '$.bids.order', 4)) b.order.forEach((x, i) => c.pos(x, `$.bids.order[${i}]`));
    c.nullable(b.teamBids, '$.bids.teamBids', c.pair);
    if (c.obj(b.mults, '$.bids.mults')) { c.int(b.mults.team1, '$.bids.mults.team1', 1); c.int(b.mults.team2, '$.bids.mults.team2', 1); }
  }

  const t = s.trick;
  if (c.obj(t, '$.trick') && c.has(t, ['number', 'leadPosition', 'cards'], '$.trick')) {
    c.nullable(t.number, '$.trick.number', (v, p) => c.int(v, p, 1, 13));
    c.nullable(t.leadPosition, '$.trick.leadPosition', c.pos);
    if (c.arr(t.cards, '$.trick.cards')) {
      if (t.cards.length > 4) c.fail('$.trick.cards', 'at most 4 cards');
      t.cards.forEach((x, i) => c.obj(x, `$.trick.cards[${i}]`) && c.pos(x.position, `$.trick.cards[${i}].position`) && c.card(x.card, `$.trick.cards[${i}].card`));
    }
  }
  c.pair(s.tricks, '$.tricks');
  if (c.arr(s.tricksByPosition, '$.tricksByPosition', 4)) s.tricksByPosition.forEach((x, i) => c.int(x, `$.tricksByPosition[${i}]`, 0));
  c.pair(s.score, '$.score');
  c.pair(s.rainbows, '$.rainbows');
  c.nullable(s.hsi, '$.hsi', (h, p) => c.arr(h, p, 4) && h.every((x, i) => c.nullable(x, `${p}[${i}]`, c.num)));

  if (c.arr(s.seats, '$.seats')) {
    if (s.seats.length !== 0 && s.seats.length !== 4) c.fail('$.seats', `expected 0 or 4 seats, got ${s.seats.length}`);
    s.seats.forEach((st, i) => {
      const p = `$.seats[${i}]`;
      if (!c.obj(st, p)) return;
      if (st.position !== i + 1) c.fail(`${p}.position`, `expected ${i + 1}`);
      c.nullable(st.username, `${p}.username`, c.str);
      c.nullable(st.pic, `${p}.pic`, c.int);
      c.bool(st.hasCustomPic, `${p}.hasCustomPic`);
      c.nullable(st.customPic, `${p}.customPic`, c.str);
      c.nullable(st.ownerUsername, `${p}.ownerUsername`, c.str);
      c.oneOf(st.controller, `${p}.controller`, CONTROLLERS);
      c.oneOf(st.presence, `${p}.presence`, PRESENCES);
      ['isBot', 'lazy', 'offered'].forEach((k) => c.bool(st[k], `${p}.${k}`));
      c.nullable(st.graceDeadline, `${p}.graceDeadline`, c.int);
      c.nullable(st.resignableAt, `${p}.resignableAt`, c.int);
      c.int(st.cardsInHand, `${p}.cardsInHand`, 0, 13);
    });
  }
  c.nullable(s.entrants, '$.entrants', (es, p) => c.arr(es, p) && es.every((e, i) => c.obj(e, `${p}[${i}]`) &&
    c.nullable(e.username, `${p}[${i}].username`, c.str) && c.bool(e.isBot, `${p}[${i}].isBot`) &&
    c.oneOf(e.presence, `${p}[${i}].presence`, ENTRANT_PRESENCES) && c.bool(e.hasDrawn, `${p}[${i}].hasDrawn`)));
  c.nullable(s.draw, '$.draw', (d, p) => c.obj(d, p) && c.has(d, ['deckRemaining', 'drawn', 'viewerDrawOrder'], p) &&
    c.nullable(d.deckRemaining, `${p}.deckRemaining`, (v, q) => c.int(v, q, 0, 54)) &&
    c.arr(d.drawn, `${p}.drawn`) && d.drawn.every((x, i) => c.obj(x, `${p}.drawn[${i}]`) &&
      c.int(x.drawOrder, `${p}.drawn[${i}].drawOrder`, 1, 4) && c.card(x.card, `${p}.drawn[${i}].card`) &&
      c.nullable(x.position, `${p}.drawn[${i}].position`, c.pos)) &&
    c.nullable(d.viewerDrawOrder, `${p}.viewerDrawOrder`, (v, q) => c.int(v, q, 1, 4)));
  c.int(s.spectatorCount, '$.spectatorCount', 0);
  c.nullable(s.tournament, '$.tournament', (tt, p) => c.obj(tt, p) && c.str(tt.tournamentId, `${p}.tournamentId`) &&
    c.str(tt.name, `${p}.name`) && c.nullable(tt.roundNumber, `${p}.roundNumber`, (v, q) => c.int(v, q, 1)) && c.int(tt.totalRounds, `${p}.totalRounds`));
  if (c.arr(s.log, '$.log')) s.log.forEach((e, i) => c.obj(e, `$.log[${i}]`) && c.str(e.message, `$.log[${i}].message`) && c.str(e.type, `$.log[${i}].type`));
}

function deepFreeze(v) {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(deepFreeze);
    Object.freeze(v);
  }
  return v;
}

/**
 * @param {*} raw - a snapshot as received on the wire
 * @returns {{ok: true, snapshot: Object} | {ok: false, errors: string[]}}
 *   snapshot: a deep-frozen copy of the known keys (unknown keys dropped)
 */
export function parseSnapshotV2(raw) {
  const c = checker();
  validate(raw, c);
  if (c.errors.length) return { ok: false, errors: c.errors };
  const copy = {};
  for (const k of TOP_KEYS) copy[k] = JSON.parse(JSON.stringify(raw[k]));
  return { ok: true, snapshot: deepFreeze(copy) };
}

/**
 * Where an incoming broadcast's seq stands against the last applied one
 * (contract/README.md R2): 'next' (apply), 'stale' (drop), 'gap' (buffer,
 * requestSnapshot, replay what is newer than the snapshot).
 */
export function classifySeq(lastSeq, seq) {
  if (seq === lastSeq + 1) return 'next';
  if (seq <= lastSeq) return 'stale';
  return 'gap';
}

/** The seat record at position 1-4, or null (no seats before seating). */
export function seatAt(snapshot, pos) {
  return snapshot.seats.find((s) => s.position === pos) || null;
}

/**
 * Seat `pos` relative to the viewer: 0 = the viewer's own seat (bottom),
 * 1 = left, 2 = across (partner), 3 = right. Spectators view from seat 1.
 */
export function relativeSeat(viewerPos, pos) {
  const base = viewerPos || 1;
  return (pos - base + 4) % 4;
}

/** True when nothing was left out (log and custom pictures included). */
export function isComplete(snapshot) {
  return snapshot.partial.length === 0;
}

/**
 * Apply an incoming (parsed) snapshot over the previous one (contract/README.md
 * R5): the table is always replaced, but what `next.partial` says was left out
 * is kept from what the client already has instead of being wiped:
 *   - 'log': keep `prev.log` (same game only). The caller must keep
 *     `prev.log` current with the gameLogEntry events received since `prev`
 *     arrived, or entries in between are lost.
 *   - 'customPics': for a seat with hasCustomPic and customPic null, keep the
 *     picture the client already holds for that displayed username, taken from
 *     `pics` ({username: dataUrl}, e.g. built from the same v1 payload's
 *     players[].pic) or from the same seat of `prev`.
 * `partial` of the result lists only what is still missing.
 * @param {Object|null} prev - the snapshot currently applied (parsed), or null
 * @param {Object} next - the incoming snapshot (parsed)
 * @param {{pics?: Object<string, string>}} [opts]
 * @returns {Object} a deep-frozen snapshot
 */
export function mergeSnapshot(prev, next, { pics = {} } = {}) {
  const same = !!prev && prev.gameId === next.gameId;
  const out = JSON.parse(JSON.stringify(next));
  const missing = new Set(out.partial);
  if (missing.has('log') && same && !prev.partial.includes('log')) {
    out.log = JSON.parse(JSON.stringify(prev.log));
    missing.delete('log');
  }
  if (missing.has('customPics')) {
    let still = false;
    out.seats = out.seats.map((seat) => {
      if (!seat.hasCustomPic || seat.customPic !== null) return seat;
      const old = same ? seatAt(prev, seat.position) : null;
      const known = (seat.username != null && typeof pics[seat.username] === 'string' && pics[seat.username].startsWith('data:image'))
        ? pics[seat.username]
        : (old && old.username === seat.username && old.customPic) || null;
      if (!known) still = true;
      return known ? { ...seat, customPic: known } : seat;
    });
    if (!still) missing.delete('customPics');
  }
  out.partial = out.partial.filter((p) => missing.has(p));
  return deepFreeze(out);
}

/** 1 for seats 1 and 3, 2 for seats 2 and 4. */
export function teamOf(pos) {
  return pos % 2 === 1 ? 1 : 2;
}

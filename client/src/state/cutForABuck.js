/**
 * Cut for a buck on the web (owner 2026-11-25; spec section 6): the
 * tournament's finale as one pure state, from the server's events
 * (cutForABuckStart / Round / Drew / Left / Reveal / Winner) or from
 * tournamentJoined.cut (a reload, a return from the score screen), and the
 * words the screen shows. No DOM, no timers: ui/cut/CutForABuck.js draws
 * it, main.js feeds it (cutStore).
 *
 * Times are absolute (ms, the receiver's clock): the server sends relative
 * ones (startsInMs, closesInMs, nextInMs, cut.inMs), so `endsAt` is
 * now + that at receipt.
 *
 * Every word names people: "you" for me, usernames for everyone else,
 * never a team or a number.
 */

import { RANK_VALUES } from '../constants/ranks.js';

export const STAGE = Object.freeze({ GATHER: 'gather', DRAWING: 'drawing', REVEAL: 'reveal', WINNER: 'winner' });

export const DECK_SIZE = 54;

/** The empty state (no cut). */
export function cutIdle() {
  return null;
}

function base() {
  return {
    stage: STAGE.GATHER,
    endsAt: null,
    round: 0,
    candidates: [],
    participants: [],
    alive: [],
    // username -> {round, left?}
    out: {},
    // username -> cards revealed since the last reshuffle (oldest first)
    table: {},
    // username -> {slot, auto} this round (never a card: they are secret)
    drawn: {},
    // the round's deck at its open (slots 0..deckCount-1)
    deckCount: DECK_SIZE,
    // the full deck(s): the fan's widest spread
    deckSize: DECK_SIZE,
    lastReveal: null,
    reshuffled: false,
    winner: null,
    rounds: null,
    // the last change, for the view's animations: {type, ...}
    last: null,
    seq: 0,
  };
}

const at = (now, ms) => (Number.isFinite(ms) ? now + Math.max(0, ms) : null);
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const fullDecks = (n) => DECK_SIZE * Math.max(1, Math.ceil(n / DECK_SIZE));

/**
 * The state from tournamentJoined.cut ($defs.cutState; null or absent: no cut).
 * @param {Object} wire
 * @param {number} now
 */
export function cutFromWire(wire, now = Date.now()) {
  if (!wire || typeof wire !== 'object') return null;
  const s = base();
  s.stage = Object.values(STAGE).includes(wire.stage) ? wire.stage : STAGE.GATHER;
  s.endsAt = at(now, wire.inMs);
  s.round = Number.isInteger(wire.round) ? wire.round : 0;
  s.candidates = list(wire.candidates);
  s.participants = list(wire.participants);
  s.alive = list(wire.alive);
  for (const o of Array.isArray(wire.out) ? wire.out : []) {
    if (o && typeof o.username === 'string') s.out[o.username] = { round: o.round || 0, ...(o.left ? { left: true } : {}) };
  }
  for (const t of Array.isArray(wire.table) ? wire.table : []) {
    if (t && typeof t.username === 'string' && Array.isArray(t.cards)) s.table[t.username] = t.cards.map((c) => ({ suit: c.suit, rank: c.rank }));
  }
  if (s.stage === STAGE.DRAWING) {
    for (const d of Array.isArray(wire.drawn) ? wire.drawn : []) {
      if (d && typeof d.username === 'string') s.drawn[d.username] = { slot: d.slot, auto: false };
    }
  }
  const people = s.participants.length || s.candidates.length;
  s.deckSize = fullDecks(people);
  s.deckCount = Number.isInteger(wire.deckCount) ? wire.deckCount : s.deckSize;
  if (wire.lastReveal) {
    s.lastReveal = {
      round: wire.lastReveal.round,
      draws: (wire.lastReveal.draws || []).map((d) => ({ username: d.username, slot: d.slot, card: { suit: d.card.suit, rank: d.card.rank } })),
      eliminated: list(wire.lastReveal.eliminated),
      redraw: !!wire.lastReveal.redraw,
    };
  }
  if (typeof wire.winner === 'string') s.winner = wire.winner;
  if (s.winner) s.stage = STAGE.WINNER;
  s.last = { type: 'restore' };
  return s;
}

/**
 * One server event.
 * @param {Object|null} state
 * @param {string} type - 'start' | 'round' | 'drew' | 'left' | 'reveal' | 'winner'
 * @param {Object} data - the event's payload
 * @param {number} now
 * @returns {Object|null} the next state (a new object; the old one is not changed)
 */
export function cutReduce(state, type, data, now = Date.now()) {
  const d = data || {};
  if (type === 'start') {
    const s = base();
    s.candidates = list(d.candidates);
    s.deckSize = Number.isInteger(d.deckCount) ? d.deckCount : fullDecks(s.candidates.length);
    s.deckCount = s.deckSize;
    s.endsAt = at(now, d.startsInMs);
    s.last = { type: 'start' };
    s.seq = (state?.seq || 0) + 1;
    return s;
  }
  if (!state) {
    // an event without its start (a tab that joined late): build what we can
    if (type !== 'round' && type !== 'winner') return null;
    state = base();
  }
  const s = { ...state, out: { ...state.out }, table: { ...state.table }, drawn: { ...state.drawn }, seq: state.seq + 1 };
  switch (type) {
    case 'round': {
      s.stage = STAGE.DRAWING;
      s.round = d.round;
      if (Array.isArray(d.participants)) s.participants = list(d.participants);
      if (s.deckSize < fullDecks(s.participants.length)) s.deckSize = fullDecks(s.participants.length);
      s.alive = list(d.alive);
      s.deckCount = Number.isInteger(d.deckCount) ? d.deckCount : s.deckCount;
      s.reshuffled = !!d.reshuffled;
      if (s.reshuffled) s.table = {};
      s.drawn = {};
      s.endsAt = at(now, d.closesInMs);
      s.last = { type: 'round', reshuffled: s.reshuffled, round: d.round };
      return s;
    }
    case 'drew': {
      if (d.round !== s.round || typeof d.username !== 'string') return state;
      s.drawn[d.username] = { slot: d.slot, auto: !!d.auto };
      s.last = { type: 'drew', username: d.username, slot: d.slot, auto: !!d.auto };
      return s;
    }
    case 'left': {
      if (typeof d.username !== 'string') return state;
      s.alive = list(d.alive);
      s.out[d.username] = { round: d.round || s.round, left: true };
      delete s.drawn[d.username];
      s.last = { type: 'left', username: d.username, freedSlot: d.freedSlot };
      return s;
    }
    case 'reveal': {
      const draws = (d.draws || []).map((x) => ({ username: x.username, slot: x.slot, card: { suit: x.card.suit, rank: x.card.rank } }));
      for (const x of draws) s.table[x.username] = [...(s.table[x.username] || []), x.card];
      const eliminated = list(d.eliminated);
      for (const u of eliminated) s.out[u] = { round: d.round };
      s.alive = list(d.alive);
      s.drawn = {};
      s.deckCount = Math.max(0, s.deckCount - draws.length);
      s.lastReveal = { round: d.round, draws, eliminated, redraw: !!d.redraw };
      s.stage = s.alive.length === 1 ? STAGE.WINNER : STAGE.REVEAL;
      s.endsAt = at(now, d.nextInMs);
      s.last = { type: 'reveal', round: d.round };
      return s;
    }
    case 'winner': {
      s.stage = STAGE.WINNER;
      s.winner = typeof d.winner === 'string' ? d.winner : s.winner;
      if (Array.isArray(d.participants)) s.participants = list(d.participants);
      s.rounds = Number.isInteger(d.rounds) ? d.rounds : s.round;
      // the round cap's random pick: everyone else is out now
      for (const u of s.alive) if (u !== s.winner && !s.out[u]) s.out[u] = { round: s.round };
      s.alive = s.winner ? [s.winner] : s.alive;
      s.drawn = {};
      s.last = { type: 'winner', winner: s.winner };
      return s;
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------- words

const RANK_NAME = { J: 'jack', Q: 'queen', K: 'king', A: 'ace', HI: 'HI joker', LO: 'LO joker' };
const RANK_PLURAL = { J: 'jacks', Q: 'queens', K: 'kings', A: 'aces', HI: 'HI jokers', LO: 'LO jokers' };
const SUIT_NAME = { spades: 'spades', hearts: 'hearts', diamonds: 'diamonds', clubs: 'clubs' };
const SUIT_SYMBOL = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };

/** "a 9", "an 8", "an ace", "a HI joker" */
export function rankWithArticle(rank) {
  const word = RANK_NAME[rank] || String(rank);
  return `${/^(8|ace|11|18)/.test(word) ? 'an' : 'a'} ${word}`;
}

/** "3s", "aces", "LO jokers" */
export function rankPlural(rank) {
  return RANK_PLURAL[rank] || `${rank}s`;
}

/** "3 of clubs", "HI joker" (screen readers) */
export function cardSpoken(card) {
  if (!card) return '';
  if (card.suit === 'joker') return `${card.rank} joker`;
  return `${RANK_NAME[card.rank] || card.rank} of ${SUIT_NAME[card.suit] || card.suit}`;
}

/** "9♥", "HI joker" (the list view) */
export function cardShort(card) {
  if (!card) return '';
  if (card.suit === 'joker') return `${card.rank} joker`;
  return `${card.rank}${SUIT_SYMBOL[card.suit] || ''}`;
}

/** "al", "al and cy", "al, bo and cy" */
export function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const nameOf = (u, me) => (u === me ? 'you' : u);
const secondsLeft = (endsAt, now) => (endsAt == null ? null : Math.max(0, Math.ceil((endsAt - now) / 1000)));

export const RULES_LINE = "Lowest card is out. Suits don't count; aces are high and jokers higher.";
export const RESHUFFLE_LINE = 'Not enough cards left. Shuffling them back in.';
/** My draw was the server's (I was away, disconnected or the window closed). */
export const DREW_FOR_YOU_LINE = 'We drew a card for you';
export const BRAGGING_LINE = 'Just for bragging rights.';
export const WATCHING_LINE = 'Watching Cut for a buck';

/** Am I a player still in? */
export const isAlive = (s, me) => !!s && s.alive.includes(me);
/** Am I in the cut at all (a participant, or a candidate during the gather)? */
export function isInCut(s, me) {
  if (!s || !me) return false;
  return s.stage === STAGE.GATHER ? s.candidates.includes(me) || s.participants.includes(me) : s.participants.includes(me);
}

/** The players the ring shows: the participants, or the candidates during the gather. */
export function ringPlayers(s) {
  if (!s) return [];
  return s.participants.length ? s.participants : s.candidates;
}

/** The ones still to draw this round. */
export function waitingFor(s) {
  if (!s || s.stage !== STAGE.DRAWING) return [];
  return s.alive.filter((u) => !s.drawn[u]);
}

/** "Round 2 · 9 of 12 left" (empty during the gather). */
export function roundLine(s) {
  if (!s || !s.round) return '';
  return `Round ${s.round} · ${s.alive.length} of ${s.participants.length} left`;
}

/** The deck's caption: "37 cards left" / "1 card left". */
export function deckLine(s) {
  const left = deckLeft(s);
  return `${left} card${left === 1 ? '' : 's'} left`;
}

/** Cards still face down in the deck. */
export function deckLeft(s) {
  if (!s) return 0;
  if (s.stage !== STAGE.DRAWING) return s.deckCount;
  return Math.max(0, s.deckCount - Object.keys(s.drawn).length);
}

/**
 * The verdict of a reveal for me: the lines, mine first.
 *   redraw:  ["Everyone tied on 7s. Redraw!"]
 *   I drew:  "You're safe with a 9" / "You're out with a 3"
 *   others:  "bo and al are out with 3s" / "bo is out with a 3"
 */
export function verdictLines(reveal, me) {
  if (!reveal) return [];
  const { draws, eliminated, redraw } = reveal;
  if (redraw) return [`Everyone tied on ${rankPlural(draws[0]?.card?.rank)}. Redraw!`];
  const lines = [];
  const mine = draws.find((d) => d.username === me);
  const outCard = draws.find((d) => eliminated.includes(d.username))?.card;
  if (mine) lines.push(eliminated.includes(me) ? `You're out with ${rankWithArticle(mine.card.rank)}` : `You're safe with ${rankWithArticle(mine.card.rank)}`);
  const others = eliminated.filter((u) => u !== me);
  if (others.length && outCard) {
    lines.push(others.length === 1
      ? `${others[0]} is out with ${rankWithArticle(outCard.rank)}`
      : `${joinNames(others)} are out with ${rankPlural(outCard.rank)}`);
  }
  return lines;
}

/** One announcement for a reveal (screen readers; draws are never announced one by one). */
export function revealAnnouncement(reveal, me) {
  if (!reveal) return '';
  const cards = reveal.draws.map((d) => `${nameOf(d.username, me)} ${cardSpoken(d.card)}`).join(', ');
  return `Round ${reveal.round}: ${cards}. ${verdictLines(reveal, me).join('. ')}.`;
}

/** "dan wins Cut for a buck!" / "You win Cut for a buck!" */
export function winnerLine(winner, me) {
  return winner === me ? 'You win Cut for a buck!' : `${winner} wins Cut for a buck!`;
}

/**
 * The status lines over the stage: {main, sub}.
 * @param {Object} s
 * @param {Object} o
 * @param {string} o.me
 * @param {boolean} [o.spectator]
 * @param {number} [o.now]
 */
export function statusLines(s, { me, spectator = false, now = Date.now() } = {}) {
  if (!s) return { main: '', sub: '' };
  const secs = secondsLeft(s.endsAt, now);
  switch (s.stage) {
    case STAGE.GATHER:
      return { main: `Cut for a buck starts in ${secs ?? 0}`, sub: RULES_LINE };
    case STAGE.DRAWING: {
      const waiting = waitingFor(s);
      if (spectator) return { main: WATCHING_LINE, sub: waiting.length ? `Waiting for ${joinNames(waiting)}` : '' };
      if (isAlive(s, me) && !s.drawn[me]) {
        return { main: 'Click the deck to draw', sub: secs != null ? `Auto-draw in ${secs}` : '' };
      }
      if (!isInCut(s, me) || !isAlive(s, me)) {
        return { main: isInCut(s, me) ? "You're out. Watching the rest" : WATCHING_LINE, sub: waiting.length ? `Waiting for ${joinNames(waiting)}` : '' };
      }
      return {
        main: waiting.length ? `Waiting for ${joinNames(waiting.map((u) => nameOf(u, me)))}` : 'Turning the cards over',
        sub: s.drawn[me]?.auto ? DREW_FOR_YOU_LINE : s.reshuffled ? RESHUFFLE_LINE : RULES_LINE
      };
    }
    case STAGE.REVEAL: {
      const lines = verdictLines(s.lastReveal, me);
      return { main: lines[0] || '', sub: lines.slice(1).join('. ') };
    }
    case STAGE.WINNER:
      return { main: s.winner ? winnerLine(s.winner, me) : '', sub: BRAGGING_LINE };
    default:
      return { main: '', sub: '' };
  }
}

/**
 * One player's look in the ring: {state, caption, label}.
 *   state: 'idle' | 'waiting' | 'drawn' | 'auto' | 'out' | 'left' | 'winner'
 * @param {Object} s
 * @param {string} username
 * @param {Object} o
 * @param {string} o.me
 * @param {boolean} [o.connected] - false: "reconnecting…"
 * @param {boolean} [o.talking]
 */
export function seatView(s, username, { me, connected = true, talking = false } = {}) {
  let state = 'idle';
  let caption = '';
  const out = s?.out?.[username];
  if (s?.winner === username) {
    state = 'winner';
    caption = 'Winner';
  } else if (out?.left) {
    state = 'left';
    caption = 'Left';
  } else if (out) {
    state = 'out';
    caption = `Out · round ${out.round}`;
  } else if (s?.stage === STAGE.DRAWING && s.alive.includes(username)) {
    const d = s.drawn[username];
    state = d ? (d.auto ? 'auto' : 'drawn') : 'waiting';
    caption = d?.auto ? 'auto' : '';
  }
  if (connected === false && state !== 'left' && state !== 'out') caption = 'reconnecting…';
  const cards = s?.table?.[username] || [];
  const newest = cards[cards.length - 1];
  const parts = [username === me ? 'you' : username];
  if (state === 'out') parts.push(`out in round ${out.round}`);
  else if (state === 'left') parts.push('left');
  else if (state === 'winner') parts.push('the winner');
  else if (state === 'waiting') parts.push('still to draw');
  else if (state === 'drawn' || state === 'auto') parts.push(state === 'auto' ? 'drawn for' : 'drawn');
  if (newest) parts.push(cardSpoken(newest));
  if (connected === false) parts.push('reconnecting');
  if (talking) parts.push('talking');
  return { state, caption, label: parts.join(', '), cards, disconnected: connected === false };
}

/** The lowest rank among cards (the danger outline goes on those cards). */
export function lowestRank(cards) {
  let low = Infinity;
  for (const c of cards) low = Math.min(low, RANK_VALUES[c.rank] ?? Infinity);
  return low;
}

/** "kim wins the tournament!" / "kim and bo share the win!" / "You win the tournament!" */
export function tournamentWinnerLine(winners, me) {
  const w = list(winners);
  if (w.length === 0) return 'Tournament complete';
  if (w.length === 1) return w[0] === me ? 'You win the tournament!' : `${w[0]} wins the tournament!`;
  // me first ("You and kim"); a username keeps its own case
  const names = [...w.filter((u) => u === me).map(() => 'You'), ...w.filter((u) => u !== me)];
  return `${joinNames(names)} share the win!`;
}

/** "dan won Cut for a buck" / "You won Cut for a buck" */
export function cutWonLine(cut, me) {
  if (!cut?.winner) return '';
  return cut.winner === me ? 'You won Cut for a buck' : `${cut.winner} won Cut for a buck`;
}

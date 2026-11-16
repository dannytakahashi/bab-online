/**
 * The over-trump rule (owner 2026-11-11): the card just played is a trump
 * or joker, the lead is not trump (a joker lead is), and it takes the trick
 * from an OPPONENT whose winning card was a trump or joker.
 *
 * Each row also states what the pre-2026-11-11 detector (last card vs the
 * one before it: both trump, lead not trump, higher rank) answered; the
 * rows where it was wrong are marked, and `legacyDetect` below is a copy of
 * it, so the table proves each of them fails on the old function. The
 * rows are the shared contract/rules/legality-cases.json `tricks`.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { isOverTrump, trickWinnerIndex, isTrumpCard } from './overTrump.js';
import { RANK_VALUES } from '../constants/ranks.js';

const SPADES = { suit: 'spades', rank: '7' };
const NO_TRUMP = { suit: 'joker', rank: 'LO' }; // a flipped joker: only the jokers are trump

const SUITS = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs', j: 'joker' };
/** '1:Kh 2:5s 3:HIj' → [{position, card}] in play order */
const trick = (spec) => spec.split(' ').map((t) => {
  const [pos, card] = t.split(':');
  return { position: Number(pos), card: { rank: card.slice(0, -1), suit: SUITS[card.slice(-1)] } };
});

/** GameScene.detectOverTrump before 2026-11-11 (window.ModernUtils.RANK_VALUES is RANK_VALUES). */
function legacyDetect(t, trump) {
  if (!t || t.length < 3 || !trump) return false;
  const current = t[t.length - 1].card;
  const previous = t[t.length - 2].card;
  const lead = t[0].card;
  const isTrumpOrJoker = (c) => c.suit === trump.suit || c.suit === 'joker';
  return isTrumpOrJoker(current) && isTrumpOrJoker(previous) &&
    RANK_VALUES[current.rank] > RANK_VALUES[previous.rank] && !isTrumpOrJoker(lead);
}

// The rows live in the shared table (contract/rules/legality-cases.json
// `tricks`), which Jest and XCTest run too: [name, trick, trump, expected, oldWasWrong]
const TABLE = createRequire(import.meta.url)('../../../contract/rules/legality-cases.json');
const trumpOf = (code) => ({ rank: code.slice(0, -1), suit: SUITS[code.slice(-1)] });
const CASES = TABLE.tricks.map((r) => [r.name, r.trick, trumpOf(r.trump), r.overTrump, r.oldDetectorWrong]);

describe('isOverTrump: the case table', () => {
  it.each(CASES)('%s', (_name, spec, trump, expected, oldWasWrong) => {
    const t = trick(spec);
    expect(isOverTrump(t, trump)).toBe(expected);
    // the old detector agreed except on the marked rows
    expect(legacyDetect(t, trump) !== expected).toBe(oldWasWrong);
  });

  it('every row the old detector got wrong is a false over-trump on a partner\'s winning trump', () => {
    const wrong = CASES.filter((c) => c[4]);
    expect(wrong.length).toBeGreaterThanOrEqual(3);
    for (const [, spec, trump, expected] of wrong) {
      expect(expected).toBe(false);
      expect(legacyDetect(trick(spec), trump)).toBe(true);
    }
  });

  it.each(TABLE.tricks.map((r) => [r.name, r]))('winner so far: %s', (_name, row) => {
    const t = trick(row.trick);
    expect(t[trickWinnerIndex(t, trumpOf(row.trump))].position).toBe(row.winner);
  });

  it('nothing to judge without a trump or with fewer than 3 cards', () => {
    expect(isOverTrump(trick('1:Kh 2:5s 3:9s'), null)).toBe(false);
    expect(isOverTrump([], SPADES)).toBe(false);
    expect(isOverTrump(null, SPADES)).toBe(false);
  });
});

describe('trickWinnerIndex mirrors server rules.determineWinner', () => {
  const rules = createRequire(import.meta.url)('../../../server/game/rules.js');
  const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck = [...suits.flatMap((s) => ranks.map((r) => ({ suit: s, rank: r }))), { suit: 'joker', rank: 'HI' }, { suit: 'joker', rank: 'LO' }];

  it('on 5000 random 4-card tricks, every trump (a joker flip included) and every lead seat', () => {
    let seed = 7;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let k = 0; k < 5000; k++) {
      const pool = [...deck];
      const cards = [0, 1, 2, 3].map(() => pool.splice(rand(pool.length), 1)[0]);
      const trump = rand(10) === 0 ? NO_TRUMP : { suit: suits[rand(4)], rank: '2' };
      const lead = 1 + rand(4);
      const played = cards.map((card, i) => ({ card, position: ((lead - 1 + i) % 4) + 1 }));
      const byPos = [];
      for (const p of played) byPos[p.position - 1] = p.card;
      const server = rules.determineWinner(byPos, lead, trump);
      expect(played[trickWinnerIndex(played, trump)].position).toBe(server);
    }
  });

  it('isTrumpCard: the trump suit and both jokers', () => {
    expect(isTrumpCard({ suit: 'spades', rank: '2' }, SPADES)).toBe(true);
    expect(isTrumpCard({ suit: 'joker', rank: 'LO' }, SPADES)).toBe(true);
    expect(isTrumpCard({ suit: 'hearts', rank: 'A' }, SPADES)).toBe(false);
    expect(isTrumpCard({ suit: 'spades', rank: 'A' }, NO_TRUMP)).toBe(false);
  });
});

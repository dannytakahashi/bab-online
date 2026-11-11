/**
 * The over-trump rule (owner 2026-11-11): the card just played is a trump
 * or joker, the lead is not trump (a joker lead is), and it takes the trick
 * from an OPPONENT whose winning card was a trump or joker.
 *
 * Each row also states what the pre-2026-11-11 detector (last card vs the
 * one before it: both trump, lead not trump, higher rank) answered; the
 * rows where it was wrong are marked, and `legacyDetect` below is a copy of
 * it, so the table proves each of them fails on the old function.
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

// [name, trick, trump, expected, oldWasWrong]
const CASES = [
  // genuine over-trumps
  ['opponent ruffs, the next player trumps higher', '1:Kh 2:5s 3:9s', SPADES, true, false],
  ['an over-trump of an over-trump', '1:Kh 2:5s 3:9s 4:Js', SPADES, true, false],
  ['the 4th seat over-trumps the 3rd (the leader is its opponent)', '1:Kh 2:Ah 3:5s 4:9s', SPADES, true, false],
  ['LO joker over the opponent\'s trump ace', '1:Kh 2:As 3:LOj', SPADES, true, false],
  ['HI joker over the opponent\'s LO joker', '1:Kh 2:LOj 3:HIj', SPADES, true, false],
  ['no-trump hand: HI over the opponent\'s LO', '1:Kh 2:LOj 3:HIj', NO_TRUMP, true, false],
  // over a PARTNER's winning trump: never an over-trump
  ['over my partner\'s trump (the opponent between them under-trumped)', '1:Kh 2:9s 3:5s 4:Js', SPADES, false, true],
  ['beats the opponent\'s under-trump, not the partner\'s winning 9', '1:Kh 2:9s 3:5s 4:7s', SPADES, false, true],
  ['both jokers: HI over the partner\'s LO, the opponent under-trumped', '1:Kh 2:LOj 3:2s 4:HIj', SPADES, false, true],
  ['no-trump hand: HI over the partner\'s LO', '1:Kh 2:LOj 3:5h 4:HIj', NO_TRUMP, false, false],
  ['partner ruffed, the next opponent followed, I trump higher', '1:Kh 2:5s 3:2h 4:9s', SPADES, false, false],
  // trump leads (a joker lead is a trump lead)
  ['a trump lead, then a higher trump', '1:5s 2:9s 3:Js', SPADES, false, false],
  ['a trump lead, a higher trump by the 4th seat', '1:5s 2:2s 3:3s 4:Js', SPADES, false, false],
  ['the HI joker led: the opponents\' forced trumps', '1:HIj 2:As 3:2s 4:Ks', SPADES, false, false],
  ['the LO joker led, the HI joker over it', '1:LOj 2:2s 3:HIj', SPADES, false, false],
  ['no-trump hand: LO led, HI over it', '1:LOj 2:5h 3:HIj', NO_TRUMP, false, false],
  // not over a winning trump
  ['the first trump of the trick (a ruff)', '1:Kh 2:Ah 3:2s', SPADES, false, false],
  ['an under-trump of the opponent', '1:Kh 2:9s 3:5s', SPADES, false, false],
  ['a slough after an opponent ruffed', '1:Kh 2:5s 3:2d', SPADES, false, false],
  ['no-trump hand: a spade is not a trump', '1:Kh 2:LOj 3:As', NO_TRUMP, false, false],
  ['no-trump hand: the first joker of the trick', '1:Kh 2:As 3:LOj', NO_TRUMP, false, false],
  ['a lead and one card', '1:Kh 2:5s', SPADES, false, false],
];

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

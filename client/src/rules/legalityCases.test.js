/**
 * The shared case table (contract/rules/legality-cases.json `legality`)
 * against the web copy of the rules, and the web copy against the server's
 * on random deals. Jest runs the same rows on server/game/rules.js, XCTest on
 * CardLegality.swift.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { getLegalCards, isLegalMove } from './legality.js';

const require = createRequire(import.meta.url);
const TABLE = require('../../../contract/rules/legality-cases.json');
const rules = require('../../../server/game/rules.js');

const SUITS = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs', j: 'joker' };
const card = (code) => ({ rank: code.slice(0, -1), suit: SUITS[code.slice(-1)] });
const code = (c) => `${c.rank}${c.suit === 'joker' ? 'j' : c.suit[0]}`;

describe('legality-cases.json: web getLegalCards', () => {
  it.each(TABLE.legality.map((r) => [r.name, r]))('%s', (_name, row) => {
    const hand = row.hand.map(card);
    const lead = row.lead ? card(row.lead.card) : null;
    const leadPosition = row.lead ? row.lead.position : row.position;
    const legal = getLegalCards(hand, lead, row.lead === null, card(row.trump), row.trumpBroken, row.position, leadPosition);
    expect(legal.map(code)).toEqual(row.legal);
    // an illegal card always says why
    for (const c of hand.filter((h) => !row.legal.includes(code(h)))) {
      const r = isLegalMove(c, hand, lead, row.lead === null, card(row.trump), row.trumpBroken, row.position, leadPosition);
      expect(r.legal).toBe(false);
      expect(typeof r.reason).toBe('string');
    }
  });
});

describe('web legality agrees with server rules.isLegalPlay', () => {
  const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck = [...suits.flatMap((s) => ranks.map((r) => ({ suit: s, rank: r }))), { suit: 'joker', rank: 'HI' }, { suit: 'joker', rank: 'LO' }];

  it('on 5000 random positions: every hand size, trump (a joker flip included), lead and seat', () => {
    let seed = 11;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let k = 0; k < 5000; k++) {
      const pool = [...deck];
      const trump = pool.splice(rand(pool.length), 1)[0];
      // a HI lead on every 5th position, so the forcing rule is exercised
      const leadCard = rand(5) === 0 && trump.rank !== 'HI' ? pool.splice(pool.findIndex((c) => c.rank === 'HI'), 1)[0] : pool.splice(rand(pool.length), 1)[0];
      const hand = Array.from({ length: 1 + rand(13) }, () => pool.splice(rand(pool.length), 1)[0]);
      const isLeading = rand(3) === 0;
      const position = 1 + rand(4);
      const leadPosition = isLeading ? position : 1 + ((position + rand(3)) % 4);
      const trumpBroken = rand(2) === 0;
      const web = getLegalCards(hand, isLeading ? null : leadCard, isLeading, trump, trumpBroken, position, leadPosition);
      const server = hand.filter((c) => rules.isLegalPlay(c, hand, {
        leadCard: isLeading ? null : leadCard, isLeading, trump, trumpBroken, position, leadPosition,
      }));
      expect(web.map(code)).toEqual(server.map(code));
    }
  });
});

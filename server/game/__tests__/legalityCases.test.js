/**
 * The shared case table (contract/rules/legality-cases.json) against the
 * server copy of the rules. The web (Vitest) and iOS (XCTest) copies run the
 * same rows.
 */

const path = require('path');
const rules = require('../rules');

const table = require(path.join(__dirname, '..', '..', '..', 'contract', 'rules', 'legality-cases.json'));

const SUITS = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs', j: 'joker' };
const card = (code) => ({ rank: code.slice(0, -1), suit: SUITS[code.slice(-1)] });
const code = (c) => `${c.rank}${c.suit[0] === 'j' ? 'j' : c.suit[0]}`;

describe('legality-cases.json: server rules.isLegalPlay', () => {
    test('the table has rows of every kind', () => {
        expect(table.legality.length).toBeGreaterThanOrEqual(20);
        expect(table.tricks.length).toBeGreaterThanOrEqual(20);
        for (const row of table.legality) expect(row.legal.every((c) => row.hand.includes(c))).toBe(true);
    });

    test.each(table.legality.map((r) => [r.name, r]))('%s', (_name, row) => {
        const hand = row.hand.map(card);
        const trick = {
            leadCard: row.lead ? card(row.lead.card) : null,
            isLeading: row.lead === null,
            trump: card(row.trump),
            trumpBroken: row.trumpBroken,
            position: row.position,
            leadPosition: row.lead ? row.lead.position : null,
        };
        const legal = hand.filter((c) => rules.isLegalPlay(c, hand, trick)).map(code);
        expect(legal).toEqual(row.legal);
        // the bot fallback plays the first of them
        expect(code(rules.firstLegalCard(hand, trick))).toBe(row.legal[0]);
    });
});

describe('legality-cases.json: server rules.determineWinner on the full tricks', () => {
    const full = table.tricks.filter((r) => r.trick.split(' ').length === 4);

    test('enough full tricks to matter', () => {
        expect(full.length).toBeGreaterThanOrEqual(12);
    });

    test.each(full.map((r) => [r.name, r]))('%s', (_name, row) => {
        const plays = row.trick.split(' ').map((t) => t.split(':'));
        const byPos = [];
        for (const [pos, c] of plays) byPos[Number(pos) - 1] = card(c);
        expect(rules.determineWinner(byPos, Number(plays[0][0]), card(row.trump))).toBe(row.winner);
    });
});

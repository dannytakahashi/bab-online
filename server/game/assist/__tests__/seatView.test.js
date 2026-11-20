/**
 * seatView (plan §3.2): the pinned key set, frozen copies, the seat's own
 * hand only, and seatView.js as the only engine file that reads a game.
 */

const fs = require('fs');
const path = require('path');
const { seatView, KEYS } = require('../seatView');
const { advise } = require('../advise');
const { tableAt, card } = require('../sim/table');
const { playStateGame } = require('../sim/stateGame');
const { openTrick } = require('../../tableView');
const cardMemory = require('../../bot/cardMemory');

const EIGHT = () => tableAt({
    handSize: 8, trump: '5h',
    hands: { 1: ['HI', 'Ah', '9h', '4h', 'Ac', 'Kc', '7d', '3s'], 2: ['2c', '3c', '4c', '5c', '6c', '7c', '8c', '9c'] },
    bids: [null, '1', '2', '0'], turn: 1
});

describe('seatView', () => {
    test('the key set is pinned', () => {
        expect(KEYS).toEqual([
            'position', 'partner', 'others', 'names',
            'hand', 'trump', 'isTrumpBroken', 'handSize',
            'stage', 'turnKey', 'currentTurn',
            'playerBids', 'score', 'currentHand',
            'playedCards', 'leadCard', 'leadPosition',
            'playContext', 'memory', 'legal'
        ]);
        const v = seatView(EIGHT(), 1);
        expect(Object.keys(v)).toEqual(KEYS);
        expect(Object.keys(v.playContext)).toEqual(['playerBids', 'bids', 'tricks', 'team1Mult', 'team2Mult']);
    });

    test('names, pair, own hand, bids and score from the seat\'s side', () => {
        const g = EIGHT();
        g.score = { team1: 40, team2: 75 };
        const v = seatView(g, 1);
        expect(v.position).toBe(1);
        expect(v.partner).toBe(3);
        expect(v.others).toEqual([2, 4]);
        expect(v.names).toEqual({ 1: 'Alice', 2: 'Carol', 3: 'Bob', 4: 'Dan' });
        expect(v.hand).toEqual(['HI', 'Ah', '9h', '4h', 'Ac', 'Kc', '7d', '3s'].map(card));
        expect(v.stage).toBe('bid');
        expect(v.turnKey).toBe(g.turnKey());
        expect(v.score).toEqual({ mine: 40, theirs: 75 });
        expect(seatView(g, 2).score).toEqual({ mine: 75, theirs: 40 });
        expect(seatView(g, 2).others).toEqual([3, 1]);
        expect(v.playerBids).toEqual([undefined, '1', '2', '0']);
        // Bids: every valid bid (no 2B without a B on the table)
        expect(v.legal).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', 'B']);
    });

    test('frozen deep copies: the engine cannot touch the game through it', () => {
        const g = EIGHT();
        const v = seatView(g, 1);
        expect(Object.isFrozen(v)).toBe(true);
        for (const k of ['hand', 'trump', 'names', 'playerBids', 'score', 'playContext', 'memory', 'legal']) expect(Object.isFrozen(v[k])).toBe(true);
        expect(Object.isFrozen(v.hand[0])).toBe(true);
        expect(() => { 'use strict'; v.hand.push(card('2s')); }).toThrow(TypeError);
        // Copies, not the game's own objects (which stay unfrozen)
        const own = g.getHand(g.seat(1).seatSocketId);
        expect(v.hand[0]).not.toBe(own[0]);
        expect(Object.isFrozen(own[0])).toBe(false);
        expect(v.trump).not.toBe(g.trump);
        expect(v.playerBids).not.toBe(g.playerBids);
        // advise leaves view and game alone
        const before = JSON.stringify(own);
        advise(v);
        expect(JSON.stringify(own)).toBe(before);
    });

    test('null outside a bid or play stage', () => {
        const g = EIGHT();
        expect(seatView(g, 1)).not.toBeNull();
        g.transition('BIDDING', 'REDEAL');
        expect(seatView(g, 1)).toBeNull();
    });

    test('play: legal cards, the table, the contract and the memory from the public record', () => {
        const g = tableAt({
            handSize: 3, trump: '2s', stage: 'play',
            hands: { 3: ['Kh', '4h', '9d'] },
            bids: ['1', '1', '0', '0'], turn: 3,
            tricks: [], open: { lead: 2, cards: ['5h'] }
        });
        const v = seatView(g, 3);
        expect(v.stage).toBe('play');
        expect(v.playedCards[1]).toEqual(card('5h'));
        expect(v.leadCard).toEqual(card('5h'));
        expect(v.leadPosition).toBe(2);
        expect(v.legal).toEqual([card('Kh'), card('4h')]);
        expect(v.playContext.bids).toEqual({ team1: 1, team2: 1 });
        expect(v.memory).toEqual(cardMemory.fromHistory(g.trump, g.trickHistory, openTrick(g)));
        expect(v.memory.playedCards).toEqual([{ suit: 'hearts', rank: '5', position: 2, trickIndex: 0, isLead: true }]);
    });

    test('a seeded game: views at every turn match the game and never carry another hand', () => {
        let checked = 0;
        playStateGame({
            seed: 7, hands: 4,
            onTurn(game, pos) {
                const v = seatView(game, pos);
                expect(v.currentTurn).toBe(pos);
                expect(v.hand).toEqual(game.getHand(game.seat(pos).seatSocketId));
                const blob = JSON.stringify(v);
                // Every card in the view is the seat's own, the trump card or a played one
                const seen = new Set([...v.hand, ...v.memory.playedCards, v.trump].map((c) => `${c.suit}:${c.rank}`));
                const walk = (o) => {
                    if (!o || typeof o !== 'object') return;
                    if (typeof o.suit === 'string' && typeof o.rank === 'string') expect(seen.has(`${o.suit}:${o.rank}`)).toBe(true);
                    for (const k of Object.keys(o)) walk(o[k]);
                };
                walk(v);
                expect(blob).not.toMatch(/socket|bot:/i);
                checked++;
            }
        });
        expect(checked).toBeGreaterThan(100);
    });
});

describe('only seatView.js reads the game', () => {
    const dir = path.join(__dirname, '..');
    const engine = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));

    test('the engine files', () => {
        expect(engine.sort()).toEqual(['advise.js', 'copy.js', 'curriculum.js', 'explain.js', 'reasons.js', 'seatView.js']);
    });

    test.each(engine.filter((f) => f !== 'seatView.js'))('%s has no game. and requires no game module', (f) => {
        const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(src).not.toMatch(/\bgame\s*\.|\bgame\s*\[/);
        expect(src).not.toMatch(/require\(['"][^'"]*(GameState|GameManager|socket|seatLifecycle|BotPlayer|BotController|database)/);
        // Nothing that makes a bot, draws, waits, or touches the shared search settings
        expect(src).not.toMatch(/createSeatBot|new BotPlayer|getActionDelay|decideDraw|pickBotPersonality|randomStockPic|sendBotChat|Math\.random|Date\.|uuid/);
        expect(src).not.toMatch(/SEARCH\.[A-Za-z]+\s*=[^=]|SEARCH\[[^\]]+\]\s*=[^=]/);
    });
});

/**
 * The Records superlatives (server/utils/superlatives.js): pure, over
 * gameRecords documents as fillRecords projects them.
 */

const {
    computeSuperlatives, createSuperlatives, seatNames, isSolo, SUPERLATIVE_MIN_GAMES, TITLE_IDS
} = require('../superlatives');

/** One seat's counters (the 13 of seatStatsDelta; totalBags optional). */
const delta = (o = {}) => ({
    gamesPlayed: 1, wins: 0, losses: 1, draws: 0, totalPoints: 100,
    totalTricksBid: 20, totalTricksTaken: 20, totalHands: 13, totalSets: 0,
    totalSetPoints: 0, totalFaults: 0, totalHSI: 1300, ...o
});

/**
 * A human game: seats {pos: [name, deltaOverrides]} for all four; names
 * map written unless `legacy`.
 */
function humanGame(seats, { legacy = false, assist, extra = {} } = {}) {
    const byPosition = {};
    const names = {};
    for (const [pos, [name, o]] of Object.entries(seats)) {
        byPosition[pos] = delta(o);
        names[pos] = name;
    }
    const team = (a, b) => [a, b].filter((p) => seats[p]).map((p) => seats[p][0]);
    const sd = { bucket: 'stats', byPosition };
    if (!legacy) sd.names = names;
    if (assist) sd.assist = assist;
    return { team1Score: 300, team2Score: 200, team1Players: team(1, 3), team2Players: team(2, 4), statsDeltas: sd, ...extra };
}

/** A solo game: `name` at seat 1, three native bots. */
function soloGame(name, o = {}, { legacy = false } = {}) {
    const sd = { bucket: 'botStats', byPosition: { 1: delta(o) } };
    if (!legacy) sd.names = { 1: name };
    return {
        withBots: true, team1Score: 300, team2Score: 200,
        team1Players: [name], team2Players: [], team1Bots: ['🤖 Zach'], team2Bots: ['🤖 Ivy', '🤖 Mary'], statsDeltas: sd
    };
}

const times = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const byId = (list) => Object.fromEntries(list.map((s) => [s.id, s]));
/** Four regulars who each played `n` identical games together. */
const regulars = (n, overrides = {}) => times(n, () => humanGame({
    1: ['Ann', overrides.Ann], 2: ['Ben', overrides.Ben], 3: ['Cat', overrides.Cat], 4: ['Dan', overrides.Dan]
}));

describe('the titles', () => {
    test('each of the six, in wire order, with its detail', () => {
        const games = [
            ...regulars(5, {
                Ann: { totalTricksBid: 10, totalTricksTaken: 13, totalBags: 3, totalHSI: 2000, totalSets: 4 },
                Ben: { totalBags: 1, totalHSI: 1000 },
                Cat: { totalBags: 0, totalHSI: 1500, totalSets: 1 },
                Dan: { totalBags: 2, totalHSI: 1300 }
            }),
            // Ben also asked for /help in two of them
            humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }, { assist: { 2: { help: 4 } } }),
            humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }, { assist: { 2: { help: 3 }, 4: { help: 1 } } }),
            ...times(5, () => soloGame('Eve')),
            soloGame('Ann')
        ];
        const out = computeSuperlatives(games);
        expect(out.map((s) => s.id)).toEqual(TITLE_IDS);
        expect(TITLE_IDS).toEqual(['bagBoy', 'luckyDuck', 'cursed', 'botFriends', 'helpFromFriends', 'anchor']);
        const s = byId(out);
        // Ann: 15 bags in 8 games (the two help games and her solo game: 0)
        expect(s.bagBoy).toEqual({ id: 'bagBoy', title: 'Bag Boy', names: ['Ann'], detail: '1.9 bags a game' });
        // Ann: (5*2000 + 3*1300) / (8*13) = 133.65...
        expect(s.luckyDuck).toEqual({ id: 'luckyDuck', title: 'Lucky Duck', names: ['Ann'], detail: '133.7 avg HSI' });
        // Ben: (5*1000 + 2*1300) / (7*13) = 83.5
        expect(s.cursed).toEqual({ id: 'cursed', title: 'Cursed', names: ['Ben'], detail: '83.5 avg HSI' });
        expect(s.botFriends).toEqual({ id: 'botFriends', title: 'Some of my best friends are bots', names: ['Eve'], detail: '5 solo games' });
        expect(s.helpFromFriends).toEqual({ id: 'helpFromFriends', title: 'A little help from my friends', names: ['Ben'], detail: '7 /help uses' });
        // Ann: 20 sets / 104 hands = 19%
        expect(s.anchor).toEqual({ id: 'anchor', title: 'Anchor', names: ['Ann'], detail: '19% of hands set' });
    });

    test('a count title whose best value is 0 is left out; the HSI titles still show', () => {
        const out = computeSuperlatives(regulars(5, { Ann: { totalBags: 0 }, Ben: { totalBags: 0 }, Cat: { totalBags: 0 }, Dan: { totalBags: 0 } }));
        expect(out.map((s) => s.id)).toEqual(['luckyDuck', 'cursed']);
        // everyone tied on HSI: both list all four's first three
        expect(byId(out).luckyDuck).toEqual({ id: 'luckyDuck', title: 'Lucky Duck', names: ['Ann', 'Ben', 'Cat'], detail: '100.0 avg HSI (+1 more)' });
    });

    test('no records, or nobody with enough games: an empty list', () => {
        expect(computeSuperlatives([])).toEqual([]);
        expect(computeSuperlatives(regulars(SUPERLATIVE_MIN_GAMES - 1, { Ann: { totalBags: 9 } }))).toEqual([]);
    });

    test('singular details', () => {
        const s = byId(computeSuperlatives([...regulars(5), soloGame('Ann')].map((g, i) => (i === 0
            ? { ...g, statsDeltas: { ...g.statsDeltas, assist: { 1: { help: 1 } } } } : g)), { minGames: 1 }));
        expect(s.botFriends.detail).toBe('1 solo game');
        expect(s.helpFromFriends.detail).toBe('1 /help use');
    });
});

describe('who qualifies', () => {
    test('the minimum is SUPERLATIVE_MIN_GAMES (5) games in the period; 4 is not enough', () => {
        expect(SUPERLATIVE_MIN_GAMES).toBe(5);
        const games = [
            ...regulars(4, { Ann: { totalBags: 9 } }),
            // Ben, Cat and Dan have a 5th game, Ann does not
            humanGame({ 1: ['Zed'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] })
        ];
        const s = byId(computeSuperlatives(games));
        expect(s.bagBoy).toBeUndefined(); // only Ann bagged, and she has 4 games
        expect(s.luckyDuck.names).toEqual(['Ben', 'Cat', 'Dan']);
        // one more game and she qualifies
        const more = byId(computeSuperlatives([...games, humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] })]));
        expect(more.bagBoy.names).toEqual(['Ann']);
    });

    test('humans only: bot personas, [deleted] and empty names never win', () => {
        const games = [
            ...times(6, () => humanGame({ 1: ['[deleted]', { totalBags: 9, totalSets: 13 }], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] })),
            // a record that would name a bot persona at a seat (it never
            // should): skipped for that seat, never a winner
            ...times(6, () => ({ ...soloGame('🤖 Zach', { totalBags: 9 }) })),
            ...times(6, () => humanGame({ 1: ['', { totalBags: 9 }], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }))
        ];
        const all = computeSuperlatives(games, { minGames: 1 });
        const names = all.flatMap((s) => s.names);
        expect(names).not.toContain('[deleted]');
        expect(names).not.toContain('🤖 Zach');
        expect(names).not.toContain('');
        expect(byId(all).bagBoy).toBeUndefined();
        expect(byId(all).botFriends).toBeUndefined();
    });

    test('bots never get a value: only byPosition (human owner) seats are counted', () => {
        const s = byId(computeSuperlatives(times(5, () => soloGame('Eve', { totalBags: 2 }))));
        expect(s.bagBoy.names).toEqual(['Eve']);
        for (const t of Object.values(s)) expect(t.names).toEqual(['Eve']);
    });
});

describe('ties', () => {
    test('up to 3 names, alphabetical ignoring case; more add (+N more) to the detail', () => {
        const names = ['dora', 'Bob', 'alice', 'Carl', 'Eve'];
        const games = names.flatMap((n) => times(5, () => soloGame(n, { totalBags: 2 })));
        const s = byId(computeSuperlatives(games));
        expect(s.bagBoy).toEqual({ id: 'bagBoy', title: 'Bag Boy', names: ['alice', 'Bob', 'Carl'], detail: '2.0 bags a game (+2 more)' });
        expect(s.botFriends.names).toEqual(['alice', 'Bob', 'Carl']);
        expect(s.botFriends.detail).toBe('5 solo games (+2 more)');
    });

    test('exactly 3 tied: no (+N more); a ratio that only rounds the same is not a tie', () => {
        const games = [
            ...times(5, () => soloGame('Ann', { totalBags: 2 })),
            ...times(5, () => soloGame('Ben', { totalBags: 2 })),
            ...times(5, () => soloGame('Cat', { totalBags: 2 })),
            // 2.04 a game: shows as 2.0, but more
            ...times(4, () => soloGame('Dan', { totalBags: 2 })), soloGame('Dan', { totalBags: 2.2 })
        ];
        expect(byId(computeSuperlatives(games)).bagBoy).toEqual({ id: 'bagBoy', title: 'Bag Boy', names: ['Dan'], detail: '2.0 bags a game' });
        expect(byId(computeSuperlatives(games.slice(0, 15))).bagBoy.detail).toBe('2.0 bags a game');
        expect(byId(computeSuperlatives(games.slice(0, 15))).bagBoy.names).toEqual(['Ann', 'Ben', 'Cat']);
    });

    test('ratios tie exactly across different game counts (2 a game over 5 and over 10 games)', () => {
        const games = [...times(5, () => soloGame('Ann', { totalBags: 2 })), ...times(10, () => soloGame('Ben', { totalBags: 2 }))];
        const s = byId(computeSuperlatives(games));
        expect(s.bagBoy.names).toEqual(['Ann', 'Ben']);
        expect(s.botFriends.names).toEqual(['Ben']);
    });
});

describe('solo games (Some of my best friends are bots)', () => {
    test('one human seat and three native bots', () => {
        expect(isSolo(soloGame('Eve'))).toBe(true);
    });

    test('a resign bot keeps its owner in teamNPlayers: not solo (two humans, two native bots)', () => {
        const resigned = {
            withBots: true, team1Players: ['Eve', 'Fay'], team2Players: [], team1Bots: [], team2Bots: ['🤖 Ivy', '🤖 Mary'],
            statsDeltas: { bucket: 'botStats', byPosition: { 1: delta(), 3: delta() }, names: { 1: 'Eve', 3: 'Fay' } }
        };
        expect(isSolo(resigned)).toBe(false);
        const s = byId(computeSuperlatives(times(5, () => resigned)));
        expect(s.botFriends).toBeUndefined();
        expect(s.luckyDuck.names).toEqual(['Eve', 'Fay']);
    });

    test('lazy seats are human (their owner is in teamNPlayers): a lazy game with 3 other humans is not solo', () => {
        expect(isSolo(humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }))).toBe(false);
    });

    test('a game the /help or tutorial marking moved to the bot scope (withBots, empty teamNBots) is not solo', () => {
        const assisted = humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }, { extra: { withBots: true, team1Bots: [], team2Bots: [] } });
        expect(isSolo(assisted)).toBe(false);
    });

    test('two humans and two bots, or a human record without bots (the human scope projection): not solo', () => {
        const two = { team1Players: ['Eve'], team2Players: ['Fay'], team1Bots: ['🤖 Zach'], team2Bots: ['🤖 Ivy'] };
        expect(isSolo(two)).toBe(false);
        const noBots = { team1Players: ['Eve'], team2Players: [] };
        expect(isSolo(noBots)).toBe(false);
    });
});

describe('/help (A little help from my friends)', () => {
    test('counts statsDeltas.assist[pos].help only: a tutorial seat with no /help of its own counts 0 (its tips are not /help)', () => {
        const tutorial = times(5, () => humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }, { assist: { 1: { help: 0, tutorial: true } } }));
        expect(byId(computeSuperlatives(tutorial)).helpFromFriends).toBeUndefined();
        const mixed = times(5, () => humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }, { assist: { 1: { help: 2, tutorial: true }, 3: { help: 1 } } }));
        expect(byId(computeSuperlatives(mixed)).helpFromFriends).toMatchObject({ names: ['Ann'], detail: '10 /help uses' });
    });

    test('a malformed assist entry is ignored', () => {
        const games = times(5, () => humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }, { assist: { 1: { help: '9' }, 2: { help: -3 }, 3: 'x' } }));
        expect(byId(computeSuperlatives(games)).helpFromFriends).toBeUndefined();
    });
});

describe('bags (Bag Boy)', () => {
    test('the per-hand totalBags wins over the net: a bore that took every trick has totalBags 0', () => {
        // took 24 on a bid of 20 overall, but the extra 4 came on bore hands (0 bags)
        const games = times(5, () => soloGame('Eve', { totalTricksBid: 20, totalTricksTaken: 24, totalBags: 0 }));
        expect(byId(computeSuperlatives(games)).bagBoy).toBeUndefined();
    });

    test('an older record (no totalBags) falls back to max(0, taken - bid) of that seat in that game', () => {
        const games = [
            ...times(3, () => soloGame('Eve', { totalTricksBid: 20, totalTricksTaken: 23 })),
            ...times(2, () => soloGame('Eve', { totalTricksBid: 20, totalTricksTaken: 15 }))
        ];
        expect(byId(computeSuperlatives(games)).bagBoy).toMatchObject({ names: ['Eve'], detail: '1.8 bags a game' });
    });
});

describe('seat names', () => {
    test('the names map when present', () => {
        expect(seatNames(humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }))).toEqual({ 1: 'Ann', 2: 'Ben', 3: 'Cat', 4: 'Dan' });
    });

    test('an older record (byPosition, no names): each team\'s seats in seat order against teamNPlayers', () => {
        const g = humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }, { legacy: true });
        expect(seatNames(g)).toEqual({ 1: 'Ann', 2: 'Ben', 3: 'Cat', 4: 'Dan' });
        // a bot game: only the human seats are in byPosition and in teamNPlayers
        expect(seatNames(soloGame('Eve', {}, { legacy: true }))).toEqual({ 1: 'Eve' });
        const mixed = {
            withBots: true, team1Players: ['Ann'], team2Players: ['Ben', 'Dan'], team1Bots: ['🤖 Zach'], team2Bots: [],
            statsDeltas: { byPosition: { 3: delta(), 2: delta(), 4: delta() } }
        };
        expect(seatNames(mixed)).toEqual({ 2: 'Ben', 3: 'Ann', 4: 'Dan' });
    });

    test('ambiguous (counts differ) or no per-seat counters: the record is skipped', () => {
        const g = humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }, { legacy: true });
        expect(seatNames({ ...g, team1Players: ['Ann'] })).toBeNull();
        expect(seatNames({ ...g, team2Players: ['Ben', 'Dan', 'Eve'] })).toBeNull();
        expect(seatNames({ ...g, team1Players: undefined })).toBeNull();
        // before 2026-11-15: no statsDeltas at all
        expect(seatNames({ team1Players: ['Ann', 'Cat'], team2Players: ['Ben', 'Dan'] })).toBeNull();
        expect(seatNames({ statsDeltas: { byPosition: {} } })).toBeNull();
        expect(seatNames({ statsDeltas: { names: { 1: 'Ann' } } })).toBeNull();
        // a names map missing a seat of byPosition is not guessed
        expect(seatNames({ ...g, statsDeltas: { ...g.statsDeltas, names: { 1: 'Ann', 2: 'Ben', 3: 'Cat' } } })).toBeNull();

        // skipped whole: Ann's ambiguous games do not count toward her 5
        const games = [...times(4, () => g), ...times(3, () => ({ ...g, team1Players: ['Ann'] }))];
        expect(computeSuperlatives(games)).toEqual([]);
        expect(computeSuperlatives([...games, g]).length).toBeGreaterThan(0);
    });

    test('a legacy record and a names-map record of the same player add up', () => {
        const games = [
            ...times(3, () => humanGame({ 1: ['Ann', { totalBags: 2 }], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] })),
            ...times(2, () => humanGame({ 1: ['Ann', { totalTricksBid: 20, totalTricksTaken: 22 }], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }, { legacy: true }))
        ];
        expect(byId(computeSuperlatives(games)).bagBoy).toMatchObject({ names: ['Ann'], detail: '2.0 bags a game' });
    });
});

test('createSuperlatives accumulates like computeSuperlatives (one add per record, then result)', () => {
    const games = [...regulars(5, { Ann: { totalBags: 3 } }), ...times(5, () => soloGame('Eve'))];
    const acc = createSuperlatives();
    for (const g of games) acc.add(g);
    acc.add(null);
    expect(acc.result()).toEqual(computeSuperlatives(games));
});

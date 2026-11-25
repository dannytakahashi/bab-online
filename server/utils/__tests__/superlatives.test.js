/**
 * The Records superlatives (server/utils/superlatives.js): pure, over
 * gameRecords documents as fillRecords projects them.
 */

const {
    computeSuperlatives, createSuperlatives, seatNames, isSolo, accountTotals, SUPERLATIVE_MIN_GAMES, TITLE_IDS, ACCOUNT_TITLE_IDS, ACCOUNT_FIELDS
} = require('../superlatives');

/** One seat's counters (the 12 of seatStatsDelta; `totalBags` and `spotOn` are not among them). */
const delta = ({ totalBags: _bags, spotOn: _spot, ...o } = {}) => ({
    gamesPlayed: 1, wins: 0, losses: 1, draws: 0, totalPoints: 100,
    totalTricksBid: 20, totalTricksTaken: 20, totalHands: 13, totalSets: 0,
    totalSetPoints: 0, totalFaults: 0, totalHSI: 1300, ...o
});

/**
 * statsDeltas for seats {pos: overrides}: a `totalBags` override goes to
 * statsDeltas.bags[pos] and a `spotOn` one to statsDeltas.exact[pos] (where
 * buildGameEndRecord writes them), the rest to byPosition[pos].
 */
function deltas(bucket, seatOverrides) {
    const sd = { bucket, byPosition: {} };
    for (const [pos, o] of Object.entries(seatOverrides)) {
        sd.byPosition[pos] = delta(o);
        if (o && o.totalBags !== undefined) (sd.bags = sd.bags || {})[pos] = o.totalBags;
        if (o && o.spotOn !== undefined) (sd.exact = sd.exact || {})[pos] = o.spotOn;
    }
    return sd;
}

/**
 * A human game: seats {pos: [name, deltaOverrides]} for all four; names
 * map written unless `legacy`.
 */
function humanGame(seats, { legacy = false, assist, extra = {} } = {}) {
    const names = {};
    for (const [pos, [name]] of Object.entries(seats)) names[pos] = name;
    const team = (a, b) => [a, b].filter((p) => seats[p]).map((p) => seats[p][0]);
    const sd = deltas('stats', Object.fromEntries(Object.entries(seats).map(([pos, [, o]]) => [pos, o])));
    if (!legacy) sd.names = names;
    if (assist) sd.assist = assist;
    return { team1Score: 300, team2Score: 200, team1Players: team(1, 3), team2Players: team(2, 4), statsDeltas: sd, ...extra };
}

/** A solo game: `name` at seat 1, three native bots. */
function soloGame(name, o = {}, { legacy = false } = {}) {
    const sd = deltas('botStats', { 1: o });
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

describe('My Quantitative (spot-on bids)', () => {
    test('only records with the counter count; one without it neither counts nor dilutes', () => {
        const counted = regulars(5, { Ann: { spotOn: 13 }, Ben: { spotOn: 6 }, Cat: { spotOn: 6 }, Dan: { spotOn: 6 } });
        // Ann's five more games ended before the counter: still games (the
        // 5-game minimum), never hands for this title
        const before = regulars(5, { Ann: {}, Ben: {}, Cat: {}, Dan: {} });
        const s = byId(computeSuperlatives([...counted, ...before]));
        expect(s.myQuantitative).toEqual({ id: 'myQuantitative', title: 'My Quantitative', names: ['Ann'], detail: '100% of bids spot on' });
    });

    test('left out while nobody has a counted game, and when the best is 0%', () => {
        expect(byId(computeSuperlatives(regulars(5))).myQuantitative).toBeUndefined();
        expect(byId(computeSuperlatives(regulars(5, { Ann: { spotOn: 0 }, Ben: { spotOn: 0 }, Cat: { spotOn: 0 }, Dan: { spotOn: 0 } }))).myQuantitative).toBeUndefined();
    });

    test('a count above the seat\'s hands is capped, a bad one ignored', () => {
        const games = regulars(5, { Ann: { spotOn: 99 }, Ben: { spotOn: 'x' }, Cat: { spotOn: -2 }, Dan: { spotOn: 1.5 } });
        expect(byId(computeSuperlatives(games)).myQuantitative).toMatchObject({ names: ['Ann'], detail: '100% of bids spot on' });
    });
});

describe('the titles', () => {
    test('each of the seven, in wire order, with its detail', () => {
        const games = [
            ...regulars(5, {
                Ann: { totalTricksBid: 10, totalTricksTaken: 13, totalBags: 3, totalHSI: 2000, totalSets: 4, spotOn: 2 },
                Ben: { totalBags: 1, totalHSI: 1000, spotOn: 5 },
                Cat: { totalBags: 0, totalHSI: 1500, totalSets: 1, spotOn: 8 },
                Dan: { totalBags: 2, totalHSI: 1300, spotOn: 6 }
            }),
            // Ben also asked for /help in two of them
            humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }, { assist: { 2: { help: 4 } } }),
            humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }, { assist: { 2: { help: 3 }, 4: { help: 1 } } }),
            ...times(5, () => soloGame('Eve')),
            soloGame('Ann')
        ];
        const out = computeSuperlatives(games);
        expect(out.map((s) => s.id)).toEqual(TITLE_IDS);
        expect(TITLE_IDS).toEqual(['bagBoy', 'luckyDuck', 'cursed', 'botFriends', 'helpFromFriends', 'myQuantitative', 'delusionsOfGrandeur']);
        const s = byId(out);
        // Ann: 15 bags in 8 games (the two help games and her solo game: 0)
        expect(s.bagBoy).toEqual({ id: 'bagBoy', title: 'Bag Boy', names: ['Ann'], detail: '1.9 bags a game' });
        // Ann: (5*2000 + 3*1300) / (8*13) = 133.65...
        expect(s.luckyDuck).toEqual({ id: 'luckyDuck', title: 'Lucky Duck', names: ['Ann'], detail: '133.7 avg HSI' });
        // Ben: (5*1000 + 2*1300) / (7*13) = 83.5
        expect(s.cursed).toEqual({ id: 'cursed', title: 'Cursed', names: ['Ben'], detail: '83.5 avg HSI' });
        expect(s.botFriends).toEqual({ id: 'botFriends', title: 'Some of my best friends are bots', names: ['Eve'], detail: '5 solo games' });
        expect(s.helpFromFriends).toEqual({ id: 'helpFromFriends', title: 'A little help from my friends', names: ['Ben'], detail: '7 /help uses' });
        // Cat: 40 spot-on bids / 65 hands of the five counted games = 62% (the
        // help and solo games carry no counter: neither counted nor diluting)
        expect(s.myQuantitative).toEqual({ id: 'myQuantitative', title: 'My Quantitative', names: ['Cat'], detail: '62% of bids spot on' });
        // Ann: 20 sets / 104 hands = 19%
        expect(s.delusionsOfGrandeur).toEqual({ id: 'delusionsOfGrandeur', title: 'Delusions of Grandeur', names: ['Ann'], detail: '19.2% of hands set' });
    });

    test('a count title whose best value is 0 is left out; the HSI titles still show', () => {
        const out = computeSuperlatives(regulars(5, { Ann: { totalBags: 0 }, Ben: { totalBags: 0 }, Cat: { totalBags: 0 }, Dan: { totalBags: 0 } }));
        expect(out.map((s) => s.id)).toEqual(['luckyDuck']);
        // everyone tied on HSI: Lucky Duck lists all four's first three, and
        // Cursed (the same value, the same people) is left out
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
        // a names map missing a seat of byPosition is not trusted: seat order
        // against teamNPlayers instead, and skipped if that is ambiguous too
        expect(seatNames({ ...g, statsDeltas: { ...g.statsDeltas, names: { 1: 'Ann', 2: 'Ben', 3: 'Cat' } } }))
            .toEqual({ 1: 'Ann', 2: 'Ben', 3: 'Cat', 4: 'Dan' });
        expect(seatNames({ ...g, team1Players: ['Ann'], statsDeltas: { ...g.statsDeltas, names: { 1: 'Ann', 2: 'Ben', 3: 'Cat' } } })).toBeNull();

        // skipped whole: Ann's ambiguous games do not count toward her 5
        const games = [...times(4, () => g), ...times(3, () => ({ ...g, team1Players: ['Ann'] }))];
        expect(computeSuperlatives(games)).toEqual([]);
        expect(computeSuperlatives([...games, g]).length).toBeGreaterThan(0);
    });

    test('the names map only while every seat\'s name is in its own team\'s teamNPlayers (odd seats team1, even team2)', () => {
        const g = humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] });
        // seat 1 named on the other team: not trusted, seat order instead
        expect(seatNames({ ...g, team1Players: ['Ben', 'Cat'], team2Players: ['Ann', 'Dan'] }))
            .toEqual({ 1: 'Ben', 2: 'Ann', 3: 'Cat', 4: 'Dan' });
        // a merged player in two seats: as often as the seats name them
        const merged = humanGame({ 1: ['Ann'], 2: ['Ben'], 3: ['Ann'], 4: ['Dan'] });
        expect(seatNames(merged)).toEqual({ 1: 'Ann', 2: 'Ben', 3: 'Ann', 4: 'Dan' });
        expect(seatNames({ ...merged, team1Players: ['Ann', 'Cat'] })).toEqual({ 1: 'Ann', 2: 'Ben', 3: 'Cat', 4: 'Dan' });
        // a non-string name in the map: seat order
        expect(seatNames({ ...g, statsDeltas: { ...g.statsDeltas, names: { ...g.statsDeltas.names, 2: 7 } } }))
            .toEqual({ 1: 'Ann', 2: 'Ben', 3: 'Cat', 4: 'Dan' });
        // a bot game: only the human seats
        const solo = soloGame('Eve');
        expect(seatNames({ ...solo, team1Players: ['Eva'] })).toEqual({ 1: 'Eva' });
    });

    test('a delete / rename / merge by the release before (teamNPlayers only) never lets the stale names map win', () => {
        // Ann has the most bags, Cat the best HSI
        const rec = () => humanGame({
            1: ['Ann', { totalBags: 9 }], 2: ['Ben', { totalBags: 1 }],
            3: ['Cat', { totalBags: 1, totalHSI: 2600 }], 4: ['Dan', { totalBags: 1 }]
        });
        // the release before's eraseAccount and renameEverywhere: '[deleted]'
        // and 'Kit' in team1Players, statsDeltas.names untouched
        const games = times(6, () => ({ ...rec(), team1Players: ['[deleted]', 'Kit'] }));
        expect(games[0].statsDeltas.names).toEqual({ 1: 'Ann', 2: 'Ben', 3: 'Cat', 4: 'Dan' });
        expect(seatNames(games[0])).toEqual({ 1: '[deleted]', 2: 'Ben', 3: 'Kit', 4: 'Dan' });
        const out = computeSuperlatives(games);
        const shown = out.flatMap((s) => s.names);
        for (const stale of ['Ann', 'Cat', '[deleted]']) expect(shown).not.toContain(stale);
        expect(byId(out).luckyDuck.names).toEqual(['Kit']);
        // the deleted seat's bags are nobody's: Bag Boy goes to the 1-bag seats
        expect(byId(out).bagBoy).toMatchObject({ names: ['Ben', 'Dan', 'Kit'], detail: '1.0 bags a game' });

        // a merge of Cat into Ann by the release before: Ann in both team1 seats
        const mergedGames = times(6, () => ({ ...rec(), team1Players: ['Ann', 'Ann'] }));
        expect(seatNames(mergedGames[0])).toEqual({ 1: 'Ann', 2: 'Ben', 3: 'Ann', 4: 'Dan' });
        expect(byId(computeSuperlatives(mergedGames)).luckyDuck.names).toEqual(['Ann']);
        expect(computeSuperlatives(mergedGames).flatMap((s) => s.names)).not.toContain('Cat');
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

describe('review fixes (2026-11-20)', () => {
    test('Bag Boy is per seat-game: a merge that left one player in two seats of a game averages them, not adds them', () => {
        // every seat 2 bags; Ann holds seats 1 and 3 in the first game
        const games = times(5, (i) => humanGame({
            1: ['Ann', { totalBags: 2 }], 2: ['Ben', { totalBags: 2 }], 3: [i === 0 ? 'Ann' : 'Cat', { totalBags: 2 }], 4: ['Dan', { totalBags: 2 }]
        }));
        expect(byId(computeSuperlatives(games)).bagBoy).toEqual({ id: 'bagBoy', title: 'Bag Boy', names: ['Ann', 'Ben', 'Dan'], detail: '2.0 bags a game' });
        // and a better real rate still wins: Ben 3 a game over Ann's 2 + 2 in one game
        const ben = times(5, (i) => humanGame({
            1: ['Ann', { totalBags: 2 }], 2: ['Ben', { totalBags: 3 }], 3: [i === 0 ? 'Ann' : 'Cat', { totalBags: 2 }], 4: ['Dan', { totalBags: 0 }]
        }));
        expect(byId(computeSuperlatives(ben)).bagBoy).toMatchObject({ names: ['Ben'], detail: '3.0 bags a game' });
        // that game counts once toward her 5: in 4 games (5 seats) nobody qualifies
        expect(computeSuperlatives(ben.slice(0, 4))).toEqual([]);
    });

    test('a record from before the per-seat counters still counts as a game (and a solo game) for whoever its teams name', () => {
        // 2026-11-13..15: bot personas, no statsDeltas
        const oldSolo = { withBots: true, team1Players: ['Eve'], team2Players: [], team1Bots: ['🤖 Mary'], team2Bots: ['🤖 A', '🤖 B'] };
        const s = byId(computeSuperlatives(times(5, () => oldSolo)));
        expect(s.botFriends).toEqual({ id: 'botFriends', title: 'Some of my best friends are bots', names: ['Eve'], detail: '5 solo games' });
        // no per-seat values from it: no HSI, bags or sets titles
        expect(Object.keys(s)).toEqual(['botFriends']);

        // old games no longer make up the 5 of a per-seat title (2026-11-24):
        // that takes 5 games with per-seat counters
        const mixed = [...times(4, () => ({ team1Players: ['Ann', 'Cat'], team2Players: ['Ben', 'Dan'] })), ...regulars(1, { Ann: { totalBags: 3 } })];
        expect(computeSuperlatives(mixed)).toEqual([]);
        expect(byId(computeSuperlatives([...mixed, ...regulars(4)])).bagBoy).toMatchObject({ names: ['Ann'], detail: '0.6 bags a game' });
        // '[deleted]', bot personas and a merge duplicate in the teams: as for named seats
        const odd = times(5, () => ({ withBots: true, team1Players: ['[deleted]', 'Fay'], team2Players: ['Fay'], team1Bots: [], team2Bots: ['🤖 Ivy'] }));
        const acc = createSuperlatives();
        for (const g of odd) acc.add(g);
        expect(acc.result()).toEqual([]);
        // Fay's 10 games (each record once) qualify her for the game-level
        // title; her 5 with per-seat counters do not reach 10 for the rest
        expect(computeSuperlatives([...odd, ...times(5, () => soloGame('Fay'))], { minGames: 10 }).map((t) => [t.id, t.names]))
            .toEqual([['botFriends', ['Fay']]]);
        expect(computeSuperlatives([...odd, ...times(5, () => soloGame('Fay'))], { minGames: 5 }).map((t) => t.id)).toEqual(['luckyDuck', 'botFriends']);
    });

    test('Cursed is left out when it is the same value as Lucky Duck (one qualifier); shown when they differ', () => {
        const one = byId(computeSuperlatives(times(5, () => soloGame('Eve', { totalHSI: 1700 }))));
        expect(one.luckyDuck).toMatchObject({ names: ['Eve'], detail: '130.8 avg HSI' });
        expect(one.cursed).toBeUndefined();
        const two = byId(computeSuperlatives([...times(5, () => soloGame('Eve', { totalHSI: 1700 })), ...times(5, () => soloGame('Fay'))]));
        expect(two.luckyDuck.names).toEqual(['Eve']);
        expect(two.cursed).toMatchObject({ names: ['Fay'], detail: '100.0 avg HSI' });
    });

    test('a count title whose best value only shows as 0 ("0.0 bags a game", "0.0% of hands set") is left out', () => {
        // one bag in 30 games: 0.03 a game; one set in 5 games of 500 hands: 0.04% of hands
        const games = [...times(29, () => soloGame('Ann')), soloGame('Ann', { totalBags: 1 })];
        expect(byId(computeSuperlatives(games)).bagBoy).toBeUndefined();
        const few = times(5, (i) => soloGame('Ann', { totalHands: 500, totalSets: i === 0 ? 1 : 0 }));
        expect(byId(computeSuperlatives(few)).delusionsOfGrandeur).toBeUndefined();
        // 0.05 a game shows as 0.1 (rounded half up): shown
        const half = [...times(19, () => soloGame('Ann')), soloGame('Ann', { totalBags: 1 })];
        expect(byId(computeSuperlatives(half)).bagBoy).toMatchObject({ names: ['Ann'], detail: '0.1 bags a game' });
        // 1 set in 2000 hands shows as 0.1% (the leaderboard's toFixed(1)): shown
        const tenth = times(5, (i) => soloGame('Ann', { totalHands: 400, totalSets: i === 0 ? 1 : 0 }));
        expect(byId(computeSuperlatives(tenth)).delusionsOfGrandeur).toMatchObject({ names: ['Ann'], detail: '0.1% of hands set' });
        // 1 set in 100 hands shows as 1.0%
        const sets = times(5, (i) => soloGame('Ann', { totalHands: 20, totalSets: i === 0 ? 1 : 0 }));
        expect(byId(computeSuperlatives(sets)).delusionsOfGrandeur).toMatchObject({ names: ['Ann'], detail: '1.0% of hands set' });
    });

    test('Delusions of Grandeur prints Set % as the leaderboard and profiles do (one decimal, toFixed(1))', () => {
        // 2 sets in 7 hands = 28.571...%: the leaderboard shows 28.6%, not 29%
        const games = times(5, (i) => soloGame('Ann', { totalHands: i < 2 ? 2 : 1, totalSets: i === 0 ? 2 : 0 }));
        const leaderboardText = ((2 / 7) * 100).toFixed(1) + '%';
        expect(leaderboardText).toBe('28.6%');
        expect(byId(computeSuperlatives(games)).delusionsOfGrandeur.detail).toBe(`${leaderboardText} of hands set`);
    });

    test('bags come from statsDeltas.bags only; a byPosition totalBags (never written) is ignored for the net', () => {
        const g = soloGame('Eve', { totalTricksBid: 20, totalTricksTaken: 22 });
        g.statsDeltas.byPosition[1].totalBags = 9;
        expect(byId(computeSuperlatives(times(5, () => g))).bagBoy.detail).toBe('2.0 bags a game');
        // counted (bags) wins over the net, also when 0
        const counted = soloGame('Eve', { totalTricksBid: 20, totalTricksTaken: 22, totalBags: 1 });
        expect(byId(computeSuperlatives(times(5, () => counted))).bagBoy.detail).toBe('1.0 bags a game');
    });

    test('the projection names exactly what add() reads', () => {
        const { SUPERLATIVES_PROJECTION } = require('../superlatives');
        const keys = Object.keys(SUPERLATIVES_PROJECTION);
        expect(keys).toEqual(expect.arrayContaining(['statsDeltas.bags', 'statsDeltas.exact', 'statsDeltas.names', 'statsDeltas.assist',
            'statsDeltas.byPosition.1.totalHSI', 'statsDeltas.byPosition.4.totalSets', 'statsDeltas.byPosition.3.totalTricksBid']));
        expect(keys).toHaveLength(24);
        expect(keys).not.toContain('statsDeltas.byPosition');
        // a record cut down to it gives the same superlatives
        const { applyProjection } = require('../../testUtils/memoryDb');
        const games = [...regulars(5, { Ann: { totalBags: 3, totalSets: 2, spotOn: 7 } }), ...times(5, () => soloGame('Eve'))].map((g, i) => (i === 0
            ? { ...g, statsDeltas: { ...g.statsDeltas, assist: { 2: { help: 4 } } } } : g));
        const cut = games.map((g) => applyProjection(g, { team1Players: 1, team2Players: 1, team1Bots: 1, team2Bots: 1, ...SUPERLATIVES_PROJECTION }));
        expect(computeSuperlatives(cut)).toEqual(computeSuperlatives(games));
    });
});

describe('eligibility by the data a title reads (2026-11-24)', () => {
    /** A record from before the per-seat counters (2026-11-15): names, no statsDeltas. */
    const oldGame = (a, b, c, d) => ({ team1Players: [a, c], team2Players: [b, d] });

    test('Hannah: many games without per-seat counters and 2 bad recent ones do not qualify her for a per-seat title', () => {
        const games = [
            ...times(30, () => oldGame('Hannah', 'Ben', 'Cat', 'Dan')),
            // her two recent games: set 5 hands of 13 each (38%)
            ...times(2, () => humanGame({ 1: ['Hannah', { totalSets: 5, totalBags: 4, totalHSI: 2600, spotOn: 13 }], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] },
                { assist: { 1: { help: 9 } } })),
            // the others' five games with counters: 1 set in 13 hands
            ...times(3, () => humanGame({ 1: ['Eve'], 2: ['Ben', { totalSets: 1 }], 3: ['Cat', { totalSets: 1 }], 4: ['Dan', { totalSets: 1 }] }))
        ];
        const s = byId(computeSuperlatives(games));
        // 32 games, but 2 with per-seat data: no per-seat title for her
        for (const id of ['bagBoy', 'luckyDuck', 'cursed', 'helpFromFriends', 'myQuantitative', 'delusionsOfGrandeur']) {
            expect(s[id]?.names || []).not.toContain('Hannah');
        }
        // Ben, Cat and Dan have 5 such games: 3 sets in 65 hands = 5%
        expect(s.delusionsOfGrandeur).toEqual({ id: 'delusionsOfGrandeur', title: 'Delusions of Grandeur', names: ['Ben', 'Cat', 'Dan'], detail: '4.6% of hands set' });
        // three more and she qualifies (5 games with counters)
        const more = byId(computeSuperlatives([...games, ...times(3, () => humanGame({ 1: ['Hannah'], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }))]));
        expect(more.delusionsOfGrandeur).toMatchObject({ names: ['Hannah'], detail: '15.4% of hands set' });
        expect(more.bagBoy).toMatchObject({ names: ['Hannah'], detail: '1.6 bags a game' });
        expect(more.helpFromFriends).toMatchObject({ names: ['Hannah'], detail: '18 /help uses' });
    });

    test('a game-level title (solo games) still counts every record of the period', () => {
        const oldSolo = { withBots: true, team1Players: ['Eve'], team2Players: [], team1Bots: ['🤖 Mary'], team2Bots: ['🤖 A', '🤖 B'] };
        const s = byId(computeSuperlatives([...times(4, () => oldSolo), soloGame('Eve', { totalSets: 6 })]));
        expect(s.botFriends).toMatchObject({ names: ['Eve'], detail: '5 solo games' });
        expect(s.delusionsOfGrandeur).toBeUndefined();
    });

    test('My Quantitative: 5 games whose spot-on counter covers one of the player\'s seats; per-seat games without it do not count', () => {
        const counted = (n) => times(n, () => soloGame('Ann', { spotOn: 7 }));
        const without = times(10, () => soloGame('Ann'));
        expect(byId(computeSuperlatives([...without, ...counted(4)])).myQuantitative).toBeUndefined();
        // the other per-seat titles have their 14 games
        expect(byId(computeSuperlatives([...without, ...counted(4)])).luckyDuck.names).toEqual(['Ann']);
        expect(byId(computeSuperlatives([...without, ...counted(5)])).myQuantitative).toMatchObject({ names: ['Ann'], detail: '54% of bids spot on' });
        // a counter on a seat with no hands is not a counted game
        expect(byId(computeSuperlatives([...counted(4), soloGame('Ann', { spotOn: 0, totalHands: 0 })])).myQuantitative).toBeUndefined();
    });

    test('a merge that left one player in two seats of a game: that game counts once toward the 5 per-seat games', () => {
        const twoSeats = humanGame({ 1: ['Ann', { totalBags: 2 }], 2: ['Ben'], 3: ['Ann', { totalBags: 2 }], 4: ['Dan'] });
        expect(computeSuperlatives([twoSeats, ...times(3, () => humanGame({ 1: ['Ann', { totalBags: 2 }], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }))])).toEqual([]);
    });
});

describe('All Time account titles (accounts: the leaderboard\'s totals, 2026-11-24)', () => {
    const acct = (name, games, hands, sets, hsi) => accountTotals(name, { gamesPlayed: games, totalHands: hands, totalSets: sets, totalHSI: hsi, wins: 3 });

    test('the account titles are Lucky Duck, Cursed and Delusions of Grandeur, from {gamesPlayed, totalHands, totalSets, totalHSI}', () => {
        expect(ACCOUNT_TITLE_IDS).toEqual(['luckyDuck', 'cursed', 'delusionsOfGrandeur']);
        expect(ACCOUNT_FIELDS).toEqual(['gamesPlayed', 'totalHands', 'totalSets', 'totalHSI']);
        expect(acct('Ann', 6, 78, 9, 9000)).toEqual({ name: 'Ann', games: 6, hands: 78, sets: 9, hsi: 9000 });
        expect(accountTotals('Ann', undefined)).toEqual({ name: 'Ann', games: 0, hands: 0, sets: 0, hsi: 0 });
        expect(accountTotals('Ann', { gamesPlayed: 'x', totalHands: null })).toEqual({ name: 'Ann', games: 0, hands: 0, sets: 0, hsi: 0 });
        for (const bad of ['[deleted]', '', null, 7]) expect(accountTotals(bad, { gamesPlayed: 9 })).toBeNull();
    });

    test('Hannah: All Time Delusions of Grandeur is her lifetime Set % (totalSets / totalHands), not her 2 recent games', () => {
        const games = [
            ...times(30, () => ({ team1Players: ['Hannah', 'Cat'], team2Players: ['Ben', 'Dan'] })),
            ...times(2, () => humanGame({ 1: ['Hannah', { totalSets: 5 }], 2: ['Ben'], 3: ['Cat'], 4: ['Dan'] }))
        ];
        // 32 games of 13 hands; 50 sets in 416 hands = 12.02%
        const hannah = acct('Hannah', 32, 416, 50, 416 * 90);
        const ben = acct('Ben', 32, 416, 40, 416 * 110);
        const cat = acct('Cat', 32, 416, 30, 416 * 100);
        const s = byId(computeSuperlatives(games, { accounts: [hannah, ben, cat] }));
        expect(s.delusionsOfGrandeur).toEqual({ id: 'delusionsOfGrandeur', title: 'Delusions of Grandeur', names: ['Hannah'], detail: '12.0% of hands set' });
        expect(Math.round((50 / 416) * 100)).toBe(12);
        expect(s.luckyDuck).toEqual({ id: 'luckyDuck', title: 'Lucky Duck', names: ['Ben'], detail: '110.0 avg HSI' });
        expect(s.cursed).toEqual({ id: 'cursed', title: 'Cursed', names: ['Hannah'], detail: '90.0 avg HSI' });
        // without accounts (the other periods): from the records, and she has no 5 per-seat games
        expect(byId(computeSuperlatives(games)).delusionsOfGrandeur).toBeUndefined();
    });

    test('only accounts with SUPERLATIVE_MIN_GAMES games in the scope; the other titles still come from the records', () => {
        const games = regulars(5, { Ann: { totalBags: 3, totalSets: 13, totalHSI: 2600 } });
        const accounts = [acct('Ann', 5, 65, 1, 6500), acct('Zed', 4, 52, 52, 52 * 300), null];
        const s = byId(computeSuperlatives(games, { accounts }));
        // Zed (4 games) is not a candidate; Ann's records (13 sets a game) are not read for it
        expect(s.delusionsOfGrandeur).toMatchObject({ names: ['Ann'], detail: '1.5% of hands set' });
        expect(s.luckyDuck).toMatchObject({ names: ['Ann'], detail: '100.0 avg HSI' });
        expect(s.cursed).toBeUndefined(); // one candidate: the same value as Lucky Duck
        // Bag Boy from the records
        expect(s.bagBoy).toMatchObject({ names: ['Ann'], detail: '3.0 bags a game' });
        // no account qualifies: the account titles are left out (never the records' instead)
        expect(Object.keys(byId(computeSuperlatives(games, { accounts: [] })))).toEqual(['bagBoy']);
    });

    test('ties, MAX_NAMES, zeroOmits and a duplicate account document', () => {
        const names = ['dora', 'Bob', 'alice', 'Carl', 'Eve'];
        const accounts = names.map((n) => acct(n, 10, 130, 13, 130 * 100));
        const s = byId(computeSuperlatives(regulars(5), { accounts }));
        expect(s.delusionsOfGrandeur).toEqual({ id: 'delusionsOfGrandeur', title: 'Delusions of Grandeur', names: ['alice', 'Bob', 'Carl'], detail: '10.0% of hands set (+2 more)' });
        expect(s.luckyDuck).toEqual({ id: 'luckyDuck', title: 'Lucky Duck', names: ['alice', 'Bob', 'Carl'], detail: '100.0 avg HSI (+2 more)' });
        expect(s.cursed).toBeUndefined();
        // nobody set (or only 0.04%, shown as 0.0%): left out; HSI titles still show
        const none = byId(computeSuperlatives(regulars(5), { accounts: [acct('Ann', 30, 2500, 1, 250000), acct('Ben', 30, 390, 0, 30000)] }));
        expect(none.delusionsOfGrandeur).toBeUndefined();
        expect(none.luckyDuck.names).toEqual(['Ann']);
        expect(none.cursed).toMatchObject({ names: ['Ben'], detail: '76.9 avg HSI' });
        // no hands at all: no value
        expect(byId(computeSuperlatives(regulars(5), { accounts: [acct('Ann', 5, 0, 0, 0)] })).luckyDuck).toBeUndefined();
        // a legacy duplicate name: one entry (the first), never listed twice
        const dup = byId(computeSuperlatives(regulars(5), { accounts: [acct('Ann', 9, 117, 30, 0), acct('Ann', 9, 117, 30, 0)] }));
        expect(dup.delusionsOfGrandeur.names).toEqual(['Ann']);
    });
});

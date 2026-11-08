/**
 * Pacing budget (server/game/pacing.js): server-imposed wall-clock per
 * 1-human/3-bot game, measured in virtual time over a fixed seed set with a
 * human that acts instantly (server/testUtils/pacingHarness.js).
 * BAB_PACING_REPORT=1 prints the per-component table.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const { gameLogger, socketLogger, logger } = require('../../utils/logger');
const pacing = require('../../game/pacing');
const { measure, report, gapMins } = require('../../testUtils/pacingHarness');

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const AMBIENT_SEEDS = [21, 22];

// Recorded at commit 1 of the pacing change with df59149's values (the
// legacy profile): 594.6 s mean over SEEDS
const BASELINE_MS = 594600;

// Standard profile, mean seconds per component over SEEDS (pinned +-5%)
const STANDARD_S = {
    'botBid:bid': 23.0,
    'botBid:firstBid': 11.5,
    botDraw: 2.0,
    'botPlay:afterBidding': 8.4,
    'botPlay:afterTrick': 42.8,
    'botPlay:follow': 71.1,
    'botPlay:forced': 25.5,
    countdown: 2.0,
    drawReveal: 1.0,
    firstTurn: 1.0,
    gameEnd: 1.5,
    handEnd: 12.0,
    lobby: 1.0,
    seatingToTeams: 0.5,
    teams: 3.0,
    trickView: 100.1,
};

// The smallest gap each client-visible transition may have (pacing.js
// SHIPPED_IOS_FLOORS), checked on every emit of every seeded game
const F = pacing.SHIPPED_IOS_FLOORS;
const GAP_FLOORS = {
    drawToTeams: F['DRAW_REVEAL_MS+SEATING_TO_TEAMS_MS'],
    teamsToGameStart: F.TEAMS_MS,
    firstBotBid: F.BOT_FIRST_BID,
    bidToBid: F.BOT_BID,
    doneBiddingToLead: F.BOT_LEAD_AFTER_BIDDING,
    cardToBotCard: Math.min(F.BOT_PLAY, F.BOT_FORCED_PLAY),
    trickView: F.TRICK_VIEW_MS,
    trickCompleteToLead: F.BOT_LEAD_AFTER_TRICK,
    handEnd: F.HAND_END_MS,
    gameEnd: F.GAME_END_MS,
};



beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, logger]) {
        jest.spyOn(l, 'info').mockImplementation(() => {});
        jest.spyOn(l, 'debug').mockImplementation(() => {});
        jest.spyOn(l, 'warn').mockImplementation(() => {});
    }
});

afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

const print = (s) => { if (process.env.BAB_PACING_REPORT) process.stdout.write(`${s}\n`); };

function expectAccounted(m) {
    for (const r of m.runs) {
        const summed = Object.values(r.components).reduce((a, b) => a + b, 0);
        // every server delay is traced (fake timers drop sub-ms fractions)
        expect(Math.abs(summed - r.total)).toBeLessThan(r.traces.length);
    }
}

describe('1 human + 3 bots, the human acting instantly', () => {
    test('legacy profile reproduces the recorded baseline', async () => {
        pacing.setPacingForTests('legacy');
        const m = await measure(SEEDS, { humans: 1 });
        print(report('legacy', m));
        expectAccounted(m);
        expect(Math.abs(m.mean - BASELINE_MS)).toBeLessThan(500);
    }, 60000);

    test('standard: at most 0.55 x the baseline, components as pinned, every gap above its shipped-iOS floor, no refusal', async () => {
        const m = await measure(SEEDS, { humans: 1 });
        print(report('standard', m));
        print(`  vs baseline ${(m.mean / BASELINE_MS * 100).toFixed(1)}%`);
        expectAccounted(m);
        expect(m.mean).toBeLessThanOrEqual(0.55 * BASELINE_MS);
        expect(Object.keys(m.components).sort()).toEqual(Object.keys(STANDARD_S).sort());
        for (const [k, sec] of Object.entries(STANDARD_S)) {
            expect([k, Math.abs(m.components[k] / 1000 - sec) <= sec * 0.05 + 0.05]).toEqual([k, true]);
        }
        const mins = {};
        for (const r of m.runs) {
            expect(r.humanErrors).toEqual([]);
            for (const [k, v] of Object.entries(gapMins(r))) mins[k] = Math.min(mins[k] ?? Infinity, v);
        }
        print(`  smallest gaps (ms): ${JSON.stringify(mins)}`);
        expect(Object.keys(mins).sort()).toEqual(Object.keys(GAP_FLOORS).sort());
        for (const [k, floor] of Object.entries(GAP_FLOORS)) expect([k, mins[k] >= floor]).toEqual([k, true]);
    }, 60000);
});

describe('ambient 4-bot game', () => {
    test('measured end to end, every gap above its floor', async () => {
        const m = await measure(AMBIENT_SEEDS, { humans: 0 });
        print(report('ambient', m));
        expectAccounted(m);
        for (const r of m.runs) {
            for (const [k, v] of Object.entries(gapMins(r))) {
                if (GAP_FLOORS[k] !== undefined && k !== 'drawToTeams' && k !== 'teamsToGameStart') {
                    expect([k, v >= GAP_FLOORS[k]]).toEqual([k, true]);
                }
            }
        }
    }, 60000);
});

describe('zero profile', () => {
    test('a game completes with every delay at 0', async () => {
        pacing.setPacingForTests('zero');
        const m = await measure([1], { humans: 1 });
        expect(m.runs[0].game.stage).toBe('ENDED');
        expect(m.runs[0].humanErrors).toEqual([]);
    }, 30000);
});

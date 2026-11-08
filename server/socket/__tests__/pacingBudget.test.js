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
const { measure, report } = require('../../testUtils/pacingHarness');

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const AMBIENT_SEEDS = [21, 22];

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

describe('1 human + 3 bots, the human acting instantly', () => {
    test('the measured components account for the whole game and the human is never refused', async () => {
        const m = await measure(SEEDS, { humans: 1 });
        print(report(`profile ${process.env.BAB_PACING || 'standard'}`, m));
        for (const r of m.runs) {
            const summed = Object.values(r.components).reduce((a, b) => a + b, 0);
            expect(Math.abs(summed - r.total)).toBeLessThan(r.traces.length); // fake timers drop sub-ms delay fractions
            expect(r.humanErrors).toEqual([]);
        }
        // Baseline (df59149 values): 593-597 s
        expect(m.mean).toBeGreaterThan(560000);
        expect(m.mean).toBeLessThan(630000);
    }, 60000);
});

describe('ambient 4-bot game', () => {
    test('measured end to end', async () => {
        const m = await measure(AMBIENT_SEEDS, { humans: 0 });
        print(report('ambient', m));
        for (const r of m.runs) {
            const summed = Object.values(r.components).reduce((a, b) => a + b, 0);
            expect(Math.abs(summed - r.total)).toBeLessThan(r.traces.length); // fake timers drop sub-ms delay fractions
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

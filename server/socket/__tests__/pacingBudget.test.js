/**
 * Pacing budget (server/game/pacing.js): server-imposed wall-clock per
 * 1-human/3-bot game, measured in virtual time over a fixed seed set with a
 * human that acts instantly (server/testUtils/pacingHarness.js).
 * BAB_PACING_REPORT=1 prints the per-component table.
 *
 * A 1-human game gets the solo overlay (pacing.SOLO) unless the upgrade gate
 * is off: the standard numbers are measured with UPGRADE_GATE=off, the solo
 * ones with the gate on; a 2-human game and the ambient game must draw every
 * delay from the standard profile.
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
    'botPlay:afterTrick': 47.2,
    'botPlay:follow': 95.1,
    'botPlay:forced': 11.7,
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

// The smallest gap each client-visible transition may have, checked on every
// emit of every seeded game: the standard profile still meets the 1.0.0
// floors (pacing.IOS_1_0_FLOORS, for UPGRADE_GATE=off), which are at or above
// the 1.1.0 ones (SHIPPED_IOS_FLOORS) everywhere (pacing.test.js)
const F = Object.fromEntries(Object.entries(pacing.SHIPPED_IOS_FLOORS).map(([k, v]) => [k, Math.max(v, pacing.IOS_1_0_FLOORS[k])]));
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

// Standard total over SEEDS (s), the reference for the solo report line
const STANDARD_TOTAL_S = 320.9;

// Solo overlay (pacing.SOLO on standard, a game with exactly one human):
// mean total and components over SEEDS (pinned like STANDARD_S)
const SOLO_PROFILE = { ...pacing.PROFILES.standard, ...pacing.SOLO };
const SOLO_TOTAL_S = 288.0;
const SOLO_S = {
    ...STANDARD_S,
    'botBid:firstBid': 8.4,
    'botPlay:afterBidding': 5.4,
    'botPlay:afterTrick': 35.4,
    handEnd: 6.0,
    trickView: 91.0,
};

// The solo game is below the 1.0.0 floors by design (it is off with the
// gate off), so its gaps are held to the 1.1.0 floors, plus the web
// collect (CARD_COLLECT 500 ms) before a lead after a trick
const S11 = pacing.SHIPPED_IOS_FLOORS;
const SOLO_GAP_FLOORS = {
    drawToTeams: S11['DRAW_REVEAL_MS+SEATING_TO_TEAMS_MS'],
    teamsToGameStart: S11.TEAMS_MS,
    firstBotBid: S11.BOT_FIRST_BID,
    bidToBid: S11.BOT_BID,
    doneBiddingToLead: S11.BOT_LEAD_AFTER_BIDDING,
    cardToBotCard: Math.min(S11.BOT_PLAY, S11.BOT_FORCED_PLAY),
    trickView: S11.TRICK_VIEW_MS,
    trickCompleteToLead: Math.max(S11.BOT_LEAD_AFTER_TRICK, 500),
    handEnd: S11.HAND_END_MS,
    gameEnd: S11.GAME_END_MS,
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

const gateEnv = process.env.UPGRADE_GATE;
afterEach(() => {
    if (gateEnv === undefined) delete process.env.UPGRADE_GATE; else process.env.UPGRADE_GATE = gateEnv;
});

function expectPinned(m, pins) {
    expect(Object.keys(m.components).sort()).toEqual(Object.keys(pins).sort());
    for (const [k, sec] of Object.entries(pins)) {
        expect([k, Math.abs(m.components[k] / 1000 - sec) <= sec * 0.05 + 0.05]).toEqual([k, true]);
    }
}

function smallestGaps(m) {
    const mins = {};
    for (const r of m.runs) {
        expect(r.humanErrors).toEqual([]);
        for (const [k, v] of Object.entries(gapMins(r))) mins[k] = Math.min(mins[k] ?? Infinity, v);
    }
    return mins;
}

// trace kind -> the pacing key it was drawn from
const TRACE_KEYS = {
    'botBid:firstBid': 'BOT_FIRST_BID',
    'botBid:bid': 'BOT_BID',
    'botPlay:afterBidding': 'BOT_LEAD_AFTER_BIDDING',
    'botPlay:afterTrick': 'BOT_LEAD_AFTER_TRICK',
    'botPlay:follow': 'BOT_PLAY',
    'botPlay:forced': 'BOT_FORCED_PLAY',
    trickView: 'TRICK_VIEW_MS',
    handEnd: 'HAND_END_MS',
    gameEnd: 'GAME_END_MS',
    firstTurn: 'FIRST_HAND_TURN_MS',
};

/** Every traced play-phase delay of every run came from profile `p`. */
function expectTracesWithin(m, p) {
    let checked = 0;
    for (const r of m.runs) {
        for (const t of r.traces) {
            const key = TRACE_KEYS[t.kind];
            if (!key) continue;
            const v = p[key];
            const [lo, hi] = Array.isArray(v) ? [v[0], v[0] + v[1]] : [v, v];
            expect([t.kind, t.ms >= lo && t.ms <= hi]).toEqual([t.kind, true]);
            checked++;
        }
    }
    expect(checked).toBeGreaterThan(100);
}

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

    // UPGRADE_GATE=off turns the solo overlay off (it is below the 1.0.0
    // floors), so this is the standard profile itself on a 1-human game
    test('standard (UPGRADE_GATE=off forces it): at most 0.55 x the baseline, components as pinned, every gap above both iOS floors, no refusal', async () => {
        pacing.setPacingForTests('standard'); // whatever BAB_PACING says
        process.env.UPGRADE_GATE = 'off';
        const m = await measure(SEEDS, { humans: 1 });
        print(report('standard (gate off)', m));
        print(`  vs baseline ${(m.mean / BASELINE_MS * 100).toFixed(1)}%`);
        expectAccounted(m);
        expect(m.mean).toBeLessThanOrEqual(0.55 * BASELINE_MS);
        expectPinned(m, STANDARD_S);
        expectTracesWithin(m, pacing.PROFILES.standard);
        const mins = smallestGaps(m);
        print(`  smallest gaps (ms): ${JSON.stringify(mins)}`);
        expect(Object.keys(mins).sort()).toEqual(Object.keys(GAP_FLOORS).sort());
        for (const [k, floor] of Object.entries(GAP_FLOORS)) expect([k, mins[k] >= floor]).toEqual([k, true]);
    }, 60000);

    test('solo overlay (gate on, exactly one human): about 288 s, components as pinned, every gap above the 1.1.0 floors and the web collect, no refusal', async () => {
        pacing.setPacingForTests('standard');
        const m = await measure(SEEDS, { humans: 1 });
        print(report('solo (standard + SOLO, 1 human)', m));
        print(`  vs baseline ${(m.mean / BASELINE_MS * 100).toFixed(1)}%, vs standard ${(m.mean / 1000 - STANDARD_TOTAL_S).toFixed(1)} s`);
        expectAccounted(m);
        expect(Math.abs(m.mean / 1000 - SOLO_TOTAL_S)).toBeLessThan(SOLO_TOTAL_S * 0.02);
        expectPinned(m, SOLO_S);
        expectTracesWithin(m, SOLO_PROFILE);
        const mins = smallestGaps(m);
        print(`  smallest gaps (ms): ${JSON.stringify(mins)}`);
        expect(Object.keys(mins).sort()).toEqual(Object.keys(SOLO_GAP_FLOORS).sort());
        for (const [k, floor] of Object.entries(SOLO_GAP_FLOORS)) expect([k, mins[k] >= floor]).toEqual([k, true]);
    }, 60000);
});

describe('2 humans + 2 bots, both acting instantly', () => {
    test('standard, unchanged by the solo overlay: every delay from the standard profile, every gap above both iOS floors', async () => {
        pacing.setPacingForTests('standard');
        const m = await measure(SEEDS.slice(0, 6), { humans: 2 });
        print(report('2 humans (standard)', m));
        expectAccounted(m);
        for (const r of m.runs) expect(r.humanPositions.every((p) => p >= 1 && p <= 4)).toBe(true);
        expectTracesWithin(m, pacing.PROFILES.standard);
        const mins = smallestGaps(m);
        print(`  smallest gaps (ms): ${JSON.stringify(mins)}`);
        for (const [k, v] of Object.entries(mins)) {
            if (GAP_FLOORS[k] !== undefined) expect([k, v >= GAP_FLOORS[k]]).toEqual([k, true]);
        }
    }, 60000);
});

describe('ambient 4-bot game', () => {
    test('measured end to end at standard (no solo overlay), every gap above its floor', async () => {
        pacing.setPacingForTests('standard');
        const m = await measure(AMBIENT_SEEDS, { humans: 0 });
        print(report('ambient', m));
        expectAccounted(m);
        expectTracesWithin(m, pacing.PROFILES.standard);
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

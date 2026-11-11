/**
 * server/game/pacing.js: every non-zero profile respects the shipped iOS
 * app's floors, the test-only profiles and helpers refuse to run outside
 * tests, and no presentation delay is left as a literal in the handlers
 * or the bot code.
 */

const fs = require('fs');
const path = require('path');
const pacing = require('../pacing');

const { PROFILES, SHIPPED_IOS_FLOORS, IOS_1_0_FLOORS } = pacing;
const minOf = (v) => (Array.isArray(v) ? v[0] : v);

const floorValue = (p, key) => key.split('+').reduce((sum, k) => {
    expect(p).toHaveProperty(k);
    return sum + minOf(p[k]);
}, 0);

describe('SHIPPED_IOS_FLOORS (1.1.0 build 2)', () => {
    test.each(Object.keys(PROFILES).filter((n) => n !== 'zero'))('%s respects every floor', (name) => {
        const p = PROFILES[name];
        for (const [key, floor] of Object.entries(SHIPPED_IOS_FLOORS)) {
            expect([name, key, floorValue(p, key) >= floor]).toEqual([name, key, true]);
        }
    });

    // UPGRADE_GATE=off lets the 1.0.0 build play again: the production
    // profiles keep its floors until the gate is permanent
    test.each(['standard', 'legacy'])('%s still respects every 1.0.0 floor (the kill switch)', (name) => {
        const p = PROFILES[name];
        for (const [key, floor] of Object.entries(IOS_1_0_FLOORS)) {
            expect([name, key, floorValue(p, key) >= floor]).toEqual([name, key, true]);
        }
    });

    test('the 1.1.0 floors cover the same keys and never exceed the 1.0.0 ones; fast sits on them', () => {
        expect(Object.keys(SHIPPED_IOS_FLOORS).sort()).toEqual(Object.keys(IOS_1_0_FLOORS).sort());
        for (const [k, v] of Object.entries(SHIPPED_IOS_FLOORS)) expect([k, v <= IOS_1_0_FLOORS[k]]).toEqual([k, true]);
        expect(Object.isFrozen(SHIPPED_IOS_FLOORS) && Object.isFrozen(IOS_1_0_FLOORS)).toBe(true);
        // what changed with 1.1.0 (pacing.js comments cite the iOS source)
        expect(Object.fromEntries(Object.entries(SHIPPED_IOS_FLOORS).filter(([k, v]) => v !== IOS_1_0_FLOORS[k]))).toEqual({
            BOT_FIRST_BID: 500, BOT_LEAD_AFTER_BIDDING: 300, BOT_LEAD_AFTER_TRICK: 400, HAND_END_MS: 400,
        });
        for (const [key, floor] of Object.entries(SHIPPED_IOS_FLOORS)) {
            if (key.includes('+') || key === 'BOT_LEAD_AFTER_TRICK') continue; // web collect 500 (below)
            expect([key, minOf(PROFILES.fast[key])]).toEqual([key, floor]);
        }
    });

    test('every profile defines the same keys; ranges are [min, span] with span >= 0', () => {
        const keys = Object.keys(PROFILES.standard).sort();
        for (const [name, p] of Object.entries(PROFILES)) {
            expect([name, Object.keys(p).sort()]).toEqual([name, keys]);
            for (const [k, v] of Object.entries(p)) {
                if (Array.isArray(v)) {
                    expect([name, k, v.length === 2 && v[0] >= 0 && v[1] >= 0]).toEqual([name, k, true]);
                } else {
                    expect([name, k, Number.isFinite(v) && v >= 0]).toEqual([name, k, true]);
                }
            }
        }
    });

    test('the web collect (500 ms) finishes before the earliest bot lead after a trick', () => {
        for (const name of ['standard', 'legacy', 'fast']) expect(PROFILES[name].BOT_LEAD_AFTER_TRICK[0]).toBeGreaterThanOrEqual(500);
    });
});

describe('solo overlay (exactly one human; owner 2026-11-11)', () => {
    const { SOLO } = pacing;
    const SOLO_PROFILE = { ...PROFILES.standard, ...SOLO };
    const gateEnv = process.env.UPGRADE_GATE;
    afterEach(() => {
        if (gateEnv === undefined) delete process.env.UPGRADE_GATE; else process.env.UPGRADE_GATE = gateEnv;
    });

    const seat = (pos, controller, presence, ownerUsername) => ({ position: pos, controller, presence, ownerUsername });
    const bot = (pos) => seat(pos, 'bot', 'none', null);
    const seated = (seats, extra = {}) => ({
        isDemo: false, stage: 'PLAYING', spectators: new Set(), entrants: null,
        seats: Object.fromEntries(seats.map((s) => [s.position, s])), ...extra,
    });
    const solo = () => seated([seat(1, 'human', 'connected', 'alice'), bot(2), bot(3), bot(4)]);
    const duo = () => seated([seat(1, 'human', 'connected', 'alice'), bot(2), seat(3, 'human', 'connected', 'bob'), bot(4)]);

    test('the solo values: standard keys only, the measured cuts', () => {
        expect(SOLO).toEqual({
            BOT_LEAD_AFTER_TRICK: [500, 200],
            HAND_END_MS: 500,
            BOT_FIRST_BID: [600, 400],
            BOT_LEAD_AFTER_BIDDING: [400, 300],
            TRICK_VIEW_MS: 1000,
        });
        expect(Object.isFrozen(SOLO)).toBe(true);
        for (const k of Object.keys(SOLO)) expect(PROFILES.standard).toHaveProperty(k);
    });

    test('standard + SOLO respects every SHIPPED_IOS_FLOORS floor and the web collect', () => {
        for (const [key, floor] of Object.entries(SHIPPED_IOS_FLOORS)) {
            expect([key, floorValue(SOLO_PROFILE, key) >= floor]).toEqual([key, true]);
        }
        expect(SOLO_PROFILE.BOT_LEAD_AFTER_TRICK[0]).toBeGreaterThanOrEqual(500);
    });

    test('SOLO is below IOS_1_0_FLOORS (why UPGRADE_GATE=off turns it off) and never slower than standard', () => {
        const below = Object.keys(SOLO).filter((k) => minOf(SOLO[k]) < IOS_1_0_FLOORS[k]);
        expect(below.sort()).toEqual(['BOT_FIRST_BID', 'BOT_LEAD_AFTER_BIDDING', 'BOT_LEAD_AFTER_TRICK', 'HAND_END_MS']);
        for (const [k, v] of Object.entries(SOLO)) {
            const max = (x) => (Array.isArray(x) ? x[0] + x[1] : x);
            expect([k, max(v) <= max(PROFILES.standard[k])]).toEqual([k, true]);
        }
    });

    test('humanOwnerCount: distinct seat owners; lazy, AFK, resigned and disconnected owners count, gone owners and spectators do not', () => {
        const count = pacing.humanOwnerCount;
        expect(count(solo())).toBe(1);
        expect(count(duo())).toBe(2);
        expect(count(seated([seat(1, 'lazyBot', 'connected', 'alice'), bot(2), bot(3), bot(4)]))).toBe(1); // /lazy or AFK
        expect(count(seated([seat(1, 'lazyBot', 'away', 'alice'), bot(2), bot(3), bot(4)]))).toBe(1);
        expect(count(seated([seat(1, 'human', 'grace', 'alice'), bot(2), bot(3), bot(4)]))).toBe(1);
        expect(count(seated([seat(1, 'human', 'resignable', 'alice'), bot(2), bot(3), bot(4)]))).toBe(1);
        expect(count(seated([seat(1, 'resignBot', 'away', 'alice'), bot(2), seat(3, 'human', 'connected', 'bob'), bot(4)]))).toBe(2);
        // left for good: the game lost that human
        expect(count(seated([seat(1, 'lazyBot', 'gone', 'alice'), bot(2), seat(3, 'human', 'connected', 'bob'), bot(4)]))).toBe(1);
        expect(count(seated([bot(1), bot(2), bot(3), bot(4)], { spectators: new Set(['s1', 's2']) }))).toBe(0);
        // the same username twice is one human
        expect(count(seated([seat(1, 'human', 'connected', 'alice'), bot(2), seat(3, 'lazyBot', 'away', 'alice'), bot(4)]))).toBe(1);
        // before seating: entrants that are not bots and have not left
        const pre = (entrants) => ({ isDemo: false, stage: 'DRAWING', seats: { 1: null, 2: null, 3: null, 4: null },
            entrants: new Map(entrants.map((e, i) => [`s${i}`, e])) });
        expect(count(pre([{ username: 'alice', isBot: false, presence: 'connected' }, { username: 'B1', isBot: true },
            { username: 'B2', isBot: true }, { username: 'B3', isBot: true }]))).toBe(1);
        expect(count(pre([{ username: 'alice', isBot: false, presence: 'disconnected' }, { username: 'bob', isBot: false, presence: 'left' }]))).toBe(1);
        expect(count(null)).toBe(0);
    });

    test('standard: a 1-human game gets SOLO; 2 humans, the ambient game and no game keep standard', () => {
        pacing.setPacingForTests('standard');
        const p = pacing(solo());
        for (const [k, v] of Object.entries(SOLO)) expect([k, p[k]]).toEqual([k, v]);
        expect(p.BOT_PLAY).toEqual(PROFILES.standard.BOT_PLAY);
        expect(Object.isFrozen(p) && Object.isFrozen(p.BOT_LEAD_AFTER_TRICK)).toBe(true);
        expect(pacing(solo())).toBe(p); // cached
        expect(pacing.isSolo(solo())).toBe(true);
        expect(pacing(duo()).TRICK_VIEW_MS).toBe(PROFILES.standard.TRICK_VIEW_MS);
        expect(pacing().TRICK_VIEW_MS).toBe(PROFILES.standard.TRICK_VIEW_MS);
        const ambient = seated([bot(1), bot(2), bot(3), bot(4)], { isDemo: true, spectators: new Set(['watcher']) });
        expect(pacing(ambient).TRICK_VIEW_MS).toBe(PROFILES.standard.TRICK_VIEW_MS);
        // a tournament table is just a game: one human there is solo too
        expect(pacing(solo()).HAND_END_MS).toBe(SOLO.HAND_END_MS);
    });

    test('decided at read time: a game that gains or loses a human follows its composition', () => {
        pacing.setPacingForTests('standard');
        const g = duo();
        expect(pacing(g).TRICK_VIEW_MS).toBe(1100);
        g.seats[3] = seat(3, 'lazyBot', 'gone', 'bob'); // bob /leave'd for good
        expect(pacing(g).TRICK_VIEW_MS).toBe(1000);
        g.seats[1] = seat(1, 'lazyBot', 'connected', 'alice'); // alice went AFK: still her game
        expect(pacing(g).TRICK_VIEW_MS).toBe(1000);
        g.seats[1] = seat(1, 'lazyBot', 'gone', 'alice'); // nobody left: standard
        expect(pacing(g).TRICK_VIEW_MS).toBe(1100);
    });

    test.each(['off', 'false', '0', 'disabled', 'no', ' OFF '])('UPGRADE_GATE=%p forces standard (read per call)', (v) => {
        pacing.setPacingForTests('standard');
        process.env.UPGRADE_GATE = v;
        expect(pacing(solo()).TRICK_VIEW_MS).toBe(PROFILES.standard.TRICK_VIEW_MS);
        expect(pacing(solo()).BOT_LEAD_AFTER_BIDDING).toEqual(PROFILES.standard.BOT_LEAD_AFTER_BIDDING);
        delete process.env.UPGRADE_GATE;
        expect(pacing(solo()).TRICK_VIEW_MS).toBe(SOLO.TRICK_VIEW_MS);
        process.env.UPGRADE_GATE = 'on';
        expect(pacing(solo()).TRICK_VIEW_MS).toBe(SOLO.TRICK_VIEW_MS);
    });

    test.each(['legacy', 'fast', 'zero'])('%s never gets the overlay (BAB_PACING=legacy is the full rollback)', (name) => {
        pacing.setPacingForTests(name);
        expect(pacing(solo())).toBe(pacing());
        expect(pacing(solo()).TRICK_VIEW_MS).toBe(PROFILES[name].TRICK_VIEW_MS);
    });

    test('BAB_PACING=legacy from the environment: no overlay', () => {
        const prev = process.env.BAB_PACING;
        process.env.BAB_PACING = 'legacy';
        pacing.resetPacing();
        try {
            expect(pacing(solo()).TRICK_VIEW_MS).toBe(PROFILES.legacy.TRICK_VIEW_MS);
        } finally {
            if (prev === undefined) delete process.env.BAB_PACING; else process.env.BAB_PACING = prev;
            pacing.resetPacing();
        }
    });

    test('test overrides are never masked by the overlay', () => {
        pacing.setPacingForTests('standard');
        pacing.setPacingForTests({ TRICK_VIEW_MS: 7 });
        expect(pacing(solo()).TRICK_VIEW_MS).toBe(7);
    });
});

describe('ambient pre-game overlay', () => {
    const demo = (stage) => ({ isDemo: true, stage, spectators: new Set() });

    test('standard: an unwatched ambient game before the deal skips the hidden stages', () => {
        pacing.setPacingForTests('standard');
        expect(pacing(demo('DRAW_RESOLVING')).TEAMS_MS).toBe(0);
        expect(pacing(demo('PLAYING')).TEAMS_MS).toBe(PROFILES.standard.TEAMS_MS);
        expect(pacing({ ...demo('DRAWING'), spectators: new Set(['s']) }).TEAMS_MS).toBe(PROFILES.standard.TEAMS_MS);
    });

    test('legacy keeps df59149\'s ambient pre-deal timing exactly (rollback knob)', () => {
        pacing.setPacingForTests('legacy');
        for (const stage of ['CREATED', 'DRAWING', 'DRAW_RESOLVING', 'TEAMS_ANNOUNCED']) {
            const p = pacing(demo(stage));
            for (const k of Object.keys(pacing.AMBIENT_PREGAME)) expect([stage, k, p[k]]).toEqual([stage, k, PROFILES.legacy[k]]);
        }
    });
});

describe('profile selection', () => {
    const env = { ...process.env };
    // "Outside tests" = neither NODE_ENV=test nor a Jest worker
    const leaveTests = () => {
        process.env.NODE_ENV = 'production';
        delete process.env.JEST_WORKER_ID;
    };
    afterEach(() => {
        process.env.NODE_ENV = env.NODE_ENV;
        process.env.JEST_WORKER_ID = env.JEST_WORKER_ID;
        if (env.BAB_PACING === undefined) delete process.env.BAB_PACING; else process.env.BAB_PACING = env.BAB_PACING;
        pacing.resetPacing();
    });

    test('the active values are frozen; standard by default', () => {
        delete process.env.BAB_PACING;
        pacing.resetPacing();
        const p = pacing();
        expect(p.TRICK_VIEW_MS).toBe(PROFILES.standard.TRICK_VIEW_MS);
        expect(Object.isFrozen(p)).toBe(true);
        expect(Object.isFrozen(p.BOT_PLAY)).toBe(true);
    });

    test('zero, setPacingForTests and resetPacing throw outside tests', () => {
        process.env.BAB_PACING = 'zero';
        pacing.resetPacing();
        leaveTests();
        expect(() => pacing()).toThrow(/test-only/);
        expect(() => pacing.setPacingForTests('zero')).toThrow(/test-only/);
        expect(() => pacing.resetPacing()).toThrow(/test-only/);
        expect(() => pacing.setTracer(() => {})).toThrow(/test-only/);
        process.env.JEST_WORKER_ID = env.JEST_WORKER_ID;
    });

    test('fast is ignored in production (standard, with a warning)', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        process.env.BAB_PACING = 'fast';
        pacing.resetPacing();
        process.env.NODE_ENV = 'production';
        expect(pacing().TRICK_VIEW_MS).toBe(PROFILES.standard.TRICK_VIEW_MS);
        expect(warn).toHaveBeenCalled();
        process.env.NODE_ENV = 'development';
        pacing.resetPacing();
        expect(pacing().TRICK_VIEW_MS).toBe(PROFILES.fast.TRICK_VIEW_MS);
        warn.mockRestore();
    });

    test('setPacingForTests takes a profile name or overrides', () => {
        expect(pacing.setPacingForTests({ TRICK_VIEW_MS: 7 }).TRICK_VIEW_MS).toBe(7);
        expect(pacing.setPacingForTests('legacy').TRICK_VIEW_MS).toBe(2000);
        expect(() => pacing.setPacingForTests('nope')).toThrow();
    });
});

describe('no literal delays outside pacing.js', () => {
    const root = path.join(__dirname, '..', '..');
    const files = [
        ...fs.readdirSync(path.join(root, 'socket')).filter((f) => f.endsWith('.js')).map((f) => path.join(root, 'socket', f)),
        ...['BotController.js', 'BotPlayer.js'].map((f) => path.join(root, 'game', 'bot', f)),
        path.join(root, 'demo', 'ambientBots.js'),
        path.join(root, 'game', 'GameState.js'),
    ];

    test.each(files.map((f) => path.relative(root, f)))('%s', (rel) => {
        const src = fs.readFileSync(path.join(root, rel), 'utf8');
        expect(src.match(/\b(pause|delay|hold)\(\s*\d/g)).toBeNull();
        expect(src.match(/\bpause\([^)]*\b\d{3,}\b/g)).toBeNull();
        expect(src.match(/sendBotChat\([^;]*,\s*\d{3,}\s*\)/g)).toBeNull();
        expect(src.match(/getActionDelay[\s\S]{0,400}?\d{3,}\s*\+\s*Math\.random/g)).toBeNull();
    });
});

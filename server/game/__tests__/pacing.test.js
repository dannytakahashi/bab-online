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

/**
 * server/game/pacing.js: every non-zero profile respects the shipped iOS
 * app's floors, the test-only profiles and helpers refuse to run outside
 * tests, and no presentation delay is left as a literal in the handlers
 * or the bot code.
 */

const fs = require('fs');
const path = require('path');
const pacing = require('../pacing');

const { PROFILES, SHIPPED_IOS_FLOORS } = pacing;
const minOf = (v) => (Array.isArray(v) ? v[0] : v);

describe('SHIPPED_IOS_FLOORS', () => {
    test.each(Object.keys(PROFILES).filter((n) => n !== 'zero'))('%s respects every floor', (name) => {
        const p = PROFILES[name];
        for (const [key, floor] of Object.entries(SHIPPED_IOS_FLOORS)) {
            const value = key.split('+').reduce((sum, k) => {
                expect(p).toHaveProperty(k);
                return sum + minOf(p[k]);
            }, 0);
            expect([name, key, value >= floor]).toEqual([name, key, true]);
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

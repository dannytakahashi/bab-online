/**
 * LIVE_PERSIST (server/utils/livePersistSwitch.js): off | write | on, unset
 * or unknown means off (an unknown value warns once), read once at boot,
 * and no dependencies.
 */

const fs = require('fs');
const path = require('path');
const sw = require('../livePersistSwitch');

afterEach(() => sw._resetForTests());

test.each([
    [undefined, 'off'],
    ['', 'off'],
    ['   ', 'off'],
    ['off', 'off'],
    ['write', 'write'],
    ['on', 'on'],
    ['ON', 'on'],
    [' Write ', 'write'],
])('LIVE_PERSIST=%j reads as %s, with no warning', (raw, mode) => {
    const warn = jest.fn();
    const env = raw === undefined ? {} : { LIVE_PERSIST: raw };
    expect(sw.livePersistMode(env, { warn })).toBe(mode);
    expect(warn).not.toHaveBeenCalled();
});

test.each(['true', '1', 'yes', 'enabled', 'onn', 'read'])('an unknown value (%j) is off, with one warning', (raw) => {
    const warn = jest.fn();
    expect(sw.livePersistMode({ LIVE_PERSIST: raw }, { warn })).toBe('off');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/LIVE_PERSIST/);
    expect(warn.mock.calls[0][0]).toMatch(/using off/);
});

test('the warning quotes at most 20 characters of the value', () => {
    const warn = jest.fn();
    sw.livePersistMode({ LIVE_PERSIST: 'x'.repeat(200) }, { warn });
    expect(warn.mock.calls[0][0]).toContain(JSON.stringify('x'.repeat(20)));
    expect(warn.mock.calls[0][0]).not.toContain('x'.repeat(21));
});

test('parseLivePersist reports unknown values', () => {
    expect(sw.parseLivePersist('on')).toEqual({ mode: 'on', unknown: false });
    expect(sw.parseLivePersist(null)).toEqual({ mode: 'off', unknown: false });
    expect(sw.parseLivePersist('maybe')).toEqual({ mode: 'off', unknown: true });
    expect(sw.MODES).toEqual(['off', 'write', 'on']);
});

test('read once at boot: later env changes do not move it, and an unknown value warns once', () => {
    const warn = jest.fn();
    const env = { LIVE_PERSIST: 'bogus' };
    expect(sw.bootLivePersistMode(env, { warn })).toBe('off');
    env.LIVE_PERSIST = 'on';
    expect(sw.bootLivePersistMode(env, { warn })).toBe('off');
    expect(sw.bootLivePersistMode(env, { warn })).toBe('off');
    expect(warn).toHaveBeenCalledTimes(1);

    sw._resetForTests();
    expect(sw.bootLivePersistMode(env, { warn })).toBe('on');
});

test('defaults to process.env and console.warn', () => {
    const saved = process.env.LIVE_PERSIST;
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        process.env.LIVE_PERSIST = 'write';
        expect(sw.livePersistMode()).toBe('write');
        process.env.LIVE_PERSIST = 'nope';
        expect(sw.livePersistMode()).toBe('off');
        expect(spy).toHaveBeenCalledTimes(1);
    } finally {
        if (saved === undefined) delete process.env.LIVE_PERSIST;
        else process.env.LIVE_PERSIST = saved;
        spy.mockRestore();
    }
});

test('dependency-free (any layer can require it), and nothing reads it yet', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'livePersistSwitch.js'), 'utf8');
    expect(src).not.toMatch(/require\(/);

    // No production module requires it yet (PR 4 wires the store)
    const serverDir = path.join(__dirname, '..', '..');
    const readers = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'testUtils') continue;
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (entry.name.endsWith('.js') && p !== path.join(__dirname, '..', 'livePersistSwitch.js')
                && fs.readFileSync(p, 'utf8').includes('livePersistSwitch')) readers.push(path.relative(serverDir, p));
        }
    };
    walk(serverDir);
    expect(readers).toEqual([]);
});

/**
 * c2s clientError (server/socket/clientErrorHandlers.js): a client's short
 * error report, logged at warn with the signed-in username and every text
 * field scrubbed. Never answered; dropped silently when malformed, over a
 * limit (per socket, per IP, server-wide) or while CLIENT_ERRORS=off.
 */

const contract = require('../../../contract');
const validators = require('../validators');
const rateLimiter = require('../rateLimiter');
const gameManager = require('../../game/GameManager');
const handlers = require('../clientErrorHandlers');
const { socketLogger } = require('../../utils/logger');
const { setupSocketHandlers } = require('../index');

const { scrub } = handlers;

afterAll(() => rateLimiter.shutdown());

let n = 0;
/** A socket wired through the real setupSocketHandlers registrations. */
function wiredSocket({ ip = '203.0.113.9', data = {} } = {}) {
    const on = new Map();
    const emitted = [];
    const socket = {
        id: `ce-${++n}`,
        data: { ...data },
        handshake: { address: ip, headers: {} },
        on: (ev, fn) => on.set(ev, fn),
        emit: (event, payload) => emitted.push({ event, payload }),
        join() {},
        leave() {},
    };
    setupSocketHandlers({ on: (ev, cb) => cb(socket) });
    return { socket, emitted, send: async (d) => { await on.get('clientError')(d); } };
}

const REPORT = { kind: 'error', message: 'TypeError: x is undefined', where: 'main-AbCd1234.js:1:2345', build: 'abc1234', page: 'TABLE' };
const reports = () => socketLogger.warn.mock.calls.filter(([m]) => m === 'Client error').map(([, meta]) => meta);

beforeEach(() => {
    rateLimiter._resetBuckets();
    handlers._reset();
    delete process.env.CLIENT_ERRORS;
    jest.spyOn(socketLogger, 'warn').mockImplementation(() => {});
    jest.spyOn(socketLogger, 'info').mockImplementation(() => {});
    jest.spyOn(socketLogger, 'debug').mockImplementation(() => {});
});
afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.CLIENT_ERRORS;
});

describe('payload', () => {
    test('Joi and the contract agree on the examples and the rejected payloads', () => {
        const entry = contract.schema.c2s.clientError;
        for (const ex of entry.examples) {
            expect(contract.validateC2S('clientError', ex).ok).toBe(true);
            expect(() => validators.validate('clientError', ex)).not.toThrow();
        }
        for (const bad of entry.invalid) {
            expect(contract.validateC2S('clientError', bad).ok).toBe(false);
            expect(() => validators.validate('clientError', bad)).toThrow();
        }
    });

    test('a report is logged once at warn, with no reply; extra keys and objects never reach the log', async () => {
        const { emitted, send } = wiredSocket();
        await send({ ...REPORT, extra: { nested: 'object' }, chat: 'hello there' });
        expect(emitted).toEqual([]);
        const [meta] = reports();
        expect(meta).toMatchObject({ kind: 'error', error: 'TypeError: x is undefined', where: 'main-AbCd1234.js:1:2345', build: 'abc1234', page: 'TABLE', username: null });
        expect(JSON.stringify(meta)).not.toMatch(/nested|hello there|203\.0\.113/);
    });

    test.each([
        ['no payload', undefined],
        ['a string', 'boom'],
        ['no kind', { message: 'x' }],
        ['an object message', { kind: 'error', message: { a: 1 } }],
        ['a message too long', { kind: 'error', message: 'x'.repeat(501) }],
        ['a stack too long', { kind: 'error', message: 'x', stack: 's'.repeat(4001) }],
    ])('%s is dropped silently (no log line, no serverError)', async (_, payload) => {
        const { emitted, send } = wiredSocket();
        await send(payload);
        expect(emitted).toEqual([]);
        expect(reports()).toEqual([]);
    });

    test('the signed-in username is logged; an anonymous socket logs none', async () => {
        const a = wiredSocket();
        jest.spyOn(gameManager, 'getUserBySocketId').mockImplementation((id) => (id === a.socket.id ? { username: 'alan' } : undefined));
        await a.send(REPORT);
        const b = wiredSocket({ data: { username: 'claimed-only' } });
        await b.send(REPORT);
        expect(reports().map((r) => r.username)).toEqual(['alan', null]);
    });

    test('the client and build it said in clientHello, and the iOS build from the User-Agent', async () => {
        const web = wiredSocket({ data: { client: { client: 'web', version: '1.0.0', build: 'abc', caps: [] } } });
        await web.send(REPORT);
        const ios = wiredSocket({ data: { appBuild: 10 } });
        await ios.send(REPORT);
        expect(reports().map(({ client, version, appBuild }) => ({ client, version, appBuild }))).toEqual([
            { client: 'web', version: '1.0.0', appBuild: null },
            { client: 'ios', version: null, appBuild: 10 },
        ]);
    });
});

describe('limits', () => {
    test('5 a minute per socket, then dropped; allowed again once the minute has passed', async () => {
        let clock = 1.9e12;
        jest.spyOn(Date, 'now').mockImplementation(() => clock);
        const { send } = wiredSocket();
        for (let i = 0; i < 7; i++) await send({ ...REPORT, message: `m${i}` });
        expect(reports()).toHaveLength(handlers.PER_MINUTE);
        clock += 60 * 1000 + 1;
        await send(REPORT);
        expect(reports()).toHaveLength(handlers.PER_MINUTE + 1);
    });

    test('50 a day per socket', async () => {
        let clock = 1.9e12;
        jest.spyOn(Date, 'now').mockImplementation(() => clock);
        const { send } = wiredSocket({ ip: '198.51.100.1' });
        for (let i = 0; i < 70; i++) {
            await send(REPORT);
            clock += 61 * 1000; // never the minute limit
            if (i % 15 === 0) rateLimiter._resetBuckets(); // never the IP bucket
        }
        expect(reports()).toHaveLength(handlers.PER_DAY);
        clock += 24 * 60 * 60 * 1000;
        rateLimiter._resetBuckets();
        await send(REPORT);
        expect(reports()).toHaveLength(handlers.PER_DAY + 1);
    });

    test('per IP: new sockets (a reconnect loop) from one address stop at the bucket; another address still reports', async () => {
        for (let i = 0; i < 30; i++) await wiredSocket({ ip: '198.51.100.7' }).send(REPORT);
        expect(reports()).toHaveLength(rateLimiter.buckets.clientErrorIp.burst);
        await wiredSocket({ ip: '198.51.100.8' }).send(REPORT);
        expect(reports()).toHaveLength(rateLimiter.buckets.clientErrorIp.burst + 1);
    });

    test('server-wide cap: past it every report is dropped, with ONE warn line', async () => {
        const cap = rateLimiter.buckets.clientErrorGlobal.burst;
        for (let i = 0; i < cap + 20; i++) await wiredSocket({ ip: `198.18.${Math.floor(i / 200)}.${i % 200}` }).send(REPORT);
        expect(reports()).toHaveLength(cap);
        expect(socketLogger.warn.mock.calls.filter(([m]) => /capped/.test(m))).toHaveLength(1);
    });

    test('a refused report charges no bucket (a malformed flood cannot starve real reports)', async () => {
        const { send } = wiredSocket({ ip: '198.51.100.20' });
        for (let i = 0; i < 50; i++) await send({ kind: 'error' });
        await send(REPORT);
        expect(reports()).toHaveLength(1);
    });
});

describe('kill switch', () => {
    test.each(['off', 'OFF', 'false', '0', 'disabled', 'no'])('CLIENT_ERRORS=%s: ignored, read per report', async (v) => {
        const { send } = wiredSocket();
        process.env.CLIENT_ERRORS = v;
        await send(REPORT);
        expect(reports()).toEqual([]);
        delete process.env.CLIENT_ERRORS;
        await send(REPORT);
        expect(reports()).toHaveLength(1);
    });

    test('anything else keeps it on', () => {
        expect(handlers.enabled({})).toBe(true);
        expect(handlers.enabled({ CLIENT_ERRORS: 'on' })).toBe(true);
    });
});

describe('scrub', () => {
    // Built from parts: no credential-shaped literal in the repository
    const tokenish = ['Ab', 'Cd'.repeat(10), 'Ef', '0123456789'].join('');
    const host = ['https://babonline', 'invalid'].join('.');

    test.each([
        ['a URL query and fragment', `failed ${host}/reset?token=${tokenish}#frag`, `failed ${host}/reset`],
        ['a relative path query', 'GET /avatar?v=abc&x=1 failed', 'GET /avatar failed'],
        ['an email', 'bad user a.person+x@example.invalid here', 'bad user <email> here'],
        ['a uuid', 'game 6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f gone', 'game <id> gone'],
        ['a long digit run', 'call 5551234567 now', 'call <n> now'],
        ['an IP', 'from 198.51.100.4 port', 'from <ip> port'],
        ['a token-like run', `key ${tokenish} end`, 'key <redacted> end'],
        ['a picture URL (a username)', 'img /avatar/somebody failed', 'img /avatar/<user> failed'],
        ['a home folder', 'at /Users/someone/app/x.js', 'at /Users/<user>/app/x.js'],
        ['a JSON snippet (could be a chat line)', 'SyntaxError: "hi everyone, gl" is not valid JSON', 'SyntaxError: "…" is not valid JSON'],
        ['single-quoted text', "Unexpected token 'see you all'", "Unexpected token '…'"],
        ['control characters (a forged log line)', 'a\u0007b\u001bc', 'abc'],
    ])('%s', (_, input, out) => {
        expect(scrub(input)).toBe(out);
    });

    test('keeps what says where it broke: identifiers, bundle positions, apostrophes', () => {
        expect(scrub("TypeError: Cannot read properties of undefined (reading 'seatCards')")).toBe("TypeError: Cannot read properties of undefined (reading 'seatCards')");
        expect(scrub('at r (https://babonline.io/dist/assets/main-AbCd1234.js:1:1234567)')).toBe('at r (https://babonline.io/dist/assets/main-AbCd1234.js:1:1234567)');
        expect(scrub("Can't find variable: foo; doesn't exist")).toBe("Can't find variable: foo; doesn't exist");
        expect(scrub('GameSKScene.swift:212')).toBe('GameSKScene.swift:212');
    });

    test('a scrubbed field is what gets logged', async () => {
        const { send } = wiredSocket();
        await send({ kind: 'error', message: 'SyntaxError: "my secret chat line" bad', stack: `at x (${host}/p?token=abc)`, where: 'a@example.invalid' });
        const [meta] = reports();
        expect(meta.error).toBe('SyntaxError: "…" bad');
        expect(meta.stack).toBe(`at x (${host}/p)`);
        expect(meta.where).toBe('<email>');
    });
});

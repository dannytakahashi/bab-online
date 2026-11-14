/**
 * c2s clientHello (server/socket/clientInfo.js): the capability signal that
 * lets the server send avatar URLs instead of inline images to clients that
 * can render them. Additive: a socket that never says hello keeps every
 * legacy payload shape.
 */

const contract = require('../../../contract');
const validators = require('../validators');
const rateLimiter = require('../rateLimiter');
const clientInfo = require('../clientInfo');
const { socketLogger } = require('../../utils/logger');
const { setupSocketHandlers } = require('../index');

afterAll(() => rateLimiter.shutdown());

/** A socket wired through the real setupSocketHandlers registrations. */
function wiredSocket(id) {
    const handlers = new Map();
    const emitted = [];
    const socket = { id, data: {}, on: (ev, fn) => handlers.set(ev, fn), emit: (event, data) => emitted.push({ event, data }) };
    setupSocketHandlers({ on: (ev, cb) => cb(socket) });
    return { socket, emitted, send: (ev, d) => handlers.get(ev)(d) };
}

beforeEach(() => {
    jest.spyOn(socketLogger, 'info').mockImplementation(() => {});
    jest.spyOn(socketLogger, 'debug').mockImplementation(() => {});
    jest.spyOn(socketLogger, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const HELLO = { client: 'web', version: '1.0.0', build: 'abc1234', caps: ['avatarUrl'] };

test('Joi and the contract agree on the examples and the rejected payloads', () => {
    const entry = contract.schema.c2s.clientHello;
    for (const ex of entry.examples) {
        expect(contract.validateC2S('clientHello', ex).ok).toBe(true);
        expect(() => validators.validate('clientHello', ex)).not.toThrow();
    }
    for (const bad of entry.invalid) {
        expect(contract.validateC2S('clientHello', bad).ok).toBe(false);
        expect(() => validators.validate('clientHello', bad)).toThrow();
    }
    expect(contract.schema.$defs.clientCap).toEqual({ enum: ['avatarUrl'] });
    expect(() => validators.validate('clientHello', { ...HELLO, build: '' })).not.toThrow();
    expect(() => validators.validate('clientHello', { ...HELLO, caps: Array(17).fill('x') })).toThrow();
});

test('a hello sets socket.data.client (known caps only), logs it, and sends no reply', () => {
    const { socket, emitted, send } = wiredSocket('hello-1');
    send('clientHello', { ...HELLO, caps: ['avatarUrl', 'futureThing', 'avatarUrl'], extra: 'stripped' });
    expect(socket.data.client).toEqual({ client: 'web', version: '1.0.0', build: 'abc1234', caps: ['avatarUrl'] });
    expect(clientInfo.hasCap(socket, 'avatarUrl')).toBe(true);
    expect(emitted).toEqual([]);
    expect(socketLogger.info).toHaveBeenCalledWith('clientHello', expect.objectContaining({ socketId: 'hello-1', version: '1.0.0', caps: ['avatarUrl'] }));
    rateLimiter.clearSocket('hello-1');
});

test('the last hello wins: one without avatarUrl downgrades the socket', () => {
    const { socket, send } = wiredSocket('hello-2');
    send('clientHello', HELLO);
    expect(clientInfo.hasCap(socket, 'avatarUrl')).toBe(true);
    send('clientHello', { client: 'web', version: '1.0.1', caps: [] });
    expect(clientInfo.hasCap(socket, 'avatarUrl')).toBe(false);
    expect(socket.data.client.build).toBeNull();
    rateLimiter.clearSocket('hello-2');
});

test('the 6th hello within 10 s is dropped silently (no error emit, state unchanged)', () => {
    const { socket, emitted, send } = wiredSocket('hello-3');
    for (let i = 0; i < 5; i++) send('clientHello', { ...HELLO, version: `1.0.${i}` });
    expect(socket.data.client.version).toBe('1.0.4');
    send('clientHello', { client: 'web', version: '9.9.9', caps: [] });
    expect(socket.data.client.version).toBe('1.0.4');
    expect(clientInfo.hasCap(socket, 'avatarUrl')).toBe(true);
    expect(emitted).toEqual([]);
    rateLimiter.clearSocket('hello-3');
});

test('an invalid hello is a validation error and leaves the socket legacy', () => {
    const { socket, emitted, send } = wiredSocket('hello-4');
    send('clientHello', { client: 'web', version: '1', caps: 'avatarUrl' });
    expect(socket.data.client).toBeUndefined();
    expect(emitted.map((e) => [e.event, e.data.code, e.data.handler])).toEqual([['serverError', 'validation', 'clientHello']]);
});

test('socketHasCap: live sockets only; bots, null and unknown ids are legacy', () => {
    const capable = { id: 'a', data: { client: { caps: ['avatarUrl'] } } };
    const legacy = { id: 'b', data: {} };
    const io = { sockets: { sockets: new Map([['a', capable], ['b', legacy]]) } };
    expect(clientInfo.socketHasCap(io, 'a', 'avatarUrl')).toBe(true);
    expect(clientInfo.socketHasCap(io, 'b', 'avatarUrl')).toBe(false);
    expect(clientInfo.socketHasCap(io, 'gone', 'avatarUrl')).toBe(false);
    expect(clientInfo.socketHasCap(io, null, 'avatarUrl')).toBe(false);
    expect(clientInfo.socketHasCap(io, 'bot:Mary:1', 'avatarUrl')).toBe(false);
    expect(clientInfo.hasCap(null, 'avatarUrl')).toBe(false);
});

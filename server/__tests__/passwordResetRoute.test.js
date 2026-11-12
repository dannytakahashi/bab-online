/**
 * The reset link page and API (server/routes/passwordReset.js) over real
 * HTTP, mounted with the request logger, the CSP and compression as
 * server/index.js mounts them; the player's live socket signed out through
 * the real authHandlers.signOutUser.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const Transport = require('winston-transport');
const { createMemoryDb } = require('../testUtils/memoryDb');
const { createPasswordResetRouter, MESSAGES, sameOrigin, clientKey } = require('../routes/passwordReset');
const requestLogger = require('../middleware/requestLogger');
const { cspMiddleware } = require('../middleware/csp');
const { createCompression } = require('../middleware/compression');
const { createResetLink, RESET_TTL_MS } = require('../admin/passwordReset');
const { logger } = require('../utils/logger');
// The real signIn / restoreSession read the test's memoryDb (mockDb.current)
const mockDb = { current: null };
jest.mock('../database', () => ({
    ...jest.requireActual('../database'),
    getUsersCollection: () => mockDb.current && mockDb.current.users,
    whenReady: async () => true
}));

const gameManager = require('../game/GameManager');
const auth = require('../socket/authHandlers');
const { signOutUser } = auth;
const { makeIo, makeSocket } = require('../testUtils/gameDriver');

// Capture every log line (every level) to check the token is never in one
const logLines = [];
class Capture extends Transport {
    log(info, cb) { logLines.push(JSON.stringify(info)); cb(); }
}
const capture = new Capture({ level: 'debug' });
let savedLevel;
let transportLevels;
beforeAll(() => {
    savedLevel = logger.level;
    transportLevels = logger.transports.map(t => [t, t.level]);
    for (const [t] of transportLevels) t.level = savedLevel;
    logger.level = 'debug';
    logger.add(capture);
});
afterAll(() => {
    logger.remove(capture);
    logger.level = savedLevel;
    for (const [t, l] of transportLevels) t.level = l;
});

let db;
let server;
let base;
let tmp;
let clock;
let io;
let liveSocket;

function makeClientDir({ built = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bab-reset-'));
    if (built) {
        fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'dist', 'reset.html'), '<!DOCTYPE html><title>Reset</title><script type="module" src="/dist/assets/reset-x.js"></script>');
    }
    return dir;
}

async function start({ built = true, limits = {}, hash = (pw) => bcrypt.hash(pw, 4) } = {}) {
    tmp = makeClientDir({ built });
    const app = express();
    app.use(requestLogger);
    app.use(createCompression());
    app.use(cspMiddleware);
    app.use(createPasswordResetRouter({
        getDb: () => db,
        getIo: () => io,
        signOutUser,
        hash,
        now: () => clock,
        clientDir: tmp,
        limits
    }));
    app.use((req, res) => res.status(418).end('fell through'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
    if (server) {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
        server = null;
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    gameManager.currentUsers = [];
});

beforeEach(async () => {
    clock = Date.parse('2026-11-11T12:00:00Z');
    db = createMemoryDb({
        users: [
            { username: 'Bea', password: await bcrypt.hash('old', 4), sessionTokens: [{ hash: 'h', createdAt: new Date(clock), lastUsedAt: new Date(clock) }], socketId: 'bea-sock' },
            { username: 'Old', mergedInto: 'Bea' }
        ]
    });
    // Bea is signed in on a live socket (the main room)
    liveSocket = { id: 'bea-sock', emit: jest.fn(), disconnect: jest.fn(() => io.sockets.sockets.delete('bea-sock')) };
    io = { sockets: { sockets: new Map([['bea-sock', liveSocket]]) } };
    gameManager.registerUser('bea-sock', 'Bea');
});

function post(body, headers = {}) {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request(base + '/api/password-reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch { /* not json */ }
                resolve({ status: res.statusCode, headers: res.headers, json, text });
            });
        });
        req.on('error', reject);
        req.end(data);
    });
}

function get(p, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get(base + p, { headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        }).on('error', reject);
    });
}

const INVALID = { ok: false, error: 'invalid_link', message: MESSAGES.invalid_link };

describe('GET /reset', () => {
    test('serves the standalone page: no-store, no-referrer, not frameable, the page CSP', async () => {
        await start();
        const iPhone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
        const res = await get('/reset', { 'User-Agent': iPhone });
        expect(res.status).toBe(200);
        expect(res.body).toContain('reset-x.js'); // the reset page, not index.html (no gate, no app)
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
    });

    test('503 when the client is not built', async () => {
        await start({ built: false });
        expect((await get('/reset')).status).toBe(503);
    });

    test('a query on /reset is never logged (only the path)', async () => {
        await start();
        const secret = 'Q'.repeat(43);
        await get(`/reset?t=${secret}`);
        expect(requestLogger.loggedUrl({ path: '/reset', url: `/reset?t=${secret}` })).toBe('/reset');
        expect(logLines.filter(l => l.includes(secret))).toEqual([]);
    });
});

describe('POST /api/password-reset', () => {
    test('a valid link: 200, the new password works, every session revoked, the live socket signed out, audited', async () => {
        await start();
        const { token } = await createResetLink(db, 'Bea', { now: new Date(clock) });
        logLines.length = 0;
        const res = await post({ token, password: 'brand-new' });
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ ok: true, message: 'Password changed. Sign in with your new password on the app or the website.' });
        expect(res.headers['cache-control']).toBe('no-store');
        const bea = await db.users.findOne({ username: 'Bea' });
        expect(await bcrypt.compare('brand-new', bea.password)).toBe(true);
        expect(await bcrypt.compare('old', bea.password)).toBe(false);
        expect(bea.sessionTokens).toBeUndefined();
        expect(liveSocket.emit).toHaveBeenCalledWith('forceLogout');
        expect(liveSocket.disconnect).toHaveBeenCalled();
        expect(db.adminAudit.all()).toEqual([expect.objectContaining({ actor: 'Bea', action: 'useResetLink', target: 'Bea', result: 'ok' })]);
        // no log line, audit entry or stored document holds the token or the password
        expect(logLines.length).toBeGreaterThan(0);
        for (const secret of [token, 'brand-new']) {
            expect(logLines.filter(l => l.includes(secret))).toEqual([]);
            expect(JSON.stringify([db.adminAudit.all(), db.passwordResets.all(), db.users.all()])).not.toContain(secret);
        }
        // reuse: the constant refusal
        const again = await post({ token, password: 'other' });
        expect(again.status).toBe(400);
        expect(again.json).toEqual(INVALID);
    });

    test('unknown, malformed, expired and superseded links get the byte-identical refusal', async () => {
        await start({ limits: { burst: 100 } });
        const first = await createResetLink(db, 'Bea', { now: new Date(clock) });
        const second = await createResetLink(db, 'Bea', { now: new Date(clock) });
        const bodies = [];
        for (const token of [first.token, 'x'.repeat(43), 'short', null, 42, '../../etc/passwd']) {
            const res = await post({ token, password: 'pw' });
            expect(res.status).toBe(400);
            bodies.push(res.text);
        }
        clock += RESET_TTL_MS;
        bodies.push((await post({ token: second.token, password: 'pw' })).text);
        expect(new Set(bodies).size).toBe(1);
        expect(JSON.parse(bodies[0])).toEqual(INVALID);
    });

    test('a merged account\'s old link is refused the same way', async () => {
        await start();
        await db.users.insertOne({ username: 'Bea2', password: 'x' });
        const { token } = await createResetLink(db, 'Bea2', { now: new Date(clock) });
        await db.users.updateOne({ username: 'Bea2' }, { $set: { mergedInto: 'Bea' } });
        expect((await post({ token, password: 'pw' })).json).toEqual(INVALID);
    });

    test('the sign-up password rule (1-100); a refused password keeps the link usable', async () => {
        await start();
        const { token } = await createResetLink(db, 'Bea', { now: new Date(clock) });
        for (const password of ['', 'p'.repeat(101), 7, null]) {
            const res = await post({ token, password });
            expect(res.status).toBe(400);
            expect(res.json).toEqual({ ok: false, error: 'invalid_password', message: MESSAGES.invalid_password });
        }
        expect((await post({ token, password: 'fine' })).status).toBe(200);
    });

    test('two tabs submitting at once: exactly one success', async () => {
        await start();
        const { token } = await createResetLink(db, 'Bea', { now: new Date(clock) });
        const results = await Promise.all([post({ token, password: 'a1' }), post({ token, password: 'a2' })]);
        expect(results.map(r => r.status).sort()).toEqual([200, 400]);
    });

    test('JSON only, same origin only; a malformed body is never logged', async () => {
        await start();
        const { token } = await createResetLink(db, 'Bea', { now: new Date(clock) });
        expect((await post(`token=${token}&password=x`, { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
        expect((await post({ token, password: 'x' }, { Origin: 'https://evil.example' })).status).toBe(403);
        expect((await post({ token, password: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
        logLines.length = 0;
        const bad = await post(`{"token":"${token}", oops`);
        expect(bad.status).toBe(400);
        expect(bad.json.error).toBe('invalid_request');
        expect(logLines.filter(l => l.includes(token))).toEqual([]);
        // the link was never used by any of these
        expect(db.passwordResets.all()[0].state).toBe('open');
        expect(sameOrigin({ headers: { origin: 'http://h:1', host: 'h:1' } })).toBe(true);
        expect(sameOrigin({ headers: { origin: 'not a url', host: 'h' } })).toBe(false);
        expect(sameOrigin({ headers: { 'sec-fetch-site': 'same-origin', host: 'h' } })).toBe(true);
    });

    test('rate limited per client address (10 attempts, refilling over 15 minutes)', async () => {
        await start();
        // behind the proxy (a loopback peer): X-Real-IP names the client (utils/clientIp)
        const as = (ip) => post({ token: 'x'.repeat(43), password: 'pw' }, { 'X-Real-IP': ip });
        const statuses = [];
        for (let i = 0; i < 12; i++) statuses.push((await as('203.0.113.9')).status);
        expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
        expect(statuses.slice(10)).toEqual([429, 429]);
        expect((await as('198.51.100.7')).status).toBe(400); // another client is not blocked
        clock += 15 * 60 * 1000;
        expect((await as('203.0.113.9')).status).toBe(400);
    });

    test('a global bucket bounds real attempts together (and an unknown client address); junk never charges it', async () => {
        await start({ limits: { globalBurst: 2, globalPerSec: 0.001, burst: 100 } });
        for (const username of ['Cy', 'Di', 'Ed']) await db.users.insertOne({ username, password: 'x' });
        const links = [];
        for (const username of ['Cy', 'Di', 'Ed']) links.push((await createResetLink(db, username, { now: new Date(clock) })).token);
        // junk first: malformed and unknown well-formed tokens, any number of them
        for (let i = 0; i < 5; i++) expect((await post({ token: i % 2 ? 'x' : 'x'.repeat(43), password: 'pw' })).status).toBe(400);
        const statuses = [];
        for (const token of links) statuses.push((await post({ token, password: 'pw' })).status);
        expect(statuses).toEqual([200, 200, 429]);
        // the refused link was not used up: it works once the bucket refills
        expect(db.passwordResets.all().find(r => r.username === 'Ed').state).toBe('open');
        clock += 1000 * 1000;
        expect((await post({ token: links[2], password: 'pw' })).status).toBe(200);
    });

    test('junk from many addresses never locks a real link out (SEC2-RESET-GLOBAL-DOS)', async () => {
        await start(); // the production limits
        const { token } = await createResetLink(db, 'Bea', { now: new Date(clock) });
        const statuses = {};
        for (let i = 1; i <= 90; i++) {
            const junk = i % 2 ? { token: 'x', password: 'p' } : { token: 'y'.repeat(43), password: 'p' };
            const res = await post(junk, { 'X-Real-IP': `198.51.100.${i}` });
            statuses[res.status] = (statuses[res.status] || 0) + 1;
        }
        expect(statuses).toEqual({ 400: 90 });
        // and an unknown client address (no X-Real-IP behind the proxy) can send junk all day
        for (let i = 0; i < 70; i++) expect((await post({ token: 'z'.repeat(43), password: 'p' })).status).toBe(400);
        const victim = await post({ token, password: 'brand-new' }, { 'X-Real-IP': '203.0.113.7' });
        expect(victim.status).toBe(200);
        expect(victim.json.ok).toBe(true);
    });

    test('an IPv6 client is limited by its /64, not per address', async () => {
        await start();
        const as = (ip) => post({ token: 'x'.repeat(43), password: 'pw' }, { 'X-Real-IP': ip });
        const statuses = [];
        for (let i = 1; i <= 12; i++) statuses.push((await as(`2001:db8::${i.toString(16)}`)).status);
        expect(statuses).toEqual([...Array(10).fill(400), 429, 429]);
        expect((await as('2001:db8:0:0:ffff:ffff:ffff:ffff')).status).toBe(429); // same /64
        expect((await as('2001:db8:0:1::1')).status).toBe(400); // the next /64 is another client
        expect(clientKey('2001:DB8::1')).toBe(clientKey('2001:db8:0:0:1:2:3:4'));
        expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
    });

    test('the in-flight hash cap counts real attempts only: junk is answered while a hash runs', async () => {
        let release;
        let hashing;
        const entered = new Promise((r) => { hashing = r; });
        const gate = new Promise((r) => { release = r; });
        await start({ limits: { maxInFlight: 1 }, hash: async (pw) => { hashing(); await gate; return bcrypt.hash(pw, 4); } });
        await db.users.insertOne({ username: 'Cy', password: 'x' });
        const bea = (await createResetLink(db, 'Bea', { now: new Date(clock) })).token;
        const cy = (await createResetLink(db, 'Cy', { now: new Date(clock) })).token;
        const first = post({ token: bea, password: 'pw' });
        await entered; // the first is hashing
        expect((await post({ token: 'x'.repeat(43), password: 'pw' })).status).toBe(400);
        expect((await post({ token: cy, password: 'pw' })).status).toBe(503);
        release();
        expect((await first).status).toBe(200);
        expect((await post({ token: cy, password: 'pw' })).status).toBe(200);
    });

    describe('every live connection of the player is signed out', () => {
        let log;
        let wio;
        let k = 0;
        // A tab on the real auth handlers (socket.data, rooms, connected)
        const tab = () => {
            const s = makeSocket(`tab-${++k}`, log, wio);
            s.disconnect = () => {
                wio.sockets.sockets.delete(s.id);
                for (const m of wio.rooms.values()) m.delete(s.id);
            };
            return s;
        };
        const reply = (s, event) => log.filter(l => l.to === `self:${s.id}` && l.event === event).pop()?.data;
        const got = (s, event) => log.some(l => l.to === `self:${s.id}` && l.event === event);

        beforeEach(() => {
            log = [];
            wio = makeIo(log);
            io = wio;
            mockDb.current = db;
            gameManager.currentUsers = [];
            gameManager.mainRoomSocketIds.clear();
        });
        afterEach(() => { mockDb.current = null; });

        async function signedInTab() {
            const s = tab();
            await auth.signIn(s, wio, { username: 'Bea', password: 'old' });
            expect(reply(s, 'signInResponse')).toMatchObject({ success: true });
            return { s, token: reply(s, 'signInResponse').sessionToken };
        }

        test('two tabs restored from one saved session (RST-DUPSOCK): both signed out and out of the main room', async () => {
            await start();
            const { s: first, token } = await signedInTab();
            gameManager.joinMainRoom(first.id);
            first.join('mainRoom');
            // The web client copies the saved session into every new tab
            const second = tab();
            await auth.restoreSession(second, wio, { username: 'Bea', sessionToken: token });
            expect(reply(second, 'restoreSessionResponse')).toMatchObject({ success: true });
            gameManager.joinMainRoom(second.id);
            second.join('mainRoom');
            // the game manager keeps one entry per name: only the newer tab
            expect(gameManager.currentUsers.filter(u => u.username === 'Bea').map(u => u.socketId)).toEqual([second.id]);

            const { token: link } = await createResetLink(db, 'Bea', { now: new Date(clock) });
            expect((await post({ token: link, password: 'brand-new' })).status).toBe(200);
            for (const s of [first, second]) {
                expect(got(s, 'forceLogout')).toBe(true);
                expect(wio.sockets.sockets.has(s.id)).toBe(false);
                expect(gameManager.mainRoomSocketIds.has(s.id)).toBe(false);
            }
            expect(wio.rooms.get('mainRoom').size).toBe(0);
            expect(db.adminAudit.all().pop().detail).toMatch(/2 live connection\(s\) signed out/);
        });

        test('the connection the revoke found on the account (findOneAndUpdate before) is signed out even if never registered', async () => {
            await start();
            // bea-sock (beforeEach): users.socketId, not in the game manager
            // (a restore whose reply is still in flight), no claim on it
            io = { sockets: { sockets: new Map([['bea-sock', liveSocket]]) } };
            const { token } = await createResetLink(db, 'Bea', { now: new Date(clock) });
            expect((await post({ token, password: 'brand-new' })).status).toBe(200);
            expect(liveSocket.emit).toHaveBeenCalledWith('forceLogout');
            expect(liveSocket.disconnect).toHaveBeenCalled();
            expect(db.adminAudit.all().pop().detail).toMatch(/1 live connection\(s\) signed out/);
        });

        test('a restore whose write landed before the reset but resumes after it ends signed out (RST-SOCK)', async () => {
            await start();
            const { s: phone, token } = await signedInTab();
            // A controllable database: the attacker's restore lands its write
            // (epoch 0: it matches) and its reply is held
            const users = db.users;
            const original = users.updateOne.bind(users);
            let release;
            let landed;
            const gate = new Promise(r => { release = r; });
            const writeLanded = new Promise(r => { landed = r; });
            users.updateOne = async (...args) => {
                users.updateOne = original;
                const res = await original(...args);
                landed();
                await gate;
                return res;
            };
            const attacker = tab();
            const restoring = auth.restoreSession(attacker, wio, { username: 'Bea', sessionToken: token });
            await writeLanded;
            expect((await db.users.findOne({ username: 'Bea' })).socketId).toBe(attacker.id);
            expect(gameManager.getUserBySocketId(attacker.id)).toBeUndefined(); // not registered yet

            // The player uses the link while that reply is in flight
            const { token: link } = await createResetLink(db, 'Bea', { now: new Date(clock) });
            expect((await post({ token: link, password: 'brand-new' })).status).toBe(200);
            release();
            await restoring;

            expect(got(attacker, 'forceLogout')).toBe(true);
            expect(wio.sockets.sockets.has(attacker.id)).toBe(false);
            expect(log.filter(l => l.to === `self:${attacker.id}` && l.event === 'restoreSessionResponse' && l.data.success)).toEqual([]);
            expect(gameManager.getUserBySocketId(attacker.id)).toBeUndefined();
            expect(gameManager.currentUsers.filter(u => u.username === 'Bea')).toEqual([]);
            expect(got(phone, 'forceLogout')).toBe(true);
            expect(db.adminAudit.all().pop().detail).toMatch(/2 live connection\(s\) signed out/);
            // and the saved session stays dead
            const again = tab();
            await auth.restoreSession(again, wio, { username: 'Bea', sessionToken: token });
            expect(reply(again, 'restoreSessionResponse')).toMatchObject({ success: false });
        });
    });

    test('database not ready or failing: 503, the link survives', async () => {
        await start();
        const { token } = await createResetLink(db, 'Bea', { now: new Date(clock) });
        const real = db.users.findOneAndUpdate.bind(db.users);
        db.users.findOneAndUpdate = async () => { throw new Error('write failed'); };
        expect((await post({ token, password: 'pw' })).status).toBe(503);
        db.users.findOneAndUpdate = real;
        expect((await post({ token, password: 'pw' })).status).toBe(200);
        const saved = db;
        db = { users: undefined, passwordResets: undefined };
        expect((await post({ token, password: 'pw' })).status).toBe(503);
        db = saved;
    });
});

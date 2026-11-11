/**
 * Serving the built web client (server/staticAssets.js + the compression
 * middleware, mounted as server/index.js does): the page is no-cache, the
 * hashed bundles immutable, the legacy /dist/main.js entry no-cache, and
 * JS/HTML go out gzip or brotli. A fake client directory stands in for
 * client/ so the tests never depend on a local `vite build`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const express = require('express');
const { mountStatic } = require('../staticAssets');
const { createCompression } = require('../middleware/compression');

const REAL_CLIENT = path.join(__dirname, '..', '..', 'client');

let tmp;
let server;
let base;

const PAGE = `<!DOCTYPE html><html><head><script type="module" crossorigin src="/dist/assets/main-AbC123.js"></script></head><body>${'<!-- pad -->'.repeat(200)}</body></html>`;
const BUNDLE = `export const x = ${JSON.stringify('y'.repeat(5000))};\n`;

function makeClient({ built = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bab-client-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!-- source page: /src/main.js -->');
    fs.writeFileSync(path.join(dir, 'styles.css'), 'body{}');
    if (built) {
        fs.mkdirSync(path.join(dir, 'dist', 'assets'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'dist', 'index.html'), PAGE);
        fs.writeFileSync(path.join(dir, 'dist', 'main.js'), "import './assets/main-AbC123.js';\n");
        fs.writeFileSync(path.join(dir, 'dist', 'assets', 'main-AbC123.js'), BUNDLE);
    }
    return dir;
}

async function start({ isProduction = true, clientDir }) {
    const app = express();
    app.use(createCompression());
    mountStatic(app, { isProduction, clientDir });
    app.use((req, res) => res.status(418).end('fell through'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
}

// Raw request: fetch would hide which encoding came back
function get(p, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get(base + p, { headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}

function decode(res) {
    const enc = res.headers['content-encoding'];
    if (enc === 'br') return zlib.brotliDecompressSync(res.body).toString();
    if (enc === 'gzip') return zlib.gunzipSync(res.body).toString();
    return res.body.toString();
}

afterEach(async () => {
    if (server) {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
        server = null;
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
});

describe('production', () => {
    beforeEach(async () => {
        tmp = makeClient();
        await start({ clientDir: tmp });
    });

    test('/ and /index.html are the BUILT page, no-cache, brotli or gzip', async () => {
        for (const p of ['/', '/index.html']) {
            const br = await get(p, { 'Accept-Encoding': 'br, gzip' });
            expect([p, br.status, br.headers['cache-control'], br.headers['content-encoding']]).toEqual([p, 200, 'no-cache', 'br']);
            expect(br.headers['content-type']).toMatch(/^text\/html/);
            expect(br.headers.vary).toMatch(/Accept-Encoding/);
            expect(decode(br)).toBe(PAGE);
            const gz = await get(p, { 'Accept-Encoding': 'gzip' });
            expect([gz.headers['content-encoding'], decode(gz)]).toEqual(['gzip', PAGE]);
            const plain = await get(p);
            expect([plain.headers['content-encoding'], plain.body.toString()]).toEqual([undefined, PAGE]);
        }
    });

    test('a revalidated page answers 304 (no-cache means revalidate, not no-store)', async () => {
        const first = await get('/');
        expect(first.headers.etag).toBeTruthy();
        const again = await get('/', { 'If-None-Match': first.headers.etag });
        expect(again.status).toBe(304);
    });

    test('hashed bundles: immutable for a year, nosniff, JS type, compressed; a missing one is a 404', async () => {
        const res = await get('/dist/assets/main-AbC123.js', { 'Accept-Encoding': 'br, gzip' });
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
        expect(res.headers['content-type']).toMatch(/^(text|application)\/javascript/);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['content-encoding']).toBe('br');
        expect(decode(res)).toBe(BUNDLE);
        expect((await get('/dist/assets/main-Old999.js')).status).toBe(404);
    });

    test('legacy /dist/main.js (pages cached before hashing) is no-cache', async () => {
        const res = await get('/dist/main.js');
        expect([res.status, res.headers['cache-control']]).toEqual([200, 'no-cache']);
        expect(res.body.toString()).toContain('./assets/main-AbC123.js');
    });

    test('other client files keep the 1-day cache', async () => {
        const res = await get('/styles.css');
        expect([res.status, res.headers['cache-control']]).toEqual([200, 'public, max-age=86400']);
    });
});

test('development: the hashed bundles are not long-cached', async () => {
    tmp = makeClient();
    await start({ isProduction: false, clientDir: tmp });
    const res = await get('/dist/assets/main-AbC123.js');
    expect([res.status, res.headers['cache-control']]).toEqual([200, 'public, max-age=0']);
    expect((await get('/')).headers['cache-control']).toBe('no-cache');
});

test('no build: / says so (503) instead of serving the source page', async () => {
    tmp = makeClient({ built: false });
    await start({ clientDir: tmp });
    const res = await get('/');
    expect(res.status).toBe(503);
    expect(res.body.toString()).toMatch(/build:client/);
});

test('real client/: table art and avatar art keep their caches; images are never encoded', async () => {
    await start({ clientDir: REAL_CLIENT });
    const enc = { 'Accept-Encoding': 'br, gzip' };
    // The removed `/assets` mount (7 days, sprites immutable) was shadowed by
    // the root static: these were, and stay, 1 day. (The 64 px card art is
    // gone: the web client draws its cards, item 18a.)
    for (const p of ['/assets/frog.png', '/assets/rainbow1.png', '/assets/profile1.png']) {
        const res = await get(p, enc);
        expect([p, res.status, res.headers['cache-control'], res.headers['content-encoding']])
            .toEqual([p, 200, 'public, max-age=86400', undefined]);
    }
    // (not served by the static mount: the harness's fall-through answers)
    for (const p of ['/assets/sprites/cards.png', '/assets/sprites/cards.json', '/assets/card_back.png', '/assets/ace_spades.png']) {
        expect([p, (await get(p, enc)).status === 200]).toEqual([p, false]);
    }
    const webp = await get('/assets/avatars/v1/profile1.webp', enc);
    expect([webp.status, webp.headers['cache-control'], webp.headers['content-encoding']])
        .toEqual([200, 'public, max-age=31536000, immutable', undefined]);
});

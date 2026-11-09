/**
 * Stock avatar art (scripts/build-avatars.js; docs/avatars.md): the
 * re-encoded legacy files keep their paths, names and format (I5: the App
 * Store iOS build loads /assets/profile<N>.png), the new WebP siblings are
 * versioned and immutable, and client/assets stays small.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const sharp = require('sharp');
const { mountStatic } = require('../staticAssets');
const { PLACEHOLDER_INLINE } = require('../avatar/placeholder');
const fx = require('../testUtils/avatarFixtures');

const ASSETS = path.join(__dirname, '..', '..', 'client', 'assets');

function dirBytes(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).reduce((a, e) => {
        const p = path.join(dir, e.name);
        return a + (e.isDirectory() ? dirBytes(p) : fs.statSync(p).size);
    }, 0);
}

test('profile1..82.png are 192x192 PNG with alpha; avatars/v1 holds 256x256 WebP siblings; frog sizes', async () => {
    for (let n = 1; n <= 82; n++) {
        const png = await sharp(path.join(ASSETS, `profile${n}.png`)).metadata();
        expect({ n, f: png.format, w: png.width, h: png.height, a: png.hasAlpha }).toEqual({ n, f: 'png', w: 192, h: 192, a: true });
        const webp = await sharp(path.join(ASSETS, 'avatars', 'v1', `profile${n}.webp`)).metadata();
        expect({ n, f: webp.format, w: webp.width, h: webp.height, a: webp.hasAlpha }).toEqual({ n, f: 'webp', w: 256, h: 256, a: true });
    }
    expect(fs.existsSync(path.join(ASSETS, 'profile83.png'))).toBe(false);
    const frog = await sharp(path.join(ASSETS, 'frog.png')).metadata();
    expect([frog.format, frog.width]).toEqual(['png', 120]);
    const frogWebp = await sharp(path.join(ASSETS, 'avatars', 'v1', 'frog.webp')).metadata();
    expect([frogWebp.format, frogWebp.width]).toEqual(['webp', 120]);
    expect(await fx.iosLegacyDecodes(PLACEHOLDER_INLINE)).toBe(true);
});

test('client/assets totals at most 2.6 MB (was 20.1 MB)', () => {
    expect(dirBytes(ASSETS)).toBeLessThanOrEqual(2600000);
});

describe('served through the app', () => {
    let server;
    let base;
    const start = async (isProduction) => {
        const app = express();
        mountStatic(app, { isProduction });
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
    };
    afterEach(async () => {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
    });

    test('production: /assets/avatars/v1 is immutable + nosniff; /assets/profile1.png is still image/png (1 day); a missing v1 file 404s', async () => {
        await start(true);
        const w = await fetch(`${base}/assets/avatars/v1/profile1.webp`);
        expect(w.status).toBe(200);
        expect(w.headers.get('content-type')).toBe('image/webp');
        expect(w.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(w.headers.get('x-content-type-options')).toBe('nosniff');
        const p = await fetch(`${base}/assets/profile1.png`);
        expect(p.status).toBe(200);
        expect(p.headers.get('content-type')).toBe('image/png');
        expect(p.headers.get('cache-control')).toBe('public, max-age=86400');
        const f = await fetch(`${base}/assets/frog.png`);
        expect([f.status, f.headers.get('content-type')]).toEqual([200, 'image/png']);
        expect((await fetch(`${base}/assets/avatars/v1/profile83.webp`)).status).toBe(404);
        expect([403, 404]).toContain((await fetch(`${base}/assets/avatars/v1/..%2F..%2Findex.html`)).status); // serve-static: 403 on traversal
    });

    test('development: no long cache', async () => {
        await start(false);
        const w = await fetch(`${base}/assets/avatars/v1/profile2.webp`);
        expect(w.status).toBe(200);
        expect(w.headers.get('cache-control')).toBe('public, max-age=0');
    });
});

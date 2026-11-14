/**
 * The page CSP: the server header (server/middleware/csp.js) and the
 * page's meta (client/index.html, copied into the built page) are both
 * enforced, so they must agree, and neither may allow inline or CDN
 * scripts, eval or Google Fonts (all gone with the bundled build / 18b).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { cspMiddleware, CONTENT_SECURITY_POLICY } = require('../middleware/csp');

const ROOT = path.join(__dirname, '..', '..');

function parse(policy) {
    const out = {};
    for (const part of policy.split(';')) {
        const [name, ...sources] = part.trim().split(/\s+/);
        if (name) out[name] = sources;
    }
    return out;
}

function metaPolicy(page = 'index.html') {
    const html = fs.readFileSync(path.join(ROOT, 'client', page), 'utf8');
    const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
    expect(m).toBeTruthy();
    return parse(m[1]);
}

const header = parse(CONTENT_SECURITY_POLICY);

test('scripts: only the page\'s own bundle, no inline, no eval, no CDN', () => {
    for (const policy of [header, metaPolicy()]) {
        expect(policy['script-src']).toEqual(["'self'"]);
    }
});

test('no Google Fonts anywhere (the UI uses the system font; the cards\' face is a bundled file)', () => {
    for (const policy of [header, metaPolicy()]) {
        expect(policy['font-src']).toEqual(["'self'"]);
        expect(policy['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    }
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/fonts\.(googleapis|gstatic)\.com|cdn\.(jsdelivr\.net|socket\.io)/);
});

test('the cards\' index font is a same-origin file font-src \'self\' allows: a hashed /dist/assets woff2, never a data: URL', () => {
    const src = fs.readFileSync(path.join(ROOT, 'client', 'src', 'phaser', 'cards', 'cardFont.js'), 'utf8');
    expect(src).toMatch(/import fontUrl from '\.\.\/\.\.\/\.\.\/assets\/fonts\/BABCardIndex\.woff2\?url';/);
    const font = fs.statSync(path.join(ROOT, 'client', 'assets', 'fonts', 'BABCardIndex.woff2'));
    expect(font.size).toBeLessThan(8 * 1024);
    // the OFL travels with the subset (a Modified Version of Arvo, renamed)
    expect(fs.readFileSync(path.join(ROOT, 'client', 'assets', 'fonts', 'OFL.txt'), 'utf8')).toMatch(/SIL Open Font License, Version 1\.1/);
    // under Vite's 4 KB default a woff2 would be inlined as data:, which font-src 'self' refuses
    const config = fs.readFileSync(path.join(ROOT, 'client', 'vite.config.js'), 'utf8');
    expect(config).toMatch(/assetsInlineLimit: \(file\) => \(\/\\\.woff2\?\$\/\.test\(file\) \? false : undefined\)/);
    // a built client (npm run build): the app chunk points at the emitted file
    const assets = path.join(ROOT, 'client', 'dist', 'assets');
    if (!fs.existsSync(assets)) return;
    const files = fs.readdirSync(assets);
    const woff = files.filter((f) => /^BABCardIndex-[\w-]+\.woff2$/.test(f));
    expect(woff).toHaveLength(1);
    const js = files.filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n');
    expect(js).toContain(`/dist/assets/${woff[0]}`);
    expect(js).not.toMatch(/data:font\/woff2/);
});

test('the header and the meta agree on every directive but the hosts', () => {
    const meta = metaPolicy();
    for (const d of ['script-src', 'img-src', 'font-src', 'style-src', 'media-src']) {
        expect([d, header[d]]).toEqual([d, meta[d]]);
    }
});

test('the reset page (client/reset.html) carries the same meta policy as the app page', () => {
    expect(metaPolicy('reset.html')).toEqual(metaPolicy('index.html'));
    const html = fs.readFileSync(path.join(ROOT, 'client', 'reset.html'), 'utf8');
    expect(html).toMatch(/<meta name="referrer" content="no-referrer">/);
});

test('connect-src keeps the production hosts', () => {
    expect(header['connect-src']).toEqual(["'self'",
        'wss://bab-online-production.up.railway.app', 'https://bab-online-production.up.railway.app',
        'wss://babonline.io', 'https://babonline.io']);
    expect(header['default-src']).toEqual(["'self'", 'https://bab-online-production.up.railway.app', 'https://babonline.io']);
});

test('no eval: none in the client source, and the build rewrites Phaser\'s (vite.config.js)', () => {
    const offenders = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.js$/.test(e.name) && /\bnew Function\s*\(|(^|[^.\w])eval\s*\(/.test(fs.readFileSync(p, 'utf8'))) offenders.push(p);
        }
    };
    walk(path.join(ROOT, 'client', 'src'));
    expect(offenders).toEqual([]);
    const config = fs.readFileSync(path.join(ROOT, 'client', 'vite.config.js'), 'utf8');
    expect(config).toMatch(/plugins: \[phaserNoEval\(\), /);
});

test('the middleware sets the header on every response', async () => {
    const app = express();
    app.use(cspMiddleware);
    app.get('/x', (req, res) => res.end('ok'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/x`);
        expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    } finally {
        // Node 18 (CI, Railway): close() waits for fetch's keep-alive socket
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
    }
});

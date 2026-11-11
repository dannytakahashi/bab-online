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

function metaPolicy() {
    const html = fs.readFileSync(path.join(ROOT, 'client', 'index.html'), 'utf8');
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

test('no Google Fonts anywhere (the client uses the system font)', () => {
    for (const policy of [header, metaPolicy()]) {
        expect(policy['font-src']).toEqual(["'self'"]);
        expect(policy['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    }
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/fonts\.(googleapis|gstatic)\.com|cdn\.(jsdelivr\.net|socket\.io)/);
});

test('the header and the meta agree on every directive but the hosts', () => {
    const meta = metaPolicy();
    for (const d of ['script-src', 'img-src', 'font-src', 'style-src', 'media-src']) {
        expect([d, header[d]]).toEqual([d, meta[d]]);
    }
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
        await new Promise((r) => server.close(r));
    }
});

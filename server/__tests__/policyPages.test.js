/**
 * /privacy and /support (server/routes/index.js): the App Store privacy
 * policy URL and the support URL. The policy must keep naming its date and
 * the outside services that see player data, and say what an account
 * deletion keeps; a change to what the server stores or who processes it
 * should fail here until the policy says so too (and the date moves).
 */

const http = require('http');
const express = require('express');

const routes = require('../routes');

let server;
let base;

beforeAll(async () => {
    const app = express();
    app.use('/', routes);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
});

async function page(path) {
    const res = await fetch(base + path);
    expect(res.status).toBe(200);
    return res.text();
}

describe('/privacy', () => {
    let html;
    beforeAll(async () => { html = await page('/privacy'); });

    test('shows the effective date', () => {
        expect(html).toContain('<strong>Last updated:</strong> November 15, 2026');
    });

    test('names every processor that sees player data', () => {
        // Railway: server, logs, database; Cloudflare: TURN relay + STUN
        // (server/voice/turnCredentials.js); Google: the STUN fallback
        expect(html).toMatch(/<strong>Railway<\/strong> hosts our server, its logs, and our MongoDB database/);
        expect(html).toMatch(/<strong>Cloudflare<\/strong> provides the voice relay/);
        expect(html).toMatch(/<strong>Google<\/strong> runs the public STUN servers/);
    });

    test('says what deletion keeps (server/admin/accountDelete.js)', () => {
        expect(html).toContain('"[deleted]"');
        expect(html).toMatch(/<strong>Reports<\/strong> you filed or that were filed about you stay/);
        expect(html).toMatch(/<strong>The admin log<\/strong> keeps the usernames/);
        // the deleted name's 30-day hold (accountDelete.NAME_HOLD_MS)
        expect(html).toMatch(/<strong>Your username<\/strong> itself stays reserved for 30 days after you delete your account/);
        expect(html).toMatch(/<strong>Other players' block lists<\/strong> keep your username when you delete your account in the app/);
        // an admin delete (an email request) pulls the name (pullBlocks default)
        expect(html).toContain('we remove the username from block lists too');
    });

    test('mentions the sign-in IP log and chat staying out of storage', () => {
        expect(html).toContain('A sign-in with your password also logs your IP address');
        // Railway's edge logs every connection's IP (its HTTP logs)
        expect(html).toContain('Railway, our host, also records the IP address of every connection');
        // safetyHandlers logs blocks and who reported whom, never the reason
        expect(html).toContain('reports (who reported whom, not the reason)');
        expect(html).toContain('It is never saved to our database or written to our logs');
        // client error reports (server/socket/clientErrorHandlers.js)
        expect(html).toContain('When the app hits an error it may send us a short technical report (the error message and where it happened), logged with your username if you are signed in. Reports are meant for code only: before a report is logged we remove email addresses, IP addresses, long numbers, the query part of links, and quoted text other than code names.');
    });

    test('keeps the contact address and the in-app deletion path', () => {
        expect(html).toContain('mailto:support@zalberico.com');
        expect(html).toContain('Settings → Delete Account');
    });

    test('no longer claims nothing reaches a third party', () => {
        expect(html).not.toMatch(/do not sell, share, or transfer your data to any third parties/);
        expect(html).not.toMatch(/Your data stays on our server/);
    });
});

describe('/support', () => {
    test('the data answers match the policy', async () => {
        const html = await page('/support');
        expect(html).toContain('Our server logs record your IP address when you sign in with your password, and our host, Railway, logs the IP address of each connection.');
        expect(html).toContain('Reports, the admin log, and other players\' block lists keep your username');
        expect(html).not.toMatch(/We only collect your username, a hashed password, and game statistics/);
    });
});

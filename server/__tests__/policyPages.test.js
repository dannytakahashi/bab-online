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
        expect(html).toContain('<strong>Last updated:</strong> November 17, 2026');
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

    test('mentions the sign-in IP log and chat staying out of the logs', () => {
        expect(html).toContain('A sign-in with your password also logs your IP address');
        // Railway's edge logs every connection's IP (its HTTP logs)
        expect(html).toContain('Railway, our host, also records the IP address of every connection');
        // safetyHandlers logs blocks and who reported whom, never the reason
        expect(html).toContain('reports (who reported whom, not the reason)');
        expect(html).toContain('It is never written to our logs.');
        // Deploy survival (LIVE_PERSIST, server-infra.md Live game persistence):
        // a game's and a tournament's chat is in its live document
        expect(html).toContain('A game\'s or tournament\'s chat is saved to our database with the rest of the game while it is in progress (see "Games in progress" above), so it can continue after a server update, and is deleted with it.');
        expect(html).not.toContain('never saved to our database');
        // client error reports (server/socket/clientErrorHandlers.js)
        expect(html).toContain('When the app hits an error it may send us a short technical report (the error message and where it happened), logged with your username if you are signed in. Reports are meant for code only: before a report is logged we remove email addresses, IP addresses, long numbers, the query part of links, and quoted text other than code names.');
    });

    test('says who is in a voice chat: players and, in casual games, spectators (server/voice/gameVoice.js)', () => {
        expect(html).toContain('between the devices of the people in a game\'s voice chat (players and, in casual games, spectators)');
        expect(html).toContain('the people in that voice chat can see your IP address');
        expect(html).toContain('In casual games, people watching can listen and, if allowed, talk.');
        expect(html).not.toContain('the players you talk with can see your IP address');
    });

    test('says what a game in progress keeps, and for how long (deploy survival: liveGames / liveTournaments)', () => {
        // What We Collect
        expect(html).toContain('<li><strong>Games in progress:</strong> while a game or tournament is running, its state is saved to our database so it can continue after a server update: who is in each seat, each player\'s cards, bids, tricks and scores, the game log, and its chat (including spectators\' messages); for a tournament, from when it is created, also its players, scoreboard and chat. It is normally deleted when the game ends, or about 10 minutes after a tournament ends (while its final standings are shown), and always within a day.</li>');
        // How Long We Keep It (the TTL: expireAt = createdAt + 24 h)
        expect(html).toContain('<li><strong>Games in progress:</strong> until the game ends, or about 10 minutes after a tournament ends, and at most one day. Copies in backups expire as described below.</li>');
        expect(html).toContain('reconnecting you to games in progress, including after a server update');
        // Deletion: the chat scrub, and the results window's standings. "saved
        // state": the scrub runs only with LIVE_PERSIST write/on (liveStore.scrubChat),
        // so off (nothing saved) keeps today's in-memory chat as it was
        expect(html).toContain('replaces your username with "[deleted]" in game records, and removes your chat messages from the saved state of any game or tournament still in progress.');
        expect(html).toContain('<strong>A tournament that has just finished</strong> keeps your username in its final standings for about 10 minutes, then it is deleted.');
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
        // Harmonized with the policy's "Games in progress"
        expect(html).toContain('While a game or tournament is in progress, its state and chat are saved so it can continue after a server update, and deleted when it ends (about 10 minutes after, for a tournament\'s final standings; within a day at most). Main room and lobby chat is not saved, and voice chat goes directly');
        expect(html).not.toContain('Chat is not saved');
    });
});

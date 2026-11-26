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
        expect(html).toContain('<strong>Last updated:</strong> November 25, 2026');
    });

    test('says the /help counts are kept with the game and in its record (server/socket/assistHandlers.js, buildGameEndRecord)', () => {
        expect(html).toContain('how many times each seat used /help (and whether that made it a bot-assisted game for that player)');
        expect(html).toContain('how many times each player has used /help, the game log, and its chat');
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
        // Narrowed for deploy survival (owner, 2026-11-17): the database's own
        // slow-operation log may record a saved game update, chat included
        expect(html).toContain('It is never written to our application\'s logs.');
        expect(html).not.toContain('It is never written to our logs.');
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
        expect(html).toContain('<li><strong>Games in progress:</strong> while a game or tournament is running, its state is saved to our database so it can continue after a server update: who is in each seat, each player\'s cards, bids, tricks and scores, how many times each player has used /help, the game log, and its chat (including spectators\' messages), and for a game started from a lobby, the lobby\'s name and the usernames of its members (including members who sat out and watched); for a tournament, from when it is created, also its name, players, scoreboard and chat. It is normally deleted when the game ends, or about 10 minutes after a tournament ends (while its final standings are shown), and always within a day.</li>');
        // How Long We Keep It (the TTL: expireAt = createdAt + 24 h)
        expect(html).toContain('<li><strong>Games in progress:</strong> until the game ends, or about 10 minutes after a tournament ends, and at most one day. Copies in backups expire as described below.</li>');
        expect(html).toContain('reconnecting you to games in progress, including after a server update');
        // Deletion: the chat scrub, and a tournament's standings (a member who
        // left a running one can delete their account: their scoreboard row
        // stays until the tournament is deleted). "saved
        // state": the scrub runs only with LIVE_PERSIST write/on (liveStore.scrubChat),
        // so off (nothing saved) keeps today's in-memory chat as it was
        expect(html).toContain('replaces your username with "[deleted]" in game records and tournament records, and removes your chat messages from the saved state of any game or tournament still in progress.');
        expect(html).not.toContain('A tournament that has just finished');
        // the live copy goes ~10 minutes after the end; the record stays as
        // history with "[deleted]" (profileHandlers.recordTournament's
        // renamer, accountDelete's tournamentRecords step)
        expect(html).toContain('<strong>A tournament you played in</strong> that is still running or has only just ended (also one you left) keeps your username in its saved state while it runs and for about 10 minutes after it ends, while its final standings are shown, then that copy is deleted. Its tournament record shows "[deleted]" instead of your username.');
        expect(html).not.toContain('for about 10 minutes after it ends, then it is deleted.');
        // A lobby member who sat out a casual game (an 'extra', watching) can
        // delete their account mid-game (findLiveActivity: entrants, players,
        // seat owners only); gameCodec saves lobbyOrigin (order, casualUsers,
        // extras, ...) and casualVoice.lobbyExtras by username, which the
        // chat scrub leaves
        expect(html).toContain('<strong>A casual game whose lobby you were in</strong> but did not play in (for example, one you sat out and watched) keeps your username in its saved state, as one of the lobby\'s members, until the game ends, then it is deleted.');
    });

    test('says what the tournament history keeps, who sees it, and that a deletion makes it "[deleted]" (tournamentRecords, 2026-11-25)', () => {
        expect(html).toContain('<li><strong>Tournaments:</strong> a record of each finished tournament: its name, its host\'s username, the usernames of the players who finished it, the final standings (each player\'s score in every round and in total, including players who left before the end), the winners, the cut for a buck result if one was played (who took part, how many rounds it took, and who won), and when it started and ended.</li>');
        expect(html).toContain('tournament records (the tournament\'s name and date, how many players finished it, the winners, where the player placed, and who won cut for a buck) on the profiles of the players who finished them; Cut for a buck wins also count toward a title on the Records page.');
        expect(html).toContain('<li><strong>Tournament records:</strong> kept as the tournament\'s history. If you delete your account, your username in them is replaced with "[deleted]".</li>');
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
        expect(html).toContain('your username is replaced with "[deleted]" in game records and tournament records.');
        expect(html).toContain('the record of each tournament you finished (its final standings, winners and cut for a buck result, shown on your profile)');
        expect(html).toContain('Reports, the admin log, and other players\' block lists keep your username, and so do a tournament still running or only just ended that you played in (in its saved standings, until about 10 minutes after it ends) and a casual game whose lobby you were in but did not play in (until it ends); your chat messages are removed from the saved state of any game or tournament still in progress. The <a href="/privacy">Privacy Policy</a> explains why.');
        expect(html).not.toMatch(/We only collect your username, a hashed password, and game statistics/);
        // Harmonized with the policy's "Games in progress"
        expect(html).toContain('While a game or tournament is in progress, its state and chat are saved so it can continue after a server update, and deleted when it ends (about 10 minutes after, for a tournament\'s final standings; within a day at most). Main room and game lobby chat is not saved (a tournament\'s chat is, from when it is created), and voice chat goes directly');
        // A tournament is saved from creation, its lobby chat included
        expect(html).not.toContain('Main room and lobby chat is not saved');
        expect(html).not.toContain('Chat is not saved');
    });

    test('the /help answer (assistHandlers: ?help in the iOS app, 3 free uses, the 4th makes it a bot game)', async () => {
        const html = await page('/support');
        expect(html).toContain('<summary>Can I get a hint during a game?</summary>');
        expect(html).toMatch(/type <strong>\/help<\/strong> in the game chat \(in the iOS app, type <strong>\?help<\/strong>; newer versions also accept \/help\)/);
        // every App Store build refuses /help on the device: never "older versions" only
        expect(html).not.toMatch(/older versions of the iOS app, type <strong>\?help/);
        expect(html).toContain('Each game you get 3 free uses; if you use /help a 4th time, that game counts as bot-assisted for you');
        // owner 2026-11-21: only a win moves it to the bot-game statistics
        expect(html).toContain('if you win, it goes in your bot-game statistics instead of your human ones and is listed with the bot games in Records; a loss or a tie stays in your human statistics.');
    });
});

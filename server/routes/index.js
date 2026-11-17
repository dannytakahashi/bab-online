/**
 * Express routes
 */

const express = require('express');
const { getDB } = require('../database');
const { healthHandler } = require('./health');
const { logger } = require('../utils/logger');
const router = express.Router();

// Deploy measurement (docs/claude/server-infra.md, Deploys): the first 200
// from /ready is when Railway's healthcheck can pass and switch traffic to
// this instance; logged once per process
let readyLogged = false;

// The main page (`/`, the built client/dist/index.html) is served by
// server/staticAssets.js, mounted before these routes

// Privacy policy
router.get('/privacy', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BAB Online - Privacy Policy</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #e0e0e0; background: #1a1a1a; line-height: 1.6; }
        h1 { color: #4dcc73; }
        h2 { color: #ccc; margin-top: 2em; }
        p { margin: 0.8em 0; }
        a { color: #4dcc73; }
        ul { margin: 0.8em 0; }
        li { margin: 0.4em 0; }
    </style>
</head>
<body>
    <h1>BAB Online — Privacy Policy</h1>
    <p><strong>Last updated:</strong> November 17, 2026</p>

    <p>BAB Online collects only what the game needs to run. There are no ads, no tracking, no analytics, and we never sell your data.</p>

    <h2>What We Collect</h2>
    <ul>
        <li><strong>Account:</strong> your username and your password, stored only as a bcrypt hash. We don't ask for your real name, email address, or phone number.</li>
        <li><strong>Sign-in sessions:</strong> for each device that stays signed in (up to 5), a hashed sign-in token and when it was created and last used. A session stops working 90 days after its last use. The token itself is kept on your device (the iOS Keychain, or your browser's storage). An account that hasn't been used since November 7, 2026 may still hold one older sign-in token stored as is, without the 90-day limit; it is replaced with a hashed one the next time it is used.</li>
        <li><strong>Profile:</strong> the stock picture you chose, or a picture you uploaded. Other players only ever see a copy we re-encode with its metadata (such as photo location) removed, and new uploads are normally stored that way too. A picture uploaded before November 8, 2026 may still be stored as it was uploaded, metadata included, until you replace it or delete your account.</li>
        <li><strong>Games:</strong> your statistics (wins, losses, points, bids and tricks) and a record of each finished game: the usernames of the people who played, the bots' names, the scores, each seat's statistics for that game, and when it ended.</li>
        <li><strong>Games in progress:</strong> while a game or tournament is running, its state is saved to our database so it can continue after a server update: who is in each seat, each player's cards, bids, tricks and scores, the game log, and its chat (including spectators' messages); for a tournament, from when it is created, also its players, scoreboard and chat. It is normally deleted when the game ends, or about 10 minutes after a tournament ends (while its final standings are shown), and always within a day.</li>
        <li><strong>Safety:</strong> the players you block, reports you file (who you reported, the reason you wrote, where it happened, and when), and reports other players file about you.</li>
        <li><strong>Admin records:</strong> when an admin acts on an account or a report (for example a rename, a password reset link, or a deletion), a log entry with the admin's username, the account's username, the action, its result, a short note, and the time. A signed-in player who tries to use an admin function is logged the same way, with their username. Password reset links are stored only as a hash.</li>
        <li><strong>Server logs:</strong> the server logs events such as sign-ins, sign-ups, wrong passwords, blocks and unblocks (who blocked whom), reports (who reported whom, not the reason), and errors, with the usernames involved. A sign-in with your password also logs your IP address, and so does a sign-in, account deletion, or sign-up that is refused after too many attempts. Railway, our host, also records the IP address of every connection to our site in its own request logs. We use these logs to fix problems and to stop password guessing and spam sign-ups. When the app hits an error it may send us a short technical report (the error message and where it happened), logged with your username if you are signed in. Reports are meant for code only: before a report is logged we remove email addresses, IP addresses, long numbers, the query part of links, and quoted text other than code names.</li>
    </ul>
    <p>We don't collect your location, contacts, photo library, or device identifiers. The app contains no analytics or advertising code, and our website sets no cookies.</p>

    <h2>Chat and Voice</h2>
    <p><strong>Text chat</strong> is filtered for profanity and shown to the other players in the room. It is never written to our logs. The server keeps the last 50 main room messages and each game lobby's chat in memory only. A game's or tournament's chat is saved to our database with the rest of the game while it is in progress (see "Games in progress" above), so it can continue after a server update, and is deleted with it.</p>
    <p><strong>Voice chat</strong> is optional and needs your permission to use the microphone. Audio is encrypted and goes directly, over WebRTC, between the devices of the people in a game's voice chat (players and, in casual games, spectators); it is never recorded, and our server only passes along the messages that set up the call. To set up the call your device contacts a STUN server (Cloudflare's, or Google's public ones), which sees your IP address. When a direct connection isn't possible, the encrypted audio is relayed through Cloudflare, which sees the IP addresses involved but cannot listen to the audio. As in any peer-to-peer call, the people in that voice chat can see your IP address. In casual games, people watching can listen and, if allowed, talk.</p>

    <h2>Who Can See Your Data</h2>
    <p>Your username, profile picture, and statistics are public: they appear on the leaderboard, in player search and profiles, and at the table, and anyone can see them, even without an account. So do game records (who played, the scores, and when) on the Records page. Reports, block lists, sessions, and logs are never shown to other players; admins can see reports and the admin log.</p>

    <h2>How We Use Your Data</h2>
    <p>Only to run the game: showing your name and picture to other players, keeping leaderboards and records, reconnecting you to games in progress, including after a server update, handling reports and blocks, and protecting accounts from abuse. We don't use it for advertising or profiling.</p>

    <h2>Where It's Stored and Who Processes It</h2>
    <ul>
        <li><strong>Railway</strong> hosts our server, its logs, and our MongoDB database, in the United States.</li>
        <li><strong>Cloudflare</strong> provides the voice relay and its STUN server (see Chat and Voice).</li>
        <li><strong>Google</strong> runs the public STUN servers the app uses for voice when Cloudflare's relay is unavailable; they see your IP address only.</li>
        <li><strong>Apple</strong> distributes the iOS app. If you agreed on your device to share analytics with app developers, Apple may share anonymous crash reports and usage statistics with us.</li>
    </ul>
    <p>We don't sell, rent, or share your data with anyone else, unless the law requires it.</p>

    <h2>How Long We Keep It</h2>
    <ul>
        <li><strong>Account, profile, statistics, and block list:</strong> until you delete your account.</li>
        <li><strong>Sign-in sessions:</strong> they stop working 90 days after their last use, and are deleted with your account.</li>
        <li><strong>Game records:</strong> kept as the game's history. If you delete your account, your username in them is replaced with "[deleted]".</li>
        <li><strong>Reports and the admin log:</strong> kept as a moderation and safety record; they are not deleted automatically.</li>
        <li><strong>Password reset links:</strong> valid for 24 hours and deleted from our database about a week after they expire.</li>
        <li><strong>Old usernames:</strong> if an admin renames your account or merges it into another, the old username stays as a redirect to your account (and stays reserved) until your account is deleted.</li>
        <li><strong>Server logs:</strong> kept by Railway, including its request logs, for a limited time (at most 30 days), then deleted.</li>
        <li><strong>Games in progress:</strong> until the game ends, or about 10 minutes after a tournament ends, and at most one day. Copies in backups expire as described below.</li>
        <li><strong>Backups:</strong> if we keep backups of the database for recovery, deleted data disappears from them as they expire, within 3 months.</li>
    </ul>

    <h2>Data Deletion</h2>
    <p>You can permanently delete your account directly in the app: open <strong>Settings → Delete Account</strong> (iOS) or your <strong>profile page → Delete Account</strong> (web) and confirm with your password. This immediately deletes your account, password hash, sign-in sessions, statistics, profile picture, and block list, cancels any open password reset link, deletes any old usernames that redirect to your account, replaces your username with "[deleted]" in game records, and removes your chat messages from any game or tournament still in progress.</p>
    <p>Some records keep your username, and why:</p>
    <ul>
        <li><strong>Reports</strong> you filed or that were filed about you stay, marked as belonging to a deleted account, so the moderation history is not lost.</li>
        <li><strong>The admin log</strong> keeps the usernames recorded at the time, as a record of what admins did and of attempts to use admin functions.</li>
        <li><strong>Your username</strong> itself stays reserved for 30 days after you delete your account, so nobody else can sign up with it right away; then it is released.</li>
        <li><strong>Other players' block lists</strong> keep your username when you delete your account in the app, so deleting an account and signing up again with the same name can't be used to get around a block. When we delete an account for you (for example at your request by email), we remove the username from block lists too.</li>
        <li><strong>A tournament that has just finished</strong> keeps your username in its final standings for about 10 minutes, then it is deleted.</li>
        <li><strong>Server logs and backups</strong> expire on the schedule above.</li>
    </ul>
    <p>You may also email <a href="mailto:support@zalberico.com">support@zalberico.com</a> if you prefer; we will process the request within 48 hours.</p>

    <h2>Children's Privacy</h2>
    <p>BAB Online does not knowingly collect data from children under 13. The game contains no advertising, in-app purchases, or tracking. If you believe a child under 13 has created an account, email us and we will delete it.</p>

    <h2>Changes</h2>
    <p>If we update this policy, the changes will be posted on this page with an updated date.</p>

    <h2>Contact</h2>
    <p>Email: <a href="mailto:support@zalberico.com">support@zalberico.com</a></p>
    <p>Bug reports &amp; feature requests: <a href="https://github.com/dannytakahashi/bab-online/issues">github.com/dannytakahashi/bab-online/issues</a> (issues there are public, so please don't post personal information)</p>
    <p>See our <a href="/support">Support Page</a> for FAQs and more information.</p>
</body>
</html>`);
});

// Support page
router.get('/support', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BAB Online - Support</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #e0e0e0; background: #1a1a1a; line-height: 1.6; }
        h1 { color: #4dcc73; }
        h2 { color: #ccc; margin-top: 2em; }
        h3 { color: #aaa; margin-top: 1.5em; }
        p { margin: 0.8em 0; }
        a { color: #4dcc73; }
        details { margin: 0.8em 0; }
        summary { cursor: pointer; font-weight: bold; color: #ccc; padding: 0.4em 0; }
        summary:hover { color: #4dcc73; }
        details p { margin-left: 1em; }
    </style>
</head>
<body>
    <h1>BAB Online — Support</h1>

    <h2>About</h2>
    <p>BAB Online is a 4-player online multiplayer trick-taking card game (Back Alley Bridge). Play with friends or bots, bid on tricks, and compete for the highest score across 13 hands. Free to play with no ads or in-app purchases.</p>

    <h2>Contact Us</h2>
    <p>Email: <a href="mailto:support@zalberico.com">support@zalberico.com</a></p>
    <p>Bug reports &amp; feature requests: <a href="https://github.com/dannytakahashi/bab-online/issues">github.com/dannytakahashi/bab-online/issues</a></p>

    <h2>Frequently Asked Questions</h2>

    <details>
        <summary>How do I play?</summary>
        <p>BAB Online is a trick-taking card game for 4 players in two teams. Each hand, you bid how many tricks you think you can win, then play your cards. You earn points for meeting your bid and lose points for missing it. The game progresses through 13 hands of varying sizes, and the team with the most points at the end wins.</p>
    </details>

    <details>
        <summary>How do I delete my account?</summary>
        <p>You can delete your account directly in the app. On iOS, open <strong>Settings</strong> (the gear icon in the main room) and tap <strong>Delete Account</strong>; on the web, open your <strong>profile page</strong> and click <strong>Delete Account</strong>. You'll confirm with your password, and your account, statistics, profile picture, and block list are deleted immediately, and your username is replaced with "[deleted]" in game records. Reports, the admin log, and other players' block lists keep your username; the <a href="/privacy">Privacy Policy</a> explains why. (When we delete an account for you by email, block lists drop the username too.)</p>
        <p>You may also email <a href="mailto:support@zalberico.com">support@zalberico.com</a> with your username and we will delete your account within 48 hours.</p>
    </details>

    <details>
        <summary>I'm having connection issues</summary>
        <p>If you're experiencing disconnections or trouble joining games:</p>
        <p>1. Check your internet connection and try switching between Wi-Fi and cellular data.</p>
        <p>2. Close and reopen the app — it will automatically reconnect and rejoin any in-progress game.</p>
        <p>3. If you were in a game, you have 60 seconds to reconnect before other players can replace you with a bot.</p>
        <p>If problems persist, please contact us at <a href="mailto:support@zalberico.com">support@zalberico.com</a>.</p>
    </details>

    <details>
        <summary>What data do you collect?</summary>
        <p>Your username, a hashed password, your profile picture, your game statistics and game records, the players you block, and any reports you file. Our server logs record your IP address when you sign in with your password, and our host, Railway, logs the IP address of each connection. While a game or tournament is in progress, its state and chat are saved so it can continue after a server update, and deleted when it ends (about 10 minutes after, for a tournament's final standings; within a day at most). Main room and lobby chat is not saved, and voice chat goes directly between the people in a game's voice chat and is never recorded (when needed, Cloudflare relays the encrypted audio). We do not collect your real name, email address, location, or device identifiers, and there are no ads or tracking. See our <a href="/privacy">Privacy Policy</a> for full details.</p>
    </details>

    <details>
        <summary>Can I play with fewer than 4 people?</summary>
        <p>Yes! You can fill empty seats with bot players. There are 5 bot personalities with different play styles. You can also play solo with 3 bots.</p>
    </details>

    <h2>Links</h2>
    <p><a href="/privacy">Privacy Policy</a></p>
</body>
</html>`);
});

// Terms of Use — includes the zero-tolerance UGC policy required by App Store Guideline 1.2
router.get('/terms', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BAB Online - Terms of Use</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #e0e0e0; background: #1a1a1a; line-height: 1.6; }
        h1 { color: #4dcc73; }
        h2 { color: #ccc; margin-top: 2em; }
        p { margin: 0.8em 0; }
        a { color: #4dcc73; }
        ul { margin: 0.8em 0; }
    </style>
</head>
<body>
    <h1>BAB Online — Terms of Use</h1>
    <p><strong>Last updated:</strong> June 9, 2026</p>

    <h2>Acceptance</h2>
    <p>By creating an account or playing BAB Online you agree to these terms. If you do not agree, do not use the service.</p>

    <h2>User Conduct — Zero Tolerance for Objectionable Content</h2>
    <p>BAB Online includes text chat and voice chat with other players. There is <strong>no tolerance for objectionable content or abusive behavior</strong>, including but not limited to:</p>
    <ul>
        <li>Harassment, threats, or hate speech</li>
        <li>Obscene, sexual, or violent content</li>
        <li>Offensive usernames, lobby names, or profile pictures</li>
        <li>Spam or impersonation</li>
    </ul>
    <p>Violations may result in immediate account termination without notice.</p>

    <h2>Moderation Tools</h2>
    <p>You can <strong>report</strong> any player and <strong>block</strong> any player from within the app (block hides their chat messages from you immediately). Reports are reviewed within 24 hours, and offending users may be removed.</p>

    <h2>Accounts</h2>
    <p>You are responsible for your account. You may delete your account at any time in the app (Settings → Delete Account on iOS, profile page on web); see the <a href="/privacy">Privacy Policy</a> for what deletion removes.</p>

    <h2>Service</h2>
    <p>BAB Online is provided free of charge, as-is, with no warranty. We may modify or discontinue the service at any time.</p>

    <h2>Contact</h2>
    <p>Email: <a href="mailto:support@zalberico.com">support@zalberico.com</a></p>
</body>
</html>`);
});

// Apple App Site Association — links iOS app with this domain for password autofill
router.get('/.well-known/apple-app-site-association', (req, res) => {
    res.set('Content-Type', 'application/json');
    res.json({
        webcredentials: {
            apps: ['9SYNY7K2HE.com.bab-online.BABOnline']
        }
    });
});

// Health check endpoint - is the server running? Always 200, plus the DB
// state and live counts (routes/health.js)
router.get('/health', healthHandler);

// Readiness check - is the server ready to accept traffic? 200 once connectDB
// has connected and Mongo answers a ping: the Railway deploy healthcheck
// (.railway/railway.ts)
router.get('/ready', async (req, res) => {
    try {
        // Check database connection
        const db = getDB();
        if (!db) {
            throw new Error('Database not connected');
        }

        await db.admin().ping();

        if (!readyLogged) {
            readyLogged = true;
            logger.info('Ready: first 200', { at: new Date().toISOString() });
        }
        res.json({
            status: 'ready',
            checks: {
                database: 'ok'
            }
        });
    } catch (error) {
        res.status(503).json({
            status: 'not ready',
            checks: {
                database: 'failed'
            },
            error: error.message
        });
    }
});

// Liveness check - is the server alive and not deadlocked?
router.get('/live', (req, res) => {
    res.json({ status: 'alive' });
});

module.exports = router;

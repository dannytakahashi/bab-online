#!/usr/bin/env node
/**
 * LOCAL ONLY: a handful of demo players with badges, to look at the badge
 * pages on a development server. Refuses any MONGO_URI that is not this
 * machine (localhost / 127.0.0.1 / [::1]).
 *
 *   MONGO_URI=mongodb://127.0.0.1:27117 node scripts/seed-badge-demo.js
 *   MONGO_URI=mongodb://127.0.0.1:27117 npm run dev      # then sign in as one of them
 *
 * Every demo player signs in with DEMO_PASSWORD below. Running it again
 * replaces the same players (and only them).
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');
const { dbNameFrom } = require('../server/config/dbName');
const { BADGE_IDS } = require('../server/game/badges');
const { emptyStats } = require('../server/utils/statsScope');

/** The password of every demo player (local test data, never a real account's). */
const DEMO_PASSWORD = 'badges-demo-1';

const DAY = 24 * 60 * 60 * 1000;
/** name, stock picture, games / wins, and which badges (in the order earned). */
const PLAYERS = [
    { username: 'DemoAll', profilePic: 7, games: 140, wins: 82, badges: BADGE_IDS },
    { username: 'DemoMost', profilePic: 21, games: 64, wins: 30, badges: ['four-hundred', 'felted', 'go-big-or-go-home', 'heavy-hitter', 'comeback-kid', 'in-the-red', 'chemistry', 'hammer-time', 'backpack'] },
    { username: 'DemoFew', profilePic: 33, games: 18, wins: 7, badges: ['go-big-or-go-home', 'felted', 'choke-artist'] },
    { username: 'DemoOne', profilePic: 48, games: 6, wins: 4, badges: ['exact-tie'] },
    { username: 'DemoNone', profilePic: 60, games: 3, wins: 1, badges: [] }
];

function isLocal(uri) {
    try {
        const hosts = uri.replace(/^mongodb(\+srv)?:\/\//, '').split('/')[0].split('@').pop().split(',');
        return !/^mongodb\+srv:/.test(uri) && hosts.every((h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h));
    } catch {
        return false;
    }
}

function statsFor({ games, wins }) {
    const hands = games * 13;
    return {
        ...emptyStats(),
        gamesPlayed: games, wins, losses: games - wins, draws: 0,
        totalPoints: games * 185, totalTricksBid: games * 24, totalTricksTaken: games * 26,
        totalHands: hands, totalSets: Math.round(hands * 0.14), totalSetPoints: games * 38,
        totalFaults: Math.round(games * 0.8), totalHSI: hands * 130
    };
}

async function main() {
    const uri = process.env.MONGO_URI || 'mongodb://localhost:27017';
    if (!isLocal(uri)) {
        console.error('Refused: scripts/seed-badge-demo.js only writes to a database on this machine (localhost).');
        return 1;
    }
    const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 5000 });
    try {
        const users = client.db(dbNameFrom()).collection('users');
        const password = await bcrypt.hash(DEMO_PASSWORD, 10);
        const now = Date.now();
        for (const p of PLAYERS) {
            const badges = p.badges.map((id, i) => ({ id, at: new Date(now - (p.badges.length - i) * 3 * DAY), gameId: `demo-${p.username}-${i}` }));
            await users.deleteOne({ username: p.username });
            await users.insertOne({
                username: p.username, password, profilePic: p.profilePic, tutorial: 'done',
                stats: statsFor(p), badges, badgeProgress: { overtrumped: p.badges.includes('child-labor') ? 57 : 12 }
            });
            console.log(`  ${p.username}: ${badges.length} badge${badges.length === 1 ? '' : 's'}`);
        }
        console.log(`\nSeeded ${PLAYERS.length} demo players into ${dbNameFrom()}. Their password is DEMO_PASSWORD in this file.`);
        return 0;
    } finally {
        await client.close();
    }
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code; }).catch((error) => {
        console.error('Error:', error.message);
        process.exit(1);
    });
}

module.exports = { isLocal, PLAYERS };

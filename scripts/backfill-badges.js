#!/usr/bin/env node
/**
 * Give players the badges the stored data proves they already earned before
 * badges existed (server/admin/badgeBackfill.js): 500, 400 and Felted from
 * the human game records, Chemistry from 20 recorded games with the same
 * partner, Century from 100 human games. Bot games never count.
 *
 * Read-only by default; --apply writes after you type BADGES:
 *
 *   node scripts/backfill-badges.js              # read-only: what it would award
 *   node scripts/backfill-badges.js --apply      # shows the same list, then asks
 *
 * Uses MONGO_URI from the environment or .env (same as the server). Safe to
 * run twice and while the server is up: a badge a player has is never given
 * again. Players are NOT notified; the badges just appear on their profile.
 */

const { connect, confirm } = require('../server/admin/cli');
const { plan, apply } = require('../server/admin/badgeBackfill');
const { BADGES } = require('../server/game/badges');

const USAGE = `Usage:
  node scripts/backfill-badges.js [--apply] [--yes]

  Always lists what it would award first (read-only). With --apply it then
  asks you to type BADGES before writing; --yes skips the prompt.
  Run it without --apply against production first and check the database line.`;

function parseArgs(argv) {
    const args = { apply: false, yes: false, help: false };
    for (const a of argv) {
        if (a === '--apply') args.apply = true;
        else if (a === '--yes') args.yes = true;
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`Unknown argument ${a}`);
    }
    return args;
}

function printPlan(p) {
    console.log(`Human game records read: ${p.records}; accounts: ${p.players}`);
    if (p.skipped.length) console.log(`Names in records with no account now (skipped): ${p.skipped.join(', ')}`);
    if (!p.awards.length) {
        console.log('\nNothing to award: every badge the records prove is already given.');
        return;
    }
    console.log(`\nBadges to award: ${p.awards.length}`);
    for (const badge of BADGES) {
        const names = p.awards.filter((a) => a.id === badge.id).map((a) => a.username);
        if (names.length) console.log(`  ${badge.name} (${names.length}): ${names.join(', ')}`);
    }
}

async function main(argv = process.argv.slice(2), deps = {}) {
    let args;
    try {
        args = parseArgs(argv);
    } catch (e) {
        console.error(`${e.message}\n${USAGE}`);
        return 2;
    }
    if (args.help) {
        console.log(USAGE);
        return 0;
    }
    const { client, uri, db } = await (deps.connect || connect)();
    const ask = deps.confirm || confirm;
    console.log(`Database: ${uri}\n`);
    try {
        const p = await plan(db);
        printPlan(p);
        if (!args.apply) {
            if (p.awards.length) console.log('\nRead-only run: nothing was written. Add --apply to award these.');
            return 0;
        }
        if (!p.awards.length) return 0;
        if (!args.yes && !(await ask(`\nAward these ${p.awards.length} badges?`, 'BADGES'))) {
            console.log('Cancelled. Nothing was changed.');
            return 1;
        }
        const res = await apply(db, p.awards);
        console.log(`\nDone: ${res.awarded} awarded${res.already ? `, ${res.already} already there` : ''}.`);
        return 0;
    } finally {
        if (client) await client.close();
    }
}

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}

module.exports = { main, parseArgs };

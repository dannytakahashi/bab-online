#!/usr/bin/env node
/**
 * One-off (owner-run): hash every legacy plaintext users.sessionToken into
 * sessionTokens and $unset it (server/admin/legacySessions.js). Players stay
 * signed in. Dry run by default; prints counts only, never names or tokens.
 *
 *   node scripts/migrate-legacy-session-tokens.js            # dry run: how many remain
 *   node scripts/migrate-legacy-session-tokens.js --apply    # asks you to type MIGRATE
 *
 * Uses MONGO_URI from the environment or .env (same as the server). Safe to
 * re-run: a second run finds nothing.
 */

const { connect, confirm } = require('../server/admin/cli');
const { migrateLegacySessionTokens } = require('../server/admin/legacySessions');

const USAGE = `Usage:
  node scripts/migrate-legacy-session-tokens.js [--apply] [--yes]

  Without --apply: counts the accounts that still hold a plaintext
  sessionToken (read-only). With --apply: asks you to type MIGRATE, then
  hashes each into sessionTokens and unsets it. --yes skips the prompt.
  Check the Database: line first.`;

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

function printCounts(c, applied) {
    console.log(`Plaintext session tokens: ${c.found} (accounts ${c.accounts}, tombstones ${c.tombstones})`);
    if (applied) console.log(`Hashed into sessionTokens: ${c.migrated}; unset only: ${c.unset}; changed meanwhile (left alone): ${c.raced}`);
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
        const dry = await migrateLegacySessionTokens(db, { apply: false });
        printCounts(dry, false);
        if (!args.apply || dry.found === 0) {
            if (dry.found > 0) console.log('\nDry run: nothing was changed. Re-run with --apply.');
            return 0;
        }
        if (!args.yes && !(await ask(`\nHash ${dry.found} plaintext token(s)?`, 'MIGRATE'))) {
            console.log('Cancelled. Nothing was changed.');
            return 1;
        }
        const done = await migrateLegacySessionTokens(db, { apply: true });
        console.log('');
        printCounts(done, true);
        return 0;
    } finally {
        await client.close();
    }
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(err => {
        console.error('Error:', err.message);
        process.exit(1);
    });
}

module.exports = { main, parseArgs, USAGE };

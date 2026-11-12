#!/usr/bin/env node
/**
 * Make a player an admin (the web panel's Admin menu entry), or remove it.
 * The owner runs this once to make themselves the FIRST admin; after that,
 * admins add and remove admins from the panel.
 *
 * Read-only listing first, then apply:
 *
 *   node scripts/set-admin.js --list              # read-only: who is an admin now
 *   node scripts/set-admin.js Alan                # lists, then asks you to type ADMIN
 *   node scripts/set-admin.js Alan --remove       # lists, then asks you to type REMOVE
 *
 * Uses MONGO_URI from the environment or .env (same as the server). Names
 * are case-sensitive. Unknown names and merged accounts are refused.
 */

const { connect, confirm } = require('../server/admin/cli');
const { listAdmins, setAdminFlag } = require('../server/admin/adminRole');

const USAGE = `Usage:
  node scripts/set-admin.js --list                 read-only: list the current admins
  node scripts/set-admin.js <username> [--remove] [--yes]

  Always shows the current admins first (read-only), then asks you to type
  ADMIN (or REMOVE with --remove) before writing. --yes skips the prompt.
  Run --list first against production, check the database line, then apply.`;

function parseArgs(argv) {
    const args = { username: null, remove: false, yes: false, list: false, help: false };
    for (const a of argv) {
        if (a === '--remove') args.remove = true;
        else if (a === '--yes') args.yes = true;
        else if (a === '--list') args.list = true;
        else if (a === '--help' || a === '-h') args.help = true;
        else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
        else if (args.username) throw new Error('Give one username.');
        else args.username = a;
    }
    return args;
}

function printAdmins(admins) {
    if (!admins.length) {
        console.log('Current admins: none');
        return;
    }
    console.log(`Current admins (${admins.length}):`);
    for (const a of admins) {
        const since = a.adminSince ? ` since ${new Date(a.adminSince).toISOString().slice(0, 10)}` : '';
        const by = a.adminSetBy ? ` (by ${a.adminSetBy})` : '';
        console.log(`  ${a.username}${since}${by}`);
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
    if (!args.list && !args.username) {
        console.log(USAGE);
        return 2;
    }

    const { client, uri, db } = await (deps.connect || connect)();
    const ask = deps.confirm || confirm;
    console.log(`Database: ${uri}\n`);
    try {
        printAdmins(await listAdmins(db));
        if (args.list) return 0;

        const { username, remove } = args;
        const user = await db.users.findOne({ username }, { projection: { username: 1, mergedInto: 1, isAdmin: 1 } });
        if (!user) {
            console.error(`\nError: account "${username}" does not exist (names are case-sensitive).`);
            return 1;
        }
        if (user.mergedInto) {
            console.error(`\nError: "${username}" was merged into "${user.mergedInto}" and can't be an admin.`);
            return 1;
        }
        if (Boolean(user.isAdmin === true) === !remove) {
            console.log(`\n"${username}" is ${remove ? 'not' : 'already'} an admin. Nothing to do.`);
            return 0;
        }

        const word = remove ? 'REMOVE' : 'ADMIN';
        const question = remove ? `\nRemove "${username}"'s admin flag?` : `\nMake "${username}" an admin?`;
        if (!args.yes && !(await ask(question, word))) {
            console.log('Cancelled. Nothing was changed.');
            return 1;
        }
        await setAdminFlag(db, username, !remove, { by: 'scripts/set-admin.js', allowNoAdmins: true });
        console.log(`\nDone: "${username}" is ${remove ? 'no longer' : 'now'} an admin.`);
        const after = await listAdmins(db);
        printAdmins(after);
        if (!after.length) console.log('Warning: there are no admins now. Run this script again to add one.');
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

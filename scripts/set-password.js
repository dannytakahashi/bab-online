#!/usr/bin/env node
/**
 * Set a new password for a player who forgot theirs. Signs out all of their
 * saved devices. Tell them the new password; they can keep using it.
 *
 *   node scripts/set-password.js Alan                       # generates e.g. maple-otter-42
 *   node scripts/set-password.js Alan --password 'secret'   # choose it yourself
 *
 * Uses MONGO_URI from the environment or .env (same as the server).
 */

const { connect, confirm } = require('../server/admin/cli');
const { setPassword, generateFriendlyPassword } = require('../server/admin/setPassword');

const USAGE = `Usage:
  node scripts/set-password.js <username> [--password <new>] [--yes]

  Without --password a friendly one is generated (e.g. maple-otter-42).
  --yes skips the confirmation prompt.`;

async function main() {
    const argv = process.argv.slice(2);
    let username = null;
    let password = null;
    let yes = false;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--password') password = argv[++i];
        else if (argv[i] === '--yes') yes = true;
        else if (argv[i] === '--help' || argv[i] === '-h') { console.log(USAGE); return; }
        else if (argv[i].startsWith('--')) { console.error(`Unknown option ${argv[i]}\n${USAGE}`); process.exit(2); }
        else username = argv[i];
    }
    if (!username) {
        console.log(USAGE);
        process.exit(2);
    }
    password = password || generateFriendlyPassword();

    const { client, uri, db } = await connect();
    console.log(`Database: ${uri}`);
    try {
        const user = await db.users.findOne({ username }, { projection: { username: 1, mergedInto: 1 } });
        if (!user) throw new Error(`Account "${username}" does not exist (names are case-sensitive).`);
        if (user.mergedInto) throw new Error(`"${username}" was merged into "${user.mergedInto}". Reset that account instead.`);

        if (!yes && !(await confirm(`Set a new password for "${username}" and sign out their devices?`, 'YES'))) {
            console.log('Cancelled. Nothing was changed.');
            process.exitCode = 1;
            return;
        }
        const { revokedSessions, revokedLinks } = await setPassword(db, username, password);
        console.log(`\nPassword for "${username}" is now:  ${password}`);
        console.log(`Signed out ${revokedSessions} saved device session(s).`);
        if (revokedLinks) console.log(`Cancelled ${revokedLinks} open reset link(s).`);
    } finally {
        await client.close();
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});

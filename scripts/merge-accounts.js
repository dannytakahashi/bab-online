#!/usr/bin/env node
/**
 * Merge duplicate player accounts into one. Dry run by default.
 *
 *   node scripts/merge-accounts.js --find-duplicates
 *   node scripts/merge-accounts.js --into Alan Alan2 alan_b            # dry run
 *   node scripts/merge-accounts.js --into Alan Alan2 alan_b --apply    # write
 *
 * Uses MONGO_URI from the environment or .env (same as the server). Safe to
 * re-run: a finished merge reports "Nothing to do". See server/admin/accountMerge.js.
 */

const { connect, confirm } = require('../server/admin/cli');
const {
    planMerge, applyMerge, formatPlan, countChanges,
    findDuplicateCandidates, formatDuplicateGroups
} = require('../server/admin/accountMerge');

const USAGE = `Usage:
  node scripts/merge-accounts.js --find-duplicates
  node scripts/merge-accounts.js --into <keep> <old1> [old2 ...] [--apply] [--yes]

  --into <keep>   account to keep; every other name listed is merged into it
  --apply         actually write (default is a dry run that changes nothing)
  --yes           skip the confirmation prompt (for non-interactive use)`;

function parseArgs(argv) {
    const args = { sources: [], apply: false, yes: false, findDuplicates: false, target: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') args.apply = true;
        else if (a === '--yes') args.yes = true;
        else if (a === '--find-duplicates') args.findDuplicates = true;
        else if (a === '--into') args.target = argv[++i];
        else if (a === '--help' || a === '-h') args.help = true;
        else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
        else args.sources.push(a);
    }
    return args;
}

async function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(e.message, '\n', USAGE);
        process.exit(2);
    }
    if (args.help || (!args.findDuplicates && (!args.target || !args.sources.length))) {
        console.log(USAGE);
        process.exit(args.help ? 0 : 2);
    }

    const { client, uri, db } = await connect();
    console.log(`Database: ${uri}\n`);
    try {
        if (args.findDuplicates) {
            console.log(formatDuplicateGroups(await findDuplicateCandidates(db)));
            return;
        }

        const plan = await planMerge(db, { target: args.target, sources: args.sources });
        console.log(formatPlan(plan));
        if (plan.errors.length) {
            process.exitCode = 1;
            return;
        }
        if (countChanges(plan) === 0) return;

        if (!args.apply) {
            console.log('\nDry run: nothing was changed. Re-run with --apply to merge.');
            return;
        }
        if (!args.yes && !(await confirm('\nApply these changes?', 'MERGE'))) {
            console.log('Cancelled. Nothing was changed.');
            process.exitCode = 1;
            return;
        }

        // Re-plan right before writing so the plan matches the live data
        const fresh = await planMerge(db, { target: args.target, sources: args.sources });
        if (fresh.errors.length) {
            console.log(formatPlan(fresh));
            process.exitCode = 1;
            return;
        }
        const result = await applyMerge(db, fresh);
        console.log('\nDone.');
        console.log(`  stats merged from: ${result.statsMerged.join(', ') || '(none)'}`);
        console.log(`  retired: ${result.retired.join(', ') || '(none)'}`);
        if (result.notRetired.length) {
            console.log(`  NOT retired (in a game or tournament, or merged elsewhere, since the plan): ${result.notRetired.join(', ')}`);
            console.log('  This merge is only partly applied. Run it again once they are free.');
            process.exitCode = 1;
        }
        console.log(`  game records: ${result.gameRecords}, reports: ${result.reports}, other block lists: ${result.otherUsersBlocks}`);
        console.log('\nIf any of these players were online, they keep their current connection until they leave; after that only the kept account can sign in.');
    } finally {
        await client.close();
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});

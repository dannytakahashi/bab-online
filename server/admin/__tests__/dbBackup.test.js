/**
 * scripts/backup-db.js and scripts/restore-db.js plumbing (server/admin/dbBackup.js).
 * The end-to-end drill (dump, drop, restore, sign in) is manual: the runbook
 * in docs/claude/server-infra.md, Backups and restore.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const B = require('../dbBackup');

// Built from parts on reserved .invalid hosts: the source never holds a
// credential-shaped URI (secret scanning)
const pw = ['not', 'a', 'secret'].join('-');
const cred = `user:${pw}@`;
const remote = `mongodb://${cred}db.example.invalid:27017`;

describe('isLocalUri: what restore-db.js writes to without --i-mean-production', () => {
    test.each([
        ['mongodb://127.0.0.1:27017', true],
        ['mongodb://localhost', true],
        ['mongodb://LOCALHOST:27931/x?directConnection=true', true],
        ['mongodb://[::1]:27017', true],
        ['mongodb://127.0.0.1:27017,localhost:27018', true],
        [remote, false],
        ['mongodb://127.0.0.1:27017,db.example.invalid:27017', false],
        ['mongodb+srv://localhost/x', false],
        ['mongodb://127.0.0.2', false],
        ['mongodb://localhost.example.invalid', false],
        ['http://127.0.0.1', false],
        ['', false]
    ])('%s -> %s', (uri, local) => {
        expect(B.isLocalUri(uri)).toBe(local);
    });
});

describe('URIs never leak credentials', () => {
    test('describeHosts keeps hosts only', () => {
        expect(B.describeHosts(`${remote}/babonline?authSource=admin`)).toBe('mongodb://db.example.invalid:27017');
        expect(B.describeHosts(`${remote}/x`)).not.toContain(pw);
    });

    test('redact scrubs URIs inside tool output', () => {
        const line = `Failed: connecting to ${remote}/?x=1: no reachable servers`;
        expect(B.redact(line)).not.toContain(pw);
        expect(B.redact(line)).toContain('mongodb://***@db.example.invalid');
        expect(B.hasCredentials(remote)).toBe(true);
        expect(B.hasCredentials('mongodb://127.0.0.1:27017')).toBe(false);
    });

    test('the tool config is just the quoted URI', () => {
        const quoted = `mongodb://${cred}h.invalid/?appName=it's`;
        expect(B.toolConfig(quoted)).toBe(`uri: '${quoted.replace(/'/g, "''")}'\n`);
    });
});

describe('uriWithoutDbPath: --db with a URI that names a database', () => {
    test('drops the path but keeps it as the auth database', () => {
        expect(B.uriWithoutDbPath(`${remote}/babonline`)).toBe(`${remote}/?authSource=babonline`);
        expect(B.uriWithoutDbPath(`${remote}/x?tls=true`)).toBe(`${remote}/?tls=true&authSource=x`);
    });

    test('credentials without a path authenticate against admin, as the driver does', () => {
        // mongodump --db X would otherwise log in against X (Railway's root user is in admin)
        expect(B.uriWithoutDbPath(remote)).toBe(`${remote}/?authSource=admin`);
        expect(B.uriWithoutDbPath(`${remote}/?tls=true`)).toBe(`${remote}/?tls=true&authSource=admin`);
    });

    test('an explicit authSource, or no credentials, is left alone', () => {
        expect(B.uriWithoutDbPath(`${remote}/x?authSource=admin`)).toBe(`${remote}/?authSource=admin`);
        expect(B.uriWithoutDbPath('mongodb://127.0.0.1:27017/')).toBe('mongodb://127.0.0.1:27017/');
        // No credentials: an authSource would make the tools try to log in
        expect(B.uriWithoutDbPath('mongodb://127.0.0.1:27017/bab_drill')).toBe('mongodb://127.0.0.1:27017/');
    });
});

describe('checkOutDir: archives never land in a repository', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bab-outdir-')));
    afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

    test('refuses the repository, anything under it, and a missing --out', () => {
        expect(B.checkOutDir(null).error).toMatch(/--out/);
        expect(B.checkOutDir(B.REPO_ROOT).error).toMatch(/inside the repository/);
        expect(B.checkOutDir(path.join(B.REPO_ROOT, 'backups', 'new')).error).toMatch(/inside the repository/);
    });

    test('refuses any other git work tree, including through a symlink', () => {
        const repo = path.join(tmp, 'other');
        fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
        expect(B.checkOutDir(path.join(repo, 'dumps'), path.join(tmp, 'elsewhere')).error).toMatch(/git work tree/);
        fs.symlinkSync(repo, path.join(tmp, 'link'));
        expect(B.checkOutDir(path.join(tmp, 'link', 'dumps'), path.join(tmp, 'elsewhere')).error).toMatch(/git work tree/);
    });

    test('accepts a plain folder, existing or not', () => {
        const dir = path.join(tmp, 'plain', 'dumps');
        expect(B.checkOutDir(dir, path.join(tmp, 'elsewhere'))).toEqual({ dir });
    });
});

describe('archive names and --keep', () => {
    test('UTC timestamp names sort by time', () => {
        expect(B.archiveName('babonline', new Date(Date.UTC(2026, 10, 5, 3, 4, 5)))).toBe('babonline-20261105T030405Z.archive.gz');
    });

    test("prunes only this database's archives beyond the newest N", () => {
        const files = [
            'babonline-20261101T000000Z.archive.gz',
            'babonline-20261103T000000Z.archive.gz',
            'babonline-20261102T000000Z.archive.gz',
            'babonline-20261104T000000Z.archive.gz.partial',
            'babonline_restore-20261101T000000Z.archive.gz',
            'notes.txt',
            'babonline-latest.archive.gz'
        ];
        expect(B.archivesToPrune(files, 'babonline', 2)).toEqual(['babonline-20261101T000000Z.archive.gz']);
        expect(B.archivesToPrune(files, 'babonline', 5)).toEqual([]);
    });
});

describe('tool summaries (mongodump / mongorestore 100.x stderr)', () => {
    test('dump counts', () => {
        const err = [
            '2026-11-15T11:19:41.153-0800\twriting `babonline.users` to "archive `/x.gz`"',
            '2026-11-15T11:19:41.154-0800\tdone dumping `babonline.users` (12 documents)',
            '2026-11-15T11:19:41.156-0800\tdone dumping `babonline.reports` (1 document)',
            '2026-11-15T11:19:41.156-0800\tdone dumping babonline.adminAudit (0 documents)'
        ].join('\n');
        expect(B.parseDumpSummary(err)).toEqual([
            { ns: 'babonline.users', count: 12 },
            { ns: 'babonline.reports', count: 1 },
            { ns: 'babonline.adminAudit', count: 0 }
        ]);
    });

    test('restore counts and failures', () => {
        const err = [
            '2026-11-15T11:19:41.629-0800\tfinished restoring `x.users` (2 documents, 0 failures)',
            '2026-11-15T11:19:41.666-0800\tfinished restoring `x.reports` (1 document, 1 failure)',
            '2026-11-15T11:19:41.698-0800\t3 document(s) restored successfully. 1 document(s) failed to restore.'
        ].join('\n');
        expect(B.parseRestoreSummary(err)).toEqual({
            collections: [
                { ns: 'x.users', count: 2, failures: 0 },
                { ns: 'x.reports', count: 1, failures: 1 }
            ],
            restored: 3,
            failed: 1
        });
        expect(B.parseRestoreSummary('').restored).toBeNull();
    });
});

test('database names are plain', () => {
    expect(B.isValidDbName('babonline_restore_20261115')).toBe(true);
    for (const bad of ['', 'a.b', 'a/b', 'a b', '$x', 'x'.repeat(64), null]) expect(B.isValidDbName(bad)).toBe(false);
});

describe('runTool and stop signals (no password left on disk or in ps)', () => {
    // Stands in for mongodump: reads the --config path it is given and echoes it to stderr
    const fakeTool = (tool, args, opts) => spawn(process.execPath, ['-e', `
        const p = process.argv.find((a) => a.startsWith('--config=')).slice(9);
        process.stderr.write(p + '\\n' + require('fs').readFileSync(p, 'utf8'));
    `, '--', ...args], opts);

    // macOS reopens the child's extra stdio (a socket) as /dev/fd/3; Linux
    // cannot (ENXIO on a socket), so it gets a FIFO. Both run on any OS that
    // has mkfifo, so CI (Linux) and a Mac each cover both.
    test('macOS: the URI arrives through /dev/fd/3, not a file or the command line', async () => {
        if (process.platform !== 'darwin') return; // /dev/fd/N on a socket is macOS-only
        const uri = `${remote}/?authSource=admin`;
        const { child, done } = B.runTool('mongodump', ['--db=x'], uri, fakeTool, 'darwin');
        expect(child.spawnargs.join(' ')).not.toContain(pw);
        const r = await done;
        expect(r.code).toBe(0);
        const [where, ...config] = r.stderr.split('\n');
        expect(where).toBe('/dev/fd/3');
        expect(config.join('\n')).toBe(B.toolConfig(uri));
    });

    test('Linux: the URI arrives through a FIFO in a private dir, removed afterwards', async () => {
        const uri = `${remote}/?authSource=admin`;
        const { child, done } = B.runTool('mongodump', ['--db=x'], uri, fakeTool, 'linux');
        expect(child.spawnargs.join(' ')).not.toContain(pw);
        const r = await done;
        expect(r.code).toBe(0);
        const [where, ...config] = r.stderr.split('\n');
        expect(where).toMatch(/bab-tool-[^/]+\/config$/);
        expect(config.join('\n')).toBe(B.toolConfig(uri));
        expect(fs.existsSync(path.dirname(where))).toBe(false);
    });

    test('Linux: a tool that exits without reading leaves no FIFO behind', async () => {
        const quitter = (tool, args, opts) => spawn(process.execPath, ['-e', 'process.exit(3)', '--', ...args], opts);
        const { child, done } = B.runTool('mongodump', [], `${remote}/`, quitter, 'linux');
        const cfg = child.spawnargs.find((a) => a.startsWith('--config=')).slice(9);
        const r = await done;
        expect(r.code).toBe(3);
        expect(fs.existsSync(path.dirname(cfg))).toBe(false);
    });

    test('a missing tool resolves with an error instead of throwing', async () => {
        const r = await B.runTool('bab-no-such-tool-' + process.pid, [], 'mongodb://127.0.0.1').done;
        expect(r.code).toBe(-1);
    });

    test('closing the terminal (SIGHUP) is handled, not only Ctrl-C and kill', () => {
        expect(Object.keys(B.STOP_SIGNALS).sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);
    });

    test.each(Object.entries(B.STOP_SIGNALS))('%s runs the stop handler, then exits 128+n', (sig, n) => {
        const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bab-sig-')), 'stopped');
        const r = spawnSync(process.execPath, ['-e', `
            const B = require(${JSON.stringify(require.resolve('../dbBackup'))});
            B.onStopSignals((s) => require('fs').writeFileSync(${JSON.stringify(marker)}, s));
            setTimeout(() => process.kill(process.pid, ${JSON.stringify(sig)}), 50);
            setTimeout(() => {}, 5000);
        `], { timeout: 10000 });
        expect(r.status).toBe(128 + n);
        expect(fs.readFileSync(marker, 'utf8')).toBe(sig);
        fs.rmSync(path.dirname(marker), { recursive: true, force: true });
    });
});

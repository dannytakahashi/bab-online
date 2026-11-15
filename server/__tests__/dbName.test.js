/**
 * The database name (server/config/dbName.js): DB_NAME, else 'babonline',
 * never MONGO_URI's path; the server, the admin scripts and the backup tools
 * read the same value.
 */

const { DEFAULT_DB_NAME, dbNameFrom, uriPathDb, isValidDbName } = require('../config/dbName');

describe('dbNameFrom', () => {
    test("default 'babonline' (production sets no DB_NAME)", () => {
        expect(DEFAULT_DB_NAME).toBe('babonline');
        for (const env of [{}, { DB_NAME: '' }, { DB_NAME: '   ' }, { DB_NAME: undefined }]) expect(dbNameFrom(env)).toBe('babonline');
    });

    test('DB_NAME wins, trimmed; MONGO_URI is never read', () => {
        expect(dbNameFrom({ DB_NAME: 'bab_live_3912' })).toBe('bab_live_3912');
        expect(dbNameFrom({ DB_NAME: ' bab-check ' })).toBe('bab-check');
        expect(dbNameFrom({ MONGO_URI: 'mongodb://localhost:27017/elsewhere' })).toBe('babonline');
    });

    test('a DB_NAME that is not a plain database name throws (the boot stops)', () => {
        for (const bad of ['a/b', 'a.b', 'a b', 'x$', '"q"', 'n'.repeat(64)]) {
            expect(() => dbNameFrom({ DB_NAME: bad })).toThrow(/DB_NAME must be a plain database name/);
        }
        expect(isValidDbName('n'.repeat(63))).toBe(true);
    });
});

describe('uriPathDb', () => {
    test('the path database, else empty', () => {
        expect(uriPathDb('mongodb://localhost:27017/bab-x')).toBe('bab-x');
        expect(uriPathDb('mongodb://localhost:27017/bab-x?directConnection=true')).toBe('bab-x');
        expect(uriPathDb('mongodb://localhost:27017')).toBe('');
        expect(uriPathDb('mongodb://localhost:27017/')).toBe('');
        expect(uriPathDb('mongodb://localhost:27017/?replicaSet=rs0')).toBe('');
        expect(uriPathDb('mongodb+srv://h.example.invalid/my%5Fdb')).toBe('my_db');
        expect(uriPathDb('not a uri')).toBe('');
        expect(uriPathDb(undefined)).toBe('');
    });
});

describe('server/database.js takes it at load', () => {
    const saved = { DB_NAME: process.env.DB_NAME, MONGO_URI: process.env.MONGO_URI };
    afterEach(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    function loadDatabase() {
        let database;
        jest.isolateModules(() => {
            database = require('../database');
        });
        return database;
    }

    test('DB_NAME, else babonline, whatever MONGO_URI names', () => {
        delete process.env.DB_NAME;
        process.env.MONGO_URI = 'mongodb://127.0.0.1:1/some-other-db';
        expect(loadDatabase().getDbName()).toBe('babonline');
        process.env.DB_NAME = 'bab_scratch_1';
        expect(loadDatabase().getDbName()).toBe('bab_scratch_1');
    });

    test('an invalid DB_NAME fails the require', () => {
        process.env.DB_NAME = 'no/slashes';
        expect(() => loadDatabase()).toThrow(/DB_NAME/);
    });
});

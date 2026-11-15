const { describeTarget, redactUri, DB_NAME } = require('../cli');
const { dbNameFrom } = require('../../config/dbName');

describe('describeTarget: the "Database:" line the admin scripts print', () => {
    test('names the database actually written (DB_NAME, else babonline), never the URI path', () => {
        // The scripts' database is the server's: DB_NAME, else babonline
        expect(DB_NAME).toBe(dbNameFrom(process.env));
        expect(dbNameFrom({})).toBe('babonline');
        expect(describeTarget('mongodb://localhost:27017/bab-admin-3949', 'babonline'))
            .toBe("mongodb://localhost:27017 (database babonline; the URI's /bab-admin-3949 is ignored)");
        expect(describeTarget('mongodb://localhost:27017', 'babonline')).toBe('mongodb://localhost:27017 (database babonline)');
        expect(describeTarget('mongodb://localhost:27017/', 'babonline')).toBe('mongodb://localhost:27017 (database babonline)');
        // a path naming the database written is not called out
        expect(describeTarget('mongodb://localhost:27017/babonline', 'babonline')).toBe('mongodb://localhost:27017 (database babonline)');
        expect(describeTarget('mongodb://localhost:27017/x', 'bab_scratch')).toBe("mongodb://localhost:27017 (database bab_scratch; the URI's /x is ignored)");
    });

    test('keeps the password redacted and drops query options', () => {
        // Built from parts on a reserved, non-resolvable host so the source
        // never holds a credential-shaped URI (GitHub secret scanning flagged
        // the literal form; it was never a real credential)
        const pw = ['not', 'a', 'secret'].join('-');
        const out = describeTarget(`mongodb+srv://user:${pw}@db.example.invalid/?retryWrites=true&w=majority`, 'babonline');
        expect(out).toBe('mongodb+srv://user:***@db.example.invalid (database babonline)');
        expect(out).not.toContain(pw);
        const withPath = describeTarget(`mongodb+srv://user:${pw}@db.example.invalid/test?retryWrites=true`, 'babonline');
        expect(withPath).toBe("mongodb+srv://user:***@db.example.invalid (database babonline; the URI's /test is ignored)");
        expect(withPath).not.toContain(pw);
        expect(redactUri('mongodb://a:b@h/db')).toBe('mongodb://a:***@h/db');
    });
});

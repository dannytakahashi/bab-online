const { describeTarget, redactUri, DB_NAME } = require('../cli');

describe('describeTarget: the "Database:" line the admin scripts print', () => {
    test('names the database actually written (babonline), never the URI path', () => {
        expect(DB_NAME).toBe('babonline');
        expect(describeTarget('mongodb://localhost:27017/bab-admin-3949')).toBe('mongodb://localhost:27017 (database babonline)');
        expect(describeTarget('mongodb://localhost:27017')).toBe('mongodb://localhost:27017 (database babonline)');
    });

    test('keeps the password redacted and drops query options', () => {
        // Built from parts on a reserved, non-resolvable host so the source
        // never holds a credential-shaped URI (GitHub secret scanning flagged
        // the literal form; it was never a real credential)
        const pw = ['not', 'a', 'secret'].join('-');
        const out = describeTarget(`mongodb+srv://user:${pw}@db.example.invalid/test?retryWrites=true&w=majority`);
        expect(out).toBe('mongodb+srv://user:***@db.example.invalid (database babonline)');
        expect(out).not.toContain(pw);
        expect(redactUri('mongodb://a:b@h/db')).toBe('mongodb://a:***@h/db');
    });
});

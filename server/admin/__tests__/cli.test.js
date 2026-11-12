const { describeTarget, redactUri, DB_NAME } = require('../cli');

describe('describeTarget: the "Database:" line the admin scripts print', () => {
    test('names the database actually written (babonline), never the URI path', () => {
        expect(DB_NAME).toBe('babonline');
        expect(describeTarget('mongodb://localhost:27017/bab-admin-3949')).toBe('mongodb://localhost:27017 (database babonline)');
        expect(describeTarget('mongodb://localhost:27017')).toBe('mongodb://localhost:27017 (database babonline)');
    });

    test('keeps the password redacted and drops query options', () => {
        const out = describeTarget('mongodb+srv://user:s3cret@cluster0.x.mongodb.net/test?retryWrites=true&w=majority');
        expect(out).toBe('mongodb+srv://user:***@cluster0.x.mongodb.net (database babonline)');
        expect(out).not.toContain('s3cret');
        expect(redactUri('mongodb://a:b@h/db')).toBe('mongodb://a:***@h/db');
    });
});

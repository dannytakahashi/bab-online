const { createMemoryDb } = require('../../testUtils/memoryDb');
const { migrateLegacySessionTokens } = require('../legacySessions');
const { hashToken, verifySession } = require('../../utils/sessionTokens');
const script = require('../../../scripts/migrate-legacy-session-tokens');

// Plain words, never token-shaped (public repo, secret scanning)
const OLD = 'legacy-device-one';
const NOW = new Date('2026-11-15T12:00:00Z');

function seed() {
    return createMemoryDb({
        users: [
            { username: 'Alan', sessionToken: OLD },
            { username: 'Bea', sessionToken: 'legacy-device-two', sessionTokens: [{ hash: hashToken('newer-device'), createdAt: NOW, lastUsedAt: NOW }] },
            { username: 'Cy', sessionTokens: [{ hash: hashToken('cy-device'), createdAt: NOW, lastUsedAt: NOW }] },
            { username: 'Old', mergedInto: 'Alan', sessionToken: 'legacy-device-three' },
        ]
    });
}
const doc = (db, username) => db.users.docs.find((d) => d.username === username);

test('dry run: counts only, nothing changes', async () => {
    const db = seed();
    const before = JSON.stringify(db.users.docs);
    expect(await migrateLegacySessionTokens(db)).toEqual({ found: 3, accounts: 2, tombstones: 1, migrated: 0, unset: 0, raced: 0 });
    expect(JSON.stringify(db.users.docs)).toBe(before);
});

test('apply: the token is hashed in and unset, the device stays signed in; tombstones are only unset; a re-run finds nothing', async () => {
    const db = seed();
    expect(await migrateLegacySessionTokens(db, { apply: true, now: NOW })).toEqual({ found: 3, accounts: 2, tombstones: 1, migrated: 2, unset: 1, raced: 0 });

    const alan = doc(db, 'Alan');
    expect(alan).not.toHaveProperty('sessionToken');
    expect(alan.sessionTokens).toEqual([{ hash: hashToken(OLD), createdAt: NOW, lastUsedAt: NOW }]);
    expect(verifySession(alan, OLD, NOW)).not.toBeNull();
    expect(JSON.stringify(db.users.docs)).not.toContain(OLD);

    // Kept next to the newer device's session
    expect(doc(db, 'Bea').sessionTokens.map((e) => e.hash)).toEqual([hashToken('legacy-device-two'), hashToken('newer-device')]);
    expect(doc(db, 'Cy').sessionTokens).toHaveLength(1);
    expect(doc(db, 'Old')).not.toHaveProperty('sessionToken');
    expect(doc(db, 'Old')).not.toHaveProperty('sessionTokens');

    expect(await migrateLegacySessionTokens(db, { apply: true, now: NOW })).toMatchObject({ found: 0, migrated: 0 });
});

test('a revoke between the read and the write wins (guarded on token and sessionEpoch)', async () => {
    const db = seed();
    const users = db.users;
    const realFind = users.find.bind(users);
    users.find = (...args) => {
        const cursor = realFind(...args);
        const toArray = cursor.toArray;
        cursor.toArray = async () => {
            const rows = await toArray();
            // Sign out everywhere lands after the read
            delete doc(db, 'Alan').sessionToken;
            doc(db, 'Alan').sessionEpoch = 1;
            return rows;
        };
        return cursor;
    };
    const out = await migrateLegacySessionTokens(db, { apply: true, now: NOW });
    expect(out).toMatchObject({ found: 3, migrated: 1, raced: 1 });
    expect(doc(db, 'Alan')).not.toHaveProperty('sessionTokens');
});

describe('scripts/migrate-legacy-session-tokens.js', () => {
    let out;
    beforeEach(() => {
        out = [];
        jest.spyOn(console, 'log').mockImplementation((m) => out.push(String(m)));
    });
    afterEach(() => jest.restoreAllMocks());
    const deps = (db, answer) => ({
        connect: async () => ({ client: { close: async () => {} }, uri: 'test (database babonline)', db }),
        confirm: async () => answer,
    });

    test('dry run by default; --apply asks for MIGRATE; output never has a name or token', async () => {
        const db = seed();
        expect(await script.main([], deps(db, true))).toBe(0);
        expect(doc(db, 'Alan').sessionToken).toBe(OLD);
        expect(await script.main(['--apply'], deps(db, false))).toBe(1);
        expect(doc(db, 'Alan').sessionToken).toBe(OLD);
        expect(await script.main(['--apply'], deps(db, true))).toBe(0);
        expect(doc(db, 'Alan')).not.toHaveProperty('sessionToken');
        const text = out.join('\n');
        expect(text).toContain('Hashed into sessionTokens: 2; unset only: 1');
        for (const secret of ['Alan', 'Bea', OLD, hashToken(OLD)]) expect(text).not.toContain(secret);
        expect(await script.main(['--bogus'], deps(db, true))).toBe(2);
    });
});

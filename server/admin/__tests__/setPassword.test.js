const bcrypt = require('bcryptjs');
const { createMemoryDb } = require('../../testUtils/memoryDb');
const { setPassword, generateFriendlyPassword, WORDS } = require('../setPassword');

describe('setPassword', () => {
    test('sets a new bcrypt password and revokes every saved session', async () => {
        const db = createMemoryDb({
            users: [{
                username: 'Alan',
                password: await bcrypt.hash('forgotten', 4),
                sessionToken: 'legacy',
                sessionTokens: [{ hash: 'a' }, { hash: 'b' }]
            }]
        });

        const result = await setPassword(db, 'Alan', 'maple-otter-42', { rounds: 4 });

        expect(result).toEqual({ username: 'Alan', revokedSessions: 3, revokedLinks: 0 });
        const alan = await db.users.findOne({ username: 'Alan' });
        expect(await bcrypt.compare('maple-otter-42', alan.password)).toBe(true);
        expect(await bcrypt.compare('forgotten', alan.password)).toBe(false);
        expect(alan).not.toHaveProperty('sessionToken');
        expect(alan).not.toHaveProperty('sessionTokens');
        expect(alan.passwordResetByAdminAt).toBeInstanceOf(Date);
        // the revoke bumps sessionEpoch: a sign-in / restore in flight cannot write the sessions back
        expect(alan.sessionEpoch).toBe(1);
    });

    test('refuses unknown and merged accounts', async () => {
        const db = createMemoryDb({ users: [{ username: 'Alan2', mergedInto: 'Alan' }] });
        await expect(setPassword(db, 'Nobody', 'x', { rounds: 4 })).rejects.toThrow('does not exist');
        await expect(setPassword(db, 'Alan2', 'x', { rounds: 4 })).rejects.toThrow('merged into "Alan"');
    });

    test('rejects empty or over-long passwords', async () => {
        const db = createMemoryDb({ users: [{ username: 'Alan' }] });
        await expect(setPassword(db, 'Alan', '')).rejects.toThrow('1-100');
        await expect(setPassword(db, 'Alan', 'x'.repeat(101))).rejects.toThrow('1-100');
    });
});

describe('generateFriendlyPassword', () => {
    test('produces word-word-NN from the word list', () => {
        for (let i = 0; i < 20; i++) {
            const pw = generateFriendlyPassword();
            const [a, b, n] = pw.split('-');
            expect(WORDS).toContain(a);
            expect(WORDS).toContain(b);
            expect(Number(n)).toBeGreaterThanOrEqual(10);
            expect(Number(n)).toBeLessThan(100);
        }
    });
});

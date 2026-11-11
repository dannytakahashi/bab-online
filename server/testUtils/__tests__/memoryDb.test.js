/**
 * memoryDb projection support: the server's projected finds must see the
 * same document shape under Jest as against a real mongod.
 */

const { MemoryCollection } = require('../memoryDb');

function users() {
    return new MemoryCollection([
        {
            username: 'Alan',
            password: 'hash',
            customProfilePic: 'data:image/png;base64,AAAA',
            profilePic: 7,
            stats: { gamesPlayed: 3, wins: 2, totalPoints: 400 },
            sessionTokens: [{ hash: 'h1', createdAt: 1 }, { hash: 'h2', createdAt: 2 }]
        },
        { username: 'Bea', profilePic: 3 }
    ]);
}

describe('memoryDb projections', () => {
    test('inclusion keeps only the listed fields plus _id', async () => {
        const doc = await users().findOne({ username: 'Alan' }, { projection: { profilePic: 1, customProfilePic: 1 } });
        expect(Object.keys(doc).sort()).toEqual(['_id', 'customProfilePic', 'profilePic']);
        expect(doc.profilePic).toBe(7);
    });

    test('inclusion with true behaves like 1, missing fields are simply absent', async () => {
        const doc = await users().findOne({ username: 'Bea' }, { projection: { profilePic: true, stats: true } });
        expect(Object.keys(doc).sort()).toEqual(['_id', 'profilePic']);
    });

    test('exclusion drops the listed fields and keeps everything else', async () => {
        const doc = await users().findOne({ username: 'Alan' }, { projection: { customProfilePic: 0, password: 0 } });
        expect(doc).not.toHaveProperty('customProfilePic');
        expect(doc).not.toHaveProperty('password');
        expect(doc).toMatchObject({ username: 'Alan', profilePic: 7, stats: { gamesPlayed: 3 } });
        expect(doc._id).toBeDefined();
    });

    test('dotted inclusion builds nested objects', async () => {
        const doc = await users().findOne({ username: 'Alan' },
            { projection: { username: 1, 'stats.gamesPlayed': 1, 'stats.wins': 1 } });
        expect(doc.stats).toEqual({ gamesPlayed: 3, wins: 2 });
        expect(doc.username).toBe('Alan');
    });

    test('dotted inclusion reaches into arrays of sub-documents', async () => {
        const doc = await users().findOne({ username: 'Alan' }, { projection: { 'sessionTokens.hash': 1, _id: 0 } });
        expect(doc).toEqual({ sessionTokens: [{ hash: 'h1' }, { hash: 'h2' }] });
    });

    test('dotted exclusion deletes nested fields only', async () => {
        const doc = await users().findOne({ username: 'Alan' }, { projection: { 'stats.totalPoints': 0 } });
        expect(doc.stats).toEqual({ gamesPlayed: 3, wins: 2 });
        expect(doc.password).toBe('hash');
    });

    test('_id: 0 removes _id in both modes', async () => {
        const inc = await users().findOne({ username: 'Bea' }, { projection: { _id: 0, username: 1 } });
        expect(inc).toEqual({ username: 'Bea' });
        const exc = await users().findOne({ username: 'Bea' }, { projection: { _id: 0 } });
        expect(exc).toEqual({ username: 'Bea', profilePic: 3 });
    });

    test('mixing inclusion and exclusion (other than _id) throws, as Mongo does', async () => {
        await expect(users().findOne({ username: 'Alan' }, { projection: { username: 1, password: 0 } }))
            .rejects.toThrow(/exclusion/);
        await expect(users().find({}, { projection: { username: 1, password: 0 } }).toArray())
            .rejects.toThrow(/exclusion/);
    });

    test('find applies options.projection and cursor.project()', async () => {
        const coll = users();
        const a = await coll.find({}, { projection: { username: 1, _id: 0 } }).limit(5).toArray();
        expect(a).toEqual([{ username: 'Alan' }, { username: 'Bea' }]);
        const b = await coll.find({ username: 'Alan' }).project({ profilePic: 1, _id: 0 }).toArray();
        expect(b).toEqual([{ profilePic: 7 }]);
    });

    test('projection never mutates the stored document', async () => {
        const coll = users();
        await coll.findOne({ username: 'Alan' }, { projection: { 'stats.totalPoints': 0, customProfilePic: 0 } });
        const full = await coll.findOne({ username: 'Alan' });
        expect(full.customProfilePic).toBeDefined();
        expect(full.stats.totalPoints).toBe(400);
    });
});

describe('memoryDb arrayFilters', () => {
    const coll = () => new MemoryCollection([{
        username: 'Alan',
        sessionTokens: [{ hash: 'h1', lastUsedAt: new Date(1) }, { hash: 'h2', lastUsedAt: new Date(2) }],
        tags: ['a', 'b', 'a'],
    }]);

    test("updateOne `arr.$[p].field` with { 'p.key': v } sets that field on matching elements only", async () => {
        const c = coll();
        const r = await c.updateOne({ username: 'Alan', 'sessionTokens.hash': 'h2' },
            { $set: { 'sessionTokens.$[s].lastUsedAt': new Date(99) } }, { arrayFilters: [{ 's.hash': 'h2' }] });
        expect(r).toEqual({ matchedCount: 1, modifiedCount: 1 });
        const doc = await c.findOne({ username: 'Alan' });
        expect(doc.sessionTokens).toEqual([{ hash: 'h1', lastUsedAt: new Date(1) }, { hash: 'h2', lastUsedAt: new Date(99) }]);
    });

    test('updateOne / updateMany `arr.$[p]` with { p: v } still replaces matching elements', async () => {
        const c = coll();
        await c.updateOne({ username: 'Alan' }, { $set: { 'tags.$[t]': 'x' } }, { arrayFilters: [{ t: 'a' }] });
        expect((await c.findOne({ username: 'Alan' })).tags).toEqual(['x', 'b', 'x']);
        await c.updateMany({}, { $set: { 'tags.$[t]': 'y' } }, { arrayFilters: [{ t: 'b' }] });
        expect((await c.findOne({ username: 'Alan' })).tags).toEqual(['x', 'y', 'x']);
    });

    test('unsupported shapes throw', async () => {
        const c = coll();
        await expect(c.updateOne({}, { $set: { 'sessionTokens.$[s].lastUsedAt': 1 } }, { arrayFilters: [{ 'q.hash': 'h1' }] }))
            .rejects.toThrow(/unsupported arrayFilters/);
        await expect(c.updateOne({}, { $set: { 'sessionTokens.$[s].x': 1 } }, { arrayFilters: [{ 's.hash': { $in: ['h1'] } }] }))
            .rejects.toThrow(/unsupported arrayFilters/);
        await expect(c.updateOne({}, { $unset: { 'tags.$[t]': '' } }, { arrayFilters: [{ t: 'a' }] }))
            .rejects.toThrow(/only with \$set/);
    });
});

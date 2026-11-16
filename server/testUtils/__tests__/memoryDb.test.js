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

describe('memoryDb _id uniqueness and upserts (as the unique _id index and the driver)', () => {
    const { ObjectId } = require('mongodb');

    test('insertOne of a duplicate _id rejects with code 11000 and stores nothing', async () => {
        const c = new MemoryCollection();
        await c.insertOne({ _id: 'g1', rev: 1 });
        const err = await c.insertOne({ _id: 'g1', rev: 2 }).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe(11000);
        expect(err.name).toBe('MongoServerError');
        expect(err.message).toMatch(/E11000 duplicate key/);
        expect(err.keyValue).toEqual({ _id: 'g1' });
        expect(c.all()).toEqual([{ _id: 'g1', rev: 1 }]);
    });

    test('ObjectIds compare by value; a string and an ObjectId with the same hex are different ids', async () => {
        const id = new ObjectId();
        const c = new MemoryCollection([{ _id: id }]);
        await expect(c.insertOne({ _id: new ObjectId(id.toHexString()) })).rejects.toMatchObject({ code: 11000 });
        await expect(c.insertOne({ _id: id.toHexString() })).resolves.toMatchObject({ insertedId: id.toHexString() });
    });

    test('documents without _id still get distinct ObjectIds; seeding duplicate _ids throws', () => {
        const c = new MemoryCollection([{ a: 1 }, { a: 1 }]);
        expect(String(c.all()[0]._id)).not.toBe(String(c.all()[1]._id));
        expect(() => new MemoryCollection([{ _id: 'x' }, { _id: 'x' }])).toThrow(/E11000/);
    });

    test('updateOne upsert inserts the filter equality fields plus the update, $setOnInsert included', async () => {
        const c = new MemoryCollection();
        const r = await c.updateOne({ _id: 'b1', owner: { $eq: 'A' }, beatSeq: { $gt: 3 } },
            { $set: { beatAt: 5 }, $inc: { beatSeq: 1 }, $setOnInsert: { startedAt: 1 } }, { upsert: true });
        expect(r).toEqual({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: 'b1' });
        expect(c.all()).toEqual([{ _id: 'b1', owner: 'A', beatAt: 5, beatSeq: 1, startedAt: 1 }]);

        // A match updates in place; $setOnInsert is then a no-op
        const r2 = await c.updateOne({ _id: 'b1' }, { $set: { beatAt: 9 }, $setOnInsert: { startedAt: 99 } }, { upsert: true });
        expect(r2).toEqual({ matchedCount: 1, modifiedCount: 1 });
        expect(c.all()).toEqual([{ _id: 'b1', owner: 'A', beatAt: 9, beatSeq: 1, startedAt: 1 }]);
    });

    test('an upsert whose filter misses an existing _id rejects with 11000 (as Mongo does)', async () => {
        const c = new MemoryCollection([{ _id: 'g1', owner: 'A' }]);
        await expect(c.updateOne({ _id: 'g1', owner: 'B' }, { $set: { owner: 'B' } }, { upsert: true }))
            .rejects.toMatchObject({ code: 11000 });
        expect(c.all()).toEqual([{ _id: 'g1', owner: 'A' }]);
    });

    test('without upsert a miss changes nothing; upsert where it is not implemented throws', async () => {
        const c = new MemoryCollection();
        expect(await c.updateOne({ _id: 'x' }, { $set: { a: 1 } })).toEqual({ matchedCount: 0, modifiedCount: 0 });
        expect(c.all()).toEqual([]);
        await expect(c.updateMany({}, { $set: { a: 1 } }, { upsert: true })).rejects.toThrow(/unsupported/);
        await expect(c.replaceOne({}, { a: 1 }, { upsert: true })).rejects.toThrow(/unsupported/);
        await expect(c.findOneAndUpdate({}, { $set: { a: 1 } }, { upsert: true })).rejects.toThrow(/unsupported/);
        await expect(c.updateOne({}, { $set: { 'tags.$[t]': 1 } }, { upsert: true, arrayFilters: [{ t: 1 }] }))
            .rejects.toThrow(/unsupported/);
    });
});

/**
 * Minimal in-memory stand-in for the MongoDB native driver's Collection API,
 * for Jest tests (no mongod/Docker needed). Supports only the query and
 * update operators the server actually uses; anything else throws so a test
 * can't silently pass on an unsupported operator.
 */

const { ObjectId } = require('mongodb');

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v)
        && !(v instanceof Date) && !(v instanceof ObjectId) && !(v instanceof RegExp);
}

function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v instanceof Date) return new Date(v.getTime());
    if (v instanceof ObjectId) return v;
    if (isPlainObject(v)) {
        const out = {};
        for (const [k, val] of Object.entries(v)) out[k] = clone(val);
        return out;
    }
    return v;
}

function equals(a, b) {
    if (a instanceof ObjectId || b instanceof ObjectId) return String(a) === String(b);
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (isPlainObject(a) || Array.isArray(a)) return JSON.stringify(a) === JSON.stringify(b);
    return a === b;
}

/** Resolve a dotted path to the list of candidate values (array traversal). */
function resolve(doc, path) {
    let current = [doc];
    for (const part of path.split('.')) {
        const next = [];
        for (const c of current) {
            if (c == null) continue;
            if (Array.isArray(c) && !/^\d+$/.test(part)) {
                for (const el of c) if (el != null && el[part] !== undefined) next.push(el[part]);
            } else if (c[part] !== undefined) {
                next.push(c[part]);
            }
        }
        current = next;
    }
    return current;
}

/** Values plus array elements, the way Mongo matches scalars against arrays. */
function flatten(values) {
    const out = [];
    for (const v of values) {
        out.push(v);
        if (Array.isArray(v)) out.push(...v);
    }
    return out;
}

/** Range comparisons: ObjectIds by their hex (time-ordered), the rest as is. */
const ord = (v) => (v instanceof ObjectId ? v.toHexString() : v);

function matchCondition(values, cond) {
    const flat = flatten(values);
    if (!isPlainObject(cond) || !Object.keys(cond).some(k => k.startsWith('$'))) {
        return flat.some(v => equals(v, cond));
    }
    return Object.entries(cond).every(([op, arg]) => {
        switch (op) {
            case '$eq': return flat.some(v => equals(v, arg));
            case '$ne': return !flat.some(v => equals(v, arg));
            case '$in': return arg.some(a => flat.some(v => equals(v, a)));
            case '$nin': return !arg.some(a => flat.some(v => equals(v, a)));
            case '$exists': return (values.length > 0) === Boolean(arg);
            case '$gt': return flat.some(v => ord(v) > ord(arg));
            case '$gte': return flat.some(v => ord(v) >= ord(arg));
            case '$lt': return flat.some(v => ord(v) < ord(arg));
            case '$lte': return flat.some(v => ord(v) <= ord(arg));
            case '$regex': {
                const re = new RegExp(arg, cond.$options || '');
                return flat.some(v => typeof v === 'string' && re.test(v));
            }
            case '$options': return true;
            default: throw new Error(`memoryDb: unsupported query operator ${op}`);
        }
    });
}

function matches(doc, filter = {}) {
    return Object.entries(filter).every(([key, cond]) => {
        if (key === '$or') return cond.some(f => matches(doc, f));
        if (key === '$and') return cond.every(f => matches(doc, f));
        if (key.startsWith('$')) throw new Error(`memoryDb: unsupported top-level operator ${key}`);
        return matchCondition(resolve(doc, key), cond);
    });
}

function parentFor(doc, path, create) {
    const parts = path.split('.');
    let obj = doc;
    for (const p of parts.slice(0, -1)) {
        if (obj[p] == null) {
            if (!create) return [null, null];
            obj[p] = {};
        }
        obj = obj[p];
    }
    return [obj, parts[parts.length - 1]];
}

/**
 * Apply an update document. `$setOnInsert` writes only when the update
 * inserts (an upsert that matched nothing), as Mongo does; otherwise it is
 * a no-op.
 */
function applyUpdate(doc, update, { inserting = false } = {}) {
    for (const [op, fields] of Object.entries(update)) {
        if (op === '$setOnInsert' && !inserting) continue;
        for (const [path, arg] of Object.entries(fields)) {
            const [parent, key] = parentFor(doc, path, op !== '$unset' && op !== '$pull');
            switch (op) {
                case '$set':
                case '$setOnInsert': parent[key] = clone(arg); break;
                case '$unset': if (parent) delete parent[key]; break;
                case '$inc': parent[key] = (parent[key] || 0) + arg; break;
                case '$push': {
                    const arr = Array.isArray(parent[key]) ? parent[key] : [];
                    if (isPlainObject(arg) && '$each' in arg) {
                        arr.push(...arg.$each.map(clone));
                        if (typeof arg.$slice === 'number') {
                            const sliced = arg.$slice < 0 ? arr.slice(arg.$slice) : arr.slice(0, arg.$slice);
                            arr.length = 0;
                            arr.push(...sliced);
                        }
                    } else {
                        arr.push(clone(arg));
                    }
                    parent[key] = arr;
                    break;
                }
                case '$addToSet': {
                    const arr = Array.isArray(parent[key]) ? parent[key] : [];
                    if (!arr.some(v => equals(v, arg))) arr.push(clone(arg));
                    parent[key] = arr;
                    break;
                }
                case '$pull': {
                    if (parent && Array.isArray(parent[key])) {
                        parent[key] = parent[key].filter(v => !(isPlainObject(arg)
                            ? matches(v, arg) : equals(v, arg)));
                    }
                    break;
                }
                default: throw new Error(`memoryDb: unsupported update operator ${op}`);
            }
        }
    }
}

/**
 * Apply a find/findOne projection the way Mongo does: inclusion mode (any
 * field other than _id set to 1/true) keeps only the listed paths plus _id
 * unless `_id: 0`; exclusion mode (every value 0/false) drops the listed
 * paths. Dotted paths reach into sub-documents (and arrays of them). Mixing
 * the two modes (other than _id) throws, as the server does.
 */
function applyProjection(doc, projection) {
    if (!projection || doc == null) return doc;
    const entries = Object.entries(projection);
    if (entries.length === 0) return doc;
    for (const [, v] of entries) {
        if (v !== 0 && v !== 1 && v !== true && v !== false) {
            throw new Error(`memoryDb: unsupported projection value ${JSON.stringify(v)}`);
        }
    }
    const others = entries.filter(([k]) => k !== '_id');
    const included = others.filter(([, v]) => v === 1 || v === true);
    const excluded = others.filter(([, v]) => v === 0 || v === false);
    if (included.length && excluded.length) {
        throw new Error('memoryDb: Cannot do exclusion in inclusion projection');
    }
    const idFlag = projection._id;
    const inclusion = included.length > 0 || (others.length === 0 && (idFlag === 1 || idFlag === true));

    if (inclusion) {
        const out = {};
        if (!(idFlag === 0 || idFlag === false) && doc._id !== undefined) out._id = doc._id;
        for (const [path] of included) includePath(doc, out, path.split('.'));
        return out;
    }
    const out = clone(doc);
    for (const [path] of excluded) excludePath(out, path.split('.'));
    if (idFlag === 0 || idFlag === false) delete out._id;
    return out;
}

function includePath(src, dst, parts) {
    const [head, ...rest] = parts;
    if (src == null || typeof src !== 'object' || !(head in src)) return;
    const value = src[head];
    if (rest.length === 0) {
        dst[head] = clone(value);
        return;
    }
    if (Array.isArray(value)) {
        const arr = Array.isArray(dst[head]) ? dst[head] : [];
        value.forEach((el, i) => {
            if (!isPlainObject(el)) return;
            const target = isPlainObject(arr[i]) ? arr[i] : {};
            includePath(el, target, rest);
            arr[i] = target;
        });
        dst[head] = arr.filter(e => e !== undefined);
        return;
    }
    if (!isPlainObject(value)) return;
    const target = isPlainObject(dst[head]) ? dst[head] : {};
    includePath(value, target, rest);
    dst[head] = target;
}

function excludePath(obj, parts) {
    if (obj == null || typeof obj !== 'object') return;
    const [head, ...rest] = parts;
    if (Array.isArray(obj)) {
        obj.forEach(el => excludePath(el, parts));
        return;
    }
    if (rest.length === 0) {
        delete obj[head];
        return;
    }
    excludePath(obj[head], rest);
}

/**
 * The arrayFilters shapes the server uses, with $set only:
 *   `arr.$[p]` with `[{ p: scalar }]` (account deletion anonymizing game
 *   records: replaces each matching element), and
 *   `arr.$[p].field` with `[{ 'p.key': scalar }]` (upgradeGate refreshing one
 *   session entry's lastUsedAt: sets one field of each matching element).
 * Anything else throws.
 */
function applyArrayFilterSet(doc, update, arrayFilters) {
    const ops = Object.keys(update);
    if (ops.length !== 1 || ops[0] !== '$set') throw new Error('memoryDb: arrayFilters only with $set');
    for (const [path, value] of Object.entries(update.$set)) {
        const m = /^([\w.]+)\.\$\[(\w+)\](?:\.(\w+))?$/.exec(path);
        const id = m && m[2];
        const af = m && arrayFilters.find(f => Object.keys(f).length === 1
            && (id in f || /^\w+\.\w+$/.test(Object.keys(f)[0]) && Object.keys(f)[0].split('.')[0] === id));
        const [afKey] = af ? Object.keys(af) : [];
        const afValue = af && af[afKey];
        if (!af || isPlainObject(afValue)) throw new Error(`memoryDb: unsupported arrayFilters update ${path}`);
        const sub = afKey === id ? null : afKey.split('.')[1];
        const hit = el => (sub === null ? equals(el, afValue) : isPlainObject(el) && equals(el[sub], afValue));
        const [parent, key] = parentFor(doc, m[1], false);
        if (!parent || !Array.isArray(parent[key])) continue;
        parent[key] = parent[key].map(el => {
            if (!hit(el)) return el;
            if (!m[3]) return clone(value);
            return { ...el, [m[3]]: clone(value) };
        });
    }
}

/** Comparator for a Mongo sort spec ({field: 1|-1, ...}): numbers, strings, Dates, ObjectIds. */
function compareBy(spec) {
    const keys = Object.entries(spec);
    const val = (doc, path) => {
        const v = resolve(doc, path)[0];
        if (v instanceof Date) return v.getTime();
        if (v instanceof ObjectId) return v.toHexString();
        return v;
    };
    return (a, b) => {
        for (const [path, dir] of keys) {
            const x = val(a, path);
            const y = val(b, path);
            if (x === y) continue;
            if (x === undefined || x === null) return -dir;
            if (y === undefined || y === null) return dir;
            return (x < y ? -1 : 1) * dir;
        }
        return 0;
    };
}

let sortEnabled = false;

/** Same _id the way the unique _id index compares: an ObjectId never equals a string. */
function sameId(a, b) {
    if ((a instanceof ObjectId) !== (b instanceof ObjectId)) return false;
    return equals(a, b);
}

/**
 * The error the driver throws for a duplicate key (a MongoServerError with
 * code 11000, keyPattern and keyValue), so code that checks
 * `err.code === 11000` sees the same thing under Jest.
 */
function duplicateKeyError(keyPattern, keyValue, indexName) {
    const shown = Object.entries(keyValue).map(([k, v]) => `${k}: ${JSON.stringify(v instanceof ObjectId ? String(v) : v)}`).join(', ');
    const err = new Error(`E11000 duplicate key error collection: memoryDb index: ${indexName} dup key: { ${shown} }`);
    err.name = 'MongoServerError';
    err.code = 11000;
    err.keyPattern = { ...keyPattern };
    err.keyValue = { ...keyValue };
    return err;
}

/** An index's name as the server makes it ({gameId: 1} -> 'gameId_1'). */
const indexName = (keys) => Object.entries(keys).map(([k, v]) => `${k}_${v}`).join('_');

/** A comparable form of one indexed value (missing = null, as Mongo indexes it). */
function indexValue(v) {
    if (v === undefined || v === null) return null;
    if (v instanceof ObjectId) return { $oid: v.toHexString() };
    if (v instanceof Date) return { $date: v.getTime() };
    return v;
}

/**
 * The document an upsert inserts before its update applies: the filter's
 * equality conditions (top level and inside $and; `{$eq: v}` too), as Mongo
 * seeds it. Other operator conditions contribute nothing.
 */
function upsertSeed(filter = {}) {
    const doc = {};
    const take = (f) => {
        for (const [key, cond] of Object.entries(f)) {
            if (key === '$and') { cond.forEach(take); continue; }
            if (key.startsWith('$')) continue;
            let value = cond;
            if (isPlainObject(cond) && Object.keys(cond).some(k => k.startsWith('$'))) {
                if (!('$eq' in cond)) continue;
                value = cond.$eq;
            }
            const [parent, last] = parentFor(doc, key, true);
            parent[last] = clone(value);
        }
    };
    take(filter);
    return doc;
}

class MemoryCollection {
    /**
     * @param {Array<Object>} [docs] seed documents (checked like inserts)
     * @param {{unique?: Array<{keys: Object, partialFilterExpression?: Object}>}} [options]
     *   unique secondary indexes, as database.js builds them (createMemoryDb
     *   declares the server's); createIndex adds more
     */
    constructor(docs = [], { unique = [] } = {}) {
        this.docs = [];
        this.uniqueIndexes = [];
        for (const { keys, partialFilterExpression } of unique) {
            this._addUniqueIndex(keys, partialFilterExpression ? { partialFilterExpression } : {});
        }
        docs.forEach(d => this._insert(d));
    }

    /**
     * createIndex as the driver answers it (the index name). `unique: true`
     * (with an optional partialFilterExpression) is enforced from then on
     * by every insert, upsert, update and replace, which then throw the
     * driver's E11000 with that index's keyPattern and keyValue; building
     * it over documents that already collide throws E11000, as the server's
     * build does. Other indexes change nothing here.
     */
    async createIndex(keys, options = {}) {
        if (options.unique) this._addUniqueIndex(keys, options);
        return options.name || indexName(keys);
    }

    _addUniqueIndex(keys, { partialFilterExpression = null, name = null } = {}) {
        const index = { keys: { ...keys }, partialFilterExpression, name: name || indexName(keys) };
        const seen = new Set();
        for (const d of this.docs) {
            const key = this._indexKey(index, d);
            if (key === null) continue;
            if (seen.has(key)) throw this._duplicate(index, d);
            seen.add(key);
        }
        this.uniqueIndexes = this.uniqueIndexes.filter(i => i.name !== index.name).concat(index);
    }

    /** The document's key in a unique index, or null when the index does not cover it (partial). */
    _indexKey(index, doc) {
        if (index.partialFilterExpression && !matches(doc, index.partialFilterExpression)) return null;
        return JSON.stringify(Object.keys(index.keys).map(path => indexValue(resolve(doc, path)[0])));
    }

    _duplicate(index, doc) {
        const keyValue = {};
        for (const path of Object.keys(index.keys)) keyValue[path] = resolve(doc, path)[0] ?? null;
        return duplicateKeyError(index.keys, keyValue, index.name);
    }

    /**
     * Throw the driver's E11000 if `candidate` collides with another
     * document (not `self`) on _id or on a unique index.
     */
    _assertUnique(candidate, self = null) {
        if (this.docs.some(d => d !== self && sameId(d._id, candidate._id))) {
            throw duplicateKeyError({ _id: 1 }, { _id: candidate._id }, '_id_');
        }
        for (const index of this.uniqueIndexes) {
            const key = this._indexKey(index, candidate);
            if (key === null) continue;
            if (this.docs.some(d => d !== self && this._indexKey(index, d) === key)) throw this._duplicate(index, candidate);
        }
    }

    /**
     * Change `doc` in place with `fn`, all or nothing: with unique indexes
     * the change is made on a copy and checked first, so a duplicate key
     * throws and leaves the document as it was (as the server does).
     */
    _mutate(doc, fn) {
        if (this.uniqueIndexes.length === 0) {
            fn(doc);
            return;
        }
        const next = clone(doc);
        fn(next);
        this._assertUnique(next, doc);
        for (const key of Object.keys(doc)) delete doc[key];
        Object.assign(doc, next);
    }

    /**
     * Insert a copy, with a new ObjectId when it has no _id. A duplicate _id
     * or unique-index key throws the driver's E11000 (code 11000): seeds and
     * test helpers that call this directly get the same check as insertOne.
     */
    _insert(doc) {
        const copy = clone(doc);
        if (!copy._id) copy._id = new ObjectId();
        this._assertUnique(copy);
        this.docs.push(copy);
        return copy._id;
    }

    async insertOne(doc) {
        return { acknowledged: true, insertedId: this._insert(doc) };
    }

    async findOne(filter, options = {}) {
        const doc = this.docs.find(d => matches(d, filter));
        return doc ? applyProjection(clone(doc), options.projection) : null;
    }

    find(filter, options = {}) {
        let results = this.docs.filter(d => matches(d, filter));
        let projection = options.projection;
        const cursor = {
            limit(n) { results = results.slice(0, n); return cursor; },
            // Sorting is opt-in ({sort: true} on the collection's options):
            // tests written before it relied on insertion order
            sort(spec) {
                if (spec && sortEnabled) results = [...results].sort(compareBy(spec));
                return cursor;
            },
            project(p) { projection = p; return cursor; },
            async toArray() { return results.map(d => applyProjection(clone(d), projection)); }
        };
        return cursor;
    }

    async countDocuments(filter) {
        return this.docs.filter(d => matches(d, filter)).length;
    }

    /**
     * updateOne. With `upsert: true` and no match it inserts the filter's
     * equality fields plus the update ($setOnInsert included) and answers as
     * the driver does (upsertedCount 1, upsertedId); a duplicate _id then
     * throws E11000. arrayFilters together with upsert throws (unsupported).
     */
    async updateOne(filter, update, options = {}) {
        const doc = this.docs.find(d => matches(d, filter));
        if (!doc && options.upsert) {
            if (options.arrayFilters) throw new Error('memoryDb: upsert with arrayFilters is unsupported');
            const seed = upsertSeed(filter);
            applyUpdate(seed, update, { inserting: true });
            const upsertedId = this._insert(seed);
            return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId };
        }
        if (!doc) return { matchedCount: 0, modifiedCount: 0 };
        const before = JSON.stringify(doc);
        this._mutate(doc, (d) => {
            if (options.arrayFilters) applyArrayFilterSet(d, update, options.arrayFilters);
            else applyUpdate(d, update);
        });
        return { matchedCount: 1, modifiedCount: before === JSON.stringify(doc) ? 0 : 1 };
    }

    /**
     * findOneAndUpdate as driver 6 returns it: the document (before the
     * update unless returnDocument: 'after'), or null when nothing matched.
     * Atomic here by construction (no await between match and write).
     */
    async findOneAndUpdate(filter, update, options = {}) {
        if (options.upsert) throw new Error('memoryDb: upsert is unsupported in findOneAndUpdate');
        const doc = this.docs.find(d => matches(d, filter));
        if (!doc) return null;
        const before = clone(doc);
        this._mutate(doc, (d) => applyUpdate(d, update));
        const out = options.returnDocument === 'after' ? clone(doc) : before;
        return applyProjection(out, options.projection);
    }

    async updateMany(filter, update, options = {}) {
        if (options.upsert) throw new Error('memoryDb: upsert is unsupported in updateMany');
        let modified = 0;
        const targets = this.docs.filter(d => matches(d, filter));
        for (const doc of targets) {
            const before = JSON.stringify(doc);
            this._mutate(doc, (d) => {
                if (options.arrayFilters) applyArrayFilterSet(d, update, options.arrayFilters);
                else applyUpdate(d, update);
            });
            if (before !== JSON.stringify(doc)) modified++;
        }
        return { matchedCount: targets.length, modifiedCount: modified };
    }

    /** replaceOne as the driver does it: the whole document but its _id. */
    async replaceOne(filter, replacement, options = {}) {
        if (options.upsert) throw new Error('memoryDb: upsert is unsupported in replaceOne');
        const i = this.docs.findIndex(d => matches(d, filter));
        if (i === -1) return { matchedCount: 0, modifiedCount: 0 };
        const next = clone(replacement);
        delete next._id;
        const replaced = { _id: this.docs[i]._id, ...next };
        this._assertUnique(replaced, this.docs[i]);
        this.docs[i] = replaced;
        return { matchedCount: 1, modifiedCount: 1 };
    }

    async deleteOne(filter) {
        const i = this.docs.findIndex(d => matches(d, filter));
        if (i === -1) return { deletedCount: 0 };
        this.docs.splice(i, 1);
        return { deletedCount: 1 };
    }

    async deleteMany(filter) {
        const before = this.docs.length;
        this.docs = this.docs.filter(d => !matches(d, filter));
        return { deletedCount: before - this.docs.length };
    }

    /** Test helper: synchronous snapshot of every document. */
    all() {
        return this.docs.map(clone);
    }
}

/**
 * The unique secondary indexes database.js builds (ensureUsernameIndex,
 * ensureGameIdIndex), so a second user with a taken name or a second
 * gameRecords entry for one game fails with E11000 here too.
 */
const SERVER_UNIQUE_INDEXES = Object.freeze({
    users: [{ keys: { username: 1 } }],
    gameRecords: [{ keys: { gameId: 1 }, partialFilterExpression: { gameId: { $exists: true } } }],
});

function createMemoryDb({ users = [], gameRecords = [], reports = [], passwordResets = [], adminAudit = [] } = {}) {
    return {
        users: new MemoryCollection(users, { unique: SERVER_UNIQUE_INDEXES.users }),
        gameRecords: new MemoryCollection(gameRecords, { unique: SERVER_UNIQUE_INDEXES.gameRecords }),
        reports: new MemoryCollection(reports),
        // the admin panel's (server/admin/)
        passwordResets: new MemoryCollection(passwordResets),
        adminAudit: new MemoryCollection(adminAudit)
    };
}

/** Make cursor.sort() really sort (tests of code whose order matters). */
function enableSort(on = true) {
    sortEnabled = on;
}

module.exports = { MemoryCollection, createMemoryDb, SERVER_UNIQUE_INDEXES, matches, applyProjection, enableSort };

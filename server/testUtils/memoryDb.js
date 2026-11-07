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
            case '$gt': return flat.some(v => v > arg);
            case '$gte': return flat.some(v => v >= arg);
            case '$lt': return flat.some(v => v < arg);
            case '$lte': return flat.some(v => v <= arg);
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

function applyUpdate(doc, update) {
    for (const [op, fields] of Object.entries(update)) {
        for (const [path, arg] of Object.entries(fields)) {
            const [parent, key] = parentFor(doc, path, op !== '$unset' && op !== '$pull');
            switch (op) {
                case '$set': parent[key] = clone(arg); break;
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

class MemoryCollection {
    constructor(docs = []) {
        this.docs = [];
        docs.forEach(d => this._insert(d));
    }

    _insert(doc) {
        const copy = clone(doc);
        if (!copy._id) copy._id = new ObjectId();
        this.docs.push(copy);
        return copy._id;
    }

    async insertOne(doc) {
        return { acknowledged: true, insertedId: this._insert(doc) };
    }

    async findOne(filter) {
        const doc = this.docs.find(d => matches(d, filter));
        return doc ? clone(doc) : null;
    }

    find(filter) {
        let results = this.docs.filter(d => matches(d, filter));
        const cursor = {
            limit(n) { results = results.slice(0, n); return cursor; },
            sort() { return cursor; },
            async toArray() { return results.map(clone); }
        };
        return cursor;
    }

    async countDocuments(filter) {
        return this.docs.filter(d => matches(d, filter)).length;
    }

    async updateOne(filter, update) {
        const doc = this.docs.find(d => matches(d, filter));
        if (!doc) return { matchedCount: 0, modifiedCount: 0 };
        const before = JSON.stringify(doc);
        applyUpdate(doc, update);
        return { matchedCount: 1, modifiedCount: before === JSON.stringify(doc) ? 0 : 1 };
    }

    async updateMany(filter, update, options = {}) {
        let modified = 0;
        const targets = this.docs.filter(d => matches(d, filter));
        if (options.arrayFilters && targets.length) throw new Error('memoryDb: arrayFilters not supported');
        for (const doc of targets) {
            const before = JSON.stringify(doc);
            applyUpdate(doc, update);
            if (before !== JSON.stringify(doc)) modified++;
        }
        return { matchedCount: targets.length, modifiedCount: modified };
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

function createMemoryDb({ users = [], gameRecords = [], reports = [] } = {}) {
    return {
        users: new MemoryCollection(users),
        gameRecords: new MemoryCollection(gameRecords),
        reports: new MemoryCollection(reports)
    };
}

module.exports = { MemoryCollection, createMemoryDb, matches };

/**
 * Static checks of contract/src (the schema itself, not the server):
 * supported keywords only, every $ref resolves, reserved keys stay out,
 * added keys a shipped client reads are declared in `activates`, game
 * payloads are closed, c2s Joi / rate-limit names exist.
 */

const contract = require('..');
const { compile, SUPPORTED } = require('../lib/validate');
const validators = require('../../server/socket/validators');
const rateLimiter = require('../../server/socket/rateLimiter');

const { schema } = contract;
afterAll(() => rateLimiter.shutdown());
const STATUSES = ['active', 'deprecated', 'clientOnly', 'unsent'];

/** Every (sub)schema with its path. */
function walk(s, where, out = []) {
    if (!s || typeof s !== 'object') return out;
    out.push([where, s]);
    for (const [k, v] of Object.entries(s.properties || {})) walk(v, `${where}.${k}`, out);
    for (const [k, v] of Object.entries(s.patternProperties || {})) walk(v, `${where}[${k}]`, out);
    if (s.items) walk(s.items, `${where}[]`, out);
    if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties, `${where}.*`, out);
    (s.anyOf || []).forEach((v, i) => walk(v, `${where}|${v.variant || i}`, out));
    return out;
}

/** Property names a payload can carry at the top level (all variants). */
function topKeys(payload) {
    if (!payload) return [];
    const keys = new Set(Object.keys(payload.properties || {}));
    for (const v of payload.anyOf || []) for (const k of Object.keys(v.properties || {})) keys.add(k);
    return [...keys];
}

const resolve = (s) => (s && s.$ref ? schema.$defs[s.$ref.split('/').pop()] : s);

test('every payload compiles (supported keywords only, every $ref resolves)', () => {
    for (const [name, d] of Object.entries(schema.$defs)) {
        expect(() => compile(d, schema.$defs)).not.toThrow();
        for (const [where, s] of walk(d, `$defs.${name}`)) {
            if (s.$ref) expect({ where, ok: !!schema.$defs[s.$ref.split('/').pop()] }).toEqual({ where, ok: true });
        }
    }
    for (const dir of ['s2c', 'c2s']) {
        for (const [name, e] of Object.entries(schema[dir])) {
            expect({ name, status: STATUSES.includes(e.status) }).toEqual({ name, status: true });
            if (e.payload !== null) expect(() => compile(e.payload, schema.$defs)).not.toThrow();
        }
    }
    expect(SUPPORTED.has('oneOf')).toBe(false);
});

test('reserved keys are absent from their event unless activated', () => {
    for (const [name, e] of Object.entries(schema.s2c)) {
        const keys = topKeys(e.payload);
        for (const { key, why } of e.reserved || []) {
            expect(typeof why).toBe('string');
            if ((e.activates || []).includes(key)) continue;
            if (name === 'spectatorJoined') {
                // reserved for the notice variant only
                const notice = e.payload.anyOf.find((v) => v.variant === 'notice');
                expect({ name, key, inNotice: key in notice.properties }).toEqual({ name, key, inNotice: false });
                continue;
            }
            expect({ name, key, present: keys.includes(key) }).toEqual({ name, key, present: false });
        }
    }
    // cardPlayed: trumpBroken is a Bool; the old trump Bool is gone (V1_REMOVALS #10)
    expect(schema.s2c.cardPlayed.payload.properties.trumpBroken.type).toBe('boolean');
    expect(schema.s2c.cardPlayed.payload.properties.trump).toBeUndefined();
    // gameLogEntry: only 'system' entries may omit playerPosition
    const gle = schema.s2c.gameLogEntry.payload;
    expect(gle.properties.type.const === 'system' || (gle.required || []).includes('playerPosition')).toBe(true);
});

test('added keys: declared on the payload, and activated when a shipped client reads them', () => {
    for (const [name, e] of Object.entries(schema.s2c)) {
        const keys = topKeys(e.payload);
        for (const k of e.added || []) expect({ name, k, present: keys.includes(k) }).toEqual({ name, k, present: true });
        for (const k of e.activates || []) expect({ name, k, added: (e.added || []).includes(k) }).toEqual({ name, k, added: true });
        // a key the clientReads cite by name must be activated
        for (const r of [...(e.clientReads?.web || []), ...(e.clientReads?.ios || [])]) {
            const m = /#reads:(.+)$/.exec(r);
            if (!m) continue;
            for (const k of m[1].split(',')) {
                if ((e.added || []).includes(k)) expect({ name, k, activated: (e.activates || []).includes(k) }).toEqual({ name, k, activated: true });
            }
        }
    }
});

test('every server -> client payload is closed (except documented open DB rows and client-only events)', () => {
    const OPEN_OK = /\.(stats|records|offer|answer|candidate|roundDetails\[\]|queuedUsers\[\])$|\$defs\.(scoreboardRow|leaderboardRow|recordsPeriod(\.\w+)?)$/;
    for (const [name, e] of Object.entries(schema.s2c)) {
        if (e.status === 'clientOnly' || e.payload === null) continue;
        for (const [where, s] of walk(resolve(e.payload), `s2c.${name}`)) {
            if (s.type === 'object' || s.properties) {
                expect({ where, closed: s.additionalProperties === false || OPEN_OK.test(where) }).toEqual({ where, closed: true });
            }
        }
    }
    for (const [name, d] of Object.entries(schema.$defs)) {
        if (name === 'cardIn') continue; // client-sent
        for (const [where, s] of walk(d, `$defs.${name}`)) {
            if (s.type === 'object' || s.properties) {
                expect({ where, closed: s.additionalProperties === false || OPEN_OK.test(where) }).toEqual({ where, closed: true });
            }
        }
    }
});

test('s2c metadata: to, emittedFrom (file:function, no line numbers), clientReads', () => {
    for (const [name, e] of Object.entries(schema.s2c)) {
        const tos = [].concat(e.to);
        expect({ name, to: tos.length > 0 && tos.every((t) => ['room', 'self', 'socket', 'mainRoom', 'tournament', 'all'].includes(t)) }).toEqual({ name, to: true });
        expect(Array.isArray(e.emittedFrom)).toBe(true);
        if (e.status !== 'clientOnly') expect({ name, n: e.emittedFrom.length > 0 }).toEqual({ name, n: true });
        for (const site of e.emittedFrom) expect({ name, site, ok: /^server\/[\w/.*]+\.js:/.test(site) && !/:\d+$/.test(site) }).toEqual({ name, site, ok: true });
        expect(e.clientReads && Array.isArray(e.clientReads.web) && Array.isArray(e.clientReads.ios)).toBe(true);
        for (const r of [...e.clientReads.web, ...e.clientReads.ios]) expect(/:\d+$/.test(r)).toBe(false);
    }
});

test('c2s metadata: joi and rateLimit name real schemas / limits', () => {
    for (const [name, e] of Object.entries(schema.c2s)) {
        if (e.joi !== null) expect({ name, joi: Object.prototype.hasOwnProperty.call(validators.schemas, e.joi) }).toEqual({ name, joi: true });
        if (e.joiInHandler !== undefined) expect({ name, joiInHandler: e.joi === null && Object.prototype.hasOwnProperty.call(validators.schemas, e.joiInHandler) }).toEqual({ name, joiInHandler: true });
        if (e.rateLimit !== null) expect({ name, rl: Object.prototype.hasOwnProperty.call(rateLimiter.limits, e.rateLimit) }).toEqual({ name, rl: true });
        expect(typeof e.sentBy.web === 'boolean' && typeof e.sentBy.ios === 'boolean').toBe(true);
    }
});

test('variants are named and unique per event', () => {
    for (const [name, e] of Object.entries(schema.s2c)) {
        if (!e.payload || !e.payload.anyOf) continue;
        const names = e.payload.anyOf.map((v) => v.variant);
        expect({ name, named: names.every(Boolean), unique: new Set(names).size === names.length }).toEqual({ name, named: true, unique: true });
    }
});

/**
 * The socket contract (dev/test only — production server code never
 * requires anything under contract/; contract.test.js enforces it).
 *
 *   schema            the assembled contract (same as events.schema.json)
 *   validateS2C(e,d)  {ok, errors, status, unknownEvent?} for a server emit
 *   validateC2S(e,d)  the same for a client payload
 *   s2cNames(), c2sNames()
 */

'use strict';

const { buildSchema } = require('./src');
const { compile } = require('./lib/validate');

// JSON round-trip: the in-memory schema is exactly the committed artifact
const schema = JSON.parse(JSON.stringify(buildSchema()));

const compiled = { s2c: new Map(), c2s: new Map() };

function validatorFor(dir, event) {
    const table = compiled[dir];
    if (table.has(event)) return table.get(event);
    const entry = Object.prototype.hasOwnProperty.call(schema[dir], event) ? schema[dir][event] : null;
    let fn = null;
    if (entry) {
        if (entry.payload === null) {
            fn = (data) => (data === undefined ? [] : [{ path: '$', message: `expected no payload, got ${JSON.stringify(data)}` }]);
        } else {
            const inner = compile(entry.payload, schema.$defs);
            fn = entry.optionalPayload ? (data) => (data === undefined ? [] : inner(data)) : inner;
        }
    }
    table.set(event, fn);
    return fn;
}

function validate(dir, event, data) {
    const fn = validatorFor(dir, event);
    if (!fn) return { ok: false, unknownEvent: true, errors: [{ path: '$', message: `unknown ${dir} event '${event}'` }] };
    const errors = fn(data);
    return { ok: errors.length === 0, errors, status: schema[dir][event].status };
}

module.exports = {
    schema,
    validateS2C: (event, data) => validate('s2c', event, data),
    validateC2S: (event, data) => validate('c2s', event, data),
    s2cNames: () => Object.keys(schema.s2c),
    c2sNames: () => Object.keys(schema.c2s),
    builtins: schema.builtins,
};

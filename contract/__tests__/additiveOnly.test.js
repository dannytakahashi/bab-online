/**
 * The wire only grows: the current contract must keep everything the frozen
 * v1 baseline (contract/v1-baseline.schema.json, captured from cc865b4 and
 * never regenerated) promised the shipped App Store iOS app and the web
 * client. New events, properties and variants are fine; removing or
 * changing anything the baseline has is not. The baseline is edited by hand
 * only when a V1_REMOVALS.md entry is executed.
 */

const baseline = require('../v1-baseline.schema.json');
const { schema } = require('..');
const { deepEqual } = require('../lib/validate');

const MSG = 'This would break the App Store iOS build or the web client; see contract/V1_REMOVALS.md';

/** Problems with `cur` keeping everything `base` (an object payload) had. */
function objectKeeps(base, cur, where, out) {
    if (!cur || typeof cur !== 'object') {
        out.push(`${where}: payload is gone`);
        return;
    }
    if (base.$ref || cur.$ref) {
        if (!deepEqual(base, cur)) out.push(`${where}: ${JSON.stringify(base)} became ${JSON.stringify(cur)}`);
        return;
    }
    for (const k of ['type', 'additionalProperties', 'const', 'enum']) {
        if (!deepEqual(base[k], cur[k])) out.push(`${where}: '${k}' changed from ${JSON.stringify(base[k])} to ${JSON.stringify(cur[k])}`);
    }
    for (const [k, ps] of Object.entries(base.properties || {})) {
        if (!cur.properties || !(k in cur.properties)) out.push(`${where}.${k}: removed`);
        else if (!deepEqual(ps, cur.properties[k])) out.push(`${where}.${k}: schema changed`);
    }
    for (const k of base.required || []) {
        if (!(cur.required || []).includes(k)) out.push(`${where}.${k}: no longer required`);
    }
    if (!deepEqual(base.patternProperties, cur.patternProperties)) out.push(`${where}: patternProperties changed`);
    if (!deepEqual(base.items, cur.items)) out.push(`${where}: items changed`);
}

function payloadKeeps(base, cur, where, out) {
    if (base === null) {
        if (cur !== null) out.push(`${where}: had no payload, now has one`);
        return;
    }
    if (base.anyOf) {
        if (!cur || !cur.anyOf) {
            out.push(`${where}: variants are gone`);
            return;
        }
        for (const bv of base.anyOf) {
            const cv = cur.anyOf.find((v) => v.variant === bv.variant);
            if (!cv) out.push(`${where}|${bv.variant}: variant removed`);
            else objectKeeps(bv, cv, `${where}|${bv.variant}`, out);
        }
        return;
    }
    objectKeeps(base, cur, where, out);
}

test('the baseline is the cc865b4 contract (frozen)', () => {
    expect(baseline.title).toBe('BAB Online socket contract');
    expect(Object.keys(baseline.s2c).length).toBeGreaterThan(80);
    expect(baseline.s2c.seq).toBeUndefined();
});

test.each(['s2c', 'c2s'])('every baseline %s event is still there, with the same direction and payload', (dir) => {
    const problems = [];
    for (const [name, be] of Object.entries(baseline[dir])) {
        const other = dir === 's2c' ? 'c2s' : 's2c';
        const ce = schema[dir][name];
        if (!ce) {
            problems.push(`${dir}.${name}: removed${schema[other][name] ? ` (now ${other})` : ''}`);
            continue;
        }
        if (dir === 's2c') payloadKeeps(be.payload, ce.payload, `${dir}.${name}`, problems);
        else if (!deepEqual(be.payload, ce.payload)) problems.push(`${dir}.${name}: payload schema changed`);
        if (be.status !== ce.status && !(be.status === 'active' && ce.status === 'deprecated')) {
            problems.push(`${dir}.${name}: status ${be.status} -> ${ce.status}`);
        }
    }
    if (problems.length) throw new Error(`${MSG}\n  ${problems.join('\n  ')}`);
});

test('every baseline $def is unchanged (new $defs are fine)', () => {
    const problems = [];
    for (const [name, d] of Object.entries(baseline.$defs)) {
        if (!schema.$defs[name]) problems.push(`$defs.${name}: removed`);
        else if (!deepEqual(d, schema.$defs[name])) problems.push(`$defs.${name}: changed`);
    }
    if (problems.length) throw new Error(`${MSG}\n  ${problems.join('\n  ')}`);
});

test('the builtins are unchanged', () => {
    expect(schema.builtins).toEqual(baseline.builtins);
});

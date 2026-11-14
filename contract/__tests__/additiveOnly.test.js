/**
 * The wire only grows: the current contract must keep everything the frozen
 * v1 baseline (contract/v1-baseline.schema.json, captured from cc865b4 and
 * never regenerated) promised the shipped App Store iOS app and the web
 * client. New events, properties and variants are fine; removing or
 * changing anything the baseline has is not. The baseline is edited by hand
 * only when a V1_REMOVALS.md entry is executed.
 */

const baseline = require('../v1-baseline.schema.json');
const { schema, validateC2S } = require('..');
const { deepEqual } = require('../lib/validate');

const MSG = 'This would break the App Store iOS build or the web client; see contract/V1_REMOVALS.md';

/**
 * s2c properties the baseline left as a bare open object `{}` that the
 * contract now spells out. Narrowing an s2c schema only adds promises to
 * clients (the server always sent this shape), so it cannot break one; it
 * is allowed only here, named, and only while the property stays an open
 * object.
 */
const S2C_REFINED = {
    's2c.recordsResponse|success.records': 'the documented allTime / thisYear / thisMonth periods (review fix: records content was never checked)',
};
const isBareOpenObject = (s) => s && s.type === 'object' && s.additionalProperties === true &&
    Object.keys(s.properties || {}).length === 0 && !(s.required || []).length;

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
        else if (S2C_REFINED[`${where}.${k}`] && isBareOpenObject(ps)) {
            const c = cur.properties[k];
            if (!(c.type === 'object' && c.additionalProperties === true)) out.push(`${where}.${k}: refined, but no longer an open object`);
        } else if (!deepEqual(ps, cur.properties[k])) out.push(`${where}.${k}: schema changed`);
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

/**
 * c2s: what the server ACCEPTS must not shrink. Acceptance is Joi's job
 * (the `joi` key), so that must not change; the c2s schema documents Joi
 * and may tighten toward it (bounds, required keys Joi already requires:
 * contract.test.js checks negative examples against both). Every payload
 * the baseline documented as sent by a client must still validate, and no
 * documented key may disappear.
 */
function c2sKeeps(name, be, ce, out) {
    const where = `c2s.${name}`;
    if (be.joi !== ce.joi) out.push(`${where}: joi ${be.joi} -> ${ce.joi}`);
    if (be.optionalPayload && !ce.optionalPayload) out.push(`${where}: a payload is now required`);
    if ((be.payload === null) !== (ce.payload === null)) {
        out.push(`${where}: payload presence changed`);
        return;
    }
    if (!be.payload) return;
    for (const k of Object.keys(be.payload.properties || {})) {
        if (!(k in (ce.payload.properties || {}))) out.push(`${where}.${k}: removed`);
    }
    if (be.payload.additionalProperties !== ce.payload.additionalProperties) out.push(`${where}: additionalProperties changed`);
    for (const k of ce.payload.required || []) {
        if (!(be.payload.required || []).includes(k) && !ce.joi) out.push(`${where}.${k}: newly required without a Joi schema enforcing it`);
    }
    for (const ex of be.examples || []) {
        const r = validateC2S(name, ex);
        if (!r.ok) out.push(`${where}: baseline example ${JSON.stringify(ex)} no longer validates (${r.errors[0].path} ${r.errors[0].message})`);
    }
}

test('the baseline is the cc865b4 contract (frozen)', () => {
    expect(baseline.title).toBe('BAB Online socket contract');
    // 80+ at cc865b4; the executed V1_REMOVALS entries hand-edit whole events out (#2, #4, #20, #3)
    expect(Object.keys(baseline.s2c).length).toBeGreaterThan(70);
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
        else c2sKeeps(name, be, ce, problems);
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

test('the c2s rule catches what would make the server refuse a shipped client', () => {
    const base = baseline.c2s.playerBid;
    const cur = JSON.parse(JSON.stringify(schema.c2s.playerBid));
    const run = (c) => { const out = []; c2sKeeps('playerBid', base, c, out); return out.join('\n'); };
    expect(run(cur)).toBe('');
    expect(run({ ...cur, joi: null })).toMatch(/joi playerBid -> null/);
    const noBid = JSON.parse(JSON.stringify(cur));
    delete noBid.payload.properties.bid;
    expect(run(noBid)).toMatch(/playerBid\.bid: removed/);
});

test('the s2c refinement exception is narrow: only named properties, only while still open', () => {
    const out = [];
    const base = { type: 'object', properties: { records: { type: 'object', properties: {}, additionalProperties: true } }, additionalProperties: false };
    const closed = { ...base, properties: { records: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } } };
    objectKeeps(base, closed, 's2c.recordsResponse|success', out);
    objectKeeps(base, closed, 's2c.other|success', out);
    expect(out).toEqual(['s2c.recordsResponse|success.records: refined, but no longer an open object', 's2c.other|success.records: schema changed']);
});

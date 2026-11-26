/**
 * The wire only grows, for every client that may still connect: the current
 * contract must keep everything each frozen baseline promised.
 *
 * - contract/v1-baseline.schema.json: the cc865b4 contract (iOS 1.0.0 and
 *   the web client), never regenerated.
 * - contract/baselines/ios-<version>-b<build>.schema.json: the contract at
 *   the commit each submitted iOS build was cut from (npm run
 *   contract:baseline), plus its .decodes.json: what that build's Swift
 *   decodes, held separately below because a non-optional property that
 *   goes missing or null fails the whole event on that build.
 *
 * New events, properties and variants are fine; removing or changing
 * anything a baseline has is not. A schema baseline is edited by hand only
 * when a V1_REMOVALS.md entry is executed that is safe for that build; a
 * decode floor never is: the build is retired once MIN_IOS_BUILD gates it
 * (contract/baselines/README.md). The floors' named exceptions (waived
 * mismatches, relied-on optional properties) are contract/lib/decodeRules.js.
 */

const fs = require('fs');
const path = require('path');
const v1 = require('../v1-baseline.schema.json');
const { schema, validateC2S } = require('..');
const { deepEqual } = require('../lib/validate');
const { checkDecodes } = require('../lib/swiftDecodes');
const { DECODE_WAIVED, DECODE_RELIED, reliedFor } = require('../lib/decodeRules');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'contract', 'baselines');
const FILE_RE = /^ios-(\d+\.\d+\.\d+)-b(\d+)\.(schema|decodes)\.json$/;

const MIN_IOS_BUILD = (() => {
    // read, not required: upgradeGate.js pulls in the database module
    const m = /^const MIN_IOS_BUILD = (\d+);$/m.exec(fs.readFileSync(path.join(ROOT, 'server/socket/upgradeGate.js'), 'utf8'));
    if (!m) throw new Error('MIN_IOS_BUILD not found in server/socket/upgradeGate.js');
    return Number(m[1]);
})();

const BUILDS = fs.readdirSync(DIR).filter((f) => FILE_RE.test(f) && f.endsWith('.schema.json')).map((f) => {
    const [, version, build] = FILE_RE.exec(f);
    const decodesFile = f.replace('.schema.json', '.decodes.json');
    return {
        label: `iOS ${version} (${build})`,
        version,
        build: Number(build),
        file: `contract/baselines/${f}`,
        schema: JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')),
        decodes: fs.existsSync(path.join(DIR, decodesFile)) ? JSON.parse(fs.readFileSync(path.join(DIR, decodesFile), 'utf8')) : null,
    };
}).sort((a, b) => a.build - b.build);

/**
 * test.each over the frozen builds; while none is frozen (right after a gate
 * raise retired them all, before the floor build's freeze lands) one skipped
 * placeholder, since 'the floor build is frozen' below already fails then.
 */
const eachBuild = (name, fn) => (BUILDS.length
    ? test.each(BUILDS.map((b) => [b.label, b]))(name, fn)
    : test.skip(name.replace('%s', 'every frozen iOS build'), () => {}));
/** Regex-escaped, for the labels in the messages below. */
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const BASELINES = [
    { label: 'the v1 baseline (cc865b4: iOS 1.0.0 and the web client)', file: 'contract/v1-baseline.schema.json', schema: v1 },
    ...BUILDS,
];

const fail = (b, problems) => {
    if (problems.length) {
        throw new Error(`This would break ${b.label} (${b.file}); see contract/V1_REMOVALS.md and contract/baselines/README.md\n  ${problems.join('\n  ')}`);
    }
};

/**
 * s2c properties a baseline left as a bare open object `{}` that the
 * contract now spells out. Narrowing an s2c schema only adds promises to
 * clients (the server always sent this shape), so it cannot break one; it
 * is allowed only here, named, and only while the property stays an open
 * object.
 */
const S2C_REFINED = {
    's2c.recordsResponse|success.records': 'the documented allTime / thisYear / thisMonth periods (review fix: records content was never checked)',
};
/**
 * s2c payloads that were one object and are now named variants: the variant
 * named here must keep everything the old object promised (checked as if
 * it were the old payload), and the others are new forms. Allowed only
 * here, named, with the reason every frozen build still reads both. Today:
 *   gameLogEntry (2026-11-18, /help): the room line keeps its shape (seq
 *   required) and a 'private' form without seq is new, the unstored /help
 *   lines for sockets without the assist cap. Every shipped iOS build
 *   (b6 to b14, checked at each frozen commit) decodes
 *   WirePayload.GameLogEntry with `seq: Int?` and applies an event with no
 *   seq at once (TableReducer `guard let seq = ev.seq else { return apply }`),
 *   as the web SeqGate does (unsequenced events apply in arrival order); the
 *   decode floors below hold message / type.
 */
const S2C_SPLIT = {
    's2c.gameLogEntry': { keeps: 'room', why: 'private /help lines without seq (assistHandlers); shipped builds apply seq-less events' },
};

const isBareOpenObject = (s) => s && s.type === 'object' && s.additionalProperties === true &&
    Object.keys(s.properties || {}).length === 0 && !(s.required || []).length;

/** Keys compared recursively below; `description` is documentation (wireCompat pins meaning). */
const STRUCTURAL = new Set(['properties', 'required', 'patternProperties', 'items', 'anyOf', 'description']);
const show = (v) => JSON.stringify(v);

/**
 * Problems with `cur` keeping everything the schema node `base` promised:
 * every property (recursively), every required key, every variant, and
 * the same type / const / enum / bounds / additionalProperties / $ref.
 * New optional or required properties, new variants (by name) and new
 * $defs are fine.
 */
function schemaKeeps(base, cur, where, out) {
    if (deepEqual(base, cur)) return;
    const split = S2C_SPLIT[where];
    if (split && base && !base.anyOf && cur && cur.anyOf) {
        const kept = cur.anyOf.find((v) => v.variant === split.keeps);
        if (!kept) {
            out.push(`${where}: split, but the '${split.keeps}' variant is gone`);
            return;
        }
        const { variant, ...rest } = kept;
        schemaKeeps(base, rest, `${where}|${split.keeps}`, out);
        return;
    }
    if (cur === undefined) {
        out.push(`${where}: removed`);
        return;
    }
    if (!base || typeof base !== 'object' || !cur || typeof cur !== 'object' || base.$ref || cur.$ref) {
        out.push(`${where}: ${show(base)} became ${show(cur)}`);
        return;
    }
    for (const k of new Set([...Object.keys(base), ...Object.keys(cur)])) {
        if (!STRUCTURAL.has(k) && !deepEqual(base[k], cur[k])) out.push(`${where}: '${k}' changed from ${show(base[k])} to ${show(cur[k])}`);
    }
    for (const [k, ps] of Object.entries(base.properties || {})) {
        const c = cur.properties && cur.properties[k];
        if (c === undefined) out.push(`${where}.${k}: removed`);
        else if (S2C_REFINED[`${where}.${k}`] && isBareOpenObject(ps)) {
            if (!(c.type === 'object' && c.additionalProperties === true)) out.push(`${where}.${k}: refined, but no longer an open object`);
        } else schemaKeeps(ps, c, `${where}.${k}`, out);
    }
    for (const k of base.required || []) {
        if (!(cur.required || []).includes(k)) out.push(`${where}.${k}: no longer required`);
    }
    for (const [k, ps] of Object.entries(base.patternProperties || {})) {
        schemaKeeps(ps, (cur.patternProperties || {})[k], `${where}[${k}]`, out);
    }
    if (base.items !== undefined) schemaKeeps(base.items, cur.items, `${where}[]`, out);
    if (base.anyOf) {
        if (!cur.anyOf) {
            out.push(`${where}: variants are gone`);
        } else if (base.anyOf.some((v) => v.variant)) {
            for (const bv of base.anyOf) {
                const cv = cur.anyOf.find((v) => v.variant === bv.variant);
                if (!cv) out.push(`${where}|${bv.variant}: variant removed`);
                else schemaKeeps(bv, cv, `${where}|${bv.variant}`, out);
            }
        } else if (base.anyOf.length !== cur.anyOf.length) {
            out.push(`${where}: anyOf went from ${base.anyOf.length} to ${cur.anyOf.length} branches`);
        } else {
            base.anyOf.forEach((bv, i) => schemaKeeps(bv, cur.anyOf[i], `${where}|${i}`, out));
        }
    } else if (cur.anyOf) {
        out.push(`${where}: became an anyOf`);
    }
}

function payloadKeeps(base, cur, where, out) {
    if (base === null) {
        if (cur !== null) out.push(`${where}: had no payload, now has one`);
        return;
    }
    if (!cur) {
        out.push(`${where}: payload is gone`);
        return;
    }
    schemaKeeps(base, cur, where, out);
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

/** Problems with `cur` against one baseline's events, $defs and builtins. */
function baselineProblems(base, cur) {
    const problems = [];
    for (const dir of ['s2c', 'c2s']) {
        const other = dir === 's2c' ? 'c2s' : 's2c';
        for (const [name, be] of Object.entries(base[dir])) {
            const ce = cur[dir][name];
            if (!ce) {
                problems.push(`${dir}.${name}: removed${cur[other][name] ? ` (now ${other})` : ''}`);
                continue;
            }
            if (dir === 's2c') payloadKeeps(be.payload, ce.payload, `${dir}.${name}`, problems);
            else c2sKeeps(name, be, ce, problems);
            // (a c2s event the server already handles that a client now sends,
            // unsent -> active, is additive: a shipped build never sent it)
            const gainsSender = dir === 'c2s' && be.status === 'unsent' && ce.status === 'active';
            if (be.status !== ce.status && !(be.status === 'active' && ce.status === 'deprecated') && !gainsSender) {
                problems.push(`${dir}.${name}: status ${be.status} -> ${ce.status}`);
            }
        }
    }
    for (const [name, d] of Object.entries(base.$defs)) {
        if (!cur.$defs[name]) problems.push(`$defs.${name}: removed`);
        else schemaKeeps(d, cur.$defs[name], `$defs.${name}`, problems);
    }
    if (!deepEqual(base.builtins, cur.builtins)) problems.push('builtins changed');
    return problems;
}

test('the v1 baseline is the cc865b4 contract (frozen)', () => {
    expect(v1.title).toBe('BAB Online socket contract');
    // 80+ at cc865b4; the executed V1_REMOVALS entries hand-edit whole events out (#2, #4, #20, #3, #7)
    expect(Object.keys(v1.s2c).length).toBeGreaterThan(70);
    expect(v1.s2c.seq).toBeUndefined();
});

test('the floor build is frozen: some iOS build MIN_IOS_BUILD lets connect has a baseline and a decode floor', () => {
    // Raising MIN_IOS_BUILD retires every build below it; the build that
    // becomes the floor was frozen at its upload (README "Release step"), so a
    // raise with no frozen build at or above it would leave every iOS build
    // that can connect unguarded
    if (!BUILDS.some((b) => b.build >= MIN_IOS_BUILD)) {
        throw new Error(`No frozen baseline for an iOS build >= MIN_IOS_BUILD ${MIN_IOS_BUILD}: freeze the floor build first (npm run contract:baseline -- --build ${MIN_IOS_BUILD} --commit <sha>, contract/baselines/README.md "Release step")`);
    }
});

test('every frozen iOS build has a well-formed baseline and decode floor', () => {
    for (const f of fs.readdirSync(DIR)) {
        if (f === 'README.md') continue;
        expect(f).toMatch(FILE_RE);
        expect(fs.existsSync(path.join(DIR, f.replace(/\.(schema|decodes)\.json$/, '.schema.json')))).toBe(true);
    }
    for (const b of BUILDS) {
        expect(b.decodes).not.toBeNull();
        expect([b.decodes.build, b.decodes.version]).toEqual([b.build, b.version]);
        expect(b.decodes.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(b.schema.title).toBe('BAB Online socket contract');
        expect(Object.keys(b.decodes.events).length).toBeGreaterThan(20);
    }
});

test('a build MIN_IOS_BUILD gates is retired (its baseline would hold back removals for nobody)', () => {
    const gated = BUILDS.filter((b) => b.build < MIN_IOS_BUILD).map((b) => `${b.file} (build ${b.build} < MIN_IOS_BUILD ${MIN_IOS_BUILD})`);
    if (gated.length) throw new Error(`Retire (delete) the baselines of gated builds, contract/baselines/README.md:\n  ${gated.join('\n  ')}`);
});

test.each(BASELINES.map((b) => [b.label, b]))('everything %s promised is still there, with the same direction and payload', (_, b) => {
    fail(b, baselineProblems(b.schema, schema));
});

eachBuild('what %s decodes is still sent: required, non-null, the same JSON types', (_, b) => {
    fail(b, checkDecodes(b.decodes, schema, b.label, DECODE_WAIVED, reliedFor(b.build)));
});

test('every decode waiver still matches a mismatch on some frozen build (a stale one would hide a new hole)', () => {
    // some, not every: a later build that decodes it leniently needs no waiver, the older ones still do
    // (with no frozen build at all, 'the floor build is frozen' fails instead)
    if (!BUILDS.length) return;
    for (const where of Object.keys(DECODE_WAIVED)) {
        const needed = BUILDS.some((b) => checkDecodes(b.decodes, schema, b.label).some((p) => p.startsWith(`${b.label} decodes ${where} `)));
        if (!needed) throw new Error(`DECODE_WAIVED['${where}'] matches no frozen build's mismatch: delete it (contract/lib/decodeRules.js)`);
    }
});

test('every relied-on property is one its builds decode (optional), for a build still frozen', () => {
    for (const [where, r] of Object.entries(DECODE_RELIED)) {
        const held = BUILDS.filter((b) => r.builds.includes(b.build));
        if (!held.length) throw new Error(`DECODE_RELIED['${where}']: builds ${r.builds} are all retired; delete it (contract/lib/decodeRules.js)`);
        const [event, ...keys] = where.split('.');
        for (const b of held) {
            const roots = b.decodes.events[event];
            expect(roots).toBeDefined();
            // one level is all an entry needs today; a deeper path would need the walk checkDecodes does
            expect(keys).toHaveLength(1);
            for (const root of roots) {
                const f = b.decodes.types[root].fields[keys[0]];
                if (!f || !f.optional) throw new Error(`DECODE_RELIED['${where}']: ${b.label} ${root} has ${f ? 'it non-optional (the floor already holds it)' : 'no such property'}`);
            }
        }
    }
});

test('the c2s rule catches what would make the server refuse a shipped client', () => {
    const base = v1.c2s.playerBid;
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
    schemaKeeps(base, closed, 's2c.recordsResponse|success', out);
    schemaKeeps(base, closed, 's2c.other|success', out);
    expect(out).toEqual([
        's2c.recordsResponse|success.records: refined, but no longer an open object',
        "s2c.other|success.records: 'additionalProperties' changed from true to false",
    ]);
});

test('the s2c split exception is narrow: only named payloads, and the named variant must keep the old shape', () => {
    const base = { type: 'object', properties: { message: { type: 'string' }, seq: { $ref: '#/$defs/seq' } }, required: ['message', 'seq'], additionalProperties: false };
    const room = { variant: 'room', ...base };
    const priv = { variant: 'private', type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false };
    const run = (where, cur) => { const out = []; schemaKeeps(base, cur, where, out); return out; };
    expect(run('s2c.gameLogEntry', { anyOf: [room, priv] })).toEqual([]);
    // another event may not do the same
    expect(run('s2c.other', { anyOf: [room, priv] })).toContain('s2c.other: became an anyOf');
    // the named variant must exist and keep everything (seq still required)
    expect(run('s2c.gameLogEntry', { anyOf: [priv] })).toEqual(["s2c.gameLogEntry: split, but the 'room' variant is gone"]);
    const loose = { ...room, required: ['message'] };
    expect(run('s2c.gameLogEntry', { anyOf: [loose, priv] })).toEqual(['s2c.gameLogEntry|room.seq: no longer required']);
});

// On the oldest frozen build (iOS 1.2.0 (6) until MIN_IOS_BUILD 41 retired it)
(BUILDS.length ? describe : describe.skip)('fault injection: what the per-build guards catch', () => {
    const oldest = BUILDS[0];
    const L = oldest ? esc(oldest.label) : '';
    const mutate = (fn) => {
        const s = JSON.parse(JSON.stringify(schema));
        fn(s);
        return s;
    };
    const both = (s) => [...baselineProblems(oldest.schema, s), ...checkDecodes(oldest.decodes, s, oldest.label, DECODE_WAIVED, reliedFor(oldest.build))];

    test('dropping snapshot trickHistory breaks the oldest frozen build in both guards', () => {
        const s = mutate((x) => {
            delete x.$defs.snapshotV2.properties.trickHistory;
            x.$defs.snapshotV2.required = x.$defs.snapshotV2.required.filter((k) => k !== 'trickHistory');
        });
        expect(baselineProblems(oldest.schema, s)).toContain('$defs.snapshotV2.trickHistory: removed');
        expect(checkDecodes(oldest.decodes, s, oldest.label)).toEqual(expect.arrayContaining([
            expect.stringMatching(new RegExp(`^${L} decodes rejoinSuccess\\.snapshot\\.trickHistory .*gone from the schema`)),
        ]));
    });

    test('making watching optional, or tricksByPosition nullable, is caught', () => {
        const opt = mutate((x) => { x.$defs.snapshotV2.required = x.$defs.snapshotV2.required.filter((k) => k !== 'watching'); });
        expect(both(opt)).toEqual(expect.arrayContaining(['$defs.snapshotV2.watching: no longer required',
            expect.stringMatching(/decodes stateSnapshot\.snapshot\.watching .*no longer required/)]));
        const nul = mutate((x) => { x.$defs.snapshotV2.properties.tricksByPosition = { anyOf: [x.$defs.snapshotV2.properties.tricksByPosition, { type: 'null' }] }; });
        expect(both(nul)).toEqual(expect.arrayContaining([expect.stringMatching(/decodes restorePlayerState\.snapshot\.tricksByPosition .*may be null/)]));
    });

    test('a hand-written payload field (cardPlayed.card) and a nested one (seat isBot) are held too', () => {
        const s = mutate((x) => {
            x.s2c.cardPlayed.payload.required = x.s2c.cardPlayed.payload.required.filter((k) => k !== 'card');
            x.$defs.seatV2.properties.isBot = { type: 'integer' };
        });
        const out = checkDecodes(oldest.decodes, s, oldest.label);
        expect(out).toEqual(expect.arrayContaining([
            expect.stringMatching(/decodes cardPlayed\.card \(WirePayload\.CardPlayed\): no longer required/),
            expect.stringMatching(/decodes rejoinSuccess\.snapshot\.seats\[\]\.isBot .*it is integer, Swift wants Bool/),
        ]));
    });

    test('a new card rank would throw in Card(from:) on the shipped builds', () => {
        const s = mutate((x) => { x.$defs.card.properties.rank.enum.push('XX'); });
        expect(checkDecodes(oldest.decodes, s, oldest.label)).toEqual(expect.arrayContaining([expect.stringMatching(/"XX"\] would throw \(Rank decodes only/)]));
    });

    test('a c2s event a client starts sending (unsent -> active) passes; the way back, or an s2c one, is caught', () => {
        const base = JSON.parse(JSON.stringify(schema));
        base.c2s.watchHand.status = 'unsent';
        const cur = JSON.parse(JSON.stringify(schema));
        cur.c2s.watchHand.status = 'active';
        expect(baselineProblems(base, cur)).toEqual([]);
        expect(baselineProblems(cur, base)).toEqual(['c2s.watchHand: status active -> unsent']);
        const s2cBase = JSON.parse(JSON.stringify(schema));
        s2cBase.s2c.watchHandRefused.status = 'unsent';
        expect(baselineProblems(s2cBase, schema)).toEqual(['s2c.watchHandRefused: status unsent -> active']);
    });

    test('new optional properties, new required ones and new events pass', () => {
        const s = mutate((x) => {
            x.$defs.snapshotV2.properties.newThing = { type: 'string' };
            x.$defs.seatV2.properties.newSeatFlag = { type: 'boolean' };
            x.$defs.seatV2.required.push('newSeatFlag');
            x.s2c.cardPlayed.payload.properties.extra = { type: 'integer' };
            x.s2c.brandNewEvent = { payload: null, status: 'active' };
        });
        expect(both(s)).toEqual([]);
    });
});

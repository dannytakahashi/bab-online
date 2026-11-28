#!/usr/bin/env node
/**
 * Freeze what a submitted iOS build relies on (dev only; needs git history,
 * so never run from a test: CI checks out one commit).
 *
 *   npm run contract:baseline -- --build 10 [--commit <sha>]
 *       freeze build 10 from <sha> (default HEAD): the commit whose
 *       project.pbxproj has CURRENT_PROJECT_VERSION 10, i.e. the source the
 *       build was archived from
 *   npm run contract:baseline -- --check
 *       re-derive every frozen build from its commit: the decode floor must
 *       match exactly; the schema's hand edits (executed removals) are listed
 *
 * Writes contract/baselines/ios-<version>-b<build>.schema.json (that
 * commit's contract built from its contract/src, exactly what
 * `npm run contract:gen` wrote then) and ios-<version>-b<build>.decodes.json
 * (what that commit's Swift decodes, contract/lib/swiftDecodes.js).
 * additiveOnly.test.js holds the contract to both. contract/baselines/README.md
 * has the rules (when to edit, when to retire).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractDecodes, checkDecodes } = require('./lib/swiftDecodes');
const { deepEqual } = require('./lib/validate');
const { DECODE_WAIVED } = require('./lib/decodeRules');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(__dirname, 'baselines');

/** The iOS files the table store decodes with: ServerEvent.decode and every type it reaches. */
const DECODE_SOURCES = [
    'iOSClient/BABOnline/Networking/Wire/ServerEvent.swift',
    'iOSClient/BABOnline/Networking/Wire/WirePayloads.swift',
    'iOSClient/BABOnline/Networking/Wire/WireDecoding.swift',
    'iOSClient/BABOnline/Generated/TableSnapshot.swift',
    'iOSClient/BABOnline/Models/Card.swift',
    // from 1.2.7 (41): Get Your Bid's wire types (GybStart and friends), reached from WirePayloads
    'iOSClient/BABOnline/State/Table/GetYourBid.swift',
    // from 1.2.8 (52): the scorecard's handComplete row (LenientScorecardRow, ScorecardRow)
    'iOSClient/BABOnline/State/Table/Scorecard.swift',
];
/**
 * Sources added after the first frozen build: file -> the first build that reads it. An older
 * build's floor never read the file (its frozen `sources` lists only the others), so it is
 * skipped there; from that build on it is required like every other source.
 */
const SOURCES_FROM = {
    'iOSClient/BABOnline/State/Table/GetYourBid.swift': 41,
    'iOSClient/BABOnline/State/Table/Scorecard.swift': 52,
};

const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 28 });
const show = (sha, file) => git('show', `${sha}:${file}`).toString('utf8');

/** {version, build} from that commit's project (every configuration must agree). */
function projectVersion(sha) {
    const pbx = show(sha, 'iOSClient/BABOnline.xcodeproj/project.pbxproj');
    const all = (key) => [...new Set([...pbx.matchAll(new RegExp(`${key} = ([^;]+);`, 'g'))].map((m) => m[1].trim()))];
    const builds = all('CURRENT_PROJECT_VERSION');
    const versions = all('MARKETING_VERSION');
    if (builds.length !== 1 || versions.length !== 1) throw new Error(`${sha}: the configurations disagree (builds ${builds}, versions ${versions})`);
    return { build: Number(builds[0]), version: versions[0] };
}

/** That commit's contract, built from its own contract/src (as contract:gen did then). */
function schemaAt(sha) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bab-baseline-'));
    try {
        execFileSync('tar', ['-x', '-C', tmp], { input: git('archive', '--format=tar', sha, 'contract', 'server') });
        const src = path.join(tmp, 'contract', 'src');
        const out = execFileSync(process.execPath, ['-e',
            `process.stdout.write(JSON.stringify(require(${JSON.stringify(src)}).buildSchema(), null, 2) + '\\n')`], { maxBuffer: 1 << 28 }).toString('utf8');
        if (out !== show(sha, 'contract/events.schema.json')) {
            throw new Error(`${sha}: contract/src does not build that commit's events.schema.json (stale generated file there); pick a commit where contract:check passed`);
        }
        return out;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function decodesAt(sha, version, build) {
    const sources = DECODE_SOURCES.filter((f) => !(build < (SOURCES_FROM[f] || 0)));
    const files = {};
    for (const f of sources) files[f] = show(sha, f);
    return { build, version, commit: sha, sources, ...extractDecodes(files) };
}

const fileBase = (version, build) => `ios-${version}-b${build}`;

function frozen() {
    if (!fs.existsSync(DIR)) return [];
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.decodes.json')).map((f) => {
        const decodes = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
        return { base: f.replace(/\.decodes\.json$/, ''), decodes };
    });
}

/** Top-level paths (s2c.x, c2s.x, $defs.x, builtins) where two schemas differ. */
function differingPaths(a, b) {
    const out = [];
    for (const sec of ['s2c', 'c2s', '$defs']) {
        for (const k of new Set([...Object.keys(a[sec] || {}), ...Object.keys(b[sec] || {})])) {
            if (!deepEqual((a[sec] || {})[k], (b[sec] || {})[k])) out.push(`${sec}.${k}`);
        }
    }
    if (!deepEqual(a.builtins, b.builtins)) out.push('builtins');
    return out;
}

function freeze(build, commit) {
    const sha = git('rev-parse', '--verify', `${commit}^{commit}`).toString().trim();
    const v = projectVersion(sha);
    if (v.build !== build) throw new Error(`${sha.slice(0, 7)} is build ${v.build} (${v.version}), not ${build}: pass --commit with the commit build ${build} was archived from`);
    const base = fileBase(v.version, build);
    for (const ext of ['.schema.json', '.decodes.json']) {
        if (fs.existsSync(path.join(DIR, base + ext))) throw new Error(`contract/baselines/${base}${ext} exists: a frozen baseline is never regenerated (README)`);
    }
    const schemaText = schemaAt(sha);
    const decodes = decodesAt(sha, v.version, build);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, `${base}.schema.json`), schemaText);
    fs.writeFileSync(path.join(DIR, `${base}.decodes.json`), JSON.stringify(decodes, null, 2) + '\n');
    console.log(`froze iOS ${v.version} (${build}) from ${sha.slice(0, 7)}: contract/baselines/${base}.schema.json, ${base}.decodes.json`);
    const current = require('.').schema;
    const label = `iOS ${v.version} (${build})`;
    const problems = checkDecodes(decodes, current, label, DECODE_WAIVED);
    const waived = checkDecodes(decodes, current, label).filter((p) => !problems.includes(p));
    const changed = differingPaths(JSON.parse(schemaText), current);
    if (problems.length) console.log(`today's schema fails its decode floor:\n  ${problems.join('\n  ')}`);
    // listed apart so a real failure is never lost among them; check each reason still holds for this build
    if (waived.length) console.log(`waived (contract/lib/decodeRules.js DECODE_WAIVED, check the reason holds for build ${build}):\n  ${waived.join('\n  ')}`);
    if (changed.length) console.log(`today's schema differs from it at (additiveOnly.test.js decides which are removals):\n  ${changed.join('\n  ')}`);
    console.log('Add the build to contract/baselines/README.md, then run npx jest contract/__tests__/additiveOnly.test.js');
}

function check() {
    let bad = 0;
    for (const { base, decodes } of frozen()) {
        const again = decodesAt(decodes.commit, decodes.version, decodes.build);
        if (!deepEqual(again, decodes)) {
            bad++;
            console.error(`${base}.decodes.json does not match ${decodes.commit.slice(0, 7)}'s Swift (never hand-edit a decode floor)`);
        } else {
            console.log(`${base}.decodes.json: matches ${decodes.commit.slice(0, 7)}`);
        }
        const schema = JSON.parse(fs.readFileSync(path.join(DIR, `${base}.schema.json`), 'utf8'));
        const edits = differingPaths(JSON.parse(schemaAt(decodes.commit)), schema);
        console.log(`${base}.schema.json: ${edits.length ? `hand-edited at ${edits.join(', ')}` : `exactly ${decodes.commit.slice(0, 7)}'s contract`}`);
    }
    return bad;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const opt = (name) => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : undefined;
    };
    try {
        if (args.includes('--check')) {
            process.exit(check() ? 1 : 0);
        }
        const build = Number(opt('--build'));
        if (!Number.isInteger(build) || build < 1) throw new Error('usage: npm run contract:baseline -- --build <n> [--commit <sha>] | --check');
        freeze(build, opt('--commit') || 'HEAD');
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = { DECODE_SOURCES, SOURCES_FROM, differingPaths, fileBase };

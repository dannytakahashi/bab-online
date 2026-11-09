#!/usr/bin/env node
/**
 * Contract generator (dev only).
 *
 *   node contract/gen.js                 write the generated files
 *   node contract/gen.js --check         exit 1 if any generated file is stale
 *   node contract/gen.js --seed-layout   (one-off) rebuild contract/layout.json
 *                                        from today's constants files
 *
 * Generated files (npm run contract:gen / contract:check):
 *   contract/events.schema.json                    from contract/src
 *   client/src/constants/events.js                 from layout.json (web)
 *   iOSClient/BABOnline/Constants/SocketEvents.swift  from layout.json (swift)
 *   iOSClient/BABOnline/Generated/TableSnapshot.swift Swift Codable of $defs.snapshotV2
 *                                                   + ContractSeq (contract/swift/snapshotSwift.js)
 *
 * layout.json fixes which events each platform lists, in which section and
 * order, so existing names and values never move (the shipped iOS app was
 * built from the Swift file). Every layout name must exist in the schema;
 * every active event must be listed per platform or excluded with a reason;
 * deprecated / unsent / clientOnly events are never added (the ones already
 * listed at cc865b4 stay).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { buildSchema } = require('./src');
const { SEQ_EVENTS } = require('./src/s2c');
const { renderSwiftSnapshot } = require('./swift/snapshotSwift');

const ROOT = path.join(__dirname, '..');
const LAYOUT = path.join(__dirname, 'layout.json');
const WEB = 'client/src/constants/events.js';
const SWIFT = 'iOSClient/BABOnline/Constants/SocketEvents.swift';
const SWIFT_SNAPSHOT = 'iOSClient/BABOnline/Generated/TableSnapshot.swift';

const SWIFT_KEYWORDS = new Set(['associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import',
    'init', 'inout', 'internal', 'let', 'open', 'operator', 'private', 'protocol', 'public', 'rethrows', 'static', 'struct',
    'subscript', 'typealias', 'var', 'break', 'case', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough', 'for',
    'guard', 'if', 'in', 'repeat', 'return', 'switch', 'where', 'while', 'as', 'Any', 'catch', 'false', 'is', 'nil', 'super',
    'self', 'Self', 'throw', 'throws', 'true', 'try', 'Type', 'Protocol']);

const defaultKey = (value) => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

// ---------- rendering ----------

function renderWebObject(name, sections, overrides) {
    const lines = [`export const ${name} = {`];
    sections.forEach((sec, i) => {
        if (i > 0) lines.push('');
        lines.push(`  // ${sec.section}`);
        for (const ev of sec.events) lines.push(`  ${overrides[ev] || defaultKey(ev)}: '${ev}',`);
    });
    lines.push('};');
    return lines;
}

function renderWeb(layout) {
    const w = layout.web;
    return [
        ...w.header,
        '',
        '// Client -> Server Events',
        ...renderWebObject('CLIENT_EVENTS', w.CLIENT_EVENTS, w.keyOverrides || {}),
        '',
        '// Server -> Client Events',
        ...renderWebObject('SERVER_EVENTS', w.SERVER_EVENTS, w.keyOverrides || {}),
    ].join('\n') + '\n';
}

function renderSwiftEnum(name, sections) {
    const lines = [`    enum ${name} {`];
    sections.forEach((sec, i) => {
        if (i > 0) lines.push('');
        lines.push(`        // ${sec.section}`);
        for (const ev of sec.events) {
            if (!/^[a-z][A-Za-z0-9]*$/.test(ev) || SWIFT_KEYWORDS.has(ev)) throw new Error(`gen: '${ev}' is not a valid Swift identifier`);
            lines.push(`        static let ${ev} = "${ev}"`);
        }
    });
    lines.push('    }');
    return lines;
}

function renderSwift(layout) {
    const s = layout.swift;
    return [
        'import Foundation',
        '',
        ...s.header,
        'enum SocketEvents {',
        '    // MARK: - Client → Server',
        '',
        ...renderSwiftEnum('Client', s.Client),
        '',
        '    // MARK: - Server → Client',
        '',
        ...renderSwiftEnum('Server', s.Server),
        '}',
    ].join('\n') + '\n';
}

// ---------- membership ----------

/** Problems with the layout against the schema (empty = ok). */
function checkLayout(layout, schema, legacy = null) {
    const problems = [];
    const builtins = new Set([...schema.builtins.c2s, ...schema.builtins.s2c]);
    const groups = {
        web: { c2s: layout.web.CLIENT_EVENTS, s2c: layout.web.SERVER_EVENTS },
        swift: { c2s: layout.swift.Client, s2c: layout.swift.Server },
    };
    for (const [platform, dirs] of Object.entries(groups)) {
        const exclude = (layout.exclude && layout.exclude[platform]) || {};
        for (const [dir, sections] of Object.entries(dirs)) {
            const listed = new Set();
            for (const sec of sections) {
                for (const ev of sec.events) {
                    if (listed.has(ev)) problems.push(`${platform} ${dir}: '${ev}' listed twice`);
                    listed.add(ev);
                    const entry = schema[dir][ev];
                    if (!entry && !(dir === 's2c' && builtins.has(ev)) && !(dir === 'c2s' && schema.builtins.c2s.includes(ev))) {
                        problems.push(`${platform} ${dir}: '${ev}' is not a ${dir} event in the schema`);
                        continue;
                    }
                    if (entry && entry.status !== 'active' && legacy && !legacy[platform].includes(`${dir}:${ev}`)) {
                        problems.push(`${platform} ${dir}: '${ev}' is ${entry.status}; only constants that existed at cc865b4 may stay`);
                    }
                    if (exclude[ev]) problems.push(`${platform}: '${ev}' is both listed and excluded`);
                }
            }
            for (const [ev, entry] of Object.entries(schema[dir])) {
                if (entry.status !== 'active' || listed.has(ev)) continue;
                if (!exclude[ev]) problems.push(`${platform} ${dir}: active event '${ev}' is neither listed nor excluded (with a reason) in contract/layout.json`);
            }
        }
        for (const [ev, why] of Object.entries(exclude)) {
            if (typeof why !== 'string' || !why.trim()) problems.push(`${platform}: exclude '${ev}' needs a reason`);
        }
    }
    return problems;
}

/** {platform: ['dir:event', ...]} parsed from the cc865b4 golden. */
function legacyNames() {
    const golden = require('./__tests__/legacyConstants.golden.json');
    return {
        web: [...golden.web.CLIENT_EVENTS.map(([, v]) => `c2s:${v}`), ...golden.web.SERVER_EVENTS.map(([, v]) => `s2c:${v}`)],
        swift: [...golden.swift.Client.map(([n]) => `c2s:${n}`), ...golden.swift.Server.map(([n]) => `s2c:${n}`)],
    };
}

// ---------- outputs ----------

function outputs() {
    const schema = buildSchema();
    const layout = JSON.parse(fs.readFileSync(LAYOUT, 'utf8'));
    const problems = checkLayout(layout, schema, legacyNames());
    if (problems.length) throw new Error(`contract/layout.json:\n  ${problems.join('\n  ')}`);
    return {
        'contract/events.schema.json': JSON.stringify(schema, null, 2) + '\n',
        [WEB]: renderWeb(layout),
        [SWIFT]: renderSwift(layout),
        [SWIFT_SNAPSHOT]: renderSwiftSnapshot(schema, SEQ_EVENTS),
    };
}

function check() {
    const stale = [];
    for (const [rel, content] of Object.entries(outputs())) {
        const p = path.join(ROOT, rel);
        const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
        if (current !== content) stale.push(rel);
    }
    return stale;
}

function write() {
    for (const [rel, content] of Object.entries(outputs())) {
        fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
        fs.writeFileSync(path.join(ROOT, rel), content);
        console.log(`wrote ${rel}`);
    }
}

// ---------- one-off: seed layout.json from today's files ----------

function parseSections(lines, memberRe) {
    const sections = [];
    for (const line of lines) {
        const sec = /^\s*\/\/ (.+)$/.exec(line);
        if (sec) {
            sections.push({ section: sec[1], events: [] });
            continue;
        }
        const m = memberRe.exec(line);
        if (m) sections[sections.length - 1].events.push(m);
    }
    return sections;
}

function seedLayout() {
    const web = fs.readFileSync(path.join(ROOT, WEB), 'utf8').split('\n');
    const swift = fs.readFileSync(path.join(ROOT, SWIFT), 'utf8').split('\n');
    const slice = (lines, startRe, end = /^\s*\}/) => {
        const i = lines.findIndex((l) => startRe.test(l));
        const j = lines.findIndex((l, k) => k > i && end.test(l));
        return lines.slice(i + 1, j);
    };
    const keyOverrides = {};
    const webSections = (lines) => parseSections(lines, /^\s*([A-Z_]+): '([^']+)',$/).map((s) => ({
        section: s.section,
        events: s.events.map((m) => {
            if (m[1] !== defaultKey(m[2])) keyOverrides[m[2]] = m[1];
            return m[2];
        }),
    }));
    const swiftSections = (lines) => parseSections(lines, /static let (\w+) = "([^"]+)"/)
        .filter((s) => !s.section.startsWith('MARK'))
        .map((s) => ({
            section: s.section,
            events: s.events.map((m) => {
                if (m[1] !== m[2]) throw new Error(`seed: Swift constant ${m[1]} != "${m[2]}"`);
                return m[2];
            }),
        }));
    const headerEnd = web.findIndex((l) => l.trim() === '*/');
    const layout = {
        web: {
            header: web.slice(0, headerEnd + 1),
            CLIENT_EVENTS: webSections(slice(web, /^export const CLIENT_EVENTS/, /^\};/)),
            SERVER_EVENTS: webSections(slice(web, /^export const SERVER_EVENTS/, /^\};/)),
            keyOverrides,
        },
        swift: {
            header: swift.filter((l) => l.startsWith('///')),
            Client: swiftSections(slice(swift, /^\s*enum Client \{/)),
            Server: swiftSections(slice(swift, /^\s*enum Server \{/)),
        },
        exclude: { web: {}, swift: {} },
    };
    fs.writeFileSync(LAYOUT, JSON.stringify(layout, null, 2) + '\n');
    console.log('wrote contract/layout.json (add exclude reasons next)');
}

if (require.main === module) {
    const args = process.argv.slice(2);
    try {
        if (args.includes('--seed-layout')) {
            seedLayout();
        } else if (args.includes('--check')) {
            const stale = check();
            if (stale.length) {
                console.error(`Stale generated files (run npm run contract:gen):\n  ${stale.join('\n  ')}`);
                process.exit(1);
            }
            console.log('contract: generated files are up to date');
        } else {
            write();
        }
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = { outputs, check, write, checkLayout, renderWeb, renderSwift, defaultKey };

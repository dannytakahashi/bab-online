#!/usr/bin/env node
/**
 * The Apple app's platform rule (iOSClient/CLAUDE.md, "iOS project": the platform rules):
 * no UIKit or AppKit in a shared Swift file. Every .swift file under iOSClient/BABOnline
 * compiles for iOS and, with the macOS platform, for macOS, so:
 *
 * - `import UIKit` and `UIApplication` only in a file whose first code line is `#if os(iOS)`
 *   (a whole-file iOS file, e.g. `Foo+iOS.swift`), or under `Platform/`;
 * - `import AppKit`, `NSApp` and `NSApplication` only in a file whose first code line is `#if os(macOS)`, or
 *   under `Platform/`.
 *
 * Comments and string literals are not read. Run by CI (ci.yml) on Ubuntu, so the rule holds
 * before any macOS build runs.
 *
 *   node scripts/check-apple-platform.js    exit 1 and list every offending line
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'iOSClient', 'BABOnline');

/** What may appear only in a file of one platform: the pattern and the platform. */
const RULES = [
    { what: 'import UIKit', re: /^\s*(@\w+\s+)*import\s+((class|struct|enum|protocol|typealias|func|var|let)\s+)?UIKit\b/, os: 'iOS' },
    { what: 'UIApplication', re: /\bUIApplication\b/, os: 'iOS' },
    { what: 'import AppKit', re: /^\s*(@\w+\s+)*import\s+((class|struct|enum|protocol|typealias|func|var|let)\s+)?AppKit\b/, os: 'macOS' },
    { what: 'NSApp', re: /\bNSApp\b/, os: 'macOS' },
    { what: 'NSApplication', re: /\bNSApplication\b/, os: 'macOS' },
];

/**
 * `source` with comments and string literals blanked (line breaks kept, so line numbers
 * hold). Handles `//`, nested block comments, "..." with escapes and """ multi-line strings.
 */
function stripCommentsAndStrings(source) {
    let out = '';
    let i = 0;
    let depth = 0; // block comment nesting
    let inString = null; // '"' or '"""'
    const n = source.length;
    while (i < n) {
        const c = source[i];
        const next = source.slice(i, i + 3);
        if (depth > 0) {
            if (source.startsWith('/*', i)) { depth += 1; i += 2; continue; }
            if (source.startsWith('*/', i)) { depth -= 1; i += 2; continue; }
            out += c === '\n' ? '\n' : ' ';
            i += 1;
            continue;
        }
        if (inString) {
            if (c === '\\') { out += '  '; i += 2; continue; }
            if (inString === '"""' && next === '"""') { inString = null; out += '   '; i += 3; continue; }
            if (inString === '"' && (c === '"' || c === '\n')) { inString = null; out += c === '\n' ? '\n' : ' '; i += 1; continue; }
            out += c === '\n' ? '\n' : ' ';
            i += 1;
            continue;
        }
        if (source.startsWith('//', i)) {
            while (i < n && source[i] !== '\n') { out += ' '; i += 1; }
            continue;
        }
        if (source.startsWith('/*', i)) { depth = 1; i += 2; out += '  '; continue; }
        if (next === '"""') { inString = '"""'; out += '   '; i += 3; continue; }
        if (c === '"') { inString = '"'; out += ' '; i += 1; continue; }
        out += c;
        i += 1;
    }
    return out;
}

/** The platform a whole file is for (its first code line `#if os(iOS)` / `#if os(macOS)`), or null. */
function filePlatform(code) {
    const first = code.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
    const m = first && first.match(/^#if\s+os\((iOS|macOS)\)\s*$/);
    return m ? m[1] : null;
}

/** The offending lines of one file: [{ line, what, os }]. `rel` is the path under the app folder. */
function checkSource(rel, source) {
    if (rel.split(/[\\/]/)[0] === 'Platform') return [];
    const code = stripCommentsAndStrings(source);
    const platform = filePlatform(code);
    const problems = [];
    code.split('\n').forEach((text, index) => {
        for (const rule of RULES) {
            if (rule.re.test(text) && platform !== rule.os) {
                problems.push({ line: index + 1, what: rule.what, os: rule.os });
            }
        }
    });
    return problems;
}

function swiftFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return swiftFiles(p);
        return e.name.endsWith('.swift') ? [p] : [];
    });
}

/** Every offending line under `appDir`: [{ file, line, what, os }]. */
function checkApp(appDir = APP) {
    return swiftFiles(appDir).sort().flatMap((file) => {
        const rel = path.relative(appDir, file);
        return checkSource(rel, fs.readFileSync(file, 'utf8')).map((p) => ({ file: rel, ...p }));
    });
}

if (require.main === module) {
    const problems = checkApp();
    if (problems.length) {
        for (const p of problems) {
            console.error(`iOSClient/BABOnline/${p.file}:${p.line}: ${p.what} outside a whole-file #if os(${p.os}) file or Platform/`);
        }
        console.error(`\n${problems.length} platform rule violation(s): see iOSClient/CLAUDE.md, "iOS project" (the platform rules).`);
        process.exit(1);
    }
    console.log('Apple platform rule: ok');
}

module.exports = { checkSource, checkApp, stripCommentsAndStrings, filePlatform };

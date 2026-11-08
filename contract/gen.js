#!/usr/bin/env node
/**
 * Contract generator (dev only).
 *
 *   node contract/gen.js            write contract/events.schema.json
 *   node contract/gen.js --check    exit 1 if a generated file is stale
 *
 * npm run contract:gen / contract:check.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { buildSchema } = require('./src');

const ROOT = path.join(__dirname, '..');

/** {relativePath: expected file content} for every generated file. */
function outputs() {
    return {
        'contract/events.schema.json': JSON.stringify(buildSchema(), null, 2) + '\n',
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
        fs.writeFileSync(path.join(ROOT, rel), content);
        console.log(`wrote ${rel}`);
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.includes('--check')) {
        const stale = check();
        if (stale.length) {
            console.error(`Stale generated files (run npm run contract:gen):\n  ${stale.join('\n  ')}`);
            process.exit(1);
        }
        console.log('contract: generated files are up to date');
    } else {
        write();
    }
}

module.exports = { outputs, check, write };

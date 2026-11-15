/**
 * One Node major everywhere. Railway's Nixpacks takes it from package.json
 * engines (before .nvmrc); CI and Dockerfile.local must test that same
 * major, or they drift the way they once did (CI on 18, production on 24).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// "24.x" pins one major; a range like ">=24" lets Nixpacks pick a newer one
const engines = require(path.join(ROOT, 'package.json')).engines.node;
const MAJOR = (engines.match(/^(\d+)\.x$/) || [])[1];

test('engines pins exactly one Node major', () => {
    expect(engines).toMatch(/^\d+\.x$/);
});

test('.nvmrc names the engines major', () => {
    expect(read('.nvmrc').trim()).toBe(MAJOR);
});

test('CI setup-node uses the engines major', () => {
    const versions = [...read('.github/workflows/ci.yml').matchAll(/node-version:\s*['"]?([^'"\s]+)/g)].map(m => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions).toEqual(versions.map(() => MAJOR));
});

test('every Dockerfile.local stage uses the engines major', () => {
    const froms = [...read('Dockerfile.local').matchAll(/^FROM\s+(\S+)/gm)].map(m => m[1]);
    expect(froms).toHaveLength(2);
    expect(froms).toEqual(froms.map(() => `node:${MAJOR}-alpine`));
});

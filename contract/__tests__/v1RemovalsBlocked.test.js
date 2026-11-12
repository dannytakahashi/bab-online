/**
 * V1_REMOVALS.md "Still blocked (by what a shipped client reads)" is what
 * whoever schedules a removal reads first. A bullet that names a web file
 * as a reader of the key must stay true: either the file still reads that
 * key, or the bullet says since when web no longer needs it ("(... since
 * YYYY-MM-DD ...)"). A stale "web `main.js` reads it" holds a removal back
 * or sends someone looking for a web change that is not needed.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DOC = fs.readFileSync(path.join(ROOT, 'contract', 'V1_REMOVALS.md'), 'utf8');
const CLIENT_SRC = path.join(ROOT, 'client', 'src');

function stillBlockedBullets(doc) {
    const start = doc.indexOf('**Still blocked (by what a shipped client reads):**');
    if (start < 0) return null;
    const rest = doc.slice(start);
    const end = rest.search(/\n(Next client work|## )/);
    const section = end < 0 ? rest : rest.slice(0, end);
    return section.split(/\n(?=- \*\*#)/).slice(1).map((b) => b.replace(/\s+/g, ' ').trim());
}

function findClientFile(name) {
    const direct = path.join(CLIENT_SRC, name);
    if (fs.existsSync(direct)) return direct;
    const hits = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (p.endsWith(path.sep + name) || p.endsWith('/' + name)) hits.push(p);
        }
    };
    walk(CLIENT_SRC);
    return hits.length === 1 ? hits[0] : null;
}

/** Source without comments, so a note about a removed read is not a read. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('V1_REMOVALS "Still blocked" web readers', () => {
    const bullets = stillBlockedBullets(DOC);

    test('the list is found and parsed', () => {
        expect(bullets).not.toBeNull();
        expect(bullets.length).toBeGreaterThanOrEqual(5);
    });

    test('a cited web file still reads the key, or the bullet says since when it does not', () => {
        const stale = [];
        for (const b of bullets) {
            const title = b.match(/^- \*\*(#\S+)\s+`([^`]+)`/);
            if (!title) continue;
            const [, id, key] = title;
            const field = key.split('.').pop();
            const annotated = /\([^)]*since \d{4}-\d{2}-\d{2}/.test(b);
            for (const [, file] of b.matchAll(/\bweb `([\w./-]+\.js)`/g)) {
                if (annotated) continue;
                const p = findClientFile(file);
                const reads = p && new RegExp(`\\b${field}\\b`).test(stripComments(fs.readFileSync(p, 'utf8')));
                if (!reads) stale.push(`${id} names web \`${file}\` as a reader of ${key}, but ${p ? 'it has no read of' : 'no such client file reads'} '${field}' and the bullet has no "(... since <date> ...)" note`);
            }
        }
        expect(stale).toEqual([]);
    });
});

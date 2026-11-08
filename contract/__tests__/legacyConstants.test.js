/**
 * Every event constant that existed at cc865b4 (legacyConstants.golden.json,
 * captured from client/src/constants/events.js and SocketEvents.swift) is
 * still there with the same key and value: the shipped iOS app and the web
 * client were compiled against these names.
 */

const fs = require('fs');
const path = require('path');
const golden = require('./legacyConstants.golden.json');

const ROOT = path.join(__dirname, '..', '..');
const web = fs.readFileSync(path.join(ROOT, 'client/src/constants/events.js'), 'utf8');
const swift = fs.readFileSync(path.join(ROOT, 'iOSClient/BABOnline/Constants/SocketEvents.swift'), 'utf8');

const block = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

test.each([
    ['CLIENT_EVENTS', golden.web.CLIENT_EVENTS],
    ['SERVER_EVENTS', golden.web.SERVER_EVENTS],
])('web %s keeps every cc865b4 constant', (name, pairs) => {
    const body = block(web, `export const ${name}`, '};');
    const missing = pairs.filter(([k, v]) => !body.includes(`\n  ${k}: '${v}',\n`));
    expect(missing).toEqual([]);
    expect(pairs.length).toBeGreaterThan(40);
});

test.each([
    ['Client', golden.swift.Client],
    ['Server', golden.swift.Server],
])('Swift SocketEvents.%s keeps every cc865b4 constant', (name, pairs) => {
    const body = block(swift, `enum ${name} {`, '\n    }');
    const missing = pairs.filter(([n, v]) => !body.includes(`static let ${n} = "${v}"`));
    expect(missing).toEqual([]);
    expect(pairs.length).toBeGreaterThan(39);
});

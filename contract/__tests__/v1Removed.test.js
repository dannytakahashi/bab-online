/**
 * Executed contract/V1_REMOVALS.md entries that take whole events out of the
 * contract: gone from the generated schema and the frozen baseline, from the
 * generated web and Swift constants, from every server source file and from
 * the iOS app source (the next build; 1.2.0 still registers them, harmless
 * once nothing sends them). The neighbours that stay are pinned beside them.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const schema = JSON.parse(read('contract/events.schema.json'));
const baseline = JSON.parse(read('contract/v1-baseline.schema.json'));
const web = read('client/src/constants/events.js');
const swift = read('iOSClient/BABOnline/Constants/SocketEvents.swift');

function sources(rel, ext) {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(p); } else if (p.endsWith(ext)) out.push([path.relative(ROOT, p), fs.readFileSync(p, 'utf8')]);
        }
    };
    walk(path.join(ROOT, rel));
    return out;
}
const IOS_APP = sources('iOSClient/BABOnline', '.swift');
const SERVER = sources('server', '.js');
const naming = (files, name) => files.filter(([, src]) => new RegExp(`\\b${name}\\b`).test(src)).map(([f]) => f);

describe('#3 client-only listeners: lobbyJoined, roomFull, activeTournamentFound', () => {
    test.each(['lobbyJoined', 'roomFull', 'activeTournamentFound'])('%s: no schema entry, constant, server emit or iOS listener', (name) => {
        expect(schema.s2c[name]).toBeUndefined();
        expect(baseline.s2c[name]).toBeUndefined();
        expect(web).not.toContain(`'${name}'`);
        expect(swift).not.toContain(`"${name}"`);
        expect(naming(SERVER, name)).toEqual([]);
        expect(naming(IOS_APP, name)).toEqual([]);
    });

    test('activeGameFound stays: the one event that makes the iOS app send rejoinGame by itself', () => {
        expect(schema.s2c.activeGameFound.status).toBe('clientOnly');
        expect(baseline.s2c.activeGameFound).toBeDefined();
        expect(web).toContain("\n  ACTIVE_GAME_FOUND: 'activeGameFound',\n");
        expect(swift).toContain('static let activeGameFound = "activeGameFound"');
        expect(read('iOSClient/BABOnline/Networking/Handlers/AuthSocketHandler.swift')).toContain('socket.on(SocketEvents.Server.activeGameFound)');
    });
});

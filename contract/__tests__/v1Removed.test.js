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

describe('#7 playerAssigned', () => {
    // only comments may still name it
    const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    test('no schema entry, constant, server emit, test-harness read or iOS listener', () => {
        expect(schema.s2c.playerAssigned).toBeUndefined();
        expect(baseline.s2c.playerAssigned).toBeUndefined();
        expect(web).not.toContain("'playerAssigned'");
        expect(swift).not.toContain('"playerAssigned"');
        expect(SERVER.filter(([, src]) => /\bplayerAssigned\b/.test(code(src))).map(([f]) => f)).toEqual([]);
        expect(naming(IOS_APP, 'playerAssigned')).toEqual([]);
    });

    test('the seat still reaches every client: positionUpdate sockets/usernames and the seat gameStart position stay', () => {
        const pu = schema.s2c.positionUpdate.payload;
        expect(pu.required).toEqual(expect.arrayContaining(['positions', 'sockets', 'usernames']));
        const seatStart = schema.s2c.gameStart.payload.anyOf.find((v) => v.variant === 'seat');
        expect(seatStart.required).toContain('position');
    });
});

describe('#6 gameStart.players (seat socket ids)', () => {
    const variants = (s) => s.s2c.gameStart.payload.anyOf;

    test('gone from both gameStart variants, in the schema and the baseline; nothing cites a read of it', () => {
        for (const s of [schema, baseline]) {
            for (const v of variants(s)) {
                expect({ variant: v.variant, has: 'players' in v.properties }).toEqual({ variant: v.variant, has: false });
                expect(v.required).not.toContain('players');
            }
        }
        expect(schema.s2c.gameStart.clientReads.web.filter((r) => /players/.test(r))).toEqual([]);
        // the iOS source no longer decodes it (1.2.0 decoded it optionally and never read it)
        const wire = read('iOSClient/BABOnline/Networking/Wire/WirePayloads.swift');
        const gameStart = wire.slice(wire.indexOf('struct GameStart'), wire.indexOf('}', wire.indexOf('struct GameStart')));
        expect(gameStart).not.toMatch(/\bplayers\b/);
    });

    test('the seat ids a client may still need stay on positionUpdate (sockets; usernames[].socketId went with #14, isBot[] came)', () => {
        const pu = schema.s2c.positionUpdate.payload;
        expect(pu.properties.sockets).toBeDefined();
        expect(pu.properties.usernames.items.properties.socketId).toBeUndefined();
        expect(pu.properties.isBot).toBeDefined();
    });
});

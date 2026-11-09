/**
 * server/avatar/avatarWire.js: the full matrix of picture kinds x
 * recipients x modes. Invariant I1 (docs/avatars.md): a legacy recipient
 * never sees a URL in a pic slot; every custom slot it gets is a data URL
 * the shipped iOS app decodes, today's raw stored string, or the
 * placeholder. Avatar keys are omitted when there is no URL; a slot is null
 * only for a capable recipient with a URL.
 */

const store = require('../avatarStore');
const wire = require('../avatarWire');
const { PLACEHOLDER_INLINE } = require('../placeholder');
const fx = require('../../testUtils/avatarFixtures');
const { logger } = require('../../utils/logger');

let OK;
let OK2;
let TINY;
const HOSTILE = () => fx.dataUrl(fx.SVG);
beforeAll(async () => {
    OK = fx.dataUrl(await fx.avatarPng(200, 1));
    OK2 = fx.dataUrl(await fx.avatarPng(200, 2));
    TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
});

beforeEach(() => {
    store._reset();
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    store._reset();
    jest.restoreAllMocks();
});

/** Every pic kind, with the store primed accordingly (pipeline on). */
async function primed() {
    store.configure({ enabled: true });
    await store.ensure('ok', OK);
    await store.ensure('hostile', HOSTILE());
    await store.ensure('undecodable', TINY);
    return {
        number: { username: 'num', pic: 12 },
        null: { username: 'nil', pic: null },
        raw: { username: 'raw', pic: OK2 },          // never seen: becomes pending on first resolve
        ok: { username: 'ok', pic: OK },
        hostile: { username: 'hostile', pic: HOSTILE() },
        undecodable: { username: 'undecodable', pic: TINY },
    };
}

async function legacyOk(value, kind, stored) {
    if (value === stored) return true;                           // today's value (b)
    if (value === PLACEHOLDER_INLINE) return kind === 'hostile'; // (c)
    return typeof value === 'string' && fx.I1_RE.test(value) && await fx.iosLegacyDecodes(value); // (a)
}

test.each(['derived', 'raw'])('matrix with AVATAR_LEGACY_INLINE=%s', async (mode) => {
    const kinds = await primed();
    store.configure({ legacyInline: mode });
    const want = {
        number: { url: false, legacy: 'same' },
        null: { url: false, legacy: 'same' },
        raw: { url: false, legacy: 'same' },
        ok: { url: true, legacy: mode === 'raw' ? 'same' : 'derived' },
        hostile: { url: false, legacy: 'placeholder' },
        undecodable: { url: false, legacy: 'same' },
    };
    for (const [kind, { username, pic }] of Object.entries(kinds)) {
        const r = wire.resolve(pic, username);
        const got = {
            url: !!r.url,
            legacy: r.legacy === pic ? 'same' : r.legacy === PLACEHOLDER_INLINE ? 'placeholder' : 'derived',
        };
        expect({ kind, ...got }).toEqual({ kind, ...want[kind] });
        if (r.url) expect(r.url).toBe(`/avatar/${username}?v=${store.versionOf(pic)}`);
        // I1 for the legacy slot, every kind
        expect({ kind, ok: await legacyOk(wire.slot(r, false), kind, pic) }).toEqual({ kind, ok: true });
        expect(String(wire.slot(r, false))).not.toMatch(/^\/avatar\//);
        // slot null only for capable with a URL
        expect(wire.slot(r, true) === null).toBe(!!r.url || pic === null);
    }
    // the first resolve of an unseen picture started its derive (pending, raw on the wire)
    expect(store.peek(store.versionOf(OK2))).toBeDefined();
});

test('derived legacy inline is much smaller than the stored picture', async () => {
    await primed();
    const r = wire.resolve(OK, 'ok');
    expect(r.legacy.length).toBeLessThan(16384);
    expect(r.legacy.length * 5).toBeLessThan(OK.length);
});

test('pipeline off: every kind resolves to exactly today\'s value, no URL', async () => {
    await primed();
    store.configure({ enabled: false });
    for (const pic of [12, null, OK, HOSTILE(), TINY]) expect(wire.resolve(pic, 'ok')).toEqual({ legacy: pic, url: null });
});

test('mapPlayers / wireClientState per recipient kind; keys omitted without a URL; inputs never mutated', async () => {
    await primed();
    const players = [
        { position: 1, username: 'ok', pic: OK, socketId: 's1' },
        { position: 2, username: 'num', pic: 7, socketId: 's2' },
        { position: 3, username: 'hostile', pic: HOSTILE(), socketId: 's3' },
        { position: 4, username: 'undecodable', pic: TINY, socketId: 's4' },
    ];
    const frozen = JSON.stringify(players);
    const game = { avatarVersions: new Map([['ok', store.versionOf(OK)]]) };
    const url = `/avatar/ok?v=${store.versionOf(OK)}`;

    const cap = wire.mapPlayers(game, players, 'capable');
    expect(cap.players.map((p) => p.pic)).toEqual([null, 7, PLACEHOLDER_INLINE, TINY]);
    expect(cap.avatarUrls).toEqual({ 1: url });
    const leg = wire.mapPlayers(game, players, 'legacy');
    expect(leg.avatarUrls).toBeUndefined();
    expect(await fx.iosLegacyDecodes(leg.players[0].pic)).toBe(true);
    const bc = wire.mapPlayers(game, players, 'broadcast');
    expect(bc.players[0].pic).toBe(leg.players[0].pic);
    expect(bc.avatarUrls).toEqual({ 1: url });
    expect(JSON.stringify(players)).toBe(frozen);

    const state = { gameId: 'g', players, phase: 'bidding' };
    const cs = wire.wireClientState(game, state, true);
    expect(Object.keys(cs)).toEqual(['gameId', 'players', 'phase', 'avatarUrls']);
    expect(Object.keys(wire.wireClientState(game, state, false))).toEqual(['gameId', 'players', 'phase']);
    // no custom picture with a URL: no avatar keys for anyone
    const plain = { players: [players[1], players[3]] };
    expect(wire.wireClientState(game, plain, true)).toEqual(plain);
    expect(JSON.stringify(players)).toBe(frozen);
});

test('names are percent-encoded in URLs', async () => {
    store.configure({ enabled: true });
    await store.ensure('Zoë & co', OK);
    expect(wire.resolve(OK, 'Zoë & co').url).toBe(`/avatar/Zo%C3%AB%20%26%20co?v=${store.versionOf(OK)}`);
    const { compile } = require('../../../contract/lib/validate');
    const contract = require('../../../contract');
    const v = compile({ $ref: '#/$defs/avatarUrl' }, contract.schema.$defs);
    expect(v(wire.resolve(OK, 'Zoë & co').url)).toEqual([]);
    expect(v('http://evil/avatar/x?v=0123456789abcdef').length).toBeGreaterThan(0);
    expect(v('data:image/png;base64,AAAA').length).toBeGreaterThan(0);
});

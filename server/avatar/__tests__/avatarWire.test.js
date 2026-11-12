/**
 * server/avatar/avatarWire.js: the full matrix of picture kinds, since
 * contract/V1_REMOVALS.md #19 (2026-11-12): no payload carries a picture
 * inline. A picture slot is a stock number or null for EVERY recipient; a
 * custom picture is only its URL (avatarUrls / avatarUrl), when its
 * rendition exists. Avatar keys are omitted when there is no URL.
 */

const store = require('../avatarStore');
const wire = require('../avatarWire');
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

test('matrix: a URL only for a derived custom picture; every slot a stock number or null (#19 A)', async () => {
    const kinds = await primed();
    const want = { number: [false, 12], null: [false, null], raw: [false, null], ok: [true, null], hostile: [false, null], undecodable: [false, null] };
    for (const [kind, { username, pic }] of Object.entries(kinds)) {
        const r = wire.resolve(pic, username);
        expect(Object.keys(r)).toEqual(['url']);
        expect({ kind, url: !!r.url, slot: wire.slot(pic) }).toEqual({ kind, url: want[kind][0], slot: want[kind][1] });
        if (r.url) expect(r.url).toBe(`/avatar/${username}?v=${store.versionOf(pic)}`);
    }
    // the first resolve of an unseen picture started its derive (pending: no URL yet)
    expect(store.peek(store.versionOf(OK2))).toBeDefined();
    // a slot is never a string, whatever comes in
    for (const v of ['5', '/avatar/x?v=0123456789abcdef', OK, undefined, {}]) expect(wire.slot(v)).toBeNull();
});

test('pipeline off: no URL for any kind, and still no inline picture', async () => {
    await primed();
    store.configure({ enabled: false });
    for (const pic of [12, null, OK, HOSTILE(), TINY]) expect(wire.resolve(pic, 'ok')).toEqual({ url: null });
    expect(wire.mapPlayers(null, [{ position: 1, username: 'ok', pic: OK }])).toEqual({ players: [{ position: 1, username: 'ok', pic: null }], avatarUrls: undefined });
});

test('mapPlayers / wireClientState: one shape for everyone; keys omitted without a URL; inputs never mutated', async () => {
    await primed();
    const players = [
        { position: 1, username: 'ok', pic: OK },
        { position: 2, username: 'num', pic: 7 },
        { position: 3, username: 'hostile', pic: HOSTILE() },
        { position: 4, username: 'undecodable', pic: TINY },
    ];
    const frozen = JSON.stringify(players);
    const game = { avatarVersions: new Map([['ok', store.versionOf(OK)]]) };
    const url = `/avatar/ok?v=${store.versionOf(OK)}`;

    const m = wire.mapPlayers(game, players);
    expect(m.players.map((p) => p.pic)).toEqual([null, 7, null, null]);
    expect(m.avatarUrls).toEqual({ 1: url });
    expect(m.players[1]).toBe(players[1]); // a stock seat is shared, not copied
    expect(JSON.stringify(players)).toBe(frozen);

    const state = { gameId: 'g', players, phase: 'bidding' };
    const cs = wire.wireClientState(game, state);
    expect(Object.keys(cs)).toEqual(['gameId', 'players', 'phase', 'avatarUrls']);
    // no custom picture at all: the same content, no avatar keys
    const plain = { players: [players[1]] };
    expect(wire.wireClientState(game, plain)).toEqual(plain);
    // a custom picture without a URL: the slot is still null, no avatarUrls
    const noUrl = wire.wireClientState(game, { players: [players[3]] });
    expect(noUrl).toEqual({ players: [{ ...players[3], pic: null }] });
    expect(JSON.stringify(players)).toBe(frozen);
});

test('mapProfileRows: customProfilePic null on every row, URLs by username (#19 B)', async () => {
    await primed();
    const rows = [
        { username: 'ok', profilePic: 3, customProfilePic: OK },
        { username: 'num', profilePic: 4, customProfilePic: null },
        { username: 'hostile', profilePic: 5, customProfilePic: HOSTILE() },
    ];
    const frozen = JSON.stringify(rows);
    const m = await wire.mapProfileRows(rows);
    expect(m.rows.map((r) => r.customProfilePic)).toEqual([null, null, null]);
    expect(m.rows[1]).toBe(rows[1]);
    expect(m.avatarUrls).toEqual({ ok: `/avatar/ok?v=${store.versionOf(OK)}` });
    expect(JSON.stringify(rows)).toBe(frozen);
});

test('a transient derive failure has no URL (slot null), and gets its URL once re-derived', async () => {
    let t = 1_000_000;
    store.configure({ enabled: true, now: () => t });
    const image = require('../image');
    jest.spyOn(image, 'derive').mockResolvedValueOnce({ status: 'error' });
    await store.ensure('kim', OK);
    expect(wire.resolve(OK, 'kim')).toEqual({ url: null });
    expect(wire.mapPlayers(null, [{ position: 1, username: 'kim', pic: OK }]))
        .toEqual({ players: [{ position: 1, username: 'kim', pic: null }], avatarUrls: undefined });
    t += store.ERROR_TTL_MS;
    expect(wire.resolve(OK, 'kim').url).toBeNull(); // expired: warm restarts the derive
    await store.ensure('kim', OK);
    expect(wire.resolve(OK, 'kim').url).toBe(`/avatar/kim?v=${store.versionOf(OK)}`);
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

test('the legacy inline machinery is gone (#19 D)', () => {
    expect(wire).not.toHaveProperty('legacy');
    expect(store).not.toHaveProperty('legacyInlineMode');
    expect(require('../../config').avatar).not.toHaveProperty('legacyInline');
    expect(() => require('../placeholder')).toThrow();
});

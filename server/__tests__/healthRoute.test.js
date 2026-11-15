/**
 * GET /health (server/routes/health.js): always 200 and cheap, with the DB
 * state from the driver (no round trip) and live counts for a deploy
 * decision. The endpoint is public: counts only, never a username or id.
 * GET /ready stays the deploy gate (503 without a DB).
 */

const http = require('http');
const express = require('express');

const mockDbState = { value: 'disconnected', db: null };
jest.mock('../database', () => ({
    ...jest.requireActual('../database'),
    getDbState: () => mockDbState.value,
    getDB: () => mockDbState.db,
}));

const routes = require('../routes');
const { setHealthIo, healthBody } = require('../routes/health');
const gameManager = require('../game/GameManager');

let server;
let base;

beforeAll(async () => {
    const app = express();
    app.use('/', routes);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    setHealthIo(null);
    await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
    gameManager.games.clear();
    gameManager.tournaments.clear();
    gameManager.lobbies.clear();
    mockDbState.value = 'disconnected';
    mockDbState.db = null;
    jest.restoreAllMocks();
});

async function get(path) {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
}

/** A GameState stand-in with just what getHealthCounts reads. */
function fakeGame(id, { owners = [], entrants = null, isDemo = false, terminal = false } = {}) {
    return {
        gameId: id,
        isDemo,
        isTerminal: () => terminal,
        seatList: () => owners.map((ownerUsername, i) => ({ position: i + 1, ownerUsername })),
        entrants: entrants && new Map(entrants.map((e, i) => [`s${i}`, e])),
    };
}

test('shape: 200 with status, db and live counts, nothing that names anyone', async () => {
    const sockets = new Map([['a', {}], ['b', {}], ['c', {}]]);
    setHealthIo({ of: (ns) => { expect(ns).toBe('/'); return { sockets }; } });
    mockDbState.value = 'connected';

    gameManager.games.set('g-human', fakeGame('g-human', { owners: ['Alice', null, null, null] }));
    gameManager.games.set('g-lazy', fakeGame('g-lazy', { owners: [null, 'Bob', null, null] }));
    gameManager.games.set('g-draw', fakeGame('g-draw', { entrants: [{ username: 'Cy', isBot: false }, { username: 'Mary', isBot: true }] }));
    gameManager.games.set('g-bots', fakeGame('g-bots', { owners: [null, null, null, null] }));
    gameManager.games.set('g-demo', fakeGame('g-demo', { owners: [null, null, null, null], isDemo: true }));
    gameManager.games.set('g-ended', fakeGame('g-ended', { owners: ['Dee', null, null, null], terminal: true }));
    gameManager.tournaments.set('t1', { phase: 'round_active', players: new Map() });
    gameManager.tournaments.set('t2', { phase: 'lobby', players: new Map() });
    gameManager.tournaments.set('t3', { phase: 'complete', players: new Map() });
    gameManager.lobbies.set('l1', { players: [{ username: 'Eve' }] });

    const { status, body } = await get('/health');
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['db', 'live', 'memory', 'status', 'timestamp', 'uptime']);
    expect(body.status).toBe('ok');
    expect(body.db).toBe('connected');
    expect(body.live).toEqual({ sockets: 3, games: 3, tournaments: 2, lobbies: 1 });
    expect(body.memory).toMatchObject({ unit: 'MB' });
    expect(typeof body.uptime).toBe('number');
    const text = JSON.stringify(body);
    for (const leak of ['Alice', 'Bob', 'Cy', 'Dee', 'Eve', 'g-human', 't1', 'l1']) expect(text).not.toContain(leak);
});

test('no DB: /health still 200 with db "disconnected"; /ready is 503', async () => {
    setHealthIo(null);
    const health = await get('/health');
    expect(health.status).toBe(200);
    expect(health.body.db).toBe('disconnected');
    expect(health.body.live).toEqual({ sockets: 0, games: 0, tournaments: 0, lobbies: 0 });

    const ready = await get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.checks.database).toBe('failed');
});

test('a count that throws never fails /health: that count is null', async () => {
    setHealthIo({ of: () => { throw new Error('io gone'); } });
    jest.spyOn(gameManager, 'getHealthCounts').mockImplementation(() => { throw new Error('broken'); });
    const { status, body } = await get('/health');
    expect(status).toBe(200);
    expect(body.live).toEqual({ sockets: null, games: null, tournaments: null, lobbies: null });
});

test('healthBody takes its sources as arguments', () => {
    const body = healthBody({
        io: { of: () => ({ sockets: new Map([['x', {}]]) }) },
        gameManager: { getHealthCounts: () => ({ games: 7, tournaments: 1, lobbies: 2 }) },
        dbState: () => 'connected',
    });
    expect(body).toMatchObject({ status: 'ok', db: 'connected', live: { sockets: 1, games: 7, tournaments: 1, lobbies: 2 } });
});

test('real GameState entrants: a human entrant counts before seating, bot entrants only do not', () => {
    const GameState = require('../game/GameState');
    const entrant = (socketId, username, isBot) => ({ socketId, username, isBot });
    const human = new GameState('hc-human');
    human.initEntrants([entrant('h1', 'Hal', false), entrant('bot:Mary:1', 'Mary', true), entrant('bot:Ann:2', 'Ann', true), entrant('bot:Tom:3', 'Tom', true)]);
    const bots = new GameState('hc-bots');
    bots.initEntrants([entrant('bot:Mary:4', 'Mary', true), entrant('bot:Ann:5', 'Ann', true), entrant('bot:Tom:6', 'Tom', true), entrant('bot:Sal:7', 'Sal', true)]);
    gameManager.games.set(human.gameId, human);
    gameManager.games.set(bots.gameId, bots);
    expect(gameManager.getHealthCounts().games).toBe(1);
});

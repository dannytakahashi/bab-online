/**
 * Codec field guard (deploy survival, PR 3). A field added to a game, a
 * seat record, a bot or a tournament must be classified: saved (SAVED, so
 * it survives a restart) or derived (DERIVED: rebuilt, reset or never
 * restored). Otherwise a restart would silently lose it.
 *
 *   1. Object.keys of live objects mid-play (chaos runs and a real
 *      tournament with lazy seats): GameState, its seat records and their
 *      bot records, BotPlayer, a game log line, TournamentState, its member
 *      entries, rounds, round games and chat lines. Every key is in SAVED
 *      or DERIVED, and every saved nested value survives JSON unchanged.
 *   2. A static scan of server code: every `game.<x> =`, `t.<x> =` and
 *      `tournament.<x> =`, and every `this.<x> =` in GameState,
 *      TournamentState and BotPlayer, names a classified field.
 *   3. The SAVED lists hash to the value pinned for each codec version:
 *      changing what is saved means bumping CODEC_V (and hydrate reading
 *      the old version or discarding it) and pinning the new hash here.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { createMemoryDb } = require('../../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const { gameLogger, socketLogger, authLogger, logger } = require('../../../utils/logger');
const contractCheck = require('../../../testUtils/contractCheck');
const { runSeedInner } = require('../../../testUtils/chaosEngine');
const { watchSafePoints } = require('../../../testUtils/restoreKit');
const { setupTournament, playTournament } = require('../../../testUtils/tournamentDriver');
const { mulberry32 } = require('../../../testUtils/gameDriver');
const gameCodec = require('../gameCodec');
const tournamentCodec = require('../tournamentCodec');

const SERVER = path.join(__dirname, '../../..');

// sha256(JSON.stringify(SAVED)).slice(0, 16) per codec version
const PINNED = {
    game: { 1: '3a9f4c46b400a79e' },
    tournament: { 1: '4effc20c08b2654d' },
};

const hash = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);

let errorLogs;
let realRandom;

beforeAll(() => {
    process.env.BAB_FSM_CHECK = '1';
    realRandom = Math.random;
});

afterAll(() => {
    delete process.env.BAB_FSM_CHECK;
    Math.random = realRandom;
});

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    errorLogs = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
        for (const m of ['warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

/** kind -> Set of keys seen on live objects */
function keyCollector() {
    const keys = {};
    const add = (kind, obj) => {
        if (!obj || typeof obj !== 'object') return;
        keys[kind] = keys[kind] || new Set();
        for (const k of Object.keys(obj)) keys[kind].add(k);
    };
    const nested = [];
    const game = (g) => {
        add('game', g);
        for (const s of g.seatList()) {
            add('seat', s);
            if (s.bot) add('seatBot', s.bot);
        }
        for (const b of botController.getGameBots(g.gameId)) add('botPlayer', b);
        for (const e of g.gameLog.slice(-20)) add('logEntry', e);
        // Saved values that are objects must be JSON values (no Map, Set,
        // class instance or undefined inside)
        for (const k of ['bids', 'tricks', 'score', 'rainbows', 'handStats', 'playerStats', 'handTricks', 'hsiValues', 'trickHistory']) {
            const v = g[k];
            if (v === undefined) continue;
            if (!isDeepStrictEqual(JSON.parse(JSON.stringify(v)), v)) nested.push(`game.${k}`);
        }
    };
    const tournament = (t) => {
        add('tournament', t);
        for (const p of t.players.values()) add('player', p);
        for (const r of t.rounds) {
            add('round', r);
            for (const g of r.games.values()) add('roundGame', g);
        }
        for (const m of t.messages) add('message', m);
        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(t.scoreboard)), t.scoreboard)) nested.push('tournament.scoreboard');
    };
    return { keys, nested, game, tournament };
}

function unclassified(keys, codec) {
    const out = {};
    for (const [kind, seen] of Object.entries(keys)) {
        const known = new Set([...(codec.SAVED[kind] || []), ...(codec.DERIVED[kind] || [])]);
        const missing = [...seen].filter((k) => !known.has(k));
        if (missing.length) out[kind] = missing;
    }
    return out;
}

describe('every live field is classified', () => {
    test('games, seats and bots mid-play (chaos runs)', async () => {
        const c = keyCollector();
        const watch = watchSafePoints((game) => {
            if (gameManager.getGameById(game.gameId) === game && game.seatList().length === 4) c.game(game);
        });
        try {
            for (let seed = 1; seed <= 20; seed++) {
                contractCheck.setContext(`field guard seed ${seed}`);
                const r = await runSeedInner(seed, () => {}, { errorLogs });
                if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 2000));
            }
        } finally {
            watch.stop();
        }
        for (const kind of ['game', 'seat', 'seatBot', 'botPlayer', 'logEntry']) expect(c.keys[kind]?.size).toBeGreaterThan(0);
        expect(unclassified(c.keys, gameCodec)).toEqual({});
        expect(c.nested).toEqual([]);
    }, 300000);

    test('a real tournament (tables with lazy seats, every phase)', async () => {
        Math.random = mulberry32(17);
        const c = keyCollector();
        const ctx = await setupTournament(5);
        require('../../../socket/tournamentHandlers').tournamentChat(ctx.sockets[1], ctx.io, { message: 'gl all' });
        c.tournament(ctx.t);
        await playTournament(ctx, {
            round: async (round, cx, tables) => {
                await jest.advanceTimersByTimeAsync(15000);
                c.tournament(cx.t);
                for (const g of tables) if (!g.isTerminal() && g.seatList().length === 4) c.game(g);
            },
        });
        c.tournament(ctx.t);
        for (const kind of ['tournament', 'player', 'round', 'roundGame', 'message']) expect(c.keys[kind]?.size).toBeGreaterThan(0);
        expect(c.keys.seat.size).toBeGreaterThan(0);
        expect(unclassified({ tournament: c.keys.tournament, player: c.keys.player, round: c.keys.round, roundGame: c.keys.roundGame, message: c.keys.message }, tournamentCodec)).toEqual({});
        expect(unclassified({ game: c.keys.game, seat: c.keys.seat, seatBot: c.keys.seatBot, botPlayer: c.keys.botPlayer }, gameCodec)).toEqual({});
        expect(c.nested).toEqual([]);
    }, 300000);

    test('no field is both saved and derived', () => {
        for (const codec of [gameCodec, tournamentCodec]) {
            for (const [kind, saved] of Object.entries(codec.SAVED)) {
                const derived = new Set(codec.DERIVED[kind] || []);
                expect([kind, saved.filter((k) => derived.has(k))]).toEqual([kind, []]);
            }
        }
    });
});

describe('every field written in server code is classified', () => {
    function sourceFiles(dir) {
        const out = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'testUtils') continue;
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) out.push(...sourceFiles(p));
            else if (entry.name.endsWith('.js')) out.push(p);
        }
        return out;
    }
    const writes = (text, re) => {
        const names = new Set();
        for (const m of text.matchAll(re)) names.add(m[1]);
        return names;
    };
    const known = (codec, kind) => new Set([...codec.SAVED[kind], ...codec.DERIVED[kind]]);

    test('game.<x> =, t.<x> =, tournament.<x> = across server/', () => {
        const gameKnown = known(gameCodec, 'game');
        const tKnown = known(tournamentCodec, 'tournament');
        const bad = [];
        let scanned = 0;
        for (const file of sourceFiles(SERVER)) {
            const text = fs.readFileSync(file, 'utf8');
            const rel = path.relative(SERVER, file);
            for (const x of writes(text, /\bgame\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
                scanned++;
                if (!gameKnown.has(x)) bad.push(`${rel}: game.${x}`);
            }
            for (const x of writes(text, /\b(?:t|tournament)\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
                scanned++;
                if (!tKnown.has(x)) bad.push(`${rel}: tournament.${x}`);
            }
        }
        expect(scanned).toBeGreaterThan(20);
        expect(bad).toEqual([]);
    });

    test.each([
        ['game/GameState.js', gameCodec, 'game'],
        ['game/TournamentState.js', tournamentCodec, 'tournament'],
        ['game/bot/BotPlayer.js', gameCodec, 'botPlayer'],
    ])('this.<x> = in %s', (file, codec, kind) => {
        const text = fs.readFileSync(path.join(SERVER, file), 'utf8');
        const names = [...writes(text, /\bthis\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)];
        expect(names.length).toBeGreaterThan(5);
        const k = known(codec, kind);
        expect(names.filter((x) => !k.has(x))).toEqual([]);
    });
});

describe('SAVED is pinned to the codec version', () => {
    test('game codec', () => {
        expect({ v: gameCodec.CODEC_V, hash: hash(gameCodec.SAVED) })
            .toEqual({ v: gameCodec.CODEC_V, hash: PINNED.game[gameCodec.CODEC_V] });
    });

    test('tournament codec', () => {
        expect({ v: tournamentCodec.TOURNAMENT_CODEC_V, hash: hash(tournamentCodec.SAVED) })
            .toEqual({ v: tournamentCodec.TOURNAMENT_CODEC_V, hash: PINNED.tournament[tournamentCodec.TOURNAMENT_CODEC_V] });
    });
});

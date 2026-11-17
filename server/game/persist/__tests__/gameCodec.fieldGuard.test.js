/**
 * Codec field guard (deploy survival, PR 3). A field added to a game, a
 * seat record, a bot or a tournament must be classified: saved (SAVED, so
 * it survives a restart) or derived (DERIVED: rebuilt, reset or never
 * restored). Otherwise a restart would silently lose it.
 *
 *   1. Object.keys of live objects mid-play (chaos runs and a real
 *      tournament with lazy seats): GameState, its seat records and their
 *      bot records, BotPlayer, a game log line, a lobby-born game's
 *      casualVoice and lobbyOrigin, TournamentState, its member
 *      entries, rounds, round games and chat lines. Every key is in SAVED
 *      or DERIVED, and every saved nested value survives JSON unchanged.
 *   2. A static scan of server code: every `game.<x> =`, `t.<x> =` and
 *      `tournament.<x> =`, and every `this.<x> =` in GameState,
 *      TournamentState and BotPlayer, names a classified field.
 *   3. SAVED is what serialize writes and hydrate reads back: at every
 *      safe point of chaos runs (and for a real tournament and its tables),
 *      every SAVED key has its place in the doc (GAME_DOC_PLACE: _stage is
 *      `stage`, gameLog `log`, players `state.seatOrder`, gameId and
 *      logTotal top level, the rest `state.<key>`), the doc holds nothing
 *      else (bar the listed doc-only fields), and the hydrated object's
 *      field equals the live one (hands and seats compared per position,
 *      presence as a restore maps it). The same for seats, seat bots, the
 *      bot records and the tournament lists. A field listed in SAVED but
 *      never written, or never read back, fails here.
 *   4. The SAVED lists, and the codec's encoding shape (the key sets of
 *      the doc, its state, seats, bots, cards and tricks, and the slot
 *      lengths), hash to the values pinned for each codec version:
 *      changing what is saved or how it is encoded means bumping CODEC_V
 *      (and hydrate reading the old version or discarding it) and pinning
 *      the new hashes here.
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
const { isStockPic } = require('../../../avatar/stockAvatars');
const gameCodec = require('../gameCodec');
const tournamentCodec = require('../tournamentCodec');

const SERVER = path.join(__dirname, '../../..');

// sha256(JSON.stringify(SAVED)).slice(0, 16) per codec version. Game v1
// was re-pinned (not bumped) when casualVoice and lobbyOrigin joined SAVED
// (main's family lobbies and play again): no v1 doc had ever been written,
// nothing calls serialize before the persist store (PR 4). From PR 4 on a
// change bumps CODEC_V.
const PINNED = {
    game: { 1: '53c0d6fe0850bbdc' },
    tournament: { 1: '4effc20c08b2654d' },
};

// sha256 of the encoding shape (docShape / tournamentDocShape below,
// collected over every doc of the coverage runs), per codec version
const PINNED_SHAPE = {
    game: { 1: '26ba3747585567ba' },
    tournament: { 1: 'b361a440bd865499' },
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
        add('casualVoice', g.casualVoice);
        add('lobbyOrigin', g.lobbyOrigin);
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
        for (const kind of ['game', 'seat', 'seatBot', 'botPlayer', 'logEntry', 'casualVoice', 'lobbyOrigin']) expect(c.keys[kind]?.size).toBeGreaterThan(0);
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

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const sortedKeys = (o) => Object.keys(o || {}).sort();
const sameKeys = (o, list) => expect(sortedKeys(o)).toEqual([...list].sort());
const failuresOf = () => {
    const bad = [];
    const check = (what, fn) => {
        try {
            fn();
        } catch (err) {
            bad.push(`${what}: ${err.message.split('\n').filter(Boolean).slice(0, 6).join(' ')}`);
        }
    };
    return { bad, check };
};
const merge = (acc, kind, values) => {
    acc[kind] = acc[kind] || new Set();
    for (const v of values) acc[kind].add(v);
};
const shapeHash = (acc) => hash(Object.keys(acc).sort().map((k) => [k, [...acc[k]].sort()]));

// Where a SAVED game key lives in the doc (default: state.<key>)
const GAME_DOC_PLACE = {
    gameId: (d) => d.gameId,
    _stage: (d) => d.stage,
    gameLog: (d) => d.log,
    logTotal: (d) => d.logTotal,
    players: (d) => d.state.seatOrder,
};
const GAME_ENVELOPE = ['v', 'gameId', 'stage', 'tournamentId', 'state', 'log', 'logTotal', 'bots'];
// Doc-only: a seat's `gone` (presence === gone, for the tombstone's and
// tournament scoring's readers; a restore reads it with presence)
const SEAT_DOC_ONLY = ['gone'];
const GAME_STATE_KEYS = [...gameCodec.SAVED.game.filter((k) => !(k in GAME_DOC_PLACE)), 'seatOrder'];

/** A restore's presence for a live seat (restoreSeats). */
const restoredPresence = (s) => {
    if (s.controller === 'human') return 'grace';
    if (s.controller === 'bot') return 'none';
    return s.presence === 'gone' ? 'gone' : 'away';
};

/** `obj`'s SAVED[kind] keys, Maps and Sets as arrays (null for none). */
function savedView(obj, kind) {
    if (!obj) return null;
    const out = {};
    for (const k of gameCodec.SAVED[kind]) {
        const v = obj[k];
        out[k] = v instanceof Map || v instanceof Set ? plain(Array.from(v)) : plain(v);
    }
    return out;
}

/** The value of a SAVED game key, by position rather than by socket. */
function gameView(game, key) {
    switch (key) {
        case 'hands': {
            const out = {};
            for (let pos = 1; pos <= 4; pos++) out[pos] = plain(game.hands[game.seat(pos).seatSocketId]);
            return out;
        }
        case 'players': return Array.from(game.players.values(), (p) => p.position);
        // Sets and Maps as arrays, SAVED keys only (a restore drops the rest)
        case 'casualVoice': return savedView(game.casualVoice, 'casualVoice');
        case 'lobbyOrigin': return savedView(game.lobbyOrigin, 'lobbyOrigin');
        // Before PR 2 a live game has no logTotal: its log length counts
        case 'logTotal': return Number.isInteger(game.logTotal) ? game.logTotal : game.gameLog.length;
        default: return plain(game[key]);
    }
}

/**
 * Every SAVED key of `game` is written to `doc` and read back by hydrate
 * (`restored`), and the doc holds nothing unlisted. Failure strings.
 */
function savedCoverage(game, doc, restored, getBot) {
    const { bad, check } = failuresOf();
    check('doc keys', () => sameKeys(doc, GAME_ENVELOPE));
    check('state keys', () => sameKeys(doc.state, GAME_STATE_KEYS));
    for (const key of gameCodec.SAVED.game) {
        const place = GAME_DOC_PLACE[key] || ((d) => d.state[key]);
        check(`${key} in doc`, () => expect(place(doc)).not.toBeUndefined());
        if (key === 'seats') continue; // per seat below
        if (key === 'eventSeq') {
            check(key, () => expect(restored.eventSeq).toBe(game.eventSeq + gameCodec.EVENT_SEQ_OFFSET));
            continue;
        }
        check(key, () => expect(gameView(restored, key)).toEqual(gameView(game, key)));
    }
    for (let pos = 1; pos <= 4; pos++) {
        const live = game.seat(pos);
        const back = restored.seat(pos);
        const rec = doc.state.seats[pos];
        check(`seat ${pos} keys`, () => sameKeys(rec, [...gameCodec.SAVED.seat, ...SEAT_DOC_ONLY]));
        for (const key of gameCodec.SAVED.seat) {
            let want = plain(live[key]);
            if (key === 'presence') want = restoredPresence(live);
            // A custom picture is not saved: the adopter warms the owner's current one
            if (key === 'ownerPic' && !isStockPic(live.ownerPic)) want = null;
            // A gone seat without a leave time is stamped at the restore
            if (key === 'leftAt' && want === null && restoredPresence(live) === 'gone') continue;
            check(`seat ${pos} ${key}`, () => expect(plain(back[key])).toEqual(want));
        }
        if (rec.bot) {
            check(`seat ${pos} bot keys`, () => sameKeys(rec.bot, gameCodec.SAVED.seatBot));
            for (const key of gameCodec.SAVED.seatBot) {
                check(`seat ${pos} bot ${key}`, () => expect(plain(back.bot[key])).toEqual(plain(live.bot[key])));
            }
        }
    }
    for (const kind of ['casualVoice', 'lobbyOrigin']) {
        const rec = doc.state[kind];
        check(`${kind} present`, () => expect(rec === null).toBe(!game[kind]));
        if (rec) check(`${kind} keys`, () => sameKeys(rec, gameCodec.SAVED[kind]));
    }
    // What hydrate sets up besides the saved settings: an empty voice room
    // (voice spectators re-spectate), no lobby chat
    if (game.casualVoice) {
        check('voice room', () => expect([restored.voiceSpectators?.size, restored.voiceOfferDir?.size]).toEqual([0, 0]));
    }
    if (game.lobbyOrigin) check('lobby chat', () => expect(restored.lobbyOrigin.messages).toEqual([]));
    const botSeats = game.seatList().filter((s) => s.bot).map((s) => s.position);
    check('bots', () => expect(doc.bots.map((b) => b.position)).toEqual(botSeats));
    for (const rec of doc.bots) {
        const live = getBot(rec.socketId);
        check(`bot ${rec.position} keys`, () => sameKeys(rec, gameCodec.SAVED.botPlayer));
        check(`bot ${rec.position} registered`, () => expect(live).toBeTruthy());
        if (!live) continue;
        for (const key of gameCodec.SAVED.botPlayer) {
            check(`bot ${rec.position} ${key}`, () => expect(plain(rec[key])).toEqual(plain(live[key])));
        }
    }
    for (const e of doc.log) {
        const extra = Object.keys(e).filter((k) => !gameCodec.SAVED.logEntry.includes(k));
        if (extra.length) bad.push(`log entry keys ${extra}`);
    }
    return bad;
}

/** The codec's encoding shape of a game doc, merged into `acc` (kind -> Set). */
function docShape(doc, acc) {
    const st = doc.state;
    merge(acc, 'doc', Object.keys(doc));
    merge(acc, 'state', Object.keys(st));
    merge(acc, 'seats', Object.keys(st.seats));
    merge(acc, 'hands', Object.keys(st.hands));
    merge(acc, 'playedCards', [`length ${st.playedCards.length}`]);
    merge(acc, 'playerBids', [`length ${st.playerBids.length}`]);
    for (const seat of Object.values(st.seats)) {
        merge(acc, 'seat', Object.keys(seat));
        if (seat.bot) merge(acc, 'seatBot', Object.keys(seat.bot));
    }
    for (const b of doc.bots) merge(acc, 'bot', Object.keys(b));
    if (st.casualVoice) merge(acc, 'casualVoice', Object.keys(st.casualVoice));
    if (st.lobbyOrigin) {
        merge(acc, 'lobbyOrigin', Object.keys(st.lobbyOrigin));
        merge(acc, 'lobbyOriginSettings', Object.keys(st.lobbyOrigin.settings));
        for (const e of st.lobbyOrigin.bots) merge(acc, 'lobbyOriginBot', [`length ${e.length}`]);
    }
    for (const t of st.trickHistory) merge(acc, 'trick', Object.keys(t));
    const cards = [st.leadCard, st.trump, ...st.playedCards, ...Object.values(st.hands).flat(),
        ...st.trickHistory.flatMap((t) => t.cards)];
    for (const c of cards) if (c) merge(acc, 'card', Object.keys(c));
    return acc;
}

/** The same for a tournament doc. */
function tournamentDocShape(doc, acc) {
    const st = doc.state;
    merge(acc, 'doc', Object.keys(doc));
    merge(acc, 'state', Object.keys(st));
    for (const p of st.players) merge(acc, 'player', Object.keys(p));
    for (const r of st.rounds) {
        merge(acc, 'round', Object.keys(r));
        for (const entry of r.games) {
            merge(acc, 'roundGameEntry', [`length ${entry.length}`]);
            merge(acc, 'roundGame', Object.keys(entry[1]));
        }
    }
    for (const m of st.messages) merge(acc, 'message', Object.keys(m));
    for (const ts of Object.values(st.tableScores)) {
        merge(acc, 'tableScore', Object.keys(ts));
        merge(acc, 'tableScoreScore', Object.keys(ts.score));
        for (const seat of ts.seats) merge(acc, 'tableScoreSeat', Object.keys(seat));
    }
    return acc;
}

// Doc-only tournament field: tableScores (each live table's running score,
// read from its GameState, not a TournamentState field)
const TOURNAMENT_DOC_ONLY = ['tableScores'];

/** The value of a SAVED tournament key, Maps and Sets as arrays. */
function tournamentView(t, key) {
    switch (key) {
        case 'phase': return tournamentCodec.savedPhase(t);
        case 'players': return Array.from(t.players.values(), (p) => ({ username: p.username, pic: plain(p.pic ?? null) }));
        case 'rounds': return t.rounds.map((r) => ({
            roundNumber: r.roundNumber,
            games: plain(Array.from(r.games.entries())),
            completedGames: Array.from(r.completedGames),
        }));
        case 'messages': return t.messages.slice(-t.maxMessages).map((m) => ({ ...plain(m), isSpectator: !!m.isSpectator }));
        case 'handedOffThisWait': return !!t.handedOffThisWait;
        default: return plain(t[key] ?? null);
    }
}

function tournamentCoverage(t, doc, restored) {
    const { bad, check } = failuresOf();
    check('doc keys', () => sameKeys(doc, ['v', 'tournamentId', 'phase', 'state']));
    check('state keys', () => sameKeys(doc.state, [
        ...tournamentCodec.SAVED.tournament.filter((k) => k !== 'tournamentId'), ...TOURNAMENT_DOC_ONLY,
    ]));
    for (const key of tournamentCodec.SAVED.tournament) {
        const placed = key === 'tournamentId' ? doc.tournamentId : doc.state[key];
        check(`${key} in doc`, () => expect(placed).not.toBeUndefined());
        check(key, () => expect(tournamentView(restored, key)).toEqual(tournamentView(t, key)));
    }
    for (const p of doc.state.players) check('player keys', () => sameKeys(p, tournamentCodec.SAVED.player));
    for (const r of doc.state.rounds) {
        check('round keys', () => sameKeys(r, tournamentCodec.SAVED.round));
        for (const [, g] of r.games) check('round game keys', () => sameKeys(g, tournamentCodec.SAVED.roundGame));
    }
    for (const m of doc.state.messages) check('message keys', () => sameKeys(m, tournamentCodec.SAVED.message));
    return bad;
}

/** serialize + JSON + hydrate of a live game, its coverage failures, the stored doc. */
function coverGame(game, shape) {
    const getBot = (sid) => botController.getBot(game.gameId, sid);
    const doc = gameCodec.serialize(game, { getBot });
    if (!doc) return null;
    const stored = JSON.parse(JSON.stringify(doc));
    docShape(stored, shape);
    const { game: restored } = gameCodec.hydrate(stored, { now: Date.now() });
    try {
        return savedCoverage(game, stored, restored, getBot);
    } finally {
        restored._cancelAllTimers();
    }
}

describe('SAVED is what serialize writes and hydrate reads back', () => {
    test('games at every safe point of chaos runs', async () => {
        const shape = {};
        const failures = [];
        let docs = 0;
        const watch = watchSafePoints((game) => {
            if (gameManager.getGameById(game.gameId) !== game || game.isDemo) return;
            const bad = coverGame(game, shape);
            if (!bad) return;
            docs++;
            if (bad.length && failures.length < 5) failures.push(`${game.stage}: ${bad.slice(0, 4).join(' | ')}`);
        });
        try {
            for (let seed = 1; seed <= 10 && failures.length === 0; seed++) {
                contractCheck.setContext(`saved coverage seed ${seed}`);
                const r = await runSeedInner(seed, () => {}, { errorLogs });
                if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 2000));
            }
        } finally {
            watch.stop();
        }
        expect(failures).toEqual([]);
        expect(docs).toBeGreaterThan(50);
        // Every kind of encoded object was seen: a shape from a partial
        // sample would pin too little
        expect(sortedKeys(shape)).toEqual(['bot', 'card', 'casualVoice', 'doc', 'hands', 'lobbyOrigin', 'lobbyOriginBot',
            'lobbyOriginSettings', 'playedCards', 'playerBids', 'seat', 'seatBot', 'seats', 'state', 'trick']);
        expect({ v: gameCodec.CODEC_V, shape: shapeHash(shape) })
            .toEqual({ v: gameCodec.CODEC_V, shape: PINNED_SHAPE.game[gameCodec.CODEC_V] });
    }, 300000);

    test('a real tournament and its tables (lazy seats), every phase', async () => {
        Math.random = mulberry32(41);
        const shape = {};
        const gameShape = {};
        const failures = [];
        let tables = 0;
        const ctx = await setupTournament(6);
        require('../../../socket/tournamentHandlers').tournamentChat(ctx.sockets[1], ctx.io, { message: 'gl all' });
        const coverTournament = (label) => {
            const doc = tournamentCodec.serialize(ctx.t);
            if (!doc) {
                failures.push(`${label}: no doc (${tournamentCodec.refusal(ctx.t)})`);
                return;
            }
            const stored = JSON.parse(JSON.stringify(doc));
            tournamentDocShape(stored, shape);
            const bad = tournamentCoverage(ctx.t, stored, tournamentCodec.hydrate(stored).tournament);
            if (bad.length) failures.push(`${label}: ${bad.slice(0, 4).join(' | ')}`);
        };
        coverTournament('lobby');
        await playTournament(ctx, {
            round: async (round, cx, live) => {
                await jest.advanceTimersByTimeAsync(15000);
                coverTournament(`round ${round}`);
                for (const g of live) {
                    const bad = coverGame(g, gameShape);
                    if (!bad) continue;
                    tables++;
                    if (bad.length) failures.push(`round ${round} table ${g.gameId}: ${bad.slice(0, 4).join(' | ')}`);
                }
            },
        });
        coverTournament('complete');
        expect(failures).toEqual([]);
        expect(tables).toBeGreaterThan(0);
        expect(sortedKeys(shape)).toEqual(['doc', 'message', 'player', 'round', 'roundGame', 'roundGameEntry', 'state', 'tableScore', 'tableScoreScore', 'tableScoreSeat']);
        expect({ v: tournamentCodec.TOURNAMENT_CODEC_V, shape: shapeHash(shape) })
            .toEqual({ v: tournamentCodec.TOURNAMENT_CODEC_V, shape: PINNED_SHAPE.tournament[tournamentCodec.TOURNAMENT_CODEC_V] });
    }, 300000);
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

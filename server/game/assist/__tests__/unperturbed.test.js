/**
 * /help leaves a real game alone (plan §3.5, "unperturbed game"): a seeded
 * game through the real socket handlers (testUtils/avatarHarness: one human
 * seat + 3 lobby bots, fake timers, seeded Math.random) is played twice,
 * once plain and once with seatView + advise + explain (+ status) run for
 * EVERY seat at every updateTurn, synchronously inside the emit. Both runs
 * must send the same wire (every recipient, event and payload: the deals,
 * every bot decision, chat), at the same virtual times (the delays), keep
 * the same game log and score, and write the same game record.
 *
 * The advised run also checks, on the live handler-driven GameState, that
 * the advice for a Mary lobby bot's turn is the card or bid it then plays.
 */

const { createMemoryDb } = require('../../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));
jest.mock('uuid', () => {
    let n = 0;
    return {
        v4: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
        __reset: () => { n = 0; },
    };
});

beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/**
 * Play seed `seed` in a fresh module registry. With `advised`, run the
 * engine for all four seats at every updateTurn.
 */
async function play(seed, advised) {
    let out;
    await jest.isolateModulesAsync(async () => {
        require('uuid').__reset();
        jest.setSystemTime(Date.UTC(2026, 0, 1, 12));
        mockDb.current = createMemoryDb({ users: [] });
        const { gameLogger, socketLogger, authLogger, logger } = require('../../../utils/logger');
        for (const l of [gameLogger, socketLogger, authLogger, logger]) {
            for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
        }
        const { runGame } = require('../../../testUtils/avatarHarness');
        const { seatView } = require('../seatView');
        const { advise } = require('../advise');
        const { explain, status } = require('../explain');
        const { render } = require('../copy');
        const { botController } = require('../../bot');
        const stats = { turns: 0, answers: 0, statuses: 0, checked: 0, mismatches: [] };
        let pending = null;
        try {
            const r = await runGame(seed, {
                onEmit: (rec, ctx) => {
                    const game = ctx.game;
                    if (!advised || !game) return;
                    if (pending && (rec.event === 'bidReceived' || rec.event === 'cardPlayed') && rec.data.position === pending.pos) {
                        const got = rec.event === 'bidReceived' ? String(rec.data.bid) : `${rec.data.card.rank}${rec.data.card.suit}`;
                        const want = pending.d.kind === 'bid' ? pending.d.bid : `${pending.d.card.rank}${pending.d.card.suit}`;
                        stats.checked++;
                        if (got !== want) stats.mismatches.push({ pos: pending.pos, got, want });
                        pending = null;
                    }
                    if (rec.event !== 'updateTurn' || rec.to !== game.roomName) return;
                    stats.turns++;
                    for (let p = 1; p <= 4; p++) {
                        const v = seatView(game, p);
                        if (!v) continue;
                        const d = advise(v);
                        if (!d) {
                            status(v);
                            stats.statuses++;
                            continue;
                        }
                        const e = explain(d, v);
                        render(e, { style: 'line', uses: 1, freeUses: 3 });
                        stats.answers++;
                        const bot = botController.getBot(game.gameId, game.seat(p).seatSocketId);
                        if (bot && bot.personality === 'mary') pending = { pos: p, d };
                    }
                },
            });
            const records = await mockDb.current.gameRecords.find({}).toArray();
            out = {
                wire: r.wire.map((x) => `${x.to}|${(x.members || []).join(',')}|${x.event}|${JSON.stringify(x.data)}`),
                times: r.log.map((x) => `${x.at}|${x.event}`),
                gameLog: JSON.stringify(r.game.gameLog),
                score: r.game.score,
                records: JSON.stringify(records.map(({ _id, ...doc }) => doc)),
                stats,
            };
        } finally {
            require('../../../socket/errorHandler').rateLimiter.shutdown();
        }
    });
    return out;
}

describe('a game with /help asked at every turn plays exactly like a plain game', () => {
    test.each([[12], [13]])('seed %i (a Mary lobby bot at the table)', async (seed) => {
        const plain = await play(seed, false);
        const advised = await play(seed, true);
        expect(advised.stats.turns).toBeGreaterThan(300);
        expect(advised.stats.answers).toBeGreaterThan(300);
        expect(advised.stats.statuses).toBeGreaterThan(900);
        expect(advised.wire.length).toBe(plain.wire.length);
        expect(advised.wire).toEqual(plain.wire);
        expect(advised.times).toEqual(plain.times);
        expect(advised.gameLog).toBe(plain.gameLog);
        expect(advised.score).toEqual(plain.score);
        expect(advised.records).toBe(plain.records);
        expect(JSON.parse(plain.records)).toHaveLength(1);
        // Mary's turns: the advice on the live game is what she played
        expect(advised.stats.checked).toBeGreaterThan(100);
        expect(advised.stats.mismatches).toEqual([]);
    }, 300000);
});

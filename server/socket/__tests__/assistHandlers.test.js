/**
 * /help on the server (plan H2c; server/socket/assistHandlers.js): real
 * handlers, stub io and sockets (every emit contract-checked), fake timers.
 *
 *  - delivery: a socket with the clientHello cap `assist` gets assistHint,
 *    any other socket private gameLogEntry lines; nobody else gets either,
 *    and no private line is stored or in any viewer's snapshot
 *  - counting: the notice is stored, broadcast and named; a re-ask on the
 *    same turn, a forced move, the status line, every refusal and the rate
 *    limit are not counted; the 3rd use warns, the 4th crosses (and says so
 *    once); the defensive reset
 *  - ?help is intercepted exactly ("?help me" stays chat); spectators and
 *    entrants get their private line
 *  - the searched-answer budget (Quick suggestion, /health assist.quick),
 *    the error path
 *  - the bid clock: /help never stops, resets or delays it, and its timeout
 *    bid of 0 is not a use
 *  - the end-of-game line to the assisted player
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const snapshotHandlers = require('../snapshotHandlers');
const clientInfo = require('../clientInfo');
const assistHandlers = require('../assistHandlers');
const rateLimiter = require('../rateLimiter');
const SeatState = require('../../game/SeatState');
const pacing = require('../../game/pacing');
const { SEARCH } = require('../../game/bot/playSearch');
const { Phase } = require('../../game/GamePhase');
const { NAME_LINT, LINE_PREFIX } = require('../../game/assist/copy');
const { makeIo, makeSocket, events, legalCards, legalBids, mulberry32 } = require('../../testUtils/gameDriver');
const { world } = require('../../testUtils/contractScenarios');
const { advanceUntil } = require('../../testUtils/tournamentDriver');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

const { TEXT } = assistHandlers;
const realRandom = Math.random;
let errorLog;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    assistHandlers._resetForTests();
    errorLog = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => errorLog.push({ msg, meta }));
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    // per-socket limits (assist, chatMessage) must not leak between tests that reuse socket ids
    for (const sid of new Set([...rateLimiter.requests.keys()].map((k) => k.split(':')[0]))) rateLimiter.clearSocket(sid);
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.lobbies.keys())) gameManager.lobbies.delete(id);
    gameManager.spectatorGames.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});
afterAll(() => rateLimiter.shutdown());

// ------------------------------------------------------------ helpers

const CAP_HELLO = { client: 'web', version: '1.0.0', caps: ['assist'] };

/** A real casual game through the lobby, 4 humans, at its first open bid turn. */
async function lobbyGame(tag, { seed = 5 } = {}) {
    Math.random = mulberry32(seed);
    const w = world(tag);
    const names = ['ann', 'bob', 'cat', 'dan'].map((n) => `${tag}_${n}`);
    const socks = names.map((n, i) => w.user(`${tag}-h${i}`, n));
    mainRoomHandlers.createLobby(socks[0], w.io, { name: `${tag} table` });
    const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
    const pending = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
    await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
    const game = gameManager.getPlayerGame(socks[0].id);
    await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
    pending.push(...socks.map((s) => gameHandlers.draw(s, w.io, { num: 0 })));
    await advanceUntil(() => game.stage === Phase.BIDDING && !game.resume, 100);
    const owner = (pos) => w.sockets.get(game.seat(pos).ownerSocketId);
    const name = (pos) => game.seat(pos).ownerUsername;
    const say = (s, message) => chatHandlers.chatMessage(s, w.io, { message });
    const since = (mark) => w.log.slice(mark);
    /** Bid for the seat on turn (not all zero: no redeal). */
    const bid = () => {
        const bids = legalBids(game);
        return gameHandlers.playerBid(owner(game.currentTurn), w.io, { bid: bids.includes('1') ? '1' : bids.find((b) => /^\d+$/.test(b)) });
    };
    /** Play a legal card for the seat on turn, then let the trick resolve. */
    const play = async () => {
        const s = owner(game.currentTurn);
        await gameHandlers.playCard(s, w.io, { card: legalCards(game, s.id)[0] });
        await advanceUntil(() => game.stage === Phase.PLAYING || game.isTerminal() || game.stage === Phase.BIDDING, 100);
        await advanceUntil(() => !game.resume || game.isTerminal(), 100);
    };
    return { w, game, socks, owner, name, say, since, bid, play, pending };
}

/** Everything sent privately (not to the room) to anybody, from `mark`. */
const privateTo = (t, mark) => t.since(mark).filter((l) => !String(l.to).startsWith('game:') && !String(l.to).startsWith('self:'));

/**
 * A hand-built table (stub io, no lobby) in PLAYING with `cards` for every
 * seat, seat 1 to lead: for the forced move (one card) and searched plays
 * (2-7 cards).
 */
function playTable(cards) {
    const log = [];
    const io = makeIo(log);
    const sids = {};
    const sockets = {};
    for (let pos = 1; pos <= 4; pos++) {
        sids[pos] = `pt-p${pos}`;
        gameManager.registerUser(sids[pos], `pt_user${pos}`);
        mockDb.current.users._insert({ username: `pt_user${pos}`, profilePic: pos });
    }
    const game = gameManager.createGame([1, 2, 3, 4].map((p) => sids[p]));
    for (let pos = 1; pos <= 4; pos++) {
        game.addPlayer(sids[pos], `pt_user${pos}`, pos, pos, false);
        sockets[pos] = makeSocket(sids[pos], log, io);
        sockets[pos].join(game.roomName);
        game.setHand(game.positions[pos], cards[pos]);
    }
    game.currentHand = cards[1].length;
    game.trump = { suit: 'hearts', rank: '2' };
    game.forcePhase(Phase.PLAYING);
    game.playerBids = ['1', '0', '1', '0'];
    game.dealer = 4;
    game.bidder = 1;
    game.currentTurn = 1;
    const say = (pos, message) => chatHandlers.chatMessage(sockets[pos], io, { message });
    return { log, io, game, sockets, say };
}
const C = (rank, suit) => ({ rank, suit });

// ------------------------------------------------------------ delivery

test('cap socket: assistHint; no-cap socket: private lines; nobody else gets either; the notice is stored and named', async () => {
    const t = await lobbyGame('dl');
    const { game } = t;
    const p1 = game.currentTurn;
    const p2 = (p1 % 4) + 1;
    clientInfo.handle(t.owner(p1), t.w.io, CAP_HELLO);

    let mark = t.w.log.length;
    t.say(t.owner(p1), '/help');
    const priv = privateTo(t, mark);
    expect(priv.map((l) => [l.to, l.event])).toEqual([[t.owner(p1).id, 'assistHint']]);
    const hint = priv[0].data;
    expect(hint).toMatchObject({ v: 1, source: 'help', kind: 'bid', turnKey: game.turnKey(), uses: 1, freeUses: 3, assisted: false, counted: true });
    expect(hint.suggest).toEqual({ bid: expect.any(String) });
    expect(hint.headline).toMatch(/^Bid /);
    expect(hint.reasons.length).toBeGreaterThanOrEqual(1);
    expect(hint).not.toHaveProperty('note');
    // the room line, stored and named; no chat
    const room = t.since(mark).filter((l) => l.to === game.roomName);
    expect(room.map((l) => [l.event, l.data.message])).toEqual([['gameLogEntry', `${t.name(p1)} used /help.`]]);
    expect(room[0].data.seq).toEqual(expect.any(Number));
    expect(game.gameLog.at(-1)).toMatchObject({ message: `${t.name(p1)} used /help.`, type: 'system', playerPosition: null });
    expect(game.assist[p1]).toMatchObject({ user: t.name(p1), help: 1, lastHelpKey: game.turnKey() });

    // the bid goes in; the next seat (no cap) types ?help
    await t.bid();
    mark = t.w.log.length;
    t.say(t.owner(p2), '  ?HELP ');
    const lines = privateTo(t, mark);
    expect(lines.map((l) => [l.to, l.event])).toEqual([[t.owner(p2).id, 'gameLogEntry']]);
    expect(lines[0].data.type).toBe('system');
    expect(lines[0].data).not.toHaveProperty('seq');
    expect(lines[0].data.message.startsWith(LINE_PREFIX)).toBe(true);
    expect(lines[0].data.message).toMatch(/\(Help 1 of 3 free\)$/);
    expect(lines[0].data.message.length).toBeLessThanOrEqual(200);
    expect(t.since(mark).filter((l) => l.to === game.roomName).map((l) => l.data.message)).toEqual([`${t.name(p2)} used /help.`]);
    // the private lines never went into the log
    expect(game.gameLog.some((e) => e.message.startsWith(LINE_PREFIX))).toBe(false);
    expect(events(t.w.log, 'chatMessage')).toEqual([]);
    for (const l of [...events(t.w.log, 'gameLogEntry'), ...events(t.w.log, 'assistHint')]) {
        expect(JSON.stringify(l.data)).not.toMatch(NAME_LINT);
    }
    await Promise.all(t.pending);
});

test('private lines are in no snapshot (players, spectator); the notices are', async () => {
    const t = await lobbyGame('sn');
    const { game } = t;
    const spec = t.w.user('sn-spec', 'sn_fan');
    mainRoomHandlers.joinAsSpectator(spec, t.w.io, { gameId: game.gameId });
    const p1 = game.currentTurn;
    t.say(t.owner(p1), '?help');
    t.say(t.owner((p1 % 4) + 1), '?help');      // off turn: the status line
    t.say(spec, '?help');                       // players only
    const privateMessages = privateTo(t, 0).filter((l) => l.event === 'gameLogEntry').map((l) => l.data.message);
    expect(privateMessages).toHaveLength(3);
    for (const viewer of [...t.socks, spec]) {
        const mark = t.w.log.length;
        snapshotHandlers.requestSnapshot(viewer, t.w.io, { requestId: 'x' });
        const snap = t.w.log.slice(mark).find((l) => l.event === 'stateSnapshot').data.snapshot;
        const text = JSON.stringify(snap.log);
        for (const m of privateMessages) expect(text).not.toContain(m);
        expect(text).toContain(`${t.name(p1)} used /help.`);
    }
    await Promise.all(t.pending);
});

// ------------------------------------------------------------ counting

test('re-ask on the same turn: the same answer, not counted, no second notice', async () => {
    const t = await lobbyGame('ra');
    const p1 = t.game.currentTurn;
    clientInfo.handle(t.owner(p1), t.w.io, CAP_HELLO);
    t.say(t.owner(p1), '/help');
    const mark = t.w.log.length;
    t.say(t.owner(p1), '?help');
    t.say(t.owner(p1), '/help');
    const again = privateTo(t, mark);
    expect(again.map((l) => l.data.counted)).toEqual([false, false]);
    const first = events(t.w.log, 'assistHint')[0].data;
    expect(again[0].data).toEqual({ ...first, counted: false });
    expect(t.since(mark).filter((l) => l.to === t.game.roomName)).toEqual([]);
    expect(t.game.assist[p1].help).toBe(1);
    await Promise.all(t.pending);
});

test('3rd use warns (second private line), 4th crosses: the room says so once, later uses read normally', async () => {
    const t = await lobbyGame('cr', { seed: 11 });
    const { game } = t;
    const asker = game.currentTurn;
    const lines = [];
    const notices = [];
    let uses = 0;
    // one counted use per own turn, through bidding and into play
    while (uses < 5) {
        if (game.stage === Phase.BIDDING || game.stage === Phase.PLAYING) {
            if (game.currentTurn === asker) {
                rateLimiter.clearSocket(t.owner(asker).id);   // turns come faster than 4 per 10 s here
                const mark = t.w.log.length;
                t.say(t.owner(asker), '?help');
                const got = privateTo(t, mark).map((l) => l.data.message);
                if (got[0] && !got[0].endsWith('(Not counted.)')) {
                    uses++;
                    lines.push(got);
                    notices.push(...t.since(mark).filter((l) => l.to === game.roomName).map((l) => l.data.message));
                }
            }
            if (game.stage === Phase.BIDDING) await t.bid();
            else await t.play();
        } else {
            await jest.advanceTimersByTimeAsync(500);
        }
    }
    expect(lines.map((l) => l.length)).toEqual([1, 1, 2, 1, 1]);
    expect(lines[0][0]).toMatch(/\(Help 1 of 3 free\)$/);
    expect(lines[2][0]).toMatch(/\(Help 3 of 3 free\)$/);
    expect(lines[2][1]).toBe(TEXT.warning);
    expect(lines[3][0]).toMatch(/\(Help 4: this game counts as bot-assisted for you\)$/);
    expect(lines[4][0]).toMatch(/\(Help 5: this game counts as bot-assisted for you\)$/);
    const n = t.name(asker);
    expect(notices).toEqual([
        `${n} used /help.`, `${n} used /help.`, `${n} used /help.`,
        `${n} used /help. This game now counts as bot-assisted for ${n}.`,
        `${n} used /help.`,
    ]);
    expect(game.assist[asker].help).toBe(5);
    expect(TEXT.warning).toBe('That\'s your 3rd free /help. The next one makes this game count as bot-assisted for you: it goes in your bot-game stats, not the human leaderboard.');
    await Promise.all(t.pending);
});

test('with the cap: the warning and the crossing ride in note; assisted flips on the 4th', async () => {
    const t = await lobbyGame('cn', { seed: 12 });
    const { game } = t;
    const asker = game.currentTurn;
    clientInfo.handle(t.owner(asker), t.w.io, CAP_HELLO);
    const counted = [];
    while (counted.length < 4) {
        if (game.stage === Phase.BIDDING || game.stage === Phase.PLAYING) {
            if (game.currentTurn === asker) {
                rateLimiter.clearSocket(t.owner(asker).id);
                const mark = t.w.log.length;
                t.say(t.owner(asker), '/help');
                const h = privateTo(t, mark)[0]?.data;
                if (h && h.counted) counted.push(h);
            }
            if (game.stage === Phase.BIDDING) await t.bid();
            else await t.play();
        } else {
            await jest.advanceTimersByTimeAsync(500);
        }
    }
    expect(counted.map((h) => [h.uses, h.assisted, h.note ?? null])).toEqual([
        [1, false, null], [2, false, null], [3, false, TEXT.warning], [4, true, TEXT.crossedNote],
    ]);
    await Promise.all(t.pending);
});

test('not counted: the status line, a bot-controlled seat, no open turn, the rate limit, a forced move', async () => {
    const t = await lobbyGame('nc');
    const { game } = t;
    const p1 = game.currentTurn;
    const p2 = (p1 % 4) + 1;
    clientInfo.handle(t.owner(p2), t.w.io, CAP_HELLO);
    // off turn, without and with the cap
    let mark = t.w.log.length;
    t.say(t.owner(p1 === 1 ? 3 : 1), '?help');
    t.say(t.owner(p2), '/help');
    const st = privateTo(t, mark);
    expect(st[0].data.message).toMatch(new RegExp(`^Not your turn yet: ${t.name(p1)} is bidding\\.`));
    expect(st[1].data).toMatchObject({ kind: 'status', counted: false, uses: 0, reasons: [] });
    expect(st[1].data.headline).toMatch(/^Not your turn yet: /);
    // a bot-controlled seat (lazy, in seat view)
    const lazyPos = p1 === 1 ? 3 : 1;
    t.say(t.owner(lazyPos), '/lazy');
    mark = t.w.log.length;
    t.say(t.owner(lazyPos), '/help');
    t.say(t.owner(lazyPos), '?help');
    expect(privateTo(t, mark).map((l) => l.data.message)).toEqual([TEXT.botSeat, TEXT.botSeat]);
    t.say(t.owner(lazyPos), '/active');
    // the rate limit: 4 per 10 s per socket (status lines spend it too)
    mark = t.w.log.length;
    for (let i = 0; i < 5; i++) t.say(t.owner(p1), '/help');
    const rl = privateTo(t, mark).map((l) => l.data.message);
    expect(rl[4]).toBe(TEXT.rateLimited);
    expect(rl.slice(1, 4).every((m) => m === rl[0])).toBe(true);   // re-asks: the cached answer
    jest.advanceTimersByTime(10000);
    // nothing in the room but the one counted use; nobody else counted
    expect(events(t.w.log, 'gameLogEntry').filter((l) => l.to === game.roomName && /used \/help/.test(l.data.message)).map((l) => l.data.message))
        .toEqual([`${t.name(p1)} used /help.`]);
    expect([1, 2, 3, 4].map((p) => game.assist[p].help)).toEqual([1, 2, 3, 4].map((p) => (p === p1 ? 1 : 0)));
    // no open turn (a trick on view)
    while (game.stage === Phase.BIDDING) await t.bid();
    for (let i = 0; i < 4; i++) {
        const s = t.owner(game.currentTurn);
        await gameHandlers.playCard(s, t.w.io, { card: legalCards(game, s.id)[0] });
    }
    expect(game.acceptsTurnInput()).toBe(false);
    mark = t.w.log.length;
    t.say(t.owner(1), '?help');
    expect(privateTo(t, mark).map((l) => l.data.message)).toEqual([TEXT.nothing]);
    expect([1, 2, 3, 4].map((p) => game.assist[p].help)).toEqual([1, 2, 3, 4].map((p) => (p === p1 ? 1 : 0)));
    await Promise.all(t.pending);
});

test('a forced move (one legal card): one line, "(Not counted.)", no notice', () => {
    const t = playTable({ 1: [C('A', 'spades')], 2: [C('K', 'clubs')], 3: [C('Q', 'diamonds')], 4: [C('3', 'spades')] });
    t.say(1, '?help');
    const lines = t.log.filter((l) => l.to === 'pt-p1');
    expect(lines).toHaveLength(1);
    expect(lines[0].data.message).toBe('Suggested (only you see this): Lead A♠. It\'s your last card. (Not counted.)');
    expect(t.log.filter((l) => l.to === t.game.roomName)).toEqual([]);
    expect(t.game.assist[1]).toMatchObject({ help: 0, user: null, lastHelpKey: null });
});

test('the counter moves before the notice: the first persist hook after a counted use already sees it', async () => {
    const t = await lobbyGame('ph');
    const hooks = require('../../game/persist/hooks');
    const p1 = t.game.currentTurn;
    const seen = [];
    const listeners = { game: (g) => { if (g === t.game) seen.push(g.assist[p1].help); } };
    hooks.setListeners(listeners);
    try {
        t.say(t.owner(p1), '?help');
    } finally {
        hooks.clearListeners(listeners);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => n === 1)).toBe(true);
    await Promise.all(t.pending);
});

test('the defensive reset: a record that belongs to someone else starts again for the owner', async () => {
    const t = await lobbyGame('dr');
    const p1 = t.game.currentTurn;
    Object.assign(t.game.assist[p1], { user: 'somebody_else', help: 7, lastHelpKey: t.game.turnKey() });
    const mark = t.w.log.length;
    t.say(t.owner(p1), '?help');
    expect(t.game.assist[p1]).toMatchObject({ user: t.name(p1), help: 1, lastHelpKey: t.game.turnKey() });
    expect(privateTo(t, mark)[0].data.message).toMatch(/\(Help 1 of 3 free\)$/);
    await Promise.all(t.pending);
});

// ------------------------------------------------------------ keywords, roles

test('?help is the exact line only: "?help me", "help!" and "?helpme" stay chat', async () => {
    const t = await lobbyGame('kw');
    const p1 = t.game.currentTurn;
    for (const m of ['?help me', 'help!', '?helpme', 'help']) t.say(t.owner(p1), m);
    expect(events(t.w.log, 'chatMessage').map((l) => l.data.message)).toEqual(['?help me', 'help!', '?helpme', 'help']);
    expect(t.game.assist[p1].help).toBe(0);
    t.say(t.owner(p1), '?Help');
    expect(events(t.w.log, 'chatMessage')).toHaveLength(4);
    expect(t.game.assist[p1].help).toBe(1);
    // /help with words after it is still /help (never "Unknown command")
    t.say(t.owner(p1), '/help me please');
    expect(events(t.w.log, 'serverError')).toEqual([]);
    await Promise.all(t.pending);
});

test('spectators and entrants: a private line, never chat, never counted', async () => {
    const t = await lobbyGame('sp');
    const spec = t.w.user('sp-spec', 'sp_fan');
    mainRoomHandlers.joinAsSpectator(spec, t.w.io, { gameId: t.game.gameId });
    clientInfo.handle(spec, t.w.io, CAP_HELLO);
    const mark = t.w.log.length;
    t.say(spec, '?help');
    t.say(spec, '/help');
    const got = privateTo(t, mark);
    expect(got.map((l) => [l.to, l.event, l.data.headline])).toEqual([
        [spec.id, 'assistHint', TEXT.spectator], [spec.id, 'assistHint', TEXT.spectator],
    ]);
    expect(t.since(mark).filter((l) => l.event === 'chatMessage' || l.to === t.game.roomName)).toEqual([]);
    await Promise.all(t.pending);
});

test('an entrant during the draw: "/help works once the game starts."', async () => {
    // an entrant during the draw
    Math.random = mulberry32(3);
    const w = world('en');
    const socks = ['en_a', 'en_b', 'en_c', 'en_d'].map((n, i) => w.user(`en-h${i}`, n));
    mainRoomHandlers.createLobby(socks[0], w.io, { name: 'draw' });
    const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
    const ready = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
    await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
    const game = gameManager.getPlayerGame(socks[0].id);
    expect(game.isPreSeating()).toBe(true);
    const m2 = w.log.length;
    chatHandlers.chatMessage(socks[1], w.io, { message: '/help' });
    chatHandlers.chatMessage(socks[1], w.io, { message: '?help' });
    expect(w.log.slice(m2).map((l) => [l.to, l.event, l.data.message])).toEqual([
        [socks[1].id, 'gameLogEntry', TEXT.entrant], [socks[1].id, 'gameLogEntry', TEXT.entrant],
    ]);
    await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
    const draws = socks.map((s) => gameHandlers.draw(s, w.io, { num: 0 }));
    await advanceUntil(() => game.stage === Phase.BIDDING && !game.resume, 100);
    await Promise.all([...ready, ...draws]);
}, 20000);

// ------------------------------------------------------------ budget, errors

const SEARCH_HANDS = {
    1: [C('A', 'spades'), C('9', 'clubs'), C('4', 'diamonds')],
    2: [C('K', 'spades'), C('10', 'clubs'), C('5', 'diamonds')],
    3: [C('Q', 'spades'), C('J', 'clubs'), C('6', 'diamonds')],
    4: [C('2', 'spades'), C('3', 'clubs'), C('7', 'diamonds')],
};

test('the budget: out of searched answers, a Quick suggestion (rules only, not cached, /health quick); then the full one', () => {
    expect(SEARCH.maxCards).toBeGreaterThanOrEqual(3);
    const t = playTable(SEARCH_HANDS);
    clientInfo.handle(t.sockets[1], t.io, CAP_HELLO);
    assistHandlers._resetForTests({ perSec: 0 });
    t.say(1, '/help');
    let hint = t.log.filter((l) => l.event === 'assistHint').at(-1).data;
    expect(hint.confidence).toBe('quick');
    expect(hint.counted).toBe(true);
    expect(assistHandlers.assistHealth()).toEqual({ answered: 1, quick: 1, errors: 0 });
    // the line style says so too
    clientInfo.handle(t.sockets[1], t.io, { client: 'web', version: '1.0.0', caps: [] });
    t.say(1, '?help');
    expect(t.log.at(-1).data.message).toMatch(/^Quick suggestion, rules only \(only you see this\): /);
    expect(assistHandlers.assistHealth().quick).toBe(2);   // not cached: asked again
    // budget back: the searched answer (and the use was already counted)
    assistHandlers._resetForTests();
    clientInfo.handle(t.sockets[1], t.io, CAP_HELLO);
    t.say(1, '/help');
    hint = t.log.filter((l) => l.event === 'assistHint').at(-1).data;
    expect(hint.confidence).not.toBe('quick');
    expect(hint).toMatchObject({ counted: false, uses: 1 });
    expect(t.game.assist[1].help).toBe(1);
});

test('the bucket: 60 a second, refilling continuously', () => {
    let now = 0;
    const b = assistHandlers.createBudget({ perSec: 60, now: () => now });
    let n = 0;
    while (b.take()) n++;
    expect(n).toBe(60);
    now += 500;
    n = 0;
    while (b.take()) n++;
    expect(n).toBe(30);
    now += 60_000;
    n = 0;
    while (b.take()) n++;
    expect(n).toBe(60);
});

test('the error path: "No suggestion this time.", not counted, logged without cards', () => {
    const t = playTable(SEARCH_HANDS);
    jest.spyOn(t.game, 'getHand').mockImplementation(() => { throw new Error('boom'); });
    t.say(1, '?help');
    expect(t.log.filter((l) => l.to === 'pt-p1').map((l) => l.data.message)).toEqual([TEXT.error]);
    expect(t.game.assist[1].help).toBe(0);
    expect(t.log.filter((l) => l.to === t.game.roomName)).toEqual([]);
    expect(assistHandlers.assistHealth().errors).toBe(1);
    expect(errorLog.map((e) => e.msg)).toEqual(['/help failed']);
    expect(JSON.stringify(errorLog)).not.toMatch(/spades|clubs|diamonds|hearts/);
});

test('a search error goes to /help\'s own logger (sizes only), never to SEARCH.errors; the rule card is suggested', () => {
    const t = playTable(SEARCH_HANDS);
    jest.isolateModules(() => {
        jest.doMock('../../game/bot/playSearch', () => {
            const real = jest.requireActual('../../game/bot/playSearch');
            return { ...real, searchCard: () => { throw new TypeError('forced search failure'); } };
        });
        const isolated = require('../assistHandlers');
        const { SEARCH: S } = require('../../game/bot/playSearch');
        const { gameLogger: gl } = require('../../utils/logger');
        const warn = jest.spyOn(gl, 'warn').mockImplementation(() => {});
        const before = S.errors;
        expect(isolated.help(t.sockets[1], t.io, t.game, 1)).toBe('counted');
        const line = t.log.filter((l) => l.to === 'pt-p1').at(-1).data.message;
        expect(line.startsWith(LINE_PREFIX)).toBe(true);
        expect(S.errors).toBe(before);
        expect(warn).toHaveBeenCalledWith('/help search error', { gameId: t.game.gameId, cardsInHand: 3, handSize: 3, error: 'TypeError' });
    });
});

// ------------------------------------------------------------ the bid clock

test('the bid clock: /help never stops, resets or delays it; the timeout bid of 0 is not a use', async () => {
    const t = await lobbyGame('bc', { seed: 9 });
    const { game } = t;
    const p1 = game.currentTurn;
    const clock = () => events(t.w.log, 'bidClock').map((l) => (l.data.running ? `running:${l.data.position}` : `${l.data.reason}:${l.data.position}`));
    await jest.advanceTimersByTimeAsync(SeatState.BID_CLOCK_DELAY_MS);
    expect(clock()).toEqual([`running:${p1}`]);
    const runningAt = events(t.w.log, 'bidClock')[0].at;
    // three asks mid-tune (one counted), from the bidder and its partner
    await jest.advanceTimersByTimeAsync(5000);
    t.say(t.owner(p1), '?help');
    t.say(t.owner(p1), '/help');
    t.say(t.owner(((p1 + 1) % 4) + 1), '?help');
    expect(clock()).toEqual([`running:${p1}`]);
    // the deadline is the one it announced
    await jest.advanceTimersByTimeAsync(SeatState.BID_CLOCK_MS - 5000 - 1);
    expect(game.playerBids[p1 - 1]).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(game.playerBids[p1 - 1]).toBe('0');
    expect(events(t.w.log, 'bidReceived').at(-1).at - runningAt).toBe(SeatState.BID_CLOCK_MS);
    expect(clock()).toEqual([`running:${p1}`, `timeout:${p1}`]);
    expect([1, 2, 3, 4].map((p) => game.assist[p].help)).toEqual([1, 2, 3, 4].map((p) => (p === p1 ? 1 : 0)));
    expect(events(t.w.log, 'gameLogEntry').filter((l) => l.to === game.roomName).map((l) => l.data.message))
        .toEqual([`${t.name(p1)} used /help.`, `${t.name(p1)} ran out of time.`]);
    await Promise.all(t.pending);
});

// ------------------------------------------------------------ game end

test('game end: the assisted player (and only they) get the private line before gameEnd', async () => {
    const t = await lobbyGame('ge', { seed: 21 });
    const { game } = t;
    const asker = game.currentTurn;
    let uses = 0;
    // 4 counted uses, then every human goes /lazy and the bots finish
    while (uses < 4) {
        if (game.stage === Phase.BIDDING || game.stage === Phase.PLAYING) {
            if (game.currentTurn === asker) {
                rateLimiter.clearSocket(t.owner(asker).id);
                t.say(t.owner(asker), '?help');
                uses = game.assist[asker].help;
            }
            if (game.stage === Phase.BIDDING) await t.bid();
            else await t.play();
        } else {
            await jest.advanceTimersByTimeAsync(500);
        }
    }
    for (let p = 1; p <= 4; p++) t.say(t.owner(p), '/lazy');
    const endSocket = t.owner(asker).id;
    await advanceUntil(() => game.isTerminal(), 1000, 3_600_000);
    const end = t.w.log.findIndex((l) => l.event === 'gameEnd');
    const line = t.w.log.findIndex((l) => l.event === 'gameLogEntry' && l.to === endSocket && l.data.message === TEXT.gameEnd(4));
    expect(line).toBeGreaterThan(-1);
    expect(line).toBeLessThan(end);
    expect(t.w.log.filter((l) => l.event === 'gameLogEntry' && /counted as bot-assisted for you/.test(l.data.message)).map((l) => l.to)).toEqual([endSocket]);
    expect(TEXT.gameEnd(4)).toBe('This game counted as bot-assisted for you (4 /help uses), so it\'s in your bot-game stats.');
    await Promise.all(t.pending);
}, 60000);

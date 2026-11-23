/**
 * The tutorial on the server (the LEAN scope of 2026-11-19 with the
 * fade-out; server/socket/assistHandlers.js, server/game/assist/curriculum.js):
 * real handlers, stub io and sockets (every emit contract-checked), fake
 * timers.
 *
 *  - /tutorial toggles, /tutorial on|off sets, /tutorial keep and close are silent;
 *    the notices (human-only game: "... This game counts as bot-assisted
 *    for <name>."), the private off line, already-on / already-off, usage
 *  - refusals: spectators, entrants, a lazy owner; ?tutorial stays chat
 *  - while on: the welcome tip, one rule tip per own decision, the advice
 *    (the /help answer, source tutorial, never counted, never a room
 *    notice), pushed after the updateTurn; /help is answered, not counted
 *  - the auto-start: only 'pending' + the cap tutorial + a casual table
 *    (not without the cap, not for another flag, not at a tournament);
 *    the first own decision makes the game bot-assisted (once, with the
 *    room line); turned off before it: not assisted, users.tutorial
 *    'dismissed'; keep: still pending, still on (a kept game then aborted
 *    auto-starts the next one); close (the welcome's ✕): dismissed, still on
 *  - a game with a native bot seat: no limit or bot-assisted words, the
 *    record still marks it
 *  - the re-push on a rejoin and on /active
 *  - a finished game sets 'done' (and its fade-out, measured) for the owners
 *    still at the table, not for a dropped, force-resigned one; an aborted
 *    one keeps 'pending'
 *  - away, lazy or on an app without the cap at the end of the 2-card hand:
 *    graduated anyway, T.graduate with the next capable socket; nothing is
 *    pushed to a socket without the cap
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

jest.setTimeout(30000);

const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const snapshotHandlers = require('../snapshotHandlers');
const seatLifecycle = require('../seatLifecycle');
const tournamentHandlers = require('../tournamentHandlers');
const clientInfo = require('../clientInfo');
const assistHandlers = require('../assistHandlers');
const rateLimiter = require('../rateLimiter');
const pacing = require('../../game/pacing');
const profile = require('../profileHandlers');
const { Phase } = require('../../game/GamePhase');
const { HAND_PROGRESSION } = require('../../game/rules');
const curriculum = require('../../game/assist/curriculum');
const { legalCards, legalBids, mulberry32 } = require('../../testUtils/gameDriver');
const { world } = require('../../testUtils/contractScenarios');
const { advanceUntil, setupTournament, liveTables } = require('../../testUtils/tournamentDriver');
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
    for (const sid of new Set([...rateLimiter.requests.keys()].map((k) => k.split(':')[0]))) rateLimiter.clearSocket(sid);
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    for (const id of Array.from(gameManager.lobbies.keys())) gameManager.lobbies.delete(id);
    gameManager.spectatorGames.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});
afterAll(() => rateLimiter.shutdown());

// ------------------------------------------------------------ helpers

const CAPS = { client: 'web', version: '1.0.0', caps: ['assist', 'tutorial'] };
/** The tutor's setImmediate (fake timers: a 0 ms step does not reach it). */
const flush = () => jest.advanceTimersByTimeAsync(1);

/**
 * A real casual game through the lobby, 4 humans (or `bots` native bots
 * from Add Bot), at its first open bid turn. `prep(socks)` runs before the
 * lobby starts (flags, caps); `pending` names get users.tutorial 'pending'.
 */
async function lobbyGame(tag, { seed = 5, bots = 0, prep = null, pending = [] } = {}) {
    Math.random = mulberry32(seed);
    const w = world(tag);
    const names = ['ann', 'bob', 'cat', 'dan'].slice(0, 4 - bots).map((n) => `${tag}_${n}`);
    for (const n of names) mockDb.current.users._insert({ username: n, profilePic: 7, ...(pending.includes(n) ? { tutorial: 'pending' } : {}) });
    const socks = names.map((n, i) => w.user(`${tag}-h${i}`, n));
    for (const s of socks) if (pending.includes(gameManager.getUserBySocketId(s.id).username)) s.data.tutorialFlag = 'pending';
    if (prep) prep(socks, w);
    mainRoomHandlers.createLobby(socks[0], w.io, { name: `${tag} table` });
    const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
    for (let i = 0; i < bots; i++) await lobbyHandlers.addBot(socks[0], w.io);
    const pendingP = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
    await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
    const game = gameManager.getPlayerGame(socks[0].id);
    await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
    pendingP.push(...socks.map((s) => gameHandlers.draw(s, w.io, { num: 0 })));
    await advanceUntil(() => game.stage === Phase.BIDDING && !game.resume, 100);
    await flush();
    const owner = (pos) => w.sockets.get(game.seat(pos).ownerSocketId);
    const name = (pos) => game.seat(pos).ownerUsername;
    const posOf = (s) => game.seatByOwnerSocket(s.id);
    const say = (s, message) => chatHandlers.chatMessage(s, w.io, { message });
    const since = (mark) => w.log.slice(mark);
    /** One move by the human on turn (a legal number bid, the first legal card), then the next open turn. */
    const move = async (pick = null) => {
        const s = owner(game.currentTurn);
        if (game.stage === Phase.BIDDING) {
            const bids = legalBids(game);
            await gameHandlers.playerBid(s, w.io, { bid: pick || (bids.includes('1') ? '1' : bids.find((b) => /^\d+$/.test(b))) });
        } else {
            await gameHandlers.playCard(s, w.io, { card: pick || legalCards(game, s.id)[0] });
        }
        await flush();
        await advanceUntil(() => game.isTerminal() || (game.acceptsTurnInput() && !game.resume), 100);
        await flush();
    };
    return { w, game, socks, owner, name, posOf, say, since, move, pending: pendingP };
}

const hintsTo = (t, sid, mark) => t.since(mark).filter((l) => l.event === 'assistHint' && l.to === sid).map((l) => l.data);
const roomLines = (t, mark) => t.since(mark).filter((l) => l.event === 'gameLogEntry' && l.to === t.game.roomName).map((l) => l.data.message);
// the live tag on the tutorial's room lines (the avatar's graduation cap, 2026-11-23)
const roomTags = (t, mark) => t.since(mark).filter((l) => l.event === 'gameLogEntry' && l.to === t.game.roomName).map((l) => l.data.tutorial ?? null);
const seatTutorial = (t, sid) => t.game.getSnapshotV2(sid).seats.map((x) => x.tutorial === true);
const statesTo = (t, sid, mark) => t.since(mark).filter((l) => l.event === 'assistState' && l.to === sid).map((l) => l.data);
const userDoc = (name) => mockDb.current.users.docs.find((d) => d.username === name);

// ------------------------------------------------------------ the toggle

test('/tutorial on (human-only game): the notice, the welcome tip, a rule tip and the advice; never counted; /tutorial toggles off', async () => {
    const t = await lobbyGame('tm');
    const { game } = t;
    const p = game.currentTurn;
    const s = t.owner(p);
    clientInfo.handle(s, t.w.io, CAPS);

    let mark = t.w.log.length;
    t.say(s, '/tutorial on');
    expect(roomLines(t, mark)).toEqual([`${t.name(p)} turned on the tutorial. This game counts as bot-assisted for ${t.name(p)}.`]);
    expect(roomTags(t, mark)).toEqual([{ position: p, on: true }]);
    // stored with its tag too (a replay draws it in the cap's colour); every viewer's snapshot seats carry the state
    expect(game.gameLog.at(-1)).toMatchObject({ tutorial: { position: p, on: true } });
    const other = t.owner((p % 4) + 1);
    expect(game.getSnapshotV2(other.id).log.at(-1)).toMatchObject({ tutorial: { position: p, on: true } });
    expect(seatTutorial(t, other.id)).toEqual([1, 2, 3, 4].map((q) => q === p));
    expect(game.getSnapshotV2(other.id).seats.every((x) => !('askedHelp' in x))).toBe(true);
    const h = hintsTo(t, s.id, mark);
    expect(h.map((x) => [x.source, x.kind, x.tipId || null])).toEqual([
        ['tutorial', 'tip', 'T.welcome'],
        // the first bidder's first bid: the decision-only T.bid (T.trump waits for a between moment)
        ['tutorial', 'tip', 'T.bid'],
        ['tutorial', 'bid', null]
    ]);
    expect(h[0]).toMatchObject({ headline: 'Tutorial on', reasons: [curriculum.SYSTEM_TIPS['T.welcome'].text], actions: ['keep', 'off'], counted: false });
    expect(h[1]).not.toHaveProperty('actions');
    expect(h[2]).toMatchObject({ counted: false, uses: 0, assisted: true, turnKey: game.turnKey(), suggest: { bid: expect.any(String) } });
    expect(statesTo(t, s.id, mark).at(-1)).toEqual({ tutorial: true, auto: false, uses: 0, freeUses: 3, assisted: true });
    expect(game.assist[p]).toMatchObject({ user: t.name(p), tutorial: true, auto: false, tutorialEver: true, help: 0 });
    // the welcome and the bidding tip are remembered (once per game)
    expect(curriculum.has(game.assist[p].tips, 'T.welcome')).toBe(true);

    // a reload knows (snapshot viewer.assist)
    mark = t.w.log.length;
    snapshotHandlers.requestSnapshot(s, t.w.io, {});
    const snap = t.since(mark).find((l) => l.event === 'stateSnapshot').data.snapshot;
    expect(snap.viewer.assist).toEqual({ uses: 0, freeUses: 3, assisted: true, tutorial: true });

    // already on; usage; /help answered but never counted while it is on
    mark = t.w.log.length;
    t.say(s, '/tutorial on');
    t.say(s, '/tutorial please');
    expect(hintsTo(t, s.id, mark).map((x) => [x.source, x.kind, x.headline])).toEqual([
        ['tutorial', 'status', TEXT.tutorialAlreadyOn], ['tutorial', 'status', TEXT.tutorialUsage]
    ]);
    rateLimiter.clearSocket(s.id);
    expect(assistHandlers.help(s, t.w.io, game, p)).toBe('tutorial');
    expect(hintsTo(t, s.id, mark).at(-1)).toMatchObject({ source: 'help', kind: 'bid', counted: false, uses: 0 });
    expect(roomLines(t, mark)).toEqual([]);
    expect(game.assist[p].help).toBe(0);

    // toggle: off
    rateLimiter.clearSocket(s.id);
    mark = t.w.log.length;
    t.say(s, '/tutorial');
    expect(hintsTo(t, s.id, mark).map((x) => [x.source, x.kind, x.headline])).toEqual([['tutorial', 'status', 'Tips off. /help still works any time.']]);
    expect(roomLines(t, mark)).toEqual([`${t.name(p)} turned off the tutorial.`]);
    expect(roomTags(t, mark)).toEqual([{ position: p, on: false }]);
    expect(game.getSnapshotV2(other.id).log.at(-1)).toMatchObject({ message: `${t.name(p)} turned off the tutorial.`, tutorial: { position: p, on: false } });
    expect(seatTutorial(t, other.id)).toEqual([false, false, false, false]);
    expect(game.getSnapshotV2(other.id).seats.every((x) => !('tutorial' in x))).toBe(true);
    expect(statesTo(t, s.id, mark)).toEqual([{ tutorial: false, auto: false, uses: 0, freeUses: 3, assisted: true }]);
    expect(game.assist[p]).toMatchObject({ tutorial: false, tutorialEver: true });
    t.say(s, '/tutorial off');
    expect(hintsTo(t, s.id, mark).at(-1).headline).toBe(TEXT.tutorialAlreadyOff);
    // nothing is pushed while off
    mark = t.w.log.length;
    for (let i = 0; i < 4; i++) await t.move();
    expect(hintsTo(t, s.id, mark)).toEqual([]);
    // the record marks the seat (the tutorial was on), and moves it only
    // when its team won (owner 2026-11-21)
    const team = p % 2 === 1 ? 1 : 2;
    game.score = team === 1 ? { team1: 310, team2: 120 } : { team1: 120, team2: 310 };
    const record = profile.buildGameEndRecord(game);
    expect(record.statsDeltas.assist).toEqual({ [p]: { help: 0, tutorial: true } });
    expect(record.statsDeltas.bucketByPosition).toEqual({ [p]: 'botStats' });
    expect(record.assistedTeams).toEqual([team]);
    expect(record.withBots).toBe(true);
    // the same seat's team lost: a plain human game, the evidence kept
    game.score = team === 1 ? { team1: 120, team2: 310 } : { team1: 310, team2: 120 };
    const lost = profile.buildGameEndRecord(game);
    expect(lost.statsDeltas.assist).toEqual({ [p]: { help: 0, tutorial: true } });
    expect(lost.statsDeltas.bucket).toBe('stats');
    expect(lost.statsDeltas).not.toHaveProperty('bucketByPosition');
    expect(lost).not.toHaveProperty('assistedTeams');
    expect(lost).not.toHaveProperty('withBots');
    expect(errorLog).toEqual([]);
});

test('while on: one rule tip per own decision, one between two of them, the advice after each updateTurn, no room notice per turn', async () => {
    const t = await lobbyGame('tb', { seed: 9 });
    const { game } = t;
    const p = game.currentTurn;
    const s = t.owner(p);
    clientInfo.handle(s, t.w.io, CAPS);
    t.say(s, '/tutorial on');
    const mark = t.w.log.length;
    const startHand = game.currentHand;
    // two hands
    while (!game.isTerminal() && HAND_PROGRESSION.indexOf(game.currentHand) < 2) await t.move();
    const log = t.since(mark);
    // per turn of the table: what reached the tutorial socket
    let window = 0;
    let lastTurn = null;
    let ownTurns = 0;
    let advice = 0;
    for (const l of log) {
        if (l.event === 'updateTurn' && l.to === game.roomName) lastTurn = l.data.currentTurn;
        if (l.event !== 'assistHint' || l.to !== s.id) continue;
        const own = lastTurn === p;
        if (l.data.kind === 'tip' && l.data.tipId !== 'T.handScore') {
            if (own) continue;
            window++;
            expect(window).toBeLessThanOrEqual(1);
        }
        if (l.data.kind === 'bid' || l.data.kind === 'card') {
            expect(own).toBe(true);
            expect(l.data).toMatchObject({ source: 'tutorial', counted: false });
            ownTurns++;
            advice++;
            window = 0;
        }
    }
    expect(advice).toBeGreaterThan(5);
    expect(ownTurns).toBe(advice);
    // own-turn tips: at most one per turnKey
    const perKey = {};
    for (const x of hintsTo(t, s.id, mark)) if (x.kind === 'tip') perKey[x.turnKey] = (perKey[x.turnKey] || 0) + 1;
    expect(Math.max(...Object.values(perKey))).toBeLessThanOrEqual(2); // a decision's tip plus a hand-end tip at most
    // each topic once (T.handScore after each of the two hands)
    const ids = hintsTo(t, s.id, mark).filter((x) => x.kind === 'tip').map((x) => x.tipId);
    expect(ids.filter((i) => i === 'T.handScore')).toHaveLength(2);
    expect(new Set(ids.filter((i) => i !== 'T.handScore')).size).toBe(ids.filter((i) => i !== 'T.handScore').length);
    const hs = hintsTo(t, s.id, mark).find((x) => x.tipId === 'T.handScore');
    expect(hs.reasons[0]).toMatch(/^This hand, you and \S+ \(your partner\) bid \d+ and won \d+: .+\. \S+ and \S+ bid \d+ and won \d+: .+\.$/);
    // every advice came after its updateTurn, for that turn
    for (let i = 0; i < log.length; i++) {
        const l = log[i];
        if (l.event !== 'assistHint' || l.to !== s.id || l.data.kind === 'tip') continue;
        const turn = log.slice(0, i).reverse().find((x) => x.event === 'updateTurn' && x.to === game.roomName);
        expect(turn.data.currentTurn).toBe(p);
    }
    // never counted, never announced
    expect(game.assist[p].help).toBe(0);
    expect(roomLines(t, mark).filter((m) => /tutorial|\/help|bot-assisted/.test(m))).toEqual([]);
    expect(startHand).toBe(12);
    expect(errorLog).toEqual([]);
});

test('after the tutorial (off again): /help counts, but no 3rd-use warning or crossing (already bot-assisted); the game-end line names the tutorial; T.done', async () => {
    const t = await lobbyGame('tg', { seed: 7 });
    const { game } = t;
    const p = game.currentTurn;
    const s = t.owner(p);
    clientInfo.handle(s, t.w.io, CAPS);
    t.say(s, '/tutorial on');
    rateLimiter.clearSocket(s.id);
    t.say(s, '/tutorial off');
    const mark = t.w.log.length;
    while (game.assist[p].help < 4 && !game.isTerminal()) {
        if (game.currentTurn === p && game.acceptsTurnInput()) {
            rateLimiter.clearSocket(s.id);
            t.say(s, '/help');
        }
        await t.move();
    }
    const helps = hintsTo(t, s.id, mark).filter((x) => x.source === 'help' && x.counted);
    expect(helps.map((x) => x.uses)).toEqual([1, 2, 3, 4]);
    expect(helps.every((x) => !('note' in x) && x.assisted === true)).toBe(true);
    expect(roomLines(t, mark).filter((m) => /used \/help/.test(m))).toEqual(Array(4).fill(`${t.name(p)} used /help.`));
    // the game end (called as handleHandComplete does): T.done only while on, the line names the tutorial
    rateLimiter.clearSocket(s.id);
    t.say(s, '/tutorial on');
    // a game p's team won: the line says it went to the bot-game stats (owner 2026-11-21)
    const won = p % 2 === 1 ? { team1: 280, team2: 140 } : { team1: 140, team2: 280 };
    game.score = won;
    const m2 = t.w.log.length;
    assistHandlers.gameEndLines(t.w.io, game);
    expect(hintsTo(t, s.id, m2).map((x) => [x.kind, x.tipId, x.reasons[0]])).toEqual([['tip', 'T.done', 'Thanks for playing with the tutorial. Type /help any time for a suggestion.']]);
    const endLines = (m) => t.since(m).filter((l) => l.event === 'gameLogEntry' && l.to === s.id).map((l) => l.data.message);
    expect(endLines(m2)).toEqual([TEXT.gameEndTutorial('won')]);
    expect(TEXT.gameEndTutorial('won')).toBe('This game counted as bot-assisted for you (you played with the tutorial). You won, so it\'s in your bot-game stats.');
    // lost, and tied: it stayed in the human stats (T.done is not shown again)
    game.score = { team1: won.team2, team2: won.team1 };
    const m3 = t.w.log.length;
    assistHandlers.gameEndLines(t.w.io, game);
    expect(hintsTo(t, s.id, m3)).toEqual([]);
    expect(endLines(m3)).toEqual([TEXT.gameEndTutorial('lost')]);
    expect(TEXT.gameEndTutorial('lost')).toBe('This game counted as bot-assisted for you (you played with the tutorial). You lost, so it stays in your human stats.');
    game.score = { team1: 200, team2: 200 };
    const m4 = t.w.log.length;
    assistHandlers.gameEndLines(t.w.io, game);
    expect(endLines(m4)).toEqual([TEXT.gameEndTutorial('tied')]);
    expect(TEXT.gameEndTutorial('tied')).toBe('This game counted as bot-assisted for you (you played with the tutorial). It was a tie, so it stays in your human stats.');
});

test('a hand end does not reopen the between window: one rule tip between two own decisions', async () => {
    const t = await lobbyGame('tk', { seed: 9 });
    const { game, w } = t;
    const p = game.currentTurn;
    const s = t.owner(p);
    clientInfo.handle(s, w.io, CAPS);
    t.say(s, '/tutorial on');
    const ruleTips = (mark) => hintsTo(t, s.id, mark).filter((x) => x.kind === 'tip' && x.tipId !== 'T.handScore' && x.tipId !== 'T.welcome');
    expect(ruleTips(0).map((x) => x.tipId)).toEqual(['T.bid']);
    // the own bid, then the next seat's turn: the window's one tip
    let mark = w.log.length;
    await t.move();
    expect(game.currentTurn).not.toBe(p);
    expect(ruleTips(mark)).toHaveLength(1);
    // a hand end (as handleHandComplete calls it) between two own decisions
    assistHandlers.tutorHandEnd(w.io, game);
    mark = w.log.length;
    while (game.currentTurn !== p && !game.isTerminal()) await t.move();
    // the other seats' turns (T.set would hold there): nothing until the own decision
    const beforeOwn = t.since(mark);
    const own = beforeOwn.map((l) => l.event === 'updateTurn' && l.to === game.roomName && l.data.currentTurn === p).lastIndexOf(true);
    const between = beforeOwn.slice(0, own).filter((l) => l.event === 'assistHint' && l.to === s.id && l.data.kind === 'tip' && l.data.tipId !== 'T.handScore');
    expect(between).toEqual([]);
    expect(curriculum.has(game.assist[p].tips, 'T.set')).toBe(false);
});

// ------------------------------------------------------------ refusals

test('refusals: a spectator, an entrant, a lazy owner; ?tutorial stays chat', async () => {
    const t = await lobbyGame('tr');
    const { game } = t;
    const p = game.currentTurn;
    const s = t.owner(p);
    clientInfo.handle(s, t.w.io, CAPS);
    const fan = t.w.user('tr-spec', 'tr_fan');
    mainRoomHandlers.joinAsSpectator(fan, t.w.io, { gameId: game.gameId });
    let mark = t.w.log.length;
    t.say(fan, '/tutorial on');
    expect(t.since(mark).filter((l) => l.to === fan.id && l.event === 'gameLogEntry').map((l) => l.data.message)).toEqual([TEXT.tutorialSpectator]);

    // ?tutorial: plain chat, broadcast
    mark = t.w.log.length;
    t.say(s, '?tutorial');
    expect(t.since(mark).filter((l) => l.event === 'chatMessage').map((l) => l.data.message)).toEqual(['?tutorial']);
    expect(game.assist[p].tutorial).toBe(false);

    // a lazy owner: "Type /active first"
    t.say(s, '/lazy');
    mark = t.w.log.length;
    t.say(s, '/tutorial on');
    expect(hintsTo(t, s.id, mark).map((x) => [x.source, x.kind, x.headline])).toEqual([['tutorial', 'status', TEXT.botSeat]]);
    expect(game.assist[p].tutorial).toBe(false);
});

test('an entrant (the draw) is told the tutorial comes with the game', async () => {
    Math.random = mulberry32(3);
    const w = world('te');
    const socks = ['te_a', 'te_b', 'te_c', 'te_d'].map((n, i) => w.user(`te-h${i}`, n));
    mainRoomHandlers.createLobby(socks[0], w.io, {});
    const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
    const starting = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
    await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
    const game = gameManager.getPlayerGame(socks[0].id);
    await advanceUntil(() => game.stage === Phase.DRAWING, 100);
    const mark = w.log.length;
    chatHandlers.chatMessage(socks[1], w.io, { message: '/tutorial' });
    expect(w.log.slice(mark).filter((l) => l.to === socks[1].id).map((l) => l.data.message)).toEqual([TEXT.tutorialEntrant]);
    gameManager.abortGame(game.gameId);
    await Promise.allSettled(starting);
});

// ------------------------------------------------------------ the auto-start

describe('the auto-start (handleDrawComplete, before the first deal)', () => {
    test.each([
        ['pending', ['assist', 'tutorial'], true],
        ['pending', ['assist'], false],
        [null, ['assist', 'tutorial'], false],
        ['done', ['assist', 'tutorial'], false],
        ['dismissed', ['assist', 'tutorial'], false]
    ])('flag %s, caps %j: on %s', async (flag, caps, on) => {
        const t = await lobbyGame('ta', {
            prep: (socks, w) => {
                socks[0].data.tutorialFlag = flag;
                clientInfo.handle(socks[0], w.io, { client: 'web', version: '1.0.0', caps });
            }
        });
        const p = t.posOf(t.socks[0]);
        expect(t.game.assist[p].tutorial).toBe(on);
        expect(t.game.assist[p].auto).toBe(on);
        const notice = `${t.name(p)} is playing with the tutorial.`;
        expect(t.game.gameLog.some((e) => e.message === notice)).toBe(on);
        // the welcome came with the first turn (a tip, never before the table is up)
        expect(hintsTo(t, t.socks[0].id, 0).some((x) => x.tipId === 'T.welcome')).toBe(on);
    });

    test('never at a tournament table (the tutorial can still be turned on there)', async () => {
        const ctx = await setupTournament(4);
        for (const s of ctx.sockets) {
            s.data.tutorialFlag = 'pending';
            clientInfo.handle(s, ctx.io, CAPS);
        }
        const starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => g.stage === Phase.BIDDING && !g.resume), 100, 120000);
        await starting;
        const game = liveTables(ctx.t)[0];
        expect(gameManager.tournamentGames.has(game.gameId)).toBe(true);
        for (let pos = 1; pos <= 4; pos++) expect(game.assist[pos].tutorial).toBe(false);
        const pos = game.seatList().find((st) => st.controller === 'human').position;
        const s = ctx.sockets.find((x) => x.id === game.seat(pos).ownerSocketId);
        chatHandlers.chatMessage(s, ctx.io, { message: '/tutorial on' });
        expect(game.assist[pos]).toMatchObject({ tutorial: true, auto: false, tutorialEver: true });
    }, 120000);

    test('the first own decision makes it count (once, with the room line); off before it: not assisted, dismissed; keep: pending, still on; close: dismissed, still on', async () => {
        const names = ['tf_ann', 'tf_bob', 'tf_cat', 'tf_dan'];
        const t = await lobbyGame('tf', { pending: names, prep: (socks, w) => { for (const s of socks) clientInfo.handle(s, w.io, CAPS); } });
        const { game } = t;
        const first = game.currentTurn;
        const second = (first % 4) + 1;
        const third = (second % 4) + 1;
        const fourth = (third % 4) + 1;
        for (let pos = 1; pos <= 4; pos++) expect(game.assist[pos]).toMatchObject({ tutorial: true, auto: true });
        expect(game.gameLog.filter((e) => / is playing with the tutorial\.$/.test(e.message))).toHaveLength(4);
        // the first bidder's first own decision has been ticked
        expect(game.assist[first].tutorialEver).toBe(true);
        const counts = (pos) => game.gameLog.filter((e) => e.message === `This game now counts as bot-assisted for ${t.name(pos)}.`).length;
        expect(counts(first)).toBe(1);
        // every tutorial line is tagged (drawn in the cap's colour): the auto-starts and the counting line
        expect(game.gameLog.filter((e) => / is playing with the tutorial\.$/.test(e.message)).every((e) => e.tutorial?.on === true)).toBe(true);
        expect(game.gameLog.find((e) => e.message === `This game now counts as bot-assisted for ${t.name(first)}.`).tutorial).toEqual({ position: first, on: true });
        expect(hintsTo(t, t.owner(first).id, 0).some((x) => x.source === 'tutorial' && x.kind === 'bid')).toBe(true);
        // the second seat turns it off before its first decision
        let mark = t.w.log.length;
        t.say(t.owner(second), '/tutorial off');
        expect(game.assist[second]).toMatchObject({ tutorial: false, auto: false, tutorialEver: false });
        expect(statesTo(t, t.owner(second).id, mark)).toEqual([{ tutorial: false, auto: false, uses: 0, freeUses: 3, assisted: false }]);
        await flush();
        expect(userDoc(t.name(second)).tutorial).toBe('dismissed');
        expect(t.owner(second).data.tutorialFlag).toBe('dismissed');
        // the third keeps it (the welcome's Keep): silent, still pending on the account, still on
        mark = t.w.log.length;
        t.say(t.owner(third), '/tutorial keep');
        expect(t.since(mark).filter((l) => l.to === t.owner(third).id || l.to === game.roomName)).toEqual([]);
        await flush();
        expect(userDoc(t.name(third)).tutorial).toBe('pending');
        expect(t.owner(third).data.tutorialFlag).toBe('pending');
        expect(game.assist[third].tutorial).toBe(true);
        // the fourth closes the welcome (✕): silent, dismissed on the account, still on
        mark = t.w.log.length;
        t.say(t.owner(fourth), '/tutorial close');
        expect(t.since(mark).filter((l) => l.to === t.owner(fourth).id || l.to === game.roomName)).toEqual([]);
        await flush();
        expect(userDoc(t.name(fourth)).tutorial).toBe('dismissed');
        expect(t.owner(fourth).data.tutorialFlag).toBe('dismissed');
        expect(game.assist[fourth].tutorial).toBe(true);
        // the first seat, still pending on the account
        expect(userDoc(t.name(first)).tutorial).toBe('pending');
        // play on: the first bidder never counted again
        await t.move();
        await t.move();
        expect(counts(first)).toBe(1);
        expect(counts(second)).toBe(0);
        expect(counts(third)).toBe(1); // its own decision came (still on)
        // a game the first seat's team won (only a win moves it, owner 2026-11-21)
        game.score = first % 2 === 1 ? { team1: 250, team2: 90 } : { team1: 90, team2: 250 };
        const record = profile.buildGameEndRecord(game);
        expect(record.statsDeltas.assist[second]).toBeUndefined();
        expect(record.statsDeltas.assist[first]).toEqual({ help: 0, tutorial: true });
        expect(record.statsDeltas.bucketByPosition[second]).toBeUndefined();
        expect(record.statsDeltas.bucketByPosition[first]).toBe('botStats');
    });
});

// ------------------------------------------------------------ a game with a native bot seat

test('a game with a native bot seat: no bot-assisted words, unlimited on assistState, the record still marks it', async () => {
    const t = await lobbyGame('tn', { bots: 1, seed: 11, pending: ['tn_ann'], prep: (socks, w) => clientInfo.handle(socks[0], w.io, CAPS) });
    const { game } = t;
    const me = t.posOf(t.socks[0]);
    expect(game.assist[me]).toMatchObject({ tutorial: true, auto: true });
    expect(game.gameLog.some((e) => e.message === 'tn_ann is playing with the tutorial.')).toBe(true);
    // to my first decision (the bot acts on its own timers)
    while (game.stage === Phase.BIDDING && !game.assist[me].tutorialEver) {
        if (game.seat(game.currentTurn).controller === 'human') await t.move();
        else await jest.advanceTimersByTimeAsync(200);
    }
    await flush();
    expect(game.assist[me].tutorialEver).toBe(true);
    expect(game.gameLog.filter((e) => /bot-assisted/.test(e.message))).toEqual([]);
    const st = statesTo(t, t.socks[0].id, 0).at(-1);
    expect(st).toMatchObject({ tutorial: true, auto: true, assisted: false, unlimited: true });
    // off and on again by hand: the plain notices
    let mark = t.w.log.length;
    t.say(t.socks[0], '/tutorial off');
    rateLimiter.clearSocket(t.socks[0].id);
    t.say(t.socks[0], '/tutorial on');
    expect(roomLines(t, mark)).toEqual(['tn_ann turned off the tutorial.', 'tn_ann turned on the tutorial.']);
    expect(hintsTo(t, t.socks[0].id, mark).every((x) => x.unlimited === true && x.assisted === false)).toBe(true);
    // no new welcome (once per game)
    expect(hintsTo(t, t.socks[0].id, mark).some((x) => x.tipId === 'T.welcome')).toBe(false);
    const record = profile.buildGameEndRecord(game);
    expect(record.statsDeltas.bucket).toBe('botStats');
    expect(record.statsDeltas.bucketByPosition).toBeUndefined();
    expect(record.statsDeltas.assist).toEqual({ [me]: { help: 0, tutorial: true } });
    expect(record.assistedTeams).toEqual([me % 2 === 1 ? 1 : 2]);
    mark = t.w.log.length;
    assistHandlers.gameEndLines(t.w.io, game);
    expect(t.since(mark).filter((l) => l.event === 'gameLogEntry')).toEqual([]);
});

// ------------------------------------------------------------ the re-push

test('a rejoin on the own turn gets assistState and this turn\'s advice again (no tip repeated); so does /active', async () => {
    const t = await lobbyGame('tj', { seed: 13 });
    const { game } = t;
    const p = game.currentTurn;
    const s = t.owner(p);
    const name = t.name(p);
    clientInfo.handle(s, t.w.io, CAPS);
    t.say(s, '/tutorial on');
    const first = hintsTo(t, s.id, 0).find((x) => x.source === 'tutorial' && x.kind === 'bid');
    expect(first).toBeTruthy();
    const tipsBefore = game.assist[p].tips;

    // a new socket takes the seat (a reload)
    const back = t.w.user('tj-back', name);
    clientInfo.handle(back, t.w.io, CAPS);
    let mark = t.w.log.length;
    seatLifecycle.reconnectOwner(t.w.io, game, p, back, name);
    const mine = t.since(mark).filter((l) => l.to === back.id || l.to === `self:${back.id}`);
    expect(mine.map((l) => l.event).filter((e) => ['rejoinSuccess', 'assistState', 'assistHint'].includes(e))).toEqual(['rejoinSuccess', 'assistState', 'assistHint']);
    const again = hintsTo(t, back.id, mark);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ source: 'tutorial', kind: 'bid', turnKey: first.turnKey, headline: first.headline, counted: false });
    expect(game.assist[p].tips).toBe(tipsBefore);
    expect(statesTo(t, back.id, mark)).toEqual([{ tutorial: true, auto: false, uses: 0, freeUses: 3, assisted: true }]);

    // /lazy then /active on the same turn: the advice again
    t.say(back, '/lazy');
    mark = t.w.log.length;
    t.say(back, '/active');
    if (game.currentTurn === p && game.stage === Phase.BIDDING && game.playerBids[p - 1] == null) {
        expect(hintsTo(t, back.id, mark).filter((x) => x.source === 'tutorial' && x.kind === 'bid')).toHaveLength(1);
    }
    expect(statesTo(t, back.id, mark).at(-1)).toMatchObject({ tutorial: true });
    expect(errorLog).toEqual([]);
});

// ------------------------------------------------------------ a finished game, the fade-out

test('a whole game with the tutorial (3 native bots): the fade-out after the 2-card hand, T.done, and the account becomes done', async () => {
    const t = await lobbyGame('tw', { bots: 3, seed: 21, pending: ['tw_ann'], prep: (socks, w) => clientInfo.handle(socks[0], w.io, CAPS) });
    const { game } = t;
    const s = t.socks[0];
    const me = t.posOf(s);
    expect(game.assist[me].tutorial).toBe(true);
    const perHand = HAND_PROGRESSION.map(() => ({ decisions: 0, advice: 0 }));
    // the tutorial's advice for the open turn (by its turnKey)
    const adviceNow = () => hintsTo(t, s.id, 0).filter((x) => x.source === 'tutorial' && (x.kind === 'bid' || x.kind === 'card') && x.turnKey === game.turnKey());
    let guard = 0;
    while (!game.isTerminal() && guard++ < 5000) {
        if (game.acceptsTurnInput() && game.currentTurn === me && game.seat(me).controller === 'human') {
            await flush();
            const hand = HAND_PROGRESSION.indexOf(game.currentHand);
            const forced = game.stage === Phase.PLAYING && legalCards(game, s.id).length === 1;
            const advice = adviceNow();
            if (!forced) perHand[hand].decisions++;
            if (advice.length) perHand[hand].advice++;
            expect(advice.length).toBeLessThanOrEqual(1);
            if (forced) expect(advice).toEqual([]);
            const a = advice[0];
            if (game.stage === Phase.BIDDING) await t.move(a ? a.suggest.bid : null);
            else await t.move(a ? a.suggest.card : null);
        } else {
            await jest.advanceTimersByTimeAsync(250);
        }
    }
    expect(game.stage).toBe(Phase.ENDED);
    const before = perHand.slice(0, 6);
    const after = perHand.slice(6);
    const sum = (rows, k) => rows.reduce((n, r) => n + r[k], 0);
    // every non-forced decision of hands 1-6 had its advice; fewer after
    expect(sum(before, 'advice')).toBe(sum(before, 'decisions'));
    expect(sum(after, 'advice')).toBeLessThan(sum(after, 'decisions'));
    const tips = hintsTo(t, s.id, 0).filter((x) => x.kind === 'tip').map((x) => x.tipId);
    expect(tips).toContain('T.graduate');
    expect(tips.at(-1)).toBe('T.done');
    // the graduation came at the end of the 2-card hand
    const grad = t.w.log.findIndex((l) => l.to === s.id && l.data && l.data.tipId === 'T.graduate');
    const handEnds = t.w.log.map((l, i) => (l.event === 'handComplete' ? i : -1)).filter((i) => i >= 0);
    expect(grad).toBeGreaterThan(handEnds[5]);
    expect(grad).toBeLessThan(handEnds[6]);
    // the account is no longer new; no bot-assisted line in a bot game
    await flush();
    expect(userDoc('tw_ann').tutorial).toBe('done');
    expect(s.data.tutorialFlag).toBe('done');
    expect(t.since(0).filter((l) => l.event === 'gameLogEntry' && /bot-assisted/.test(l.data.message))).toEqual([]);
    // measured: advice per hand (printed for the report)
    console.info(`tutorial fade-out (real handlers, seed 21): ${perHand.map((r, i) => `h${i + 1} ${r.advice}/${r.decisions}`).join(', ')}`);
}, 180000);

test('an aborted game keeps the account pending, also after the welcome was kept', async () => {
    const t = await lobbyGame('tx', { pending: ['tx_ann', 'tx_bob'], prep: (socks, w) => clientInfo.handle(socks[0], w.io, CAPS) });
    expect(t.game.assist[t.posOf(t.socks[0])]).toMatchObject({ tutorial: true, auto: true });
    t.say(t.socks[0], '/tutorial keep');
    await flush();
    gameManager.abortGame(t.game.gameId);
    await flush();
    expect(userDoc('tx_ann').tutorial).toBe('pending');
    expect(t.socks[0].data.tutorialFlag).toBe('pending');
    expect(userDoc('tx_bob').tutorial).toBe('pending');
});

test('a finished game: done for the owners still at the table (playing or lazy), pending for a dropped, force-resigned one', async () => {
    const names = ['tz_ann', 'tz_bob', 'tz_cat', 'tz_dan'];
    const t = await lobbyGame('tz', { pending: names });
    const { game, w } = t;
    const [gone, lazy] = [1, 2].map((p) => t.posOf(t.socks[p]));
    // tz_bob's app closes, the grace runs out, the others replace the seat with a bot
    seatLifecycle.disconnectOwner(w.io, game, gone, t.socks[1].id);
    seatLifecycle.onGraceExpired(w.io, game, gone);
    expect(seatLifecycle.resignSeat(w.io, game, gone)).toBe(true);
    expect(game.seat(gone)).toMatchObject({ controller: 'resignBot', presence: 'away', ownerUsername: 'tz_bob' });
    // tz_cat watches a bot play the seat (lazy)
    t.say(t.socks[2], '/lazy');
    expect(game.seat(lazy)).toMatchObject({ controller: 'lazyBot', presence: 'connected' });
    // the game ends (as handleHandComplete calls it after gameEnd)
    assistHandlers.gameFinished(w.io, game);
    await flush();
    expect(names.map((n) => [n, userDoc(n).tutorial])).toEqual([
        ['tz_ann', 'done'], ['tz_bob', 'pending'], ['tz_cat', 'done'], ['tz_dan', 'done']
    ]);
});

// ------------------------------------------------------------ the end of the 2-card hand, the cap

/** The end of the 2-card hand, as handleHandComplete calls it (only the hand size is read for T.graduate). */
function endTwoCardHand(t) {
    const was = t.game.currentHand;
    t.game.currentHand = curriculum.GRADUATE_AFTER;
    try {
        assistHandlers.tutorHandEnd(t.w.io, t.game);
    } finally {
        t.game.currentHand = was;
    }
}

const tutorialTo = (t, sid, mark) => t.since(mark).filter((l) => l.to === sid && (
    (l.event === 'assistHint' && l.data.source === 'tutorial') ||
    (l.event === 'gameLogEntry' && /^Tip: /.test(l.data.message)) ||
    l.event === 'assistState'));

test('away at the end of the 2-card hand: graduated anyway; an app without the cap gets nothing pushed; T.graduate comes with the next capable socket', async () => {
    const t = await lobbyGame('tq', { seed: 17 });
    const { game, w } = t;
    const p = game.currentTurn;
    const s = t.owner(p);
    const name = t.name(p);
    clientInfo.handle(s, w.io, CAPS);
    t.say(s, '/tutorial on');
    await flush();
    // the phone backgrounds on its own turn (grace), the 2-card hand ends meanwhile
    seatLifecycle.disconnectOwner(w.io, game, p, s.id);
    let mark = w.log.length;
    endTwoCardHand(t);
    expect(curriculum.isGraduated(game.assist[p].tips)).toBe(true);
    expect(tutorialTo(t, s.id, mark)).toEqual([]);

    // back on a shipped iOS build (cap assist, no tutorial): no advice, no tip, no assistState
    const old = w.user('tq-old', name);
    clientInfo.handle(old, w.io, { client: 'ios', version: '1.2.3', caps: ['assist'] });
    mark = w.log.length;
    seatLifecycle.reconnectOwner(w.io, game, p, old, name);
    await flush();
    expect(game.seat(p).ownerSocketId).toBe(old.id);
    expect(tutorialTo(t, old.id, mark)).toEqual([]);
    // nor at the next turns while it holds the seat
    for (let i = 0; i < 4 && !game.isTerminal(); i++) await t.move();
    expect(tutorialTo(t, old.id, mark)).toEqual([]);
    expect(game.assist[p].tutorial).toBe(true);

    // back on the web: assistState and the graduation it missed (once)
    const web = w.user('tq-web', name);
    clientInfo.handle(web, w.io, CAPS);
    mark = w.log.length;
    seatLifecycle.reconnectOwner(w.io, game, p, web, name);
    await flush();
    expect(statesTo(t, web.id, mark)).toHaveLength(1);
    expect(hintsTo(t, web.id, mark).filter((x) => x.kind === 'tip').map((x) => x.tipId)).toEqual(['T.graduate']);
    for (let i = 0; i < 4 && !game.isTerminal(); i++) await t.move();
    expect(hintsTo(t, web.id, mark).filter((x) => x.tipId === 'T.graduate')).toHaveLength(1);
    expect(errorLog).toEqual([]);
});

test('lazy at the end of the 2-card hand: graduated anyway, T.graduate after /active', async () => {
    const t = await lobbyGame('tl', { seed: 19 });
    const { game, w } = t;
    const p = (game.currentTurn % 4) + 1; // not on turn: the bot does not move for it now
    const s = t.owner(p);
    clientInfo.handle(s, w.io, CAPS);
    t.say(s, '/tutorial on');
    t.say(s, '/lazy');
    let mark = w.log.length;
    endTwoCardHand(t);
    expect(curriculum.isGraduated(game.assist[p].tips)).toBe(true);
    expect(hintsTo(t, s.id, mark)).toEqual([]);
    mark = w.log.length;
    t.say(s, '/active');
    await flush();
    expect(hintsTo(t, s.id, mark).filter((x) => x.kind === 'tip').map((x) => x.tipId)).toEqual(['T.graduate']);
    expect(errorLog).toEqual([]);
});

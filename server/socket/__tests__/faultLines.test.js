/**
 * Fault lines (owner 2026-11-19): after a hand, for each team that was SET
 * (took fewer tricks than its combined bid; a bore is the whole hand), one
 * stored, sequenced room gameLogEntry per player on it who took fewer
 * tricks than they bid (a bore counts as 0 for that player):
 * "Fault: <name> (bid N, took M)", type 'system', with the optional
 * fault {position, bid, took}. Same rule as the setsCaused stat (one
 * source: rules.handFaults). The stored line carries the same fault, so a
 * snapshot's log (requestSnapshot after a reload, rejoinSuccess, the
 * spectator full state) replays it in place, exactly once.
 *
 * Real handlers (bids, plays, the hand-end hold), in-memory DB, stub io,
 * fake timers; every emit is checked against the socket contract.
 */

const crypto = require('crypto');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    whenReady: () => Promise.resolve(true),
}));

const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const authHandlers = require('../authHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const queueHandlers = require('../queueHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const snapshotHandlers = require('../snapshotHandlers');
const rules = require('../../game/rules');
const BotPlayer = require('../../game/bot/BotPlayer');
const { Phase } = require('../../game/GamePhase');
const { hashToken } = require('../../utils/sessionTokens');
const { makeIo, makeSocket, events, legalCards, resignedSeat, lazySeat } = require('../../testUtils/gameDriver');
const schema = require('../../../contract/events.schema.json');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager.mainRoomSocketIds.clear();
    gameManager.spectatorGames.clear();
    gameManager.currentUsers = [];
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

const TOP_TRUMP = ['HI', 'LO', 'A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4']
    .map((r) => (r === 'HI' || r === 'LO' ? C(r, 'joker') : C(r, 'spades')));
const SUIT = (suit) => ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'].map((r) => C(r, suit));

/** Signed-in sockets (session tokens), so a dropped one can rejoinGame. */
function world() {
    seq++;
    const log = [];
    const io = makeIo(log);
    const tokens = new Map();
    let n = 0;
    return {
        log, io, tokens,
        async connect(name) {
            const username = `${name}${seq}`;
            if (!tokens.has(username)) {
                const token = crypto.randomUUID();
                tokens.set(username, token);
                const now = new Date();
                mockDb.current.users._insert({ username, profilePic: 3, sessionTokens: [{ hash: hashToken(token), createdAt: now, lastUsedAt: now }] });
            }
            n++;
            const s = makeSocket(`fl${seq}-${username}-${n}`, log, io);
            s.username = username;
            await authHandlers.restoreSession(s, io, { username, sessionToken: tokens.get(username) });
            mainRoomHandlers.joinMainRoom(s, io);
            return s;
        },
        kill(s) {
            io.sockets.sockets.delete(s.id);
            for (const members of io.rooms.values()) members.delete(s.id);
            return queueHandlers.handleDisconnect(s, io);
        },
    };
}

/**
 * Four human seats (ann bob cat dan at 1-4) in BIDDING with `handSize`
 * cards, seat 1 to bid. Seat 1 holds the top trumps, so it takes every
 * trick; the others take none.
 */
async function setup({ handSize = 4 } = {}) {
    const w = world();
    const sockets = [];
    for (const name of ['ann', 'bob', 'cat', 'dan']) sockets.push(await w.connect(name));
    const game = gameManager.createGame(sockets.map((s) => s.id));
    sockets.forEach((s, i) => game.addPlayer(s.id, s.username, i + 1, i + 1, false));
    sockets.forEach((s) => s.join(game.roomName));
    game.entrants = null;
    game.currentHand = handSize;
    game.dealer = 4;
    const dealt = [TOP_TRUMP, SUIT('hearts'), SUIT('diamonds'), SUIT('clubs')].map((h) => h.slice(0, handSize));
    sockets.forEach((s, i) => game.setHand(s.id, dealt[i].map((c) => ({ ...c }))));
    game.trump = C('3', 'spades');
    game.forcePhase('BIDDING');
    game.bidder = 1;
    game.currentTurn = 1;
    game.playerBids = [];
    return { ...w, game, sockets, names: sockets.map((s) => s.username) };
}

async function bidAll(t, bids) {
    for (let i = 0; i < 4; i++) await gameHandlers.playerBid(t.sockets[i], t.io, { bid: bids[i] });
}

/** Play the hand out (first legal card) through the hand-end hold. */
async function playOut(t) {
    const from = t.log.length;
    for (let guard = 0; guard < 200 && t.log.slice(from).every((l) => l.event !== 'handComplete'); guard++) {
        if (t.game.stage === Phase.PLAYING) {
            const sid = t.game.positions[t.game.currentTurn];
            const socket = t.sockets.find((s) => s.id === sid);
            await gameHandlers.playCard(socket, t.io, { card: legalCards(t.game, sid)[0] });
        } else {
            await jest.advanceTimersByTimeAsync(5000);
        }
    }
    expect(t.log.slice(from).filter((l) => l.event === 'handComplete')).toHaveLength(1);
}

/** The room's gameLogEntry broadcasts that carry a fault, from log index `from`. */
const faultEntries = (t, from = 0) => t.log.slice(from)
    .filter((l) => l.event === 'gameLogEntry' && l.to === t.game.roomName && l.data.fault);
const faultMessages = (t, from = 0) => faultEntries(t, from).map((l) => l.data.message);

/** The stored game log's lines from the last '--- HAND COMPLETE ---' on. */
function lastHandBlock(game) {
    const i = game.gameLog.map((e) => e.message).lastIndexOf('--- HAND COMPLETE ---');
    return game.gameLog.slice(i);
}

describe('rules.handFaults (the setsCaused rule)', () => {
    const hand = (playerBids, teamBids, handTricks) => ({
        playerBids,
        teamBids,
        teamTricks: { team1: handTricks[1] + handTricks[3], team2: handTricks[2] + handTricks[4] },
        handTricks,
    });

    test('a set team: every player on it who took fewer than they bid, seats 1, 3, 2, 4', () => {
        // team1 bid 5, took 3 (set): seat 1 bid 3 took 3 (not short), seat 3 bid 2 took 0
        // team2 bid 5, took 1 (set): both short
        expect(rules.handFaults(hand(['3', '2', '2', '3'], { team1: 5, team2: 5 }, { 1: 3, 2: 1, 3: 0, 4: 0 })))
            .toEqual([{ position: 3, bid: 2, took: 0 }, { position: 2, bid: 2, took: 1 }, { position: 4, bid: 3, took: 0 }]);
    });

    test('a team that made its bid has none, even with a player short of their own bid', () => {
        // team1 bid 3, took 4: seat 3 bid 2 took 0 (short, but the team made it)
        expect(rules.handFaults(hand(['1', '0', '2', '0'], { team1: 3, team2: 0 }, { 1: 4, 2: 0, 3: 0, 4: 0 }))).toEqual([]);
    });

    test('a bore counts as 0 for its player (the team total is the hand)', () => {
        // team2 bored on 4 cards (team bid 4), took 0: the bore's player is never at fault
        expect(rules.handFaults(hand(['1', 'B', '0', '1'], { team1: 1, team2: 4 }, { 1: 4, 2: 0, 3: 0, 4: 0 })))
            .toEqual([{ position: 4, bid: 1, took: 0 }]);
        expect(rules.handFaults(hand(['2B', 'B', '0', '0'], { team1: 4, team2: 4 }, { 1: 2, 2: 2, 3: 0, 4: 0 }))).toEqual([]);
        expect(rules.personalBidValue('3B')).toBe(0);
        expect(rules.personalBidValue('7')).toBe(7);
        expect(rules.personalBidValue(null)).toBe(0);
    });

    // The cases the web's own copy (client/src/rules/faults.js, removed
    // 2026-11-19 when the server took over) was held to; team bids as
    // handlePostBid makes them (BID_RANKS: a bore is 13, then capped at the hand)
    const teamBids = (b, size) => ({
        team1: Math.min(size, (rules.BID_RANKS[b[0]] || 0) + (rules.BID_RANKS[b[2]] || 0)),
        team2: Math.min(size, (rules.BID_RANKS[b[1]] || 0) + (rules.BID_RANKS[b[3]] || 0)),
    });
    test.each([
        ['set, one player short', ['3', '1', '1', '0'], { 1: 1, 2: 1, 3: 2, 4: 1 }, [{ position: 1, bid: 3, took: 1 }]],
        ['made though a player was short (the partner covered it)', ['2', '1', '1', '1'], { 1: 0, 2: 1, 3: 3, 4: 1 }, []],
        ['set, both players short', ['1', '2', '0', '2'], { 1: 2, 2: 1, 3: 1, 4: 1 }, [{ position: 2, bid: 2, took: 1 }, { position: 4, bid: 2, took: 1 }]],
        ['a bore set: only the numeric partner', ['B', '0', '2', '0'], { 1: 3, 2: 1, 3: 1, 4: 0 }, [{ position: 3, bid: 2, took: 1 }]],
        ['a bore set whose partner made their 2: nobody', ['2B', '0', '2', '0'], { 1: 2, 2: 1, 3: 2, 4: 0 }, []],
        ['both teams set: every short player, team1 first', ['2', '2', '1', '2'], { 1: 1, 2: 1, 3: 1, 4: 2 }, [{ position: 1, bid: 2, took: 1 }, { position: 2, bid: 2, took: 1 }]],
        ['a bore team that took the whole hand is made', ['1', '0', 'B', '0'], { 1: 0, 2: 0, 3: 5, 4: 0 }, []],
    ])('5 cards: %s', (_name, bids, handTricks, want) => {
        expect(rules.handFaults(hand(bids, teamBids(bids, 5), handTricks))).toEqual(want);
    });

    test('nothing without the per-seat tricks', () => {
        expect(rules.handFaults({ teamBids: { team1: 3, team2: 3 }, teamTricks: { team1: 0, team2: 0 }, playerBids: ['3', '3', '0', '0'] })).toEqual([]);
        expect(rules.handFaults()).toEqual([]);
    });
});

describe('handleHandComplete writes the fault lines', () => {
    test('a set team with both players short: two red lines after the hand lines; the made team with a short player: none', async () => {
        const t = await setup();
        await bidAll(t, ['1', '2', '1', '1']);
        const from = t.log.length;
        await playOut(t);
        const [ann, bob, cat, dan] = t.names;
        expect(faultMessages(t, from)).toEqual([`Fault: ${bob} (bid 2, took 0)`, `Fault: ${dan} (bid 1, took 0)`]);
        expect(faultEntries(t, from).map((l) => l.data)).toEqual([
            { message: `Fault: ${bob} (bid 2, took 0)`, type: 'system', fault: { position: 2, bid: 2, took: 0 }, seq: expect.any(Number) },
            { message: `Fault: ${dan} (bid 1, took 0)`, type: 'system', fault: { position: 4, bid: 1, took: 0 }, seq: expect.any(Number) },
        ]);
        // cat (team of ann, made) bid 1 and took 0: no line
        expect(faultMessages(t, from).some((m) => m.includes(cat) || m.includes(ann))).toBe(false);

        // Sequenced right after handComplete, in order
        const later = t.log.slice(from).filter((l) => l.to === t.game.roomName);
        const hc = later.findIndex((l) => l.event === 'handComplete');
        expect(later[hc + 1].data.fault).toEqual({ position: 2, bid: 2, took: 0 });
        expect(later[hc + 2].data.fault).toEqual({ position: 4, bid: 1, took: 0 });
        expect(later[hc + 1].data.seq).toBe(later[hc].data.seq + 1);
        expect(later[hc + 2].data.seq).toBe(later[hc].data.seq + 2);

        // Stored after the hand's two lines, with the same fault
        const block = lastHandBlock(t.game);
        expect(block.slice(0, 5).map((e) => e.message)).toEqual([
            '--- HAND COMPLETE ---',
            expect.stringContaining(`${ann}/${cat}: Bid 1/1, Won 4`),
            expect.stringContaining(`${bob}/${dan}: Bid 2/1, Won 0`),
            `Fault: ${bob} (bid 2, took 0)`,
            `Fault: ${dan} (bid 1, took 0)`,
        ]);
        expect(block[3]).toMatchObject({ type: 'system', playerPosition: null, fault: { position: 2, bid: 2, took: 0 } });
        expect(block.slice(0, 3).every((e) => !('fault' in e))).toBe(true);

        // The stat counts the same players
        expect([1, 2, 3, 4].map((p) => t.game.playerStats[p].setsCaused)).toEqual([0, 1, 0, 1]);
    });

    test('a set team with one player short: one line (a 0 bid is never short)', async () => {
        const t = await setup();
        await bidAll(t, ['1', '0', '0', '1']);
        const from = t.log.length;
        await playOut(t);
        expect(faultMessages(t, from)).toEqual([`Fault: ${t.names[3]} (bid 1, took 0)`]);
    });

    test('the team bid is capped at the hand: 1 + 4 on 4 cards, all 4 taken, is made (no line for the 4)', async () => {
        const t = await setup();
        await bidAll(t, ['1', '0', '4', '0']);
        expect(t.game.bids.team1).toBe(4);
        const from = t.log.length;
        await playOut(t);
        expect(faultEntries(t, from)).toEqual([]);
        expect(t.game.playerStats[3].setsCaused).toBe(0);
    });

    test('a bore counts as 0 for its player: the set bore team faults only the partner who bid', async () => {
        const t = await setup();
        await bidAll(t, ['1', 'B', '0', '1']);
        expect(t.game.bids.team2).toBe(4);
        const from = t.log.length;
        await playOut(t);
        expect(faultMessages(t, from)).toEqual([`Fault: ${t.names[3]} (bid 1, took 0)`]);
    });

    test('both teams made: no line', async () => {
        const t = await setup();
        await bidAll(t, ['2', '0', '1', '0']);
        const from = t.log.length;
        await playOut(t);
        expect(faultEntries(t, from)).toEqual([]);
        expect(lastHandBlock(t.game).some((e) => e.fault)).toBe(false);
    });

    test('a redeal (every bid 0): no hand, no line', async () => {
        const t = await setup();
        const from = t.log.length;
        await bidAll(t, ['0', '0', '0', '0']);
        await jest.advanceTimersByTimeAsync(5000);
        expect(events(t.log.slice(from), 'handComplete')).toHaveLength(0);
        expect(faultEntries(t, from)).toEqual([]);
        expect(t.game.gameLog.some((e) => e.fault || e.message.startsWith('Fault:'))).toBe(false);
    });

    test('the last hand: the fault lines come before GAME OVER and gameEnd', async () => {
        const t = await setup({ handSize: 13 });
        await bidAll(t, ['1', '1', '1', '1']);
        const from = t.log.length;
        await playOut(t);
        const room = t.log.slice(from).filter((l) => l.to === t.game.roomName).map((l) => (l.data?.fault ? 'fault' : l.event));
        const hc = room.indexOf('handComplete');
        expect(room.slice(hc, hc + 3)).toEqual(['handComplete', 'fault', 'fault']);
        expect(room.indexOf('gameEnd')).toBeGreaterThan(hc + 2);
        const msgs = t.game.gameLog.map((e) => e.message);
        const i = msgs.lastIndexOf('--- HAND COMPLETE ---');
        expect(msgs.slice(i + 3, i + 6)).toEqual([`Fault: ${t.names[1]} (bid 1, took 0)`, `Fault: ${t.names[3]} (bid 1, took 0)`, '=== GAME OVER ===']);
    });

    test('a resigned seat: the fault line names the bot that bid, the team line the seat\'s owner', async () => {
        const t = await setup();
        const bot = new BotPlayer('🤖 Mary', 'mary');
        resignedSeat(t.game, 4, bot);
        const { game, io } = t;
        game.playerBids = ['1', '2', '1', '1'];
        game.bids = { team1: 2, team2: 3 };
        game.team1Mult = 1;
        game.team2Mult = 1;
        game.tricks = { team1: 4, team2: 0 };
        game.handTricks = { 1: 4, 2: 0, 3: 0, 4: 0 };
        game.forcePhase('HAND_RESOLVING');
        const from = t.log.length;
        await gameHandlers.handleHandComplete(game, io);
        expect(faultMessages(t, from)).toEqual([`Fault: ${t.names[1]} (bid 2, took 0)`, 'Fault: 🤖 Mary (bid 1, took 0)']);
        // owner rule 2026-11-25: teams by player names (gameHandlers.seatName)
        expect(lastHandBlock(game)[2].message).toContain(`${t.names[1]}/${t.names[3]}:`);
    });

    test('a lazy seat: the fault line names the bot (as its bid line does), the team line the owner; the stat stays on the seat', async () => {
        // The fault line is a player's line, named like that player's bid
        // line ("🤖 Sharon bid 2."): the bot that bid. The HAND COMPLETE team
        // line names the TEAM, by its players (owner rule 2026-11-25: teams
        // by player names, never a bot persona at a lazy or resigned seat);
        // setsCaused is per seat, as before.
        const t = await setup();
        lazySeat(t.game, 2, new BotPlayer('🤖 Sharon', 'sharon'));
        const { game, io } = t;
        game.playerBids = ['1', '2', '1', '1'];
        game.bids = { team1: 2, team2: 3 };
        game.team1Mult = 1;
        game.team2Mult = 1;
        game.tricks = { team1: 4, team2: 0 };
        game.handTricks = { 1: 4, 2: 0, 3: 0, 4: 0 };
        game.forcePhase('HAND_RESOLVING');
        const from = t.log.length;
        await gameHandlers.handleHandComplete(game, io);
        const name2 = game.getPlayerByPosition(2).username;
        expect(name2).toBe('🤖 Sharon');
        expect(faultMessages(t, from)).toEqual([`Fault: ${name2} (bid 2, took 0)`, `Fault: ${t.names[3]} (bid 1, took 0)`]);
        expect(lastHandBlock(game)[2].message).toContain(`${t.names[1]}/${t.names[3]}:`);
        expect(game.playerStats[2].setsCaused).toBe(1);
    });

    test('the contract lists handleHandComplete among the gameLogEntry senders', () => {
        expect(schema.s2c.gameLogEntry.emittedFrom).toContain('server/socket/gameHandlers.js:handleHandComplete');
    });
});

describe('a snapshot replays them in place, once', () => {
    /** The log rows of a snapshot from the last hand block on. */
    const blockOf = (log) => log.slice(log.map((e) => e.message).lastIndexOf('--- HAND COMPLETE ---'));
    const faultRows = (log) => log.filter((e) => e.fault);

    async function setHand() {
        const t = await setup();
        await bidAll(t, ['1', '2', '1', '1']);
        await playOut(t);
        // the next deal is out (and its bidding open)
        await jest.advanceTimersByTimeAsync(10000);
        return t;
    }

    test('requestSnapshot (a reload): the fault rows after the hand lines, each exactly once, with fault', async () => {
        const t = await setHand();
        const from = t.log.length;
        snapshotHandlers.requestSnapshot(t.sockets[0], t.io, { requestId: 'r1' });
        const snap = t.log.slice(from).find((l) => l.event === 'stateSnapshot').data.snapshot;
        const [, bob, , dan] = t.names;
        expect(faultRows(snap.log)).toEqual([
            { message: `Fault: ${bob} (bid 2, took 0)`, type: 'system', position: null, at: expect.any(Number), fault: { position: 2, bid: 2, took: 0 } },
            { message: `Fault: ${dan} (bid 1, took 0)`, type: 'system', position: null, at: expect.any(Number), fault: { position: 4, bid: 1, took: 0 } },
        ]);
        expect(blockOf(snap.log).slice(3, 5).map((e) => e.message)).toEqual([`Fault: ${bob} (bid 2, took 0)`, `Fault: ${dan} (bid 1, took 0)`]);
        // every other row has no fault key
        expect(snap.log.filter((e) => 'fault' in e)).toHaveLength(2);
    });

    test('a rejoin after a drop: rejoinSuccess\'s snapshot has the same rows exactly once', async () => {
        const t = await setHand();
        const before = faultRows(t.game.getSnapshotV2(t.sockets[1].id).log);
        await t.kill(t.sockets[1]);
        const bob2 = await t.connect('bob');
        const from = t.log.length;
        await reconnectHandlers.rejoinGame(bob2, t.io, { gameId: t.game.gameId, username: bob2.username, sessionToken: t.tokens.get(bob2.username) });
        const rj = t.log.slice(from).find((l) => l.event === 'rejoinSuccess' && l.to === `self:${bob2.id}`);
        expect(rj).toBeTruthy();
        expect(faultRows(rj.data.snapshot.log)).toEqual(before);
        expect(before).toHaveLength(2);
    });

    test('a spectator who joins afterwards sees them in the full state', async () => {
        const t = await setHand();
        const eve = await t.connect('eve');
        const from = t.log.length;
        mainRoomHandlers.joinAsSpectator(eve, t.io, { gameId: t.game.gameId });
        const full = t.log.slice(from).find((l) => l.event === 'spectatorJoined' && l.to === `self:${eve.id}`);
        expect(full.data.snapshot.viewer.role).toBe('spectator');
        expect(faultRows(full.data.snapshot.log).map((e) => e.message)).toEqual([`Fault: ${t.names[1]} (bid 2, took 0)`, `Fault: ${t.names[3]} (bid 1, took 0)`]);
        // a spectator has no /help count
        expect(full.data.snapshot.viewer).not.toHaveProperty('assist');
    });
});

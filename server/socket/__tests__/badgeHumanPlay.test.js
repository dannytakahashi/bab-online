/**
 * Skill badges count only a human's play (owner 2026-11-25): the badges
 * credited from a seat's own bids, plays and held cards (Go Big or Go
 * Home, Spectator, Hammer Time, Double Rainbow, the 4B badges, the
 * over-trumped count behind Child Labor) count only what the seat did
 * while its controller was HUMAN. A lazy bot (/lazy at the deal) or an AFK
 * takeover's bot earns its owner nothing. Driven through the real
 * handlers: GameState.applyBid / applyPlay mark each bid and card,
 * game/badges.js reads the marks.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports
}));

const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const badges = require('../../game/badges');
const codec = require('../../game/persist/gameCodec');
const { Phase } = require('../../game/GamePhase');
const { makeIo, makeSocket, events, legalCards } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    delete process.env.AFK_TIMEOUT_MS;
    process.env.BID_CLOCK = 'off';
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    delete process.env.BID_CLOCK;
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/**
 * Four human seats on a 1-card hand, spades trump, seat 1 to bid and lead:
 * seat 1 leads 2H, seat 2 trumps with 5S, seat 3 over-trumps with KS
 * (seat 2 over-trumped), seat 4 takes it with the HI joker (seat 3
 * over-trumped). Seat 4 holds the HI joker.
 */
function setup() {
    seq++;
    const log = [];
    const io = makeIo(log);
    const ids = [1, 2, 3, 4].map((n) => `bhp${seq}-h${n}`);
    const names = ids.map((_id, i) => `p${seq}_${i + 1}`);
    ids.forEach((id, i) => {
        gameManager.registerUser(id, names[i]);
        mockDb.current.users._insert({ username: names[i], profilePic: i + 1 });
    });
    const sockets = ids.map((id) => makeSocket(id, log, io));
    const game = gameManager.createGame(ids);
    ids.forEach((id, i) => game.addPlayer(id, names[i], i + 1, i + 1, false));
    sockets.forEach((s) => s.join(game.roomName));
    game.entrants = null;
    game.currentHand = 1;
    game.dealer = 4;
    const dealt = [[C('2', 'hearts')], [C('5', 'spades')], [C('K', 'spades')], [C('HI', 'joker')]];
    ids.forEach((id, i) => game.setHand(id, dealt[i]));
    game.trump = C('3', 'spades');
    game.bidder = 1;
    game.dealSeq = 1;
    game.currentTurn = 1;
    game.forcePhase('BIDDING');
    game.playerBids = [];
    return { log, io, game, ids, names, sockets };
}

const chat = (t, pos, message) => chatHandlers.chatMessage(t.sockets[pos - 1], t.io, { message });
const seatOf = (t) => t.sockets.find((s) => s.id === t.game.positions[t.game.currentTurn]);

/** Let bots act and humans bid `bids[pos]` / play their one card, until the hand is scored. */
async function playOut(t, bids, { idlePlay = [] } = {}) {
    const from = t.log.length;
    for (let guard = 0; guard < 200 && events(t.log.slice(from), 'handComplete').length === 0; guard++) {
        const pos = t.game.currentTurn;
        const human = t.game.seat(pos)?.controller === 'human';
        if (human && t.game.stage === Phase.BIDDING && t.game.playerBids[pos - 1] == null) {
            await gameHandlers.playerBid(seatOf(t), t.io, { bid: bids[pos] });
        } else if (human && !idlePlay.includes(pos) && t.game.stage === Phase.PLAYING && !t.game.playedCards[pos - 1]) {
            const socket = seatOf(t);
            await gameHandlers.playCard(socket, t.io, { card: legalCards(t.game, socket.id)[0] });
        } else {
            await jest.advanceTimersByTimeAsync(1000);
        }
    }
}

test('/lazy at the deal: the bot\'s bids and its HI joker earn the owner nothing', async () => {
    const t = setup();
    // seats 2 and 4 go lazy before anyone bids
    chat(t, 2, '/lazy');
    chat(t, 4, '/lazy');
    expect(t.game.seat(2).controller).toBe('lazyBot');
    expect(t.game.seat(4).controller).toBe('lazyBot');
    // seats 2 and 3 were one zero bid short of Spectator; seat 4 one HI joker short of Hammer Time
    for (const pos of [2, 3]) Object.assign(t.game.badgeTrack.byPos[pos], { zeros: 4, zeroBest: 4 });
    Object.assign(t.game.badgeTrack.byPos[4], { hi: 4 });
    await playOut(t, { 1: '1', 3: '0' });

    const track = t.game.badgeTrack;
    expect([1, 2, 3, 4].map((p) => track.byPos[p].hb)).toEqual([1, 0, 1, 0]);
    // seat 3's own zero completes the run; seat 2's bot's bid (whatever it was) ends its run
    expect(track.byPos[3].zeroBest).toBe(5);
    expect(track.byPos[2]).toMatchObject({ zeros: 0, zeroBest: 4 });
    // seat 4's bot held the HI joker: not counted
    expect(track.byPos[4].hi).toBe(4);
    const earned = badges.gameBadges({ score: { team1: 0, team2: 0 }, badgeTrack: track });
    expect(earned[3]).toContain('spectator');
    expect(earned[2]).not.toContain('spectator');
    expect(earned[4]).not.toContain('hammer-time');
});

test('/lazy at the deal: the bot\'s over-trumped card counts for nobody, a human\'s does', async () => {
    const t = setup();
    chat(t, 2, '/lazy');
    const spy = jest.spyOn(badges, 'noteTrick');
    // seat 1's bore keeps the lead at seat 1 (a heart)
    await playOut(t, { 1: 'B', 3: '0', 4: '0' });
    expect(spy.mock.calls.map(([, trick]) => trick.lead)).toEqual([1]);
    const track = t.game.badgeTrack;
    // seat 2's bot's 5S was over-trumped by seat 3: not counted; seat 3's human KS by seat 4's HI joker: counted
    expect([1, 2, 3, 4].map((p) => track.byPos[p].hp)).toEqual([1, 0, 1, 1]);
    expect(track.byPos[2].ot).toBe(0);
    expect(track.byPos[3].ot).toBe(1);
    // and the human's HI joker hand counts
    expect(track.byPos[4].hi).toBe(1);
});

test('an AFK takeover mid-hand: the bid before it counts, the bot\'s card after it does not', async () => {
    const t = setup();
    // seat 2 bids itself, then sits on its play until the watchdog hands it to a bot
    await playOut(t, { 1: '1', 2: '0', 3: '0', 4: '1' }, { idlePlay: [2] });
    const track = t.game.badgeTrack;
    expect(events(t.log, 'playerLazyMode').map((e) => e.data.position)).toEqual([2]);
    expect(t.game.seat(2).controller).toBe('lazyBot');
    // every bid was a human's (the takeover came during the play)
    expect([1, 2, 3, 4].map((p) => track.byPos[p].hb)).toEqual([1, 1, 1, 1]);
    expect(track.byPos[2].zeros).toBe(1);
    expect(track.byPos[4].hi).toBe(1);
    // seat 2's 5S was the bot's play: its over-trump is not counted
    expect(track.byPos[2].hp).toBe(0);
    expect(track.byPos[2].ot).toBe(0);
    expect(track.byPos[3].ot).toBe(1);

    // the next hand's bid is the bot's: no zero for seat 2's run
    track.byPos[2].zeros = 4;
    badges.noteBid(track, 2, t.game.seat(2).controller === 'human');
    badges.noteHandKept(track, { playerBids: ['1', '0', '0', '1'], handSize: 1, hiJokerPosition: null });
    expect(track.byPos[2].zeros).toBe(0);
});

test('the marks survive a codec round trip mid-hand (deploy survival)', async () => {
    const t = setup();
    chat(t, 2, '/lazy');
    await gameHandlers.playerBid(t.sockets[0], t.io, { bid: '1' });
    await jest.advanceTimersByTimeAsync(5000);
    expect(t.game.badgeTrack.byPos[1].hb).toBe(1);
    expect(t.game.badgeTrack.byPos[2].hb).toBe(0);
    const doc = JSON.parse(JSON.stringify(codec.serialize(t.game, { tournamentId: null, getBot: () => null })));
    expect(doc.state.badgeTrack.byPos[1]).toMatchObject({ hb: 1 });
    expect(badges.normalizeTrack(doc.state.badgeTrack)).toEqual(badges.normalizeTrack(t.game.badgeTrack));
});

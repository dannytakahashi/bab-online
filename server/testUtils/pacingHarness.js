/**
 * Server-imposed wall-clock per game (server/game/pacing.js budget).
 *
 * Virtual time under Jest modern fake timers (Date is faked too), memoryDb,
 * the real lobby flow (createLobby -> addBot x3 -> playerReady) and seeded
 * Math.random (mulberry32).
 *
 *   start: the human's playerReady (the last one: bots are auto-ready)
 *   end:   the gameEnd emit
 *
 * The human draws as soon as startDraw arrives and answers every
 * updateTurn naming its seat at +0 virtual ms. Its decisions come from a
 * non-registered BotPlayer under its own seeded RNG, so the game's RNG
 * stream does not depend on the human. Every hold and bot schedule reports
 * through pacing.trace(kind, ms); the components below are summed from
 * those (bot draws run in parallel: their component is the span from the
 * first schedule to the last draw).
 *
 * The calling test must jest.mock('../database') with a memoryDb and use
 * fake timers.
 */

'use strict';

const gameManager = require('../game/GameManager');
const gameHandlers = require('../socket/gameHandlers');
const mainRoomHandlers = require('../socket/mainRoomHandlers');
const lobbyHandlers = require('../socket/lobbyHandlers');
const ambient = require('../demo/ambientBots');
const BotPlayer = require('../game/bot/BotPlayer');
const { botController } = require('../game/bot');
const { Phase } = require('../game/GamePhase');
const pacing = require('../game/pacing');
const { makeIo, makeSocket, legalCards, legalBids, mulberry32 } = require('./gameDriver');

const sameCard = (a, b) => a && b && a.suit === b.suit && a.rank === b.rank;

/**
 * Run one game. `humans` 1 = one human + 3 lobby bots; 2 = two humans + 2
 * lobby bots (both acting instantly, each with its own RNG); 0 = an
 * ambient 4-bot game (start = startBotGame).
 * @returns {{total, components, traces, log, game, humanPos, humanPositions, humanErrors}}
 */
async function runGame(seed, { humans = 1, maxSteps = 200000 } = {}) {
    const realRandom = Math.random;
    Math.random = mulberry32(seed);
    const withRng = (rand, fn) => {
        const r = Math.random;
        Math.random = rand;
        try { return fn(); } finally { Math.random = r; }
    };

    const traces = [];
    pacing.setTracer((kind, ms) => traces.push({ kind, ms, at: Date.now() }));

    const log = [];
    const io = makeIo(log);
    let game;
    let start;
    let pending = null;
    // One entry per human: socket, decision bot, RNG, seat, open turn
    // ('draw' or the updateTurn index it still has to answer)
    const seats = [];

    try {
        if (humans >= 1) {
            for (let i = 0; i < humans; i++) {
                const sid = `pace-${seed}-h${i ? i : ''}`;
                const username = `pace_${seed}${i ? `_${i}` : ''}`;
                gameManager.registerUser(sid, username);
                require('../database').getUsersCollection()._insert({ username, profilePic: 5 });
                seats.push({
                    sock: makeSocket(sid, log, io),
                    bot: new BotPlayer('🤖 Human', 'mary'),
                    rand: mulberry32(((seed * 7919) ^ 0x5bd1e995) + i),
                    pos: null,
                    drew: false,
                    turn: null,
                });
            }
            const host = seats[0].sock;
            for (const st of seats) mainRoomHandlers.joinMainRoom(st.sock, io);
            mainRoomHandlers.createLobby(host, io, { name: 'Pace' });
            if (seats.length > 1) {
                const lobbyId = gameManager.getPlayerLobby(host.id).id;
                for (const st of seats.slice(1)) mainRoomHandlers.joinLobby(st.sock, io, { lobbyId });
            }
            for (let i = seats.length; i < 4; i++) lobbyHandlers.addBot(host, io);
            // the host readies last: its playerReady starts the game
            for (const st of seats.slice(1)) await lobbyHandlers.playerReady(st.sock, io);
            start = Date.now();
            pending = lobbyHandlers.playerReady(host, io);
            while (!(game = gameManager.getPlayerGame(host.id))) await jest.advanceTimersToNextTimerAsync();
        } else {
            start = Date.now();
            game = ambient.startBotGame(io);
        }

        let seen = 0;
        let steps = 0;
        let endAt = null;

        const scan = () => {
            for (; seen < log.length; seen++) {
                const l = log[seen];
                if (l.event === 'gameEnd' && endAt === null) endAt = l.at;
                for (const st of seats) {
                    if (l.event === 'startDraw' && !st.drew) st.turn = 'draw';
                    // my seat: my socket in positionUpdate (no playerAssigned since V1_REMOVALS #7)
                    if (l.event === 'positionUpdate' && l.to === game.roomName) {
                        const i = l.data.sockets.indexOf(st.sock.id);
                        if (i >= 0) st.pos = l.data.positions[i];
                    }
                    if (l.event === 'updateTurn' && l.to === game.roomName && l.data.currentTurn === st.pos) st.turn = seen;
                }
            }
        };

        while (endAt === null && steps++ < maxSteps) {
            scan();
            if (endAt !== null) break;
            const st = seats.find((x) => x.turn !== null);
            if (st && st.turn === 'draw') {
                st.turn = null;
                st.drew = true;
                gameHandlers.draw(st.sock, io, { num: 0 });
                await jest.advanceTimersByTimeAsync(0);
                continue;
            }
            if (st) {
                st.turn = null;
                const sock = st.sock;
                const sid = sock.id;
                const humanPos = st.pos;
                const human = st.bot;
                human.position = humanPos;
                if (game.stage === Phase.BIDDING && game.currentTurn === humanPos) {
                    const ctx = {
                        teamScore: humanPos % 2 ? game.score.team1 : game.score.team2,
                        oppScore: humanPos % 2 ? game.score.team2 : game.score.team1,
                        currentHandSize: game.currentHand,
                    };
                    let bid = withRng(st.rand, () => human.decideBid(game.getHand(sid), game.trump, game.playerBids, game.currentHand, ctx));
                    if (!legalBids(game).includes(String(bid))) bid = legalBids(game)[0];
                    gameHandlers.playerBid(sock, io, { bid });
                } else if (game.stage === Phase.PLAYING && game.currentTurn === humanPos) {
                    const legal = legalCards(game, sid);
                    let card = withRng(st.rand, () => human.decideCard(game.getHand(sid), game.playedCards, game.leadCard,
                        game.leadPosition, game.trump, game.isTrumpBroken, game.currentHand, botController.buildPlayContext(game)));
                    if (!legal.some((c) => sameCard(c, card))) card = legal[0];
                    gameHandlers.playCard(sock, io, { card });
                }
                await jest.advanceTimersByTimeAsync(0);
                continue;
            }
            await jest.advanceTimersToNextTimerAsync();
        }
        if (endAt === null) throw new Error(`seed ${seed}: game did not end (stage ${game.stage})`);
        await pending;

        const total = endAt - start;
        const components = {};
        const add = (k, ms) => { components[k] = (components[k] || 0) + ms; };
        let drawFirst = Infinity;
        let drawLast = -Infinity;
        for (const t of traces) {
            if (t.at > endAt) continue;
            if (t.kind === 'botDraw') {
                drawFirst = Math.min(drawFirst, t.at);
                drawLast = Math.max(drawLast, t.at + t.ms);
            } else {
                add(t.kind, t.ms);
            }
        }
        if (drawLast > drawFirst) add('botDraw', drawLast - drawFirst);
        const humanErrors = log.filter((l) => seats.some((st) => l.to === `self:${st.sock.id}`) &&
            (l.event === 'actionRejected' || l.event === 'serverError'));
        const humanPositions = seats.map((st) => st.pos);
        return { total, components, traces, log, game, humanPos: humanPositions[0] ?? null, humanPositions, humanErrors };
    } finally {
        Math.random = realRandom;
        pacing.setTracer(null);
        for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
        ambient.stopAmbientActivity();
    }
}

/** Mean of runGame totals and summed components (ms) over `seeds`. */
async function measure(seeds, opts) {
    const runs = [];
    for (const seed of seeds) runs.push(await runGame(seed, opts));
    const sum = (f) => runs.reduce((a, r) => a + f(r), 0);
    const kinds = new Set(runs.flatMap((r) => Object.keys(r.components)));
    const components = {};
    for (const k of [...kinds].sort()) components[k] = sum((r) => r.components[k] || 0) / runs.length;
    return { runs, mean: sum((r) => r.total) / runs.length, components };
}

/**
 * The smallest observed gap (ms) of every transition a client renders,
 * from the emit timestamps of one runGame result (room broadcasts plus the
 * human's own gameStart). Keys match pacing.SHIPPED_IOS_FLOORS' reasons.
 */
function gapMins({ log, game, humanPos, humanPositions }) {
    const mins = {};
    const gap = (k, ms) => { mins[k] = Math.min(mins[k] ?? Infinity, ms); };
    const humansAt = humanPositions || [humanPos];
    const isBot = (pos) => !humansAt.includes(pos);
    let draws = 0;
    let lastDraw = null;
    let teamsAt = null;
    let dealAt = null;
    let firstBidOfDeal = true;
    let lastBidAt = null;
    let doneBiddingAt = null;
    let trickCards = 0;
    let lastCardAt = null;
    let fourthAt = null;
    let trickDoneAt = null;
    let lastTrickAt = null;
    let handGap = null;
    for (const l of log) {
        const room = l.to === game.roomName;
        const own = l.event === 'gameStart' && l.data && l.data.gameId === game.gameId && l.data.position !== undefined; // the seat variant (hands are live arrays)
        if (!room && !own) continue;
        const d = l.data || {};
        switch (l.event) {
            case 'playerDrew':
                draws++;
                if (draws === 4) lastDraw = l.at;
                break;
            case 'teamsAnnounced':
                if (lastDraw !== null) gap('drawToTeams', l.at - lastDraw);
                teamsAt = l.at;
                break;
            case 'gameStart':
                if (teamsAt !== null) { gap('teamsToGameStart', l.at - teamsAt); teamsAt = null; }
                if (handGap !== null) { gap('handEnd', handGap); handGap = null; }
                dealAt = l.at;
                firstBidOfDeal = true;
                trickCards = 0;
                break;
            case 'bidReceived':
                if (isBot(d.position)) {
                    if (firstBidOfDeal && dealAt !== null) gap('firstBotBid', l.at - dealAt);
                    else if (!firstBidOfDeal && lastBidAt !== null) gap('bidToBid', l.at - lastBidAt);
                }
                firstBidOfDeal = false;
                lastBidAt = l.at;
                break;
            case 'doneBidding':
                doneBiddingAt = l.at;
                break;
            case 'cardPlayed':
                if (trickCards === 0) {
                    if (isBot(d.position) && doneBiddingAt !== null) gap('doneBiddingToLead', l.at - doneBiddingAt);
                    else if (isBot(d.position) && trickDoneAt !== null) gap('trickCompleteToLead', l.at - trickDoneAt);
                } else if (isBot(d.position)) {
                    gap('cardToBotCard', l.at - lastCardAt);
                }
                doneBiddingAt = null;
                trickDoneAt = null;
                trickCards++;
                lastCardAt = l.at;
                if (trickCards === 4) fourthAt = l.at;
                break;
            case 'trickComplete':
                if (fourthAt !== null) gap('trickView', l.at - fourthAt);
                trickCards = 0;
                if (Number.isFinite(d.resumeInMs)) { lastTrickAt = l.at; trickDoneAt = null; } else trickDoneAt = l.at;
                break;
            case 'handComplete':
                // handEnd or gameEnd, decided by what follows in the same tick
                if (lastTrickAt !== null) handGap = l.at - lastTrickAt;
                lastTrickAt = null;
                break;
            case 'gameEnd':
                if (handGap !== null) gap('gameEnd', handGap);
                handGap = null;
                break;
            default:
                break;
        }
    }
    return mins;
}

/** One printable row per component, in seconds. */
function report(title, m) {
    const rows = Object.entries(m.components).map(([k, v]) => `  ${k.padEnd(22)} ${(v / 1000).toFixed(1).padStart(7)} s`);
    return `${title}: mean ${(m.mean / 1000).toFixed(1)} s over ${m.runs.length} games\n${rows.join('\n')}`;
}

module.exports = { runGame, measure, report, gapMins };

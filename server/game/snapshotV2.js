/**
 * Table snapshot v2: one normalized, versioned view of a game for ONE
 * viewer (contract/events.schema.json $defs.snapshotV2; consumer rules in
 * contract/README.md).
 *
 * Pure: reads the game, never writes it, and returns a deep copy that is
 * JSON-safe and holds NO socket ids. Every key is always present, in a
 * fixed order (the committed fixtures depend on it). It deliberately
 * requires only rules / GamePhase / SeatState (never GameState or
 * GameManager): tournament info is passed in through opts.
 */

'use strict';

const { calculateMultiplier, determineDrawPosition } = require('./rules');
const { Phase } = require('./GamePhase');
const { Controller, isBotSocket, seatDisplay } = require('./SeatState');

const SNAPSHOT_VERSION = 2;
const HAND_SEQUENCE = [12, 10, 8, 6, 4, 2, 1, 3, 5, 7, 9, 11, 13];
const PRE_DEAL = new Set([Phase.CREATED, Phase.DRAWING, Phase.DRAW_RESOLVING, Phase.TEAMS_ANNOUNCED]);
const POSITIONS = [1, 2, 3, 4];

const card = (c) => (c ? { suit: c.suit, rank: c.rank } : null);
const pair = (p) => ({ team1: p?.team1 ?? 0, team2: p?.team2 ?? 0 });
const isTeamShaped = (b) => !!b && typeof b.team1 === 'number' && typeof b.team2 === 'number';

/**
 * @param {GameState} game
 * @param {string|null} viewerSid - the RECEIVING socket
 * @param {Object} [opts]
 * @param {Object|null} [opts.tournament] - {tournamentId, name, roundNumber, totalRounds}
 * @param {number} [opts.now]
 * @param {boolean} [opts.customPics=true] - include data:image seat pictures
 * @param {boolean} [opts.log=true] - include the game log
 * @param {Function} [opts.avatarResolve] - (pic, username) -> {legacy, url}
 *   for a custom seat picture (avatarWire.seatResolve; null: raw, no URL)
 * @param {Function} [opts.botName] - socketId -> display name of a bot
 *   entrant (entrant records carry no bot names)
 */
function buildSnapshotV2(game, viewerSid, { tournament = null, now = Date.now(), customPics = true, log = true, botName = null, avatarResolve = null } = {}) {
    const stage = game.stage;
    const preDeal = PRE_DEAL.has(stage);
    const partial = [];

    // ---- viewer: the receiving socket's role ----
    // A seat owner is 'seat' while the seat is human, else 'lazyWatcher' (any
    // owner of a bot-controlled seat: lazy or resigned, seat or watch view).
    // Otherwise a pure spectator, a pre-seating entrant, or nobody.
    const ownPos = viewerSid != null ? game.seatByOwnerSocket(viewerSid) : null;
    const ownSeat = ownPos ? game.seat(ownPos) : null;
    let role = 'none';
    if (ownSeat) role = ownSeat.controller === Controller.HUMAN ? 'seat' : 'lazyWatcher';
    else if (viewerSid != null && game.spectators.has(viewerSid)) role = 'spectator';
    else if (viewerSid != null && game.entrant(viewerSid)) role = 'entrant';
    const ownerView = ownSeat ? (ownSeat.controller === Controller.HUMAN ? 'seat' : (ownSeat.ownerView ?? null)) : null;

    // ---- turn: only while a turn can be taken (hides the stale
    // currentTurn during DEALING, TRICK_RESOLVING, HAND_RESOLVING, ...) ----
    let turn = null;
    if (stage === Phase.BIDDING) turn = { position: game.currentTurn, action: 'bid' };
    else if (stage === Phase.PLAYING) turn = { position: game.currentTurn, action: 'play' };

    // ---- bids: always strings by position; team bids once bidding is over ----
    const byPosition = POSITIONS.map((p) => {
        const b = game.playerBids[p - 1];
        return b == null ? null : String(b).toUpperCase();
    });
    const order = POSITIONS.map((k) => ((game.bidder - 1 + k - 1) % 4) + 1);
    const teamBids = stage !== Phase.BIDDING && !preDeal && isTeamShaped(game.bids)
        ? { team1: game.bids.team1, team2: game.bids.team2 }
        : null;
    // Over the bids so far (equals game.team1Mult/team2Mult once all are in)
    const mults = {
        team1: calculateMultiplier(byPosition[0], byPosition[2]),
        team2: calculateMultiplier(byPosition[1], byPosition[3]),
    };

    // ---- trick: the cards on the table in play order ----
    const inTrick = stage === Phase.PLAYING || stage === Phase.TRICK_RESOLVING;
    const trick = { number: null, leadPosition: null, cards: [] };
    if (inTrick) {
        trick.number = game.tricks.team1 + game.tricks.team2 + 1;
        if (game.playedCardsIndex > 0) {
            trick.leadPosition = game.leadPosition;
            for (let k = 0; k < 4; k++) {
                const p = ((game.leadPosition - 1 + k) % 4) + 1;
                const c = game.playedCards[p - 1];
                if (!c) break;
                trick.cards.push({ position: p, card: card(c) });
            }
        }
        // Between tricks (no card down) the next leader is turn.position
    }

    // ---- the viewer's hand: seat owners (also while their bot plays) ----
    const ownsHand = role === 'seat' || role === 'lazyWatcher';
    const hand = ownsHand ? (game.hands[ownSeat.seatSocketId] || []).map(card) : null;
    const hsiValues = game.hsiValues || {};
    const hsi = ownsHand && Object.keys(hsiValues).length > 0 ? POSITIONS.map((p) => hsiValues[p] ?? null) : null;

    // ---- seats: [] until all four exist (never presenceSummary: it has socket ids) ----
    let seats = [];
    if (game.seatList().length === 4) {
        let withheld = false;
        seats = POSITIONS.map((p) => {
            const s = game.seat(p);
            const d = seatDisplay(s);
            const custom = typeof d.pic === 'string' && d.pic.startsWith('data:image');
            if (custom && !customPics) withheld = true;
            // avatars (docs/avatars.md; opts.avatarResolve = avatarWire.seatResolve
            // from snapshotFor): customPic is the legacy inline value,
            // avatarUrl (additive, only with a rendition) the HTTP URL
            const r = custom && avatarResolve ? avatarResolve(d.pic, d.username) : null;
            const seat = {
                position: p,
                username: d.username ?? null,
                pic: typeof d.pic === 'number' ? d.pic : null,
                hasCustomPic: custom,
                customPic: custom && customPics ? (r ? r.legacy : d.pic) : null,
                ownerUsername: s.ownerUsername ?? null,
                controller: s.controller,
                presence: s.presence,
                isBot: s.controller !== Controller.HUMAN,
                lazy: game.wireLazy(p),
                offered: game.offerPos === p,
                graceDeadline: s.graceDeadline ?? null,
                resignableAt: s.resignableAt ?? null,
                cardsInHand: (game.hands[s.seatSocketId] || []).length,
            };
            if (r && r.url) seat.avatarUrl = r.url;
            return seat;
        });
        if (withheld) partial.push('customPics');
    }

    // ---- entrants (before seating) and the draw (until the deal resets it) ----
    const entrants = game.entrants === null || game.entrants === undefined ? null
        : Array.from(game.entrants.values(), (e) => ({
            username: e.username ?? (e.isBot && botName ? botName(e.socketId) : null),
            isBot: !!e.isBot,
            presence: e.presence,
            hasDrawn: game.drawIDs.includes(e.socketId),
        }));
    let draw = null;
    if (preDeal) {
        const complete = game.drawCards.length === 4;
        const names = game.drawNames || [];
        draw = {
            deckRemaining: game.deck ? game.deck.cards.length : null,
            drawn: game.drawCards.map((c, i) => ({
                drawOrder: i + 1,
                username: names[i] ?? null,
                isBot: isBotSocket(game.drawIDs[i]),
                card: card(c),
                position: complete ? determineDrawPosition(c, game.drawCards) : null,
            })),
            viewerDrawOrder: viewerSid != null && game.drawIDs.includes(viewerSid) ? game.drawIDs.indexOf(viewerSid) + 1 : null,
        };
    }

    // ---- deal: null before the first deal ----
    const deal = preDeal || game.dealSeq == null ? null : {
        handNo: HAND_SEQUENCE.indexOf(game.currentHand) + 1,
        handSize: game.currentHand,
        dealer: game.dealer,
        bidder: game.bidder,
        dealSeq: game.dealSeq ?? null,
    };

    let logEntries = [];
    if (log) {
        logEntries = game.gameLog.map((e) => ({
            message: e.message,
            type: e.type,
            position: e.playerPosition ?? null,
            at: e.timestamp,
        }));
    } else {
        partial.push('log');
    }
    partial.sort();

    return {
        v: SNAPSHOT_VERSION,
        gameId: game.gameId,
        seq: game.eventSeq || 0,
        serverTime: now,
        stage,
        partial,
        viewer: {
            role,
            position: ownPos || null,
            ownerView,
            canAct: role === 'seat' && !!turn && turn.position === ownPos &&
                (turn.action === 'bid' ? byPosition[ownPos - 1] == null : !game.playedCards[ownPos - 1]),
        },
        hand,
        deal,
        trump: card(game.trump),
        trumpBroken: !!game.isTrumpBroken,
        turn,
        bids: { byPosition, order, teamBids, mults },
        trick,
        tricks: pair(game.tricks),
        tricksByPosition: POSITIONS.map((p) => game.handTricks?.[p] ?? 0),
        score: pair(game.score),
        rainbows: pair(game.rainbows),
        hsi,
        seats,
        entrants,
        draw,
        spectatorCount: game.spectators.size,
        tournament: tournament ? {
            tournamentId: tournament.tournamentId,
            name: tournament.name,
            roundNumber: tournament.roundNumber ?? null,
            totalRounds: tournament.totalRounds,
        } : null,
        log: logEntries,
        // The open server-timed hold (pacing.js), relative to serverTime
        resume: typeof game.resumeInfo === 'function' ? game.resumeInfo(now) : null,
    };
}

module.exports = { buildSnapshotV2, SNAPSHOT_VERSION, HAND_SEQUENCE };

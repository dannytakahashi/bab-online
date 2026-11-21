/**
 * Table snapshot v2: one normalized, versioned view of a game for ONE
 * viewer (contract/events.schema.json $defs.snapshotV2; consumer rules in
 * contract/README.md).
 *
 * Pure: reads the game, never writes it, and returns a deep copy that is
 * JSON-safe and holds NO socket ids. Every key is always present, in a
 * fixed order (the committed fixtures depend on it). It deliberately
 * requires only rules / GamePhase / SeatState / assistState (never
 * GameState or GameManager): tournament info is passed in through opts.
 * Optional keys (absent when they do not apply): bidClock, viewer.assist
 * (the viewer's own seat only) and a log item's fault.
 */

'use strict';

const { calculateMultiplier, determineDrawPosition, HAND_PROGRESSION } = require('./rules');
const { Phase } = require('./GamePhase');
const { Controller, isBotSocket, seatDisplay } = require('./SeatState');
const { spectatorsWire } = require('./spectatorWire');
const { assistTally, tutorialTally, isFreeHelpGame } = require('./assistState');

const SNAPSHOT_VERSION = 2;
const HAND_SEQUENCE = HAND_PROGRESSION;
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
 * @param {boolean} [opts.log=true] - include the game log
 * @param {Function} [opts.avatarResolve] - (pic, username) -> {url} for a
 *   custom seat picture (avatarWire.seatResolve; null: no URL)
 * @param {Function} [opts.botName] - socketId -> display name of a bot
 *   entrant (entrant records carry no bot names)
 * @param {Set<string>|string[]|null} [opts.hideChatFrom] - usernames whose
 *   chat lines the log leaves out (the viewer's block list,
 *   socket.data.blockedUsers): both clients hide a blocked sender's live
 *   chatMessage, so a snapshot's log must not bring it back. Only 'chat'
 *   entries with a `from` are dropped; system lines are kept.
 */
function buildSnapshotV2(game, viewerSid, { tournament = null, now = Date.now(), log = true, botName = null, avatarResolve = null, hideChatFrom = null } = {}) {
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
    // Only the viewer's own seat: the other three are null (2026-11-21:
    // they leaked the others' hand strength; the 4-item array shape stays)
    const hsi = ownsHand && Object.keys(hsiValues).length > 0 ? POSITIONS.map((p) => (p === ownPos ? hsiValues[p] ?? null : null)) : null;

    // ---- seats: [] until all four exist (never presenceSummary: it has socket ids) ----
    let seats = [];
    if (game.seatList().length === 4) {
        seats = POSITIONS.map((p) => {
            const s = game.seat(p);
            const d = seatDisplay(s);
            const custom = typeof d.pic === 'string' && d.pic.startsWith('data:image');
            // avatars (docs/avatars.md; opts.avatarResolve = avatarWire.seatResolve
            // from snapshotFor): a custom picture is only avatarUrl (additive,
            // with a rendition); customPic is always null and partial never
            // lists 'customPics' (V1_REMOVALS #19 C)
            const r = custom && avatarResolve ? avatarResolve(d.pic, d.username) : null;
            const seat = {
                position: p,
                username: d.username ?? null,
                pic: typeof d.pic === 'number' ? d.pic : null,
                hasCustomPic: custom,
                customPic: null,
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
        const hidden = hideChatFrom instanceof Set ? hideChatFrom
            : Array.isArray(hideChatFrom) ? new Set(hideChatFrom) : null;
        const shown = hidden && hidden.size > 0
            ? game.gameLog.filter((e) => !(e.type === 'chat' && typeof e.from === 'string' && hidden.has(e.from)))
            : game.gameLog;
        logEntries = shown.map((e) => ({
            message: e.message,
            type: e.type,
            position: e.playerPosition ?? null,
            at: e.timestamp,
            // additive (2026-11-19): a hand's fault line {position, bid, took}
            ...(e.fault && { fault: { position: e.fault.position, bid: e.fault.bid, took: e.fault.took } }),
        }));
    } else {
        partial.push('log');
    }
    partial.sort();

    // ---- who is watching: pure spectators, one per username, never a
    // seat owner (GameState.spectatorList); capped list, true count ----
    const watching = spectatorsWire(game.spectatorList(), avatarResolve);

    // ---- the bid clock (socket/bidClock.js), only while it runs ----
    const clock = typeof game.bidClockInfo === 'function' ? game.bidClockInfo(now) : null;

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
            // additive (2026-11-19): the viewer's own /help count this game
            // (assistState; the assistHint's uses / freeUses / assisted), only
            // for a seat owner, so a reload shows the exact count
            // (+ unlimited: true in a game with a native bot seat, isFreeHelpGame)
            // (+ tutorial: true and auto: true while the tutorial is on, so
            // a reload shows it: assistState.tutorialTally)
            ...(ownSeat && {
                assist: {
                    ...assistTally(game.assist?.[ownPos], ownSeat.ownerUsername ?? null, isFreeHelpGame(game)),
                    ...tutorialTally(game.assist?.[ownPos], ownSeat.ownerUsername ?? null)
                }
            }),
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
        // This deal's won tricks (as many as `tricks` counts), each with its
        // winner, lead and 4 cards in play order: public, every viewer saw
        // them played. At most 13 x 4 cards
        trickHistory: (game.trickHistory || []).map((t) => ({ winner: t.winner, lead: t.lead, cards: t.cards.map(card) })),
        score: pair(game.score),
        rainbows: pair(game.rainbows),
        hsi,
        seats,
        entrants,
        draw,
        // (v2's own, unchanged: spectator SOCKETS, an owner's other tab
        // included; the badge reads `watching`)
        spectatorCount: game.spectators.size,
        // additive (2026-11-11, the table's spectator badge): who is
        // watching, as spectatorsUpdated sends it (people, never an owner)
        watching,
        tournament: tournament ? {
            tournamentId: tournament.tournamentId,
            name: tournament.name,
            roundNumber: tournament.roundNumber ?? null,
            totalRounds: tournament.totalRounds,
        } : null,
        log: logEntries,
        // The open server-timed hold (pacing.js), relative to serverTime
        resume: typeof game.resumeInfo === 'function' ? game.resumeInfo(now) : null,
        // additive (2026-11-18): the RUNNING bid clock, relative to
        // serverTime; the key is absent otherwise (also in its pre-wait)
        ...(clock && { bidClock: clock }),
    };
}

module.exports = { buildSnapshotV2, SNAPSHOT_VERSION, HAND_SEQUENCE };

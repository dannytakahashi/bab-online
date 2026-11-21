/**
 * Game codec (deploy survival; docs/claude/server-infra.md and the plan's
 * 2.2): a live GameState to a JSON document and back. Pure apart from two
 * lookups it can be handed instead (the game's tournament, its registered
 * bots): no I/O, no emits, no RNG. The persist store (liveStore.js, PR 4)
 * writes what serialize and serializeEnded return; adoption (PR 5,
 * persist/restoreGame.adoptGame) builds a game from hydrate.
 *
 * serialize(game) is null (nothing to save) for the ambient demo game, a
 * terminal, frozen or suspended game (GameState.suspend, the holder
 * self-fence), a stage outside the four restore stages
 * (BIDDING, PLAYING, TRICK_RESOLVING, HAND_RESOLVING: a dealt hand; DEALING
 * and REDEAL never last past one synchronous run, and a dealHand that threw
 * would leave DEALING), a game whose last run threw (game._tainted,
 * GameState.markTainted) and a game failing validateGameState. Otherwise:
 *
 *   {v, gameId, stage, tournamentId, state, log, logTotal, bots}
 *
 * `state` holds every SAVED field below (playedCards and playerBids as
 * fixed slots with nulls, hands and seats keyed by position, never a
 * socket id but the bots' own 'bot:' ids; the players index's order as
 * seatOrder, since a deal hands out cards in that order). `log` is the
 * game log (500 lines at most; a chat line carries an internal `from` once
 * PR 2 lands).
 * `bots` is one record per bot-played seat ({socketId, username,
 * personality, position, pic, partnerHistory}: the registered BotPlayer's
 * partnerHistory feeds Zach's bids).
 * A game a lobby started (GameManager.startGameFromLobby) also saves, in
 * `state`, its voice settings (casualVoice: host, spectatorsCanTalk (always
 * true), the lobby extras) and what play again reopens at its end
 * (lobbyOrigin, without the lobby chat), both by username; null for any
 * other game. `state.assist` is game.assist (assistState.js: each
 * position's /help owner, counted uses and the turn of the last one, plus
 * the tutorial's reserved fields), all four positions, normalized. Not
 * saved: the voice spectators (socket keyed: spectators re-spectate and
 * are admitted again), and process state
 * outside the game: BotController's "he sends a boy" cooldown (a restored
 * table may quip one cooldown sooner), GameManager.startedLobbies (the
 * extras' reload redirect into a just-started game) and every lobby,
 * play-again holds and reservations included (they live on lobbies).
 *
 * Versions: CODEC_V 2 added state.assist; CODEC_V 3 (2026-11-19) a log
 * entry's optional `fault` {position, bid, took} (a hand's fault line,
 * gameHandlers.handleHandComplete; the snapshot's log item carries it).
 * hydrate reads v1, v2 and v3 (a v1 doc, written before /help, restores
 * every seat with the default assist: no use yet; a v1 or v2 doc has no
 * fault lines, nothing to convert) and serialize always writes CODEC_V; any
 * other v is a CodecError('version').
 *
 * `state.seatBags` (2026-11-20, superlatives; GameState.seatBags,
 * rules.normalizeSeatBags: {hands, byPos}, or null for a game without the
 * counter) joined SAVED WITHOUT a CODEC_V bump, on purpose: a v4 doc is
 * one the release before cannot read at all (READ_VERSIONS [1, 2, 3]), so
 * a rollback would discard every live game. It is optional both ways: the
 * release before's restoreFrom reads named state fields only and drops
 * it (and its own saves leave it out), and a v3 doc without it restores
 * here as null (no counter: that game's record carries no bags, the
 * superlatives use the net per seat). Its pins in
 * gameCodec.fieldGuard.test.js were re-taken for v3.
 * `state.seatExact` (2026-11-20, the superlatives' My Quantitative;
 * GameState.seatExact, rules.normalizeSeatCounter: the same {hands, byPos}
 * shape) joined the same way, for the same reasons: still v3, optional both
 * ways (a doc without it restores null: that game's record has no spot-on
 * counts), pins re-taken.
 *
 * hydrate(doc) is `new GameState(gameId)` + GameState.restoreFrom (the
 * only restore writer; restoreSeats maps presence: every human seat in a
 * fresh reconnect grace keyed by restored:<gameId>:<pos>, lazy / resign
 * seats away (gone stays gone), native bots bot/none) + validateGameState,
 * then a lobby-born game's casualVoice (gameVoice.initCasualVoice, no io:
 * the adopter's next voice call with one sets it) and lobbyOrigin.
 * eventSeq continues 1000 past the saved one (defensive: both clients take
 * a snapshot's seq as the baseline). It registers nothing (GameManager,
 * BotController, rooms) and arms no timer but the grace timers: the
 * adopter does that, then the restore kick (gameHandlers.resumeTrick /
 * handleHandComplete, tableView.openTrick for the bots' card memory).
 *
 * The bid clock (socket/bidClock.js: game.bidClock, game.bidTimeouts) is
 * DERIVED: a deadline is an instant on the old process, and every restored
 * human seat starts in reconnect grace, so the fair rule is a fresh clock
 * (T0 = adoption; at most one extra full clock per restart) and no strikes.
 * PR 5 does: (a) the restore kick (persist/restoreGame.kick, when the
 * restored table's gate opens) takes a restored BIDDING game through
 * gameHandlers.triggerBotIfNeeded(io, game, 'bid') (its first line is
 * bidClock.onTurn), so a human bidder gets that fresh clock (otherwise a
 * restored table whose bidder never returns waits on grace + resign
 * again); (b) the reversible holder self-fence (GameState.suspend /
 * unsuspend) re-arms 'bidClock' through bidClock.afterSuspend -> onTurn
 * (its same-turn resume), never drops it.
 *
 * Field guard (gameCodec.fieldGuard.test.js): every key of a live game,
 * seat record, seat bot record and BotPlayer is in SAVED or DERIVED, every
 * `game.<x> =` in server code names one of them, and the SAVED lists hash
 * to the value pinned for CODEC_V: a new field must be classified, and
 * changing what is saved bumps CODEC_V.
 *
 * serializeEnded(game, record) is the ENDED tombstone's payload: the
 * gameRecords document the live end inserts (built once by profileHandlers
 * .buildGameEndRecord and passed both here and to recordGameStats(game,
 * {record}); never for an aborted game), the final score, each seat's
 * {username, position, gone} (tournament scoring) and the tournamentId.
 */

'use strict';

const GameState = require('../GameState');
const { Phase } = require('../GamePhase');
const { Controller, Presence } = require('../SeatState');
const { isStockPic } = require('../../avatar/stockAvatars');
const { ASSIST_SEAT_KEYS, normalizeAssist } = require('../assistState');
const { normalizeSeatBags, normalizeSeatCounter } = require('../rules');

/** Bump on any change to what is saved (SAVED) or how it is read back. */
const CODEC_V = 3;

/**
 * The versions hydrate reads. A new version keeps the old ones readable
 * (restoreFrom fills the defaults), so a game saved by the process before
 * a deploy survives it.
 */
const READ_VERSIONS = Object.freeze([1, 2, 3]);

/** A hydrated game's eventSeq continues this far past the saved one. */
const EVENT_SEQ_OFFSET = 1000;

const SAVE_STAGES = GameState.RESTORE_STAGES;

const deepFreeze = (o) => {
    for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
    return Object.freeze(o);
};

/**
 * Saved, per kind of object. `game` lists GameState keys (the doc's
 * gameId and stage, the rest in `state`; gameLog and logTotal as `log` and
 * `logTotal`).
 */
const SAVED = deepFreeze({
    game: [
        'gameId', 'createdAt', '_stage', 'eventSeq', 'dealSeq',
        'currentHand', 'dealer', 'bidder',
        'bids', 'playerBids', 'team1Mult', 'team2Mult',
        'currentTurn', 'leadPosition', 'leadCard', 'playedCards', 'playedCardsIndex',
        'trump', 'isTrumpBroken', 'cardIndex',
        'tricks', 'trickHistory', 'score', 'rainbows',
        'handStats', 'playerStats', 'handTricks', 'hsiValues',
        'seatBags',                                   // the superlatives' bag counter (2026-11-20, still v3): below
        'seatExact',                                  // the superlatives' spot-on bid counter (2026-11-20, still v3): below
        'hands', 'seats', 'gameLog', 'logTotal',
        'players',                                    // only its key order, as state.seatOrder (the deal order)
        'casualVoice', 'lobbyOrigin',                 // a lobby-born casual game (null otherwise): below
        'assist'                                      // /help per position (CODEC_V 2): assistSeat below
    ],
    seat: ['controller', 'presence', 'ownerUsername', 'ownerPic', 'bot', 'lastPersonality', 'resignedAt', 'leftAt'],
    seatBot: ['socketId', 'username', 'pic', 'personality'],
    botPlayer: ['socketId', 'username', 'personality', 'position', 'pic', 'partnerHistory'],
    // fault (CODEC_V 3): a hand's fault line {position, bid, took}
    logEntry: ['message', 'playerPosition', 'type', 'timestamp', 'from', 'fault'],
    // gameVoice.initCasualVoice's settings, by username: a restored family
    // game keeps its host and which watchers came from the lobby (hydrate
    // re-runs initCasualVoice with them). spectatorsCanTalk is always
    // written true and never read back (always true since 2026-11-18; a
    // doc saved with false before that restores as true)
    casualVoice: ['host', 'spectatorsCanTalk', 'lobbyExtras'],
    // playAgain.originOf, by username and bot id (no human socket id):
    // a restored game still returns its players to their lobby at its end.
    // Maps and Sets as arrays (bots as [botId, personality] entries)
    lobbyOrigin: ['lobbyId', 'name', 'createdBy', 'host', 'settings', 'order', 'bots',
        'playAgainUsers', 'casualUsers', 'extras'],
    // game.assist[pos] (assistState.js), by position and owner username
    assistSeat: ASSIST_SEAT_KEYS
});

/** Not saved: rebuilt, reset or set fresh on restore (or never restored). */
const DERIVED = deepFreeze({
    game: [
        'roomName', 'positions',                      // _indexSeat from the seats
        'epoch', '_timers', '_pauses', 'resume',      // back to 0 / none; the restore kick re-arms
        '_history', '_seatHistory', '_debugMode', 'maxLogEntries',
        'entrants', 'drawCards', 'drawIDs', 'drawIndex', 'drawNames', 'deck', // pre-deal only
        'offerPos', 'idleOffer', 'afkClock',          // offers re-made, a fresh AFK clock
        'bidClock', 'bidTimeouts',                    // a fresh bid clock (the restore kick's trigger) and no strikes
        'spectators',                                 // people re-spectate
        'shoulders',                                  // over-the-shoulder watchers re-send watchHand after re-spectating
        'avatarVersions',                             // recomputed after warming custom pictures
        'isDemo',                                     // the demo game is never saved
        'frozen', '_tainted',                         // a frozen or tainted game is never saved
        '_suspended',                                 // the holder self-fence (suspend): never saved while set
        'restored',                                   // restoreGame's gate and restored abandon: set fresh by the adopter
        'voiceSpectators'                             // socket-keyed: voice spectators re-spectate and re-join
    ],
    seat: ['position', 'ownerSocketId', 'ownerView', 'seatSocketId', 'absentSince', 'graceDeadline', 'resignableAt'],
    seatBot: [],
    botPlayer: ['gameId', 'cardMemory'],              // card memory: replayCardMemory from trickHistory
    logEntry: [],
    // lastIo: the adopter's io (gameVoice.ioFor sets it on the next call
    // with one); the admission counter restarts with the re-admitted
    // spectators
    casualVoice: ['lastIo', 'order'],
    // Lobby chat is not saved (lobbies are not persisted, plan 2.8): the
    // lobby a restored game reopens starts with no chat
    lobbyOrigin: ['messages'],
    // The advice cache, the budget and the tip queue are module state, not
    // fields of a record
    assistSeat: []
});

class CodecError extends Error {
    constructor(reason, details = {}) {
        super(`gameCodec: ${reason}`);
        this.name = 'CodecError';
        this.reason = reason;
        this.details = details;
    }
}

const json = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const card = (c) => (c ? { suit: c.suit, rank: c.rank } : null);
const slots = (arr, map = (v) => v) => [0, 1, 2, 3].map((i) => (arr && arr[i] != null ? map(arr[i]) : null));

function lookupTournamentId(gameId) {
    return require('../GameManager').tournamentGames.get(gameId) ?? null;
}

function defaultGetBot(game) {
    const { botController } = require('../bot');
    return (socketId) => botController.getBot(game.gameId, socketId);
}

const list = (v) => (v == null ? [] : Array.from(v));
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** game.casualVoice's SAVED settings, or null (not a lobby-born game). */
function encodeCasualVoice(cv) {
    if (!cv) return null;
    return {
        host: cv.host ?? null,
        spectatorsCanTalk: true,
        lobbyExtras: list(cv.lobbyExtras)
    };
}

/** game.lobbyOrigin without its chat, Maps and Sets as arrays, or null. */
function encodeLobbyOrigin(o) {
    if (!o) return null;
    return {
        lobbyId: o.lobbyId ?? null,
        name: o.name ?? null,
        createdBy: o.createdBy ?? null,
        host: o.host ?? null,
        settings: { spectatorsCanTalk: true },
        order: list(o.order),
        bots: Array.from(o.bots || [], ([id, personality]) => [id, personality ?? null]),
        playAgainUsers: list(o.playAgainUsers),
        casualUsers: list(o.casualUsers),
        extras: list(o.extras)
    };
}

/** playAgain.originOf's shape back from a doc (messages: none). */
function decodeLobbyOrigin(d) {
    if (!d || typeof d !== 'object') return null;
    return {
        lobbyId: d.lobbyId ?? null,
        name: d.name ?? null,
        createdBy: d.createdBy ?? null,
        host: d.host ?? null,
        settings: { spectatorsCanTalk: true },
        messages: [],
        order: strings(d.order),
        bots: new Map((Array.isArray(d.bots) ? d.bots : [])
            .filter((e) => Array.isArray(e) && typeof e[0] === 'string')
            .map(([id, personality]) => [id, personality ?? null])),
        playAgainUsers: new Set(strings(d.playAgainUsers)),
        casualUsers: new Set(strings(d.casualUsers)),
        extras: new Set(strings(d.extras))
    };
}

/**
 * Why serialize refuses `game` now (a short reason), or null when it saves.
 * @returns {string|null}
 */
function refusal(game) {
    if (!game) return 'no game';
    if (game.isDemo) return 'demo';
    if (game.isTerminal()) return 'terminal';
    if (game.frozen) return 'frozen';
    if (game.isSuspended) return 'suspended';
    if (!SAVE_STAGES.has(game.stage)) return 'stage';
    if (game._tainted) return 'tainted';
    if (game.seatList().length !== 4) return 'seats';
    if (game.validateGameState().errors.length > 0) return 'invalid';
    return null;
}

/**
 * @param {GameState} game
 * @param {Object} [opts]
 * @param {string|null} [opts.tournamentId] - default: GameManager.tournamentGames
 * @param {Function} [opts.getBot] - socketId -> the registered BotPlayer (default: BotController's)
 * @returns {Object|null} the document, or null when the game is not saved now
 */
function serialize(game, { tournamentId, getBot } = {}) {
    if (refusal(game)) return null;
    const botOf = getBot || defaultGetBot(game);
    const seats = {};
    const hands = {};
    const bots = [];
    for (let pos = 1; pos <= 4; pos++) {
        const s = game.seat(pos);
        seats[pos] = {
            controller: s.controller,
            presence: s.presence,
            ownerUsername: s.ownerUsername ?? null,
            // A custom picture (a data URL) is not saved: the adopter warms
            // the owner's current one
            ownerPic: isStockPic(s.ownerPic) ? s.ownerPic : null,
            bot: s.bot ? {
                socketId: s.bot.socketId,
                username: s.bot.username ?? null,
                pic: json(s.bot.pic ?? null),
                personality: s.bot.personality ?? null
            } : null,
            lastPersonality: s.lastPersonality ?? null,
            resignedAt: s.resignedAt ?? null,
            leftAt: s.leftAt ?? null,
            gone: s.presence === Presence.GONE
        };
        const hand = game.hands[s.seatSocketId];
        hands[pos] = Array.isArray(hand) ? hand.map(card) : null;
        if (s.bot) {
            const b = botOf(s.bot.socketId);
            bots.push({
                socketId: s.bot.socketId,
                username: s.bot.username ?? null,
                personality: s.bot.personality ?? null,
                position: pos,
                pic: json(s.bot.pic ?? null),
                partnerHistory: json(b?.partnerHistory) || []
            });
        }
    }
    const state = {
        createdAt: game.createdAt,
        eventSeq: game.eventSeq,
        dealSeq: game.dealSeq ?? null,
        currentHand: game.currentHand,
        dealer: game.dealer,
        bidder: game.bidder,
        bids: json(game.bids),
        playerBids: slots(game.playerBids),
        team1Mult: game.team1Mult,
        team2Mult: game.team2Mult,
        currentTurn: game.currentTurn,
        leadPosition: game.leadPosition,
        leadCard: card(game.leadCard),
        playedCards: slots(game.playedCards, card),
        playedCardsIndex: game.playedCardsIndex,
        trump: card(game.trump),
        isTrumpBroken: !!game.isTrumpBroken,
        cardIndex: game.cardIndex,
        tricks: json(game.tricks),
        trickHistory: (game.trickHistory || []).map((t) => ({ winner: t.winner, lead: t.lead, cards: t.cards.map(card) })),
        score: json(game.score),
        rainbows: json(game.rainbows),
        handStats: json(game.handStats),
        playerStats: json(game.playerStats),
        seatBags: normalizeSeatBags(game.seatBags),
        seatExact: normalizeSeatCounter(game.seatExact),
        handTricks: json(game.handTricks),
        hsiValues: json(game.hsiValues) || {},
        hands,
        seats,
        // The players index's order: dealHand deals to getSocketIds() in it
        seatOrder: Array.from(game.players.values(), (p) => p.position),
        casualVoice: encodeCasualVoice(game.casualVoice),
        lobbyOrigin: encodeLobbyOrigin(game.lobbyOrigin),
        assist: normalizeAssist(game.assist)
    };
    return {
        v: CODEC_V,
        gameId: game.gameId,
        stage: game.stage,
        tournamentId: tournamentId === undefined ? lookupTournamentId(game.gameId) : tournamentId,
        state,
        log: game.gameLog.map((e) => json(e)),
        logTotal: Number.isInteger(game.logTotal) ? game.logTotal : game.gameLog.length,
        bots
    };
}

/**
 * A GameState from a document serialize wrote. Throws a CodecError (the
 * caller discards the doc) on a version mismatch, a malformed doc, a
 * refused restore or a game failing validateGameState; a failed game's
 * grace timers are cancelled first.
 * @param {Object} doc
 * @param {Object} [opts]
 * @param {number} [opts.now]
 * @param {Function} [opts.onGraceExpire] - (game, pos) => void, a restored human seat's grace ran out
 * @returns {{game: GameState, bots: Object[], tournamentId: (string|null)}}
 */
function hydrate(doc, { now = Date.now(), onGraceExpire = null } = {}) {
    if (!doc || typeof doc !== 'object') throw new CodecError('no doc');
    if (!READ_VERSIONS.includes(doc.v)) throw new CodecError('version', { v: doc.v, expected: READ_VERSIONS });
    if (typeof doc.gameId !== 'string' || !doc.gameId) throw new CodecError('gameId');
    if (!SAVE_STAGES.has(doc.stage)) throw new CodecError('stage', { stage: doc.stage });
    const state = doc.state;
    if (!state || typeof state !== 'object' || !state.seats || !Number.isInteger(state.eventSeq)) throw new CodecError('state');

    const game = new GameState(doc.gameId);
    const fail = (reason, details) => {
        game._cancelAllTimers();
        return new CodecError(reason, { gameId: doc.gameId, ...details });
    };
    let ok;
    try {
        ok = game.restoreFrom(doc.stage, state, {
            log: doc.log,
            logTotal: Number.isInteger(doc.logTotal) ? doc.logTotal : null,
            eventSeq: state.eventSeq + EVENT_SEQ_OFFSET,
            now,
            onGraceExpire: onGraceExpire ? (pos) => onGraceExpire(game, pos) : null
        });
    } catch (err) {
        throw fail('restore', { error: err.message });
    }
    if (!ok) throw fail('restore');
    const { errors } = game.validateGameState();
    if (errors.length > 0) throw fail('invalid', { errors });
    if (state.casualVoice && typeof state.casualVoice === 'object') {
        require('../../voice/gameVoice').initCasualVoice(game, {
            host: state.casualVoice.host ?? null,
            io: null,
            lobbyExtras: strings(state.casualVoice.lobbyExtras)
        });
    }
    const lobbyOrigin = decodeLobbyOrigin(state.lobbyOrigin);
    if (lobbyOrigin) game.lobbyOrigin = lobbyOrigin;
    return {
        game,
        bots: (Array.isArray(doc.bots) ? doc.bots : []).map((b) => json(b)),
        tournamentId: doc.tournamentId ?? null
    };
}

/**
 * The ENDED tombstone's payload for a finished (or aborted) game.
 * @param {GameState} game
 * @param {Object|null} [record] - the gameRecords document. Omitted: built
 *   here (profileHandlers.buildGameEndRecord) for a game that ENDED, and
 *   null for any other stage (an aborted game records no stats: only
 *   gameEnd calls recordGameStats, abortGame never does). The live end
 *   path passes the record it built once, the same object it then hands
 *   recordGameStats(game, {record}), so tombstone and insert are one doc.
 * @param {{tournamentId?: (string|null)}} [opts]
 * @returns {{record: (Object|null), score: Object, seats: Object[], tournamentId: (string|null), aborted: boolean}}
 */
function serializeEnded(game, record, { tournamentId } = {}) {
    let rec = record;
    if (rec === undefined) {
        rec = game.stage === Phase.ENDED ? require('../../socket/profileHandlers').buildGameEndRecord(game) : null;
    }
    return {
        record: rec,
        score: { team1: game.score?.team1 ?? 0, team2: game.score?.team2 ?? 0 },
        seats: [1, 2, 3, 4].map((position) => ({
            username: game.getOriginalPlayer(position)?.username ?? null,
            position,
            gone: game.seat(position)?.presence === Presence.GONE
        })),
        tournamentId: tournamentId === undefined ? lookupTournamentId(game.gameId) : tournamentId,
        aborted: game.stage === Phase.ABORTED
    };
}

/**
 * What serialize(hydrate(doc)) gives back for `doc` (the round-trip
 * oracle): eventSeq EVENT_SEQ_OFFSET later and each seat's presence as
 * restoreSeats maps it (human -> grace, lazy / resign -> away or gone,
 * native bot -> none), and an older version's doc as CODEC_V writes it
 * (v1: the default assist). Everything else is identical.
 */
function expectedAfterRestore(doc) {
    const out = json(doc);
    out.v = CODEC_V;
    out.state.assist = normalizeAssist(out.state.assist);
    out.state.seatBags = normalizeSeatBags(out.state.seatBags);
    out.state.seatExact = normalizeSeatCounter(out.state.seatExact);
    for (const ps of Object.values(out.state.playerStats || {})) if (ps && typeof ps === 'object') delete ps.totalBags;
    out.state.eventSeq += EVENT_SEQ_OFFSET;
    for (const s of Object.values(out.state.seats)) {
        if (s.controller === Controller.HUMAN) s.presence = Presence.GRACE;
        else if (s.controller === Controller.BOT) s.presence = Presence.NONE;
        else s.presence = s.gone ? Presence.GONE : Presence.AWAY;
    }
    // Spectator talk is always on since 2026-11-18: a doc saved with it off
    // comes back on
    if (out.state.casualVoice) out.state.casualVoice.spectatorsCanTalk = true;
    if (out.state.lobbyOrigin) out.state.lobbyOrigin.settings = { spectatorsCanTalk: true };
    return out;
}

module.exports = {
    CODEC_V,
    READ_VERSIONS,
    EVENT_SEQ_OFFSET,
    SAVE_STAGES,
    SAVED,
    DERIVED,
    CodecError,
    refusal,
    serialize,
    hydrate,
    serializeEnded,
    expectedAfterRestore
};

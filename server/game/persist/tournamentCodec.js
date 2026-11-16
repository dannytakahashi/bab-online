/**
 * Tournament codec (deploy survival; the plan's 2.2): a TournamentState to
 * a JSON document and back. Pure apart from one lookup it can be handed
 * instead (its live tables, for tableScores): no I/O, no emits, no timers.
 * Nothing in production calls it yet.
 *
 * serialize(t) -> {v, tournamentId, phase, state} with state:
 *   name, creatorUsername, createdAt, phase ('starting', a round start in
 *   flight, is saved as 'lobby' before round 1 and 'between_rounds' after
 *   one: the start is rolled back), currentRound, totalRounds,
 *   players [{username, pic}] in Map order (transferCreator walks it),
 *   scoreboard (roundScores, roundDetails with their missed / aborted /
 *   left flags), rounds [{roundNumber, games: [[gameId, {humanPlayers,
 *   botCount, status}]], completedGames: [gameId]}], messages (all chat,
 *   players' and spectators' with isSpectator, at most maxMessages),
 *   readyDeadlineAt, handedOffThisWait, completedAt, and tableScores
 *   {gameId: {score, seats: [{username, position, gone}]}}: the running
 *   score of every seated table still in play.
 * It is null (the store keeps the last good doc) when the tournament fails
 * a check: completedGames within games, currentRound matching rounds,
 * finite scores, the creator a member (or no members), a known phase.
 *
 * hydrate(doc) -> {tournament, tableScores}: a TournamentState with the
 * saved fields; every member disconnected, not ready, keyed by a synthetic
 * restored:<tournamentId>:<i> socket id (reattachPlayerByUsername re-keys
 * it, the creator role with it); no spectators, timers or epoch history.
 *
 * Field guard: every key of a TournamentState, member entry, round and
 * round game entry is in SAVED or DERIVED (gameCodec.fieldGuard.test.js).
 */

'use strict';

const TournamentState = require('../TournamentState');
const { Presence } = require('../SeatState');

const TOURNAMENT_CODEC_V = 1;

const PHASES = new Set(['lobby', 'starting', 'round_active', 'between_rounds', 'complete']);

const deepFreeze = (o) => {
    for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
    return Object.freeze(o);
};

const SAVED = deepFreeze({
    tournament: [
        'tournamentId', 'name', 'creatorUsername', 'createdAt', 'phase',
        'currentRound', 'totalRounds', 'players', 'scoreboard', 'rounds', 'messages',
        'readyDeadlineAt', 'handedOffThisWait', 'completedAt'
    ],
    player: ['username', 'pic'],
    round: ['roundNumber', 'games', 'completedGames'],
    roundGame: ['humanPlayers', 'botCount', 'status'],
    message: ['username', 'message', 'isSpectator', 'timestamp']
});

const DERIVED = deepFreeze({
    tournament: [
        'roomName', 'createdBy', 'readyPlayers', 'spectators',  // socket ids; people re-spectate
        'epoch', 'retired', 'timers',                           // a new generation, timers re-armed
        'maxMessages', '_debugMode'
    ],
    player: ['ready', 'connected'],                             // false after a restore
    round: [],
    roundGame: [],
    message: []
});

class TournamentCodecError extends Error {
    constructor(reason, details = {}) {
        super(`tournamentCodec: ${reason}`);
        this.name = 'TournamentCodecError';
        this.reason = reason;
        this.details = details;
    }
}

const json = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Why serialize refuses `t` now, or null.
 * @returns {string|null}
 */
function refusal(t) {
    if (!t) return 'no tournament';
    if (!PHASES.has(t.phase)) return 'phase';
    if (!Array.isArray(t.rounds) || t.rounds.length !== t.currentRound) return 'rounds';
    for (let i = 0; i < t.rounds.length; i++) {
        const r = t.rounds[i];
        if (r.roundNumber !== i + 1) return 'rounds';
        for (const id of r.completedGames) if (!r.games.has(id)) return 'completedGames';
    }
    for (const entry of Object.values(t.scoreboard || {})) {
        if (!finite(entry.totalScore)) return 'scores';
        if (!Array.isArray(entry.roundScores) || entry.roundScores.some((s) => !finite(s))) return 'scores';
    }
    if (t.players.size > 0 && !t.getPlayerByUsername(t.creatorUsername)) return 'creator';
    return null;
}

/** The phase a restore resumes in: a round start in flight rolls back. */
function savedPhase(t) {
    if (t.phase !== 'starting') return t.phase;
    return t.currentRound === 0 ? 'lobby' : 'between_rounds';
}

function defaultGetGame(gameId) {
    return require('../GameManager').getGameById(gameId);
}

/** {gameId: {score, seats}} for every seated table of `t` not complete yet. */
function tableScoresOf(t, getGame) {
    const out = {};
    for (const round of t.rounds) {
        for (const [gameId, data] of round.games) {
            if (data.status === 'complete' || round.completedGames.has(gameId)) continue;
            const game = getGame(gameId);
            if (!game || game.isTerminal?.() || game.seatList().length !== 4) continue;
            out[gameId] = {
                score: { team1: game.score.team1, team2: game.score.team2 },
                seats: [1, 2, 3, 4].map((position) => ({
                    username: game.getOriginalPlayer(position)?.username ?? null,
                    position,
                    gone: game.seat(position)?.presence === Presence.GONE
                }))
            };
        }
    }
    return out;
}

/**
 * @param {TournamentState} t
 * @param {{getGame?: Function}} [opts] - gameId -> live GameState (default: GameManager's)
 * @returns {Object|null}
 */
function serialize(t, { getGame = defaultGetGame } = {}) {
    if (refusal(t)) return null;
    const phase = savedPhase(t);
    const state = {
        name: t.name,
        creatorUsername: t.creatorUsername ?? null,
        createdAt: t.createdAt,
        phase,
        currentRound: t.currentRound,
        totalRounds: t.totalRounds,
        players: Array.from(t.players.values(), (p) => ({ username: p.username, pic: json(p.pic ?? null) })),
        scoreboard: json(t.scoreboard) || {},
        rounds: t.rounds.map((r) => ({
            roundNumber: r.roundNumber,
            games: Array.from(r.games.entries(), ([gameId, g]) => [gameId, {
                humanPlayers: json(g.humanPlayers) || [],
                botCount: g.botCount,
                status: g.status
            }]),
            completedGames: Array.from(r.completedGames)
        })),
        messages: t.messages.slice(-t.maxMessages).map((m) => ({
            username: m.username,
            message: m.message,
            isSpectator: !!m.isSpectator,
            timestamp: m.timestamp
        })),
        readyDeadlineAt: t.readyDeadlineAt ?? null,
        handedOffThisWait: !!t.handedOffThisWait,
        completedAt: t.completedAt ?? null,
        tableScores: tableScoresOf(t, getGame)
    };
    return { v: TOURNAMENT_CODEC_V, tournamentId: t.tournamentId, phase, state };
}

/** The synthetic socket id of a restored member (the i-th in Map order). */
const restoredMemberId = (tournamentId, i) => `restored:${tournamentId}:${i}`;

/**
 * @param {Object} doc
 * @returns {{tournament: TournamentState, tableScores: Object}}
 */
function hydrate(doc) {
    if (!doc || typeof doc !== 'object') throw new TournamentCodecError('no doc');
    if (doc.v !== TOURNAMENT_CODEC_V) throw new TournamentCodecError('version', { v: doc.v, expected: TOURNAMENT_CODEC_V });
    const s = doc.state;
    if (typeof doc.tournamentId !== 'string' || !s || !PHASES.has(s.phase) || s.phase === 'starting') {
        throw new TournamentCodecError('malformed', { tournamentId: doc.tournamentId });
    }
    const t = new TournamentState(doc.tournamentId, s.name, null, s.creatorUsername);
    t.createdAt = s.createdAt;
    t.phase = s.phase;
    t.currentRound = s.currentRound;
    t.totalRounds = s.totalRounds;
    (s.players || []).forEach((p, i) => {
        const id = restoredMemberId(doc.tournamentId, i);
        t.players.set(id, { username: p.username, pic: p.pic ?? null, ready: false, connected: false });
        if (p.username === s.creatorUsername) t.createdBy = id;
    });
    t.scoreboard = json(s.scoreboard) || {};
    t.rounds = (s.rounds || []).map((r) => ({
        roundNumber: r.roundNumber,
        games: new Map((r.games || []).map(([gameId, g]) => [gameId, {
            humanPlayers: json(g.humanPlayers) || [],
            botCount: g.botCount,
            status: g.status
        }])),
        completedGames: new Set(r.completedGames || [])
    }));
    t.messages = (s.messages || []).slice(-t.maxMessages).map((m) => ({ ...m }));
    t.readyDeadlineAt = s.readyDeadlineAt ?? null;
    t.handedOffThisWait = !!s.handedOffThisWait;
    t.completedAt = s.completedAt ?? null;
    const why = refusal(t);
    if (why) throw new TournamentCodecError('invalid', { tournamentId: doc.tournamentId, why });
    return { tournament: t, tableScores: json(s.tableScores) || {} };
}

module.exports = {
    TOURNAMENT_CODEC_V,
    SAVED,
    DERIVED,
    TournamentCodecError,
    refusal,
    savedPhase,
    serialize,
    hydrate,
    restoredMemberId
};

/**
 * Tournament codec (deploy survival; the plan's 2.2): a TournamentState to
 * a JSON document and back. Pure apart from one lookup it can be handed
 * instead (its live tables, for tableScores): no I/O, no emits, no timers.
 * The persist store (liveStore.js, PR 4) writes what serialize returns;
 * nothing in production calls hydrate yet.
 *
 * serialize(t) -> {v, tournamentId, phase, state} with state:
 *   name, creatorUsername, createdAt, phase ('starting', a round start in
 *   flight, is saved as 'lobby' before round 1 and 'between_rounds' after
 *   one: the start is rolled back), currentRound, totalRounds,
 *   players [{username, pic}] in Map order (transferCreator walks it),
 *   scoreboard (roundScores, roundDetails with their missed / aborted /
 *   left flags), rounds [{roundNumber, games: [[gameId, {humanPlayers,
 *   botCount, status, teams}]], completedGames: [gameId]}], messages (all chat,
 *   players' and spectators' with isSpectator, at most maxMessages),
 *   readyDeadlineAt, handedOffThisWait, completedAt, and tableScores
 *   {gameId: {score, seats: [{username, position, gone}]}}: the running
 *   score of every seated table still in play.
 *   v2 (2026-11-25, Cut for a buck): finalWinners / finalMembers (the
 *   winners and members when the last round completed, or null), cut (phase
 *   'cut' only: {stage, candidates, strikes, lastReveal, result, engine:
 *   CutEngine.toSaved() or null in the gather}; the open round's draws are
 *   never saved) and cutResult (the complete phase: the cut's result, or
 *   null). READ_VERSIONS [1, 2]: a v1 doc hydrates with all four null.
 * It is null (the store keeps the last good doc) when the tournament fails
 * a check: completedGames within games, currentRound matching rounds,
 * finite scores, the creator a member (or no members), a known phase.
 *
 * hydrate(doc) -> {tournament, tableScores}: a TournamentState with the
 * saved fields; every member disconnected, not ready, keyed by a synthetic
 * restored:<tournamentId>:<username> socket id (restoredMemberId; the plan's
 * PR 6 shape; reattachPlayerByUsername re-keys it, the creator role with
 * it); no spectators, timers or epoch history. A doc naming a member twice
 * (or a member without a name) is malformed.
 * Until a member reattaches its synthetic id is never on the wire: on an
 * adopted tournament (t.restored, PR 6) getClientState() sends away:<username> for
 * a restored:* `socketId` / `creatorSocketId`. hydrate's one production
 * caller is persist/restoreTournament.adoptTournament (PR 6).
 *
 * Field guard: every key of a TournamentState, member entry, round and
 * round game entry is in SAVED or DERIVED (gameCodec.fieldGuard.test.js).
 */

'use strict';

const TournamentState = require('../TournamentState');
const { Presence } = require('../SeatState');
const { CutEngine } = require('../cutForABuck');

// v2 (2026-11-25): Cut for a buck (cut, cutResult) and the final winners /
// members. hydrate still reads v1 (READ_VERSIONS): the deploy that ships v2
// adopts every v1 doc the old instance handed off
const TOURNAMENT_CODEC_V = 2;
const READ_VERSIONS = Object.freeze([1, 2]);

const PHASES = new Set(['lobby', 'starting', 'round_active', 'between_rounds', 'cut', 'complete']);
const CUT_STAGES = new Set(['gather', 'drawing', 'reveal', 'winner']);

const deepFreeze = (o) => {
    for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
    return Object.freeze(o);
};

const SAVED = deepFreeze({
    tournament: [
        'tournamentId', 'name', 'creatorUsername', 'createdAt', 'phase',
        'currentRound', 'totalRounds', 'players', 'scoreboard', 'rounds', 'messages',
        'readyDeadlineAt', 'handedOffThisWait', 'completedAt',
        // v2: Cut for a buck
        'finalWinners', 'finalMembers', 'cut', 'cutResult'
    ],
    player: ['username', 'pic'],
    round: ['roundNumber', 'games', 'completedGames'],
    // teams (2026-11-24, partner rotation: tournamentPartners.js): optional,
    // null when the entry has none; an older doc without it restores
    // without (that round adds nothing to partnerHistory)
    roundGame: ['humanPlayers', 'botCount', 'status', 'teams'],
    message: ['username', 'message', 'isSpectator', 'timestamp'],
    // v2: t.cut (phase 'cut') and its engine (game/cutForABuck.js)
    cut: ['stage', 'candidates', 'strikes', 'lastReveal', 'result', 'engine'],
    cutEngine: ['participants', 'alive', 'out', 'round', 'open', 'deck', 'openDeck', 'table', 'reshuffles', 'decks']
});

const DERIVED = deepFreeze({
    tournament: [
        'roomName', 'createdBy', 'readyPlayers', 'spectators',  // socket ids; people re-spectate
        'epoch', 'retired', 'timers',                           // a new generation, timers re-armed
        'maxMessages', '_debugMode',
        // Deploy survival PR 6 (LIVE_PERSIST=on): set on the old instance by
        // the handoff (frozen, handedOff) and on an adopted one (restored)
        'frozen', 'handedOff', 'restored',
        // Tournament voice room (server/voice/tournamentVoice.js): socket-keyed,
        // members enter again with their next tournamentJoined
        'voiceRoom'
    ],
    player: ['ready', 'connected'],                             // false after a restore
    round: [],
    roundGame: [],
    message: [],
    // the open timer's end (re-armed: the restore lead-in) and the restore's
    // one "continues" line
    cut: ['endsAt', 'restoreLine'],
    // the open round's draws (redrawn after a restore) and the RNG hooks
    cutEngine: ['pending', 'shuffleFn', 'randomInt']
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
    // The host's pick, 1 to 5 (TournamentState.setTotalRounds, 2026-11-25)
    if (!Number.isInteger(t.totalRounds) || t.totalRounds < TournamentState.MIN_ROUNDS || t.totalRounds > TournamentState.MAX_ROUNDS) return 'totalRounds';
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
    // Cut for a buck (v2)
    if (t.phase === 'cut') {
        const cut = t.cut;
        if (!cut || !CUT_STAGES.has(cut.stage)) return 'cut';
        if (cut.stage !== 'gather' && !cut.engine) return 'cut';
        if (cut.engine && cut.engine.invalid()) return 'cut';
        if (!Array.isArray(t.finalWinners) || !Array.isArray(t.finalMembers)) return 'finalWinners';
    } else if (t.cut) {
        return 'cut';
    }
    return null;
}

/** t.cut as JSON (SAVED.cut; the open round's draws are dropped). */
function encodeCut(cut) {
    if (!cut) return null;
    return {
        stage: cut.stage,
        candidates: json(cut.candidates) || [],
        strikes: json(cut.strikes) || {},
        lastReveal: json(cut.lastReveal),
        result: json(cut.result),
        engine: cut.engine ? cut.engine.toSaved() : null
    };
}

/** encodeCut's JSON back to t.cut (the engine's remaining cards reshuffled). */
function decodeCut(saved) {
    if (!saved) return null;
    return {
        stage: saved.stage,
        candidates: json(saved.candidates) || [],
        strikes: json(saved.strikes) || {},
        lastReveal: json(saved.lastReveal),
        result: json(saved.result),
        engine: saved.engine ? CutEngine.fromSaved(saved.engine) : null,
        endsAt: null,
        restoreLine: false
    };
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
                status: g.status,
                teams: json(g.teams)
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
        finalWinners: json(t.finalWinners),
        finalMembers: json(t.finalMembers),
        cut: encodeCut(t.cut),
        cutResult: json(t.cutResult),
        tableScores: tableScoresOf(t, getGame)
    };
    return { v: TOURNAMENT_CODEC_V, tournamentId: t.tournamentId, phase, state };
}

/** The synthetic socket id of a restored member, until it reattaches by username. */
const restoredMemberId = (tournamentId, username) => `restored:${tournamentId}:${username}`;

/**
 * @param {Object} doc
 * @returns {{tournament: TournamentState, tableScores: Object}}
 */
function hydrate(doc) {
    if (!doc || typeof doc !== 'object') throw new TournamentCodecError('no doc');
    if (!READ_VERSIONS.includes(doc.v)) throw new TournamentCodecError('version', { v: doc.v, expected: READ_VERSIONS });
    const s = doc.state;
    if (typeof doc.tournamentId !== 'string' || !s || !PHASES.has(s.phase) || s.phase === 'starting') {
        throw new TournamentCodecError('malformed', { tournamentId: doc.tournamentId });
    }
    const members = s.players ?? [];
    if (!Array.isArray(members)) throw new TournamentCodecError('malformed', { tournamentId: doc.tournamentId });
    const names = new Set();
    for (const p of members) {
        // Ids are per username: a nameless or repeated member cannot be keyed
        if (!p || typeof p.username !== 'string' || !p.username || names.has(p.username)) {
            throw new TournamentCodecError('malformed', { tournamentId: doc.tournamentId, member: p?.username ?? null });
        }
        names.add(p.username);
    }
    const t = new TournamentState(doc.tournamentId, s.name, null, s.creatorUsername);
    t.createdAt = s.createdAt;
    t.phase = s.phase;
    t.currentRound = s.currentRound;
    // Missing: a doc saved before the host picked the count (always 4 then)
    t.totalRounds = s.totalRounds ?? TournamentState.DEFAULT_ROUNDS;
    members.forEach((p) => {
        const id = restoredMemberId(doc.tournamentId, p.username);
        t.players.set(id, { username: p.username, pic: p.pic ?? null, ready: false, connected: false });
        if (p.username === s.creatorUsername) t.createdBy = id;
    });
    t.scoreboard = json(s.scoreboard) || {};
    t.rounds = (s.rounds || []).map((r) => ({
        roundNumber: r.roundNumber,
        games: new Map((r.games || []).map(([gameId, g]) => [gameId, {
            humanPlayers: json(g.humanPlayers) || [],
            botCount: g.botCount,
            status: g.status,
            ...(Array.isArray(g.teams) ? { teams: json(g.teams) } : {})
        }])),
        completedGames: new Set(r.completedGames || [])
    }));
    t.messages = (s.messages || []).slice(-t.maxMessages).map((m) => ({ ...m }));
    t.readyDeadlineAt = s.readyDeadlineAt ?? null;
    t.handedOffThisWait = !!s.handedOffThisWait;
    t.completedAt = s.completedAt ?? null;
    // v2 (a v1 doc has none of them: null)
    t.finalWinners = Array.isArray(s.finalWinners) ? [...s.finalWinners] : null;
    t.finalMembers = Array.isArray(s.finalMembers) ? [...s.finalMembers] : null;
    try {
        t.cut = decodeCut(s.cut ?? null);
    } catch (err) {
        throw new TournamentCodecError('malformed', { tournamentId: doc.tournamentId, cut: err.message });
    }
    t.cutResult = json(s.cutResult);
    const why = refusal(t);
    if (why) throw new TournamentCodecError('invalid', { tournamentId: doc.tournamentId, why });
    return { tournament: t, tableScores: json(s.tableScores) || {} };
}

module.exports = {
    TOURNAMENT_CODEC_V,
    READ_VERSIONS,
    SAVED,
    DERIVED,
    TournamentCodecError,
    refusal,
    savedPhase,
    serialize,
    hydrate,
    encodeCut,
    decodeCut,
    restoredMemberId
};

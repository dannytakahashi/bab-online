/**
 * The tournament history (owner 2026-11-25): one `tournamentRecords`
 * document per completed tournament, and what a profile shows of them.
 * Pure: no io, timers or Mongo. profileHandlers.recordTournament writes
 * the document (once, by `_id`), profileHandlers.tournamentProfile reads
 * them back for a profile, utils/superlatives.js reads `cut` for Lucky Buck.
 *
 * The document (v 1), written once when the tournament completes
 * (tournamentHandlers.finishTournament, or the adoption of a 'complete'
 * doc after a restore):
 *   _id             the tournamentId
 *   v               1
 *   name            the tournament's name
 *   creatorUsername the host at the end (hand-offs move it)
 *   createdAt       Date
 *   completedAt     Date
 *   totalRounds     the rounds the host chose (1 to 5)
 *   roundsPlayed    the rounds completed (= totalRounds: a tournament
 *                   cancelled before its last round has no record)
 *   players         the members when the last round completed
 *                   (t.finalMembers): who finished it
 *   scoreboard      [{username, totalScore, roundScores}] as the final
 *                   standings showed it (members who left earlier too)
 *   winners         the score winner(s) (t.finalWinners: ties all win)
 *   cut             null (no cut ran: an all-legacy tournament, too few
 *                   players, the host ended it, everyone left) or
 *                   {winner, participants, rounds}
 *
 * Every username goes through `rename` first (the caller's: a player who
 * deleted the account during the tournament becomes '[deleted]', a renamed
 * or merged one its account's name now), exactly as the admin rename /
 * merge / delete rewrite stored records (server/admin/tournamentRecordNames.js).
 */

'use strict';

const RECORD_V = 1;
/** Recent results a profile carries (newest first). */
const RECENT_RESULTS = 5;

const isName = (v) => typeof v === 'string' && v.length > 0;
const finite = (v) => (Number.isFinite(v) ? v : 0);
const asDate = (ms) => new Date(Number.isFinite(ms) ? ms : Date.now());

/**
 * The record of a completed tournament, or null when there is nothing to
 * record (not complete, nobody finished it).
 * @param {import('./TournamentState')} t
 * @param {{winner: string, participants: string[], rounds: number}|null} cut
 * @param {{rename?: (name: string) => string, now?: number}} [opts]
 */
function buildTournamentRecord(t, cut, { rename = (n) => n, now = Date.now() } = {}) {
    if (!t || t.phase !== 'complete') return null;
    const name = (n) => rename(n);
    const members = Array.isArray(t.finalMembers)
        ? t.finalMembers
        : Array.from(t.players?.values?.() || [], (p) => p.username);
    const players = members.filter(isName).map(name);
    if (players.length === 0) return null;
    const winners = (typeof t.winnersFinal === 'function' ? t.winnersFinal() : []).filter(isName).map(name);
    const scoreboard = (typeof t.getScoreboard === 'function' ? t.getScoreboard() : [])
        .filter((e) => e && isName(e.username))
        .map((e) => ({
            username: name(e.username),
            totalScore: finite(e.totalScore),
            roundScores: Array.isArray(e.roundScores) ? e.roundScores.map(finite) : []
        }));
    const validCut = cut && isName(cut.winner) && Array.isArray(cut.participants);
    return {
        _id: t.tournamentId,
        v: RECORD_V,
        name: typeof t.name === 'string' ? t.name : '',
        creatorUsername: isName(t.creatorUsername) ? name(t.creatorUsername) : null,
        createdAt: asDate(t.createdAt),
        completedAt: asDate(Number.isFinite(t.completedAt) ? t.completedAt : now),
        totalRounds: Number.isInteger(t.totalRounds) ? t.totalRounds : 0,
        roundsPlayed: Number.isInteger(t.currentRound) ? t.currentRound : 0,
        players,
        scoreboard,
        winners,
        cut: validCut
            ? {
                winner: name(cut.winner),
                participants: cut.participants.filter(isName).map(name),
                rounds: Number.isInteger(cut.rounds) && cut.rounds >= 1 ? cut.rounds : 1
            }
            : null
    };
}

/** Every username a record holds (for the rename lookup before the insert). */
function recordNames(t, cut) {
    const out = new Set();
    const add = (n) => { if (isName(n)) out.add(n); };
    (Array.isArray(t?.finalMembers) ? t.finalMembers : Array.from(t?.players?.values?.() || [], (p) => p.username)).forEach(add);
    if (typeof t?.getScoreboard === 'function') t.getScoreboard().forEach((e) => add(e?.username));
    if (typeof t?.winnersFinal === 'function') t.winnersFinal().forEach(add);
    add(t?.creatorUsername);
    if (cut) {
        add(cut.winner);
        (cut.participants || []).forEach(add);
    }
    return [...out];
}

/**
 * Where `username` placed: competition ranking by total score among the
 * players who finished (1, 1, 3), or null when the record does not list
 * them in its standings.
 */
function placeOf(record, username) {
    const finished = new Set(Array.isArray(record?.players) ? record.players : []);
    const rows = (Array.isArray(record?.scoreboard) ? record.scoreboard : [])
        .filter((r) => r && isName(r.username) && finished.has(r.username));
    const mine = rows.filter((r) => r.username === username).map((r) => finite(r.totalScore));
    if (mine.length === 0) return null;
    const best = Math.max(...mine);
    return 1 + rows.filter((r) => r.username !== username && finite(r.totalScore) > best).length;
}

const iso = (d) => {
    const t = d instanceof Date ? d : new Date(d);
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/**
 * One recent result as the profile carries it ($defs.tournamentResult):
 * {id, name, completedAt (ISO), totalRounds, players (how many finished),
 * place (or null), won, winners, cutWinner (null when no cut ran)}.
 */
function recentResult(record, username) {
    const players = Array.isArray(record?.players) ? record.players : [];
    const winners = (Array.isArray(record?.winners) ? record.winners : []).filter(isName);
    const cutWinner = record?.cut && isName(record.cut.winner) ? record.cut.winner : null;
    return {
        id: String(record?._id ?? ''),
        name: typeof record?.name === 'string' ? record.name : '',
        completedAt: iso(record?.completedAt),
        totalRounds: Number.isInteger(record?.totalRounds) ? record.totalRounds : 0,
        players: new Set(players.filter(isName)).size,
        place: placeOf(record, username),
        won: winners.includes(username),
        winners: [...new Set(winners)],
        cutWinner
    };
}

module.exports = { RECORD_V, RECENT_RESULTS, buildTournamentRecord, recordNames, placeOf, recentResult };

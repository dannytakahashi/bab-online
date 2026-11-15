/**
 * Round scores of one tournament table, recorded once when the table
 * resolves (the caller checked it is still mapped to the tournament).
 *
 * A finished table: every current member at it scores their team's final
 * score (unchanged).
 *
 * An aborted table (owner 2026-11-15): the team's running score at the
 * abort, except that a member who LEFT (seat `gone`: /leave, or a draw-phase
 * leaver seated as a resign bot; or no longer a member: left the tournament)
 * scores min(running, 0), so walking out of a losing game never beats
 * playing it out and walking out of a winning one earns nothing. A table
 * with no leaver (the stall watchdog, everyone disconnected) scores
 * everyone's running score. Members who are not at any table that round
 * are scored by TournamentState.scoreMissedRound at round completion.
 */

'use strict';

const { Presence } = require('./SeatState');

/**
 * @param {TournamentState} tournament
 * @param {GameState} game - ended or aborted (its seats / entrants intact)
 * @param {{aborted?: boolean}} [opts]
 * @returns {string[]} the usernames scored
 */
function recordTableScores(tournament, game, { aborted = false } = {}) {
    // Scores go to the round this game was created in
    const roundNumber = tournament.roundOfGame(game.gameId)?.roundNumber ?? tournament.currentRound;
    const scored = [];
    const isMember = (u) => !!tournament.getPlayerByUsername(u);
    // An aborted table also scores a former member (their row stays on the
    // scoreboard; getWinners never picks them). Filler bots have no row.
    const counts = (u) => (aborted ? !!tournament.scoreboard[u] : isMember(u));
    const score = game.score || { team1: 0, team2: 0 };

    if (game.seatList().length === 4) {
        for (let pos = 1; pos <= 4; pos++) {
            const player = game.getOriginalPlayer(pos);
            if (!player || !player.username || !counts(player.username)) continue;

            const isTeam1 = (pos === 1 || pos === 3);
            const running = isTeam1 ? score.team1 : score.team2;
            const oppScore = isTeam1 ? score.team2 : score.team1;
            const partnerPos = pos <= 2 ? pos + 2 : pos - 2;
            const partner = game.getOriginalPlayer(partnerPos);
            const left = aborted && (game.seat(pos)?.presence === Presence.GONE || !isMember(player.username));

            tournament.recordPlayerRoundScore(player.username, {
                roundNumber,
                gameId: game.gameId,
                position: pos,
                teamScore: left ? Math.min(running, 0) : running,
                oppScore,
                partner: partner?.username || 'Bot',
                ...(aborted ? { aborted: true } : {}),
                ...(left ? { left: true } : {})
            });
            scored.push(player.username);
        }
        return scored;
    }

    // Aborted before seating: the humans are still entrants, nobody has a
    // score yet (0), a leaver too (min(0, 0))
    if (!aborted || !game.entrants) return scored;
    for (const e of game.entrants.values()) {
        if (e.isBot || !e.username || !counts(e.username)) continue;
        const left = e.presence === 'left' || !isMember(e.username);
        tournament.recordPlayerRoundScore(e.username, {
            roundNumber,
            gameId: game.gameId,
            position: null,
            teamScore: 0,
            oppScore: 0,
            partner: null,
            aborted: true,
            ...(left ? { left: true } : {})
        });
        scored.push(e.username);
    }
    return scored;
}

module.exports = { recordTableScores };

/**
 * The tournament scoreboard and results modal follow the host's round count
 * (1 to 5, 2026-11-25): never a fixed 4 columns.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createTournamentScoreboard, showTournamentResultsOverlay, removeTournamentResultsOverlay, roundsOfScoreboard } from './TournamentScoreboard.js';

const headers = (root) => [...root.querySelectorAll('th')].map((th) => th.textContent);
const board = (rounds) => [
  { username: 'ann', totalScore: 300, roundScores: rounds.map(() => 150).slice(0, rounds.length) },
  { username: 'bo', totalScore: 100, roundScores: rounds.map(() => 50) },
];

afterEach(() => {
  removeTournamentResultsOverlay();
  document.body.replaceChildren();
});

describe('tournament scoreboard columns', () => {
  it('one column per round, 1 to 5', () => {
    for (let n = 1; n <= 5; n++) {
      const expected = ['#', 'Player', ...Array.from({ length: n }, (_, i) => `R${i + 1}`), 'Total'];
      expect(headers(createTournamentScoreboard(board([]), 0, n))).toEqual(expected);
    }
  });

  it('roundsOfScoreboard: the longest roundScores, else 4', () => {
    expect(roundsOfScoreboard(board([1, 2]))).toBe(2);
    expect(roundsOfScoreboard([{ username: 'a', roundScores: [1] }, { username: 'b', roundScores: [1, 2, 3, 4, 5] }])).toBe(5);
    expect(roundsOfScoreboard([])).toBe(4);
    expect(roundsOfScoreboard(undefined)).toBe(4);
    expect(roundsOfScoreboard([{ username: 'a' }])).toBe(4);
  });

  it('the results modal: the tournament\'s rounds, given or read from the scoreboard', () => {
    showTournamentResultsOverlay({ scoreboard: board([1, 2]), winners: ['ann'] });
    expect(headers(document.getElementById('tournamentResultsOverlay'))).toEqual(['#', 'Player', 'R1', 'R2', 'Total']);
    removeTournamentResultsOverlay();
    showTournamentResultsOverlay({ scoreboard: board([1]), winners: ['ann'], totalRounds: 3 });
    expect(headers(document.getElementById('tournamentResultsOverlay'))).toEqual(['#', 'Player', 'R1', 'R2', 'R3', 'Total']);
  });
});

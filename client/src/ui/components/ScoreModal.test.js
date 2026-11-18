import { describe, it, expect, afterEach } from 'vitest';
import { showFinalScoreOverlay, removeFinalScoreOverlay, getTeamNames, scoreHeaderNames, formatGameEndMessages, formatHandCompleteMessages } from './ScoreModal.js';

const PLACEHOLDER = /Your Team|Opponents|Team 1|Team 2/;

describe('showFinalScoreOverlay', () => {
  afterEach(() => {
    removeFinalScoreOverlay();
  });

  it('renders player usernames as text, not markup', () => {
    const stats = (username) => ({ username, totalBids: 3, totalTricks: 4, setsCaused: 0, avgHSI: 1.5 });
    showFinalScoreOverlay({
      teamScore: 200,
      oppScore: 100,
      playerStats: { 1: stats('<b>x</b>'), 2: stats('Bob'), 3: stats('Carol'), 4: stats('Dan') },
      onReturnToLobby: () => {},
    });

    const overlay = document.getElementById('finalScoreOverlay');
    expect(overlay).toBeTruthy();
    expect(overlay.querySelector('b')).toBeNull();
    expect(overlay.textContent).toContain('<b>x</b>');
    expect(overlay.textContent).toContain('Bob');
    expect(overlay.textContent).toContain('VICTORY');
  });
});

// getTeamNames: the game-end lines', the hand's lines' and the score
// modal's names: player names only, never a placeholder or a team number
// (owner 2026-11-17). Before the seats exist (the draw for deal: no
// playerData) both are '' and the lines leave the names out.
describe('getTeamNames', () => {
  const seated = {
    position: [1, 2, 3, 4],
    username: [{ username: 'dadv' }, { username: 'momv' }, { username: 'gramv' }, { username: 'popv' }],
  };

  it('before the seats exist (the draw): empty, for a spectator and a seat alike', () => {
    for (const spectator of [true, false]) {
      expect(getTeamNames(1, null, { spectator })).toEqual({ teamName: '', oppName: '' });
      expect(getTeamNames(2, { position: undefined, username: undefined }, { spectator })).toEqual({ teamName: '', oppName: '' });
    }
  });

  it('a spectator once the teams are seated: the teams by name, seats 1/3 then 2/4', () => {
    expect(getTeamNames(1, seated, { spectator: true })).toEqual({ teamName: 'dadv/gramv', oppName: 'momv/popv' });
    expect(getTeamNames(null, seated, { spectator: true })).toEqual({ teamName: 'dadv/gramv', oppName: 'momv/popv' });
  });

  it('a player once seated: me/partner, then the opponents', () => {
    expect(getTeamNames(2, seated)).toEqual({ teamName: 'momv/popv', oppName: 'gramv/dadv' });
  });

  it('never a placeholder, whatever it is given', () => {
    for (const pd of [null, undefined, {}, seated, { position: [1], username: [{ username: 'ann' }] }]) {
      for (const pos of [null, 1, 2, 3, 4]) {
        for (const spectator of [false, true]) {
          const { teamName, oppName } = getTeamNames(pos, pd, { spectator });
          expect(`${teamName} ${oppName}`).not.toMatch(PLACEHOLDER);
        }
      }
    }
  });
});

describe('the game-over and hand lines', () => {
  const seated = {
    position: [1, 2, 3, 4],
    username: [{ username: 'ann' }, { username: 'bob' }, { username: 'cat' }, { username: 'dan' }],
  };

  it('a spectator\'s game-over lines name the teams, seats 1/3 then 2/4', () => {
    const lines = formatGameEndMessages({ myPosition: 1, playerData: seated, teamScore: 120, oppScore: 80, isSpectator: true });
    expect(lines).toEqual(['=== GAME OVER ===', 'ann/cat: 120', 'bob/dan: 80', 'ann/cat wins!']);
  });

  it('a seat\'s game-over lines: me/partner first', () => {
    const lines = formatGameEndMessages({ myPosition: 2, playerData: seated, teamScore: 80, oppScore: 120 });
    expect(lines).toEqual(['=== GAME OVER ===', 'bob/dan: 80', 'cat/ann: 120', 'DEFEAT']);
  });

  it('without the seats: only the score (no "Team 1" / "Your Team")', () => {
    expect(formatGameEndMessages({ myPosition: 1, playerData: null, teamScore: 120, oppScore: 80, isSpectator: true }))
      .toEqual(['=== GAME OVER ===', 'Final Score: 120 - 80']);
    expect(formatGameEndMessages({ myPosition: 1, playerData: null, teamScore: 80, oppScore: 80, isSpectator: true }))
      .toEqual(['=== GAME OVER ===', 'Final Score: 80 - 80', 'TIE GAME']);
    expect(formatGameEndMessages({ myPosition: 3, playerData: null, teamScore: 120, oppScore: 80 }))
      .toEqual(['=== GAME OVER ===', 'Final Score: 120 - 80', 'VICTORY']);
  });

  it('the hand\'s lines: me/partner first; without the seats, no names', () => {
    const opts = { myPosition: 1, bids: { 1: 2, 2: 1, 3: 3, 4: 0 }, teamScore: 50, oppScore: -10, teamOldScore: 0, oppOldScore: 0, teamTricks: 5, oppTricks: 0 };
    expect(formatHandCompleteMessages({ ...opts, playerData: seated })).toEqual([
      '--- HAND COMPLETE ---',
      'ann/cat: Bid 2/3, Won 5, +50 → 50',
      'bob/dan: Bid 1/0, Won 0, -10 → -10',
    ]);
    const bare = formatHandCompleteMessages({ ...opts, playerData: null });
    expect(bare).toEqual(['--- HAND COMPLETE ---', 'Bid 2/3, Won 5, +50 → 50', 'Bid 1/0, Won 0, -10 → -10']);
    expect(bare.join(' ')).not.toMatch(PLACEHOLDER);
  });
});

describe('the score modal\'s names', () => {
  afterEach(() => removeFinalScoreOverlay());
  const score = () => document.querySelector('#finalScoreOverlay .result-score').textContent;

  it('a seat sees the teams by name, me/partner first', () => {
    showFinalScoreOverlay({ teamScore: 300, oppScore: 120, teamName: 'bob/dan', oppName: 'cat/ann', onReturnToLobby: () => {} });
    expect(score()).toBe('bob/dan: 300  —  cat/ann: 120');
    expect(document.getElementById('finalScoreOverlay').textContent).not.toMatch(PLACEHOLDER);
  });

  it('a spectator sees seats 1/3 first', () => {
    showFinalScoreOverlay({ teamScore: 300, oppScore: 120, isSpectator: true, teamName: 'ann/cat', oppName: 'bob/dan', onReturnToLobby: () => {} });
    expect(score()).toBe('ann/cat: 300  —  bob/dan: 120');
  });

  it('without names: only the score', () => {
    showFinalScoreOverlay({ teamScore: 300, oppScore: 120, isSpectator: true, teamName: '', oppName: '', onReturnToLobby: () => {} });
    expect(score()).toBe('Final Score: 300 - 120');
    expect(document.getElementById('finalScoreOverlay').textContent).not.toMatch(PLACEHOLDER);
  });
});

// The game log's score header (GameLog, GameScene.renderScoreHeader, the
// hand and game end): player names only, '' until known, never a
// placeholder (owner 2026-11-17)
describe('scoreHeaderNames', () => {
  const seated = {
    position: [1, 2, 3, 4],
    username: [{ username: 'ann' }, { username: 'bob' }, { username: 'cat' }, { username: 'dan' }],
  };
  const NONE = { teamName: '', oppName: '' };

  it('a seat: me/partner, then opp1 (next clockwise)/opp2', () => {
    expect(scoreHeaderNames(1, seated)).toEqual({ teamName: 'ann/cat', oppName: 'bob/dan' });
    expect(scoreHeaderNames(2, seated)).toEqual({ teamName: 'bob/dan', oppName: 'cat/ann' });
    expect(scoreHeaderNames(3, seated)).toEqual({ teamName: 'cat/ann', oppName: 'dan/bob' });
    expect(scoreHeaderNames(4, seated)).toEqual({ teamName: 'dan/bob', oppName: 'ann/cat' });
  });

  it('a spectator: seats 1/3 then 2/4, as getTeamNames', () => {
    expect(scoreHeaderNames(null, seated, { spectator: true })).toEqual({ teamName: 'ann/cat', oppName: 'bob/dan' });
    expect(scoreHeaderNames(null, seated, { spectator: true })).toEqual(getTeamNames(1, seated, { spectator: true }));
  });

  it('names not known yet (the draw, no seats): empty, never a placeholder', () => {
    for (const spectator of [false, true]) {
      expect(scoreHeaderNames(2, null, { spectator })).toEqual(NONE);
      expect(scoreHeaderNames(2, { position: undefined, username: undefined }, { spectator })).toEqual(NONE);
      expect(scoreHeaderNames(2, {}, { spectator })).toEqual(NONE);
    }
  });

  it('a seat whose own position is not known yet has no side: empty', () => {
    expect(scoreHeaderNames(null, seated)).toEqual(NONE);
    expect(scoreHeaderNames(undefined, seated)).toEqual(NONE);
    expect(scoreHeaderNames(0, seated)).toEqual(NONE);
  });

  it('a side with a name missing is empty (no "P3"); the other side keeps its names', () => {
    const partial = { position: [1, 2, 4], username: [{ username: 'ann' }, { username: 'bob' }, { username: 'dan' }] };
    expect(scoreHeaderNames(1, partial)).toEqual({ teamName: '', oppName: 'bob/dan' });
    const blank = { position: [1, 2, 3, 4], username: [{ username: 'ann' }, { username: '' }, { username: 'cat' }, { username: 'dan' }] };
    expect(scoreHeaderNames(1, blank)).toEqual({ teamName: 'ann/cat', oppName: '' });
  });

  it('plain string usernames and a string position work too', () => {
    const plain = { position: [1, 2, 3, 4], username: ['ann', 'bob', 'cat', 'dan'] };
    expect(scoreHeaderNames('3', plain)).toEqual({ teamName: 'cat/ann', oppName: 'dan/bob' });
  });

  it('never returns a placeholder, whatever it is given', () => {
    for (const pd of [null, undefined, {}, seated, { position: [1], username: [{ username: 'ann' }] }]) {
      for (const pos of [null, 1, 2, 3, 4]) {
        for (const spectator of [false, true]) {
          const { teamName, oppName } = scoreHeaderNames(pos, pd, { spectator });
          expect(`${teamName} ${oppName}`).not.toMatch(PLACEHOLDER);
        }
      }
    }
  });
});

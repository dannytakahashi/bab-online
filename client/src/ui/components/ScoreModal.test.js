import { describe, it, expect, afterEach } from 'vitest';
import { showFinalScoreOverlay, removeFinalScoreOverlay, getTeamNames, placeholderTeamNames, scoreHeaderNames, formatGameEndMessages } from './ScoreModal.js';

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

// getTeamNames: the game-end lines' and the score modal's names. Before the
// seats exist (the draw for deal: no playerData) a spectator has no team:
// never "Your Team" / "Opponents" (owner nit 2026-11-16). The game log's
// score header uses scoreHeaderNames (below), which has no placeholder.
describe('getTeamNames', () => {
  const seated = {
    position: [1, 2, 3, 4],
    username: [{ username: 'dadv' }, { username: 'momv' }, { username: 'gramv' }, { username: 'popv' }],
  };

  it('a spectator during the draw (no seats yet): "Team 1" / "Team 2"', () => {
    expect(getTeamNames(1, null, { spectator: true })).toEqual({ teamName: 'Team 1', oppName: 'Team 2' });
    expect(getTeamNames(1, { position: undefined, username: undefined }, { spectator: true })).toEqual({ teamName: 'Team 1', oppName: 'Team 2' });
  });

  it('a spectator once the teams are seated: the teams by name, seats 1/3 then 2/4', () => {
    expect(getTeamNames(1, seated, { spectator: true })).toEqual({ teamName: 'dadv/gramv', oppName: 'momv/popv' });
  });

  it('a player during the draw: "Your Team" / "Opponents", as before', () => {
    expect(getTeamNames(2, null)).toEqual({ teamName: 'Your Team', oppName: 'Opponents' });
    expect(getTeamNames(2, null, { spectator: false })).toEqual({ teamName: 'Your Team', oppName: 'Opponents' });
  });

  it('a player once seated: mine/partner, then the opponents', () => {
    expect(getTeamNames(2, seated)).toEqual({ teamName: 'momv/popv', oppName: 'gramv/dadv' });
  });

  it('placeholderTeamNames: by viewer', () => {
    expect(placeholderTeamNames(true)).toEqual({ teamName: 'Team 1', oppName: 'Team 2' });
    expect(placeholderTeamNames(false)).toEqual({ teamName: 'Your Team', oppName: 'Opponents' });
    expect(placeholderTeamNames()).toEqual({ teamName: 'Your Team', oppName: 'Opponents' });
  });

  it('a spectator\'s game-over lines name the teams neutrally without seats too', () => {
    const lines = formatGameEndMessages({ myPosition: 1, playerData: null, teamScore: 120, oppScore: 80, isSpectator: true });
    expect(lines).toEqual(['=== GAME OVER ===', 'Team 1: 120', 'Team 2: 80', 'Team 1 wins!']);
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
    const PLACEHOLDER = /Your Team|Opponents|Team 1|Team 2/;
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

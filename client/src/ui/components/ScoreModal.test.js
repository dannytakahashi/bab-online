import { describe, it, expect, afterEach } from 'vitest';
import { showFinalScoreOverlay, removeFinalScoreOverlay, getTeamNames, placeholderTeamNames, formatGameEndMessages } from './ScoreModal.js';

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

// The game log's score header names (GameScene.renderScoreHeader). Before
// the seats exist (the draw for deal: no playerData) a spectator has no team:
// never "Your Team" / "Opponents" (owner nit 2026-11-16)
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

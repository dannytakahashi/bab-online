import { describe, it, expect, afterEach } from 'vitest';
import { showFinalScoreOverlay, removeFinalScoreOverlay } from './ScoreModal.js';

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

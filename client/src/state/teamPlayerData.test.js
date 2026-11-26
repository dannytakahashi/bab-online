/**
 * GameState.teamPlayerData (owner rule 2026-11-25: teams by player names):
 * the names the score header, the hand and game-over lines and the score
 * screen build the teams from. A lazy or resigned seat is named by its
 * owner, never the bot playing it; a native bot seat keeps its persona;
 * the avatars (playerData) keep showing who plays.
 */
import { describe, it, expect } from 'vitest';
import { GameState } from './GameState.js';
import { getTeamNames, scoreHeaderNames } from '../ui/components/ScoreModal.js';

function seated() {
  const s = new GameState();
  s.username = 'ann';
  s.position = 1;
  s.seatOwners = { 1: 'ann', 2: 'bo', 3: 'cy', 4: '🤖 Mary' };
  s.setPlayerData({ position: [1, 2, 3, 4], sockets: ['s1', 's2', 's3', 'bot:4'], username: ['ann', 'bo', 'cy', '🤖 Mary'].map((username) => ({ username })), pics: [1, 2, 3, 4] });
  return s;
}

describe('teamPlayerData', () => {
  it('nobody lazy: playerData itself', () => {
    const s = seated();
    expect(s.teamPlayerData).toBe(s.playerData);
    expect(getTeamNames(1, s.teamPlayerData)).toEqual({ teamName: 'ann/cy', oppName: 'bo/🤖 Mary' });
  });

  it('a lazy seat and a resigned seat: the owners in the team names, the bots on the seats', () => {
    const s = seated();
    s.applySeatDisplay(1, { username: '🤖 Zach', pic: 7 });
    s.applySeatDisplay(2, { username: '🤖 Gina', pic: 8 });
    expect(s.playerData.username.map((u) => u.username)).toEqual(['🤖 Zach', '🤖 Gina', 'cy', '🤖 Mary']);
    expect(s.teamPlayerData.username.map((u) => u.username)).toEqual(['ann', 'bo', 'cy', '🤖 Mary']);
    expect(getTeamNames(1, s.teamPlayerData)).toEqual({ teamName: 'ann/cy', oppName: 'bo/🤖 Mary' });
    expect(scoreHeaderNames(1, s.teamPlayerData)).toEqual({ teamName: 'ann/cy', oppName: 'bo/🤖 Mary' });
    // a spectator's view: seats 1/3 and 2/4
    expect(getTeamNames(null, s.teamPlayerData, { spectator: true })).toEqual({ teamName: 'ann/cy', oppName: 'bo/🤖 Mary' });
    // /active: the seat shows its owner again, nothing to replace
    s.applySeatDisplay(1, { username: 'ann', pic: 1 });
    expect(s.teamPlayerData.username[0].username).toBe('ann');
  });

  it('a snapshot of a lazy seat (a reload while the bot plays): its ownerUsername names the team', () => {
    const s = new GameState();
    s.username = 'ann';
    s.position = 1;
    s._seatsToPlayerData([
      { position: 1, username: 'ann', ownerUsername: 'ann', pic: 1 },
      { position: 2, username: '🤖 Gina', ownerUsername: 'bo', pic: 8 },
      { position: 3, username: 'cy', ownerUsername: 'cy', pic: 3 },
      { position: 4, username: '🤖 Mary', ownerUsername: null, pic: 4 },
    ]);
    expect(s.playerData.username.map((u) => u.username)).toEqual(['ann', '🤖 Gina', 'cy', '🤖 Mary']);
    expect(getTeamNames(1, s.teamPlayerData)).toEqual({ teamName: 'ann/cy', oppName: 'bo/🤖 Mary' });
  });

  it('no seats yet: null', () => {
    expect(new GameState().teamPlayerData).toBeNull();
  });
});

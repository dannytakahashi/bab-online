import { describe, it, expect } from 'vitest';
import {
  team,
  rotate,
  isSameTeam,
  getTeamNumber,
  getPlayerName,
  getRelativePosition,
} from './positions.js';

describe('team', () => {
  it('returns partner position 3 for position 1', () => {
    expect(team(1)).toBe(3);
  });

  it('returns partner position 4 for position 2', () => {
    expect(team(2)).toBe(4);
  });

  it('returns partner position 1 for position 3', () => {
    expect(team(3)).toBe(1);
  });

  it('returns partner position 2 for position 4', () => {
    expect(team(4)).toBe(2);
  });

  it('returns null for invalid position', () => {
    expect(team(5)).toBeNull();
    expect(team(0)).toBeNull();
  });
});

describe('rotate', () => {
  it('rotates 1 to 2', () => {
    expect(rotate(1)).toBe(2);
  });

  it('rotates 2 to 3', () => {
    expect(rotate(2)).toBe(3);
  });

  it('rotates 3 to 4', () => {
    expect(rotate(3)).toBe(4);
  });

  it('rotates 4 to 1 (wrap around)', () => {
    expect(rotate(4)).toBe(1);
  });
});

describe('isSameTeam', () => {
  it('positions 1 and 3 are same team', () => {
    expect(isSameTeam(1, 3)).toBe(true);
    expect(isSameTeam(3, 1)).toBe(true);
  });

  it('positions 2 and 4 are same team', () => {
    expect(isSameTeam(2, 4)).toBe(true);
    expect(isSameTeam(4, 2)).toBe(true);
  });

  it('positions 1 and 2 are not same team', () => {
    expect(isSameTeam(1, 2)).toBe(false);
  });

  it('positions 1 and 4 are not same team', () => {
    expect(isSameTeam(1, 4)).toBe(false);
  });
});

describe('getTeamNumber', () => {
  it('positions 1 and 3 are team 1', () => {
    expect(getTeamNumber(1)).toBe(1);
    expect(getTeamNumber(3)).toBe(1);
  });

  it('positions 2 and 4 are team 2', () => {
    expect(getTeamNumber(2)).toBe(2);
    expect(getTeamNumber(4)).toBe(2);
  });
});

describe('getPlayerName', () => {
  const validPlayerData = {
    username: [
      { username: 'Alice' },
      { username: 'Bob' },
      { username: 'Charlie' },
      { username: 'Diana' },
    ],
    position: [1, 2, 3, 4],
  };

  it('returns correct username for valid position', () => {
    expect(getPlayerName(1, validPlayerData)).toBe('Alice');
    expect(getPlayerName(2, validPlayerData)).toBe('Bob');
    expect(getPlayerName(3, validPlayerData)).toBe('Charlie');
    expect(getPlayerName(4, validPlayerData)).toBe('Diana');
  });

  it('returns fallback for null playerData', () => {
    expect(getPlayerName(1, null)).toBe('Player 1');
  });

  it('returns fallback for undefined playerData', () => {
    expect(getPlayerName(2, undefined)).toBe('Player 2');
  });

  it('returns fallback for missing username array', () => {
    expect(getPlayerName(1, { position: [1] })).toBe('Player 1');
  });

  it('returns fallback for position not found', () => {
    expect(getPlayerName(5, validPlayerData)).toBe('Player 5');
  });
});

describe('getRelativePosition', () => {
  it('same position returns bottom', () => {
    expect(getRelativePosition(1, 1)).toBe('bottom');
    expect(getRelativePosition(3, 3)).toBe('bottom');
  });

  it('next position clockwise returns left', () => {
    expect(getRelativePosition(2, 1)).toBe('left');
    expect(getRelativePosition(3, 2)).toBe('left');
  });

  it('partner returns top', () => {
    expect(getRelativePosition(3, 1)).toBe('top');
    expect(getRelativePosition(1, 3)).toBe('top');
  });

  it('previous position returns right', () => {
    expect(getRelativePosition(4, 1)).toBe('right');
    expect(getRelativePosition(1, 2)).toBe('right');
  });
});

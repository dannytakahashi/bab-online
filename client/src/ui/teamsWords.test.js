import { describe, it, expect } from 'vitest';
import { teamsWords } from './drawHud.js';

// The teams panel's status line (ui/drawHud.js): the teams by name, seats
// 1 and 3 then 2 and 4, never "Team 1" / "Team 2" (owner 2026-11-17)
describe('teamsWords', () => {
  it('both teams by name', () => {
    expect(teamsWords({ team1: ['ann', 'cat'], team2: ['bob', 'dan'] })).toBe('Teams: ann and cat versus bob and dan');
  });

  it('a name not known is left out; a team with none is left out; nothing known says nothing', () => {
    expect(teamsWords({ team1: ['ann', ''], team2: ['bob', null] })).toBe('Teams: ann versus bob');
    expect(teamsWords({ team1: ['ann', 'cat'], team2: [] })).toBe('Teams: ann and cat');
    expect(teamsWords({ team1: [], team2: undefined })).toBe('');
    expect(teamsWords(null)).toBe('');
  });

  it('never a team number', () => {
    for (const t of [null, {}, { team1: ['ann'] }, { team1: ['ann', 'cat'], team2: ['bob', 'dan'] }]) {
      expect(teamsWords(t)).not.toMatch(/Team [12]|Your Team|Opponents/);
    }
  });
});

import { describe, it, expect } from 'vitest';
import * as drawCopy from './drawCopy.js';

const T = [
  [{ username: 'hannah', isBot: false }, { username: 'danny', isBot: false }],
  [{ username: 'clara', isBot: false }, { username: '🤖 Mary', isBot: true }],
];

describe('drawCopy (iOS DrawCopy.swift reads this file for its parity test)', () => {
  it('the casual and the first-deal words', () => {
    expect([drawCopy.title(false), drawCopy.rules(false)]).toEqual(['Draw for Deal', 'The two highest cards are partners; the highest deals.']);
    expect([drawCopy.title(true), drawCopy.rules(true)]).toEqual(['Draw for First Deal', 'Partners are set for this round. The highest card deals first.']);
    expect(drawCopy.PROMPT).toBe('Click a card to draw');
  });

  it('teamsLine: my team first with me as You; a spectator in plan order; bots by persona', () => {
    expect(drawCopy.teamsLine(T, 'danny')).toBe('You & hannah vs clara & 🤖 Mary');
    expect(drawCopy.teamsLine(T, 'clara')).toBe('You & 🤖 Mary vs hannah & danny');
    expect(drawCopy.teamsLine(T, null)).toBe('hannah & danny vs clara & 🤖 Mary');
    // a bot persona is never "me"
    expect(drawCopy.teamsLine(T, '🤖 Mary')).toBe('hannah & danny vs clara & 🤖 Mary');
    expect(drawCopy.teamsLine(null, 'x')).toBe('');
  });

  it('teamsSpoken: and / versus, never a team number', () => {
    expect(drawCopy.teamsSpoken(T, 'danny')).toBe('Partners: you and hannah versus clara and 🤖 Mary');
    expect(drawCopy.teamsSpoken(T, null)).toBe('Partners: hannah and danny versus clara and 🤖 Mary');
    for (const me of [null, 'hannah', 'clara']) {
      expect(drawCopy.teamsLine(T, me)).not.toMatch(/Team [12]|T[12]\b|Your Team|Opponents/);
      expect(drawCopy.teamsSpoken(T, me)).not.toMatch(/Team [12]|T[12]\b|Your Team|Opponents/);
    }
  });

  it('validTeams: exactly 2 x 2 with string usernames, else null', () => {
    expect(drawCopy.validTeams(T)).toEqual(T);
    expect(drawCopy.validTeams([[{ username: 'a' }, { username: 'b', isBot: 'yes' }], [{ username: 'c' }, { username: 'd' }]]))
      .toEqual([[{ username: 'a', isBot: false }, { username: 'b', isBot: false }], [{ username: 'c', isBot: false }, { username: 'd', isBot: false }]]);
    for (const bad of [null, undefined, [], [T[0]], [...T, T[0]], [[T[0][0]], T[1]], [[T[0][0], { username: '' }], T[1]],
      [[T[0][0], { username: 5 }], T[1]], [[T[0][0], null], T[1]], 'x', { 0: T[0], 1: T[1] }]) {
      expect(drawCopy.validTeams(bad)).toBeNull();
    }
  });
});

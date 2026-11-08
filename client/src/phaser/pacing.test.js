import { describe, it, expect } from 'vitest';
import { flyInMs, collectMs, teamsFade, FLIP } from './pacing.js';
import { ANIMATION_CONFIG } from './config.js';

describe('flyInMs', () => {
  it('is CARD_PLAY (300) without resumeInMs', () => {
    expect(ANIMATION_CONFIG.CARD_PLAY).toBe(300);
    expect(flyInMs(undefined)).toBe(300);
    expect(flyInMs(null)).toBe(300);
    expect(flyInMs('1100')).toBe(300);
    expect(flyInMs(NaN)).toBe(300);
  });

  it('lands the trick-completing card within a quarter of the hold, never under 120 ms', () => {
    expect(flyInMs(1100)).toBe(275);
    expect(flyInMs(2000)).toBe(300);
    expect(flyInMs(400)).toBe(120);
    expect(flyInMs(0)).toBe(120);
  });

  it('flips faster than the fly-in', () => {
    expect(FLIP.DELAY + 2 * FLIP.HALF).toBeLessThanOrEqual(ANIMATION_CONFIG.CARD_PLAY);
  });
});

describe('collectMs', () => {
  it('is CARD_COLLECT (500) without resumeInMs', () => {
    expect(collectMs(undefined)).toBe(500);
  });

  it('fits a hand\'s last collect in half of the hold, between 150 and 500 ms', () => {
    expect(collectMs(1000)).toBe(500);
    expect(collectMs(1500)).toBe(500);
    expect(collectMs(600)).toBe(300);
    expect(collectMs(100)).toBe(150);
  });
});

describe('teamsFade', () => {
  it('ends exactly at the server\'s createUI (3000 ms hold)', () => {
    expect(teamsFade(3000)).toEqual({ fadeDelay: 2000, fadeDuration: 1000 });
  });

  it('assumes the 3000 ms hold when the field is missing', () => {
    expect(teamsFade(undefined)).toEqual({ fadeDelay: 2000, fadeDuration: 1000 });
  });

  it('scales a retuned hold', () => {
    expect(teamsFade(2400)).toEqual({ fadeDelay: 1600, fadeDuration: 800 });
    expect(teamsFade(600)).toEqual({ fadeDelay: 300, fadeDuration: 300 });
    expect(teamsFade(0)).toEqual({ fadeDelay: 0, fadeDuration: 300 });
  });
});

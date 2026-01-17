import { describe, it, expect } from 'vitest';
import {
  hashToHue,
  generateDistinctColor,
  getUsernameColor,
  extractHue,
} from './colors.js';

describe('hashToHue', () => {
  it('returns a number between 0 and 359', () => {
    const hue = hashToHue('testuser');
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });

  it('returns consistent results for same input', () => {
    expect(hashToHue('alice')).toBe(hashToHue('alice'));
    expect(hashToHue('bob')).toBe(hashToHue('bob'));
  });

  it('returns different values for different usernames', () => {
    expect(hashToHue('alice')).not.toBe(hashToHue('bob'));
  });

  it('handles empty string', () => {
    const hue = hashToHue('');
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });
});

describe('generateDistinctColor', () => {
  it('returns HSL color string', () => {
    const color = generateDistinctColor('testuser');
    expect(color).toMatch(/^hsl\(\d+, 70%, 60%\)$/);
  });

  it('avoids existing colors', () => {
    const existingColors = ['hsl(180, 70%, 60%)'];
    const newColor = generateDistinctColor('testuser', existingColors);

    // Extract hue from new color
    const newHue = parseInt(newColor.match(/hsl\((\d+)/)[1], 10);

    // Should be at least 50 degrees away from 180
    const diff = Math.abs(newHue - 180);
    const actualDiff = Math.min(diff, 360 - diff);
    expect(actualDiff).toBeGreaterThanOrEqual(50);
  });

  it('handles empty existing colors array', () => {
    const color = generateDistinctColor('testuser', []);
    expect(color).toMatch(/^hsl\(\d+, 70%, 60%\)$/);
  });

  it('handles multiple existing colors', () => {
    const existingColors = [
      'hsl(0, 70%, 60%)',
      'hsl(90, 70%, 60%)',
      'hsl(180, 70%, 60%)',
      'hsl(270, 70%, 60%)',
    ];
    const color = generateDistinctColor('testuser', existingColors);
    expect(color).toMatch(/^hsl\(\d+, 70%, 60%\)$/);
  });
});

describe('getUsernameColor', () => {
  it('returns HSL color string', () => {
    const color = getUsernameColor('testuser');
    expect(color).toMatch(/^hsl\(\d+, 70%, 60%\)$/);
  });

  it('returns consistent color for same username', () => {
    expect(getUsernameColor('alice')).toBe(getUsernameColor('alice'));
  });
});

describe('extractHue', () => {
  it('extracts hue from HSL string', () => {
    expect(extractHue('hsl(180, 70%, 60%)')).toBe(180);
    expect(extractHue('hsl(0, 70%, 60%)')).toBe(0);
    expect(extractHue('hsl(359, 70%, 60%)')).toBe(359);
  });

  it('returns null for invalid string', () => {
    expect(extractHue('rgb(255, 0, 0)')).toBeNull();
    expect(extractHue('red')).toBeNull();
    expect(extractHue('')).toBeNull();
  });
});
